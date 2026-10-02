// #565: synthetic provider evidence for the ordinary Detailed Earth path.
// The browser uses real controls and MapLibre rendering; only the external
// routing/API boundary is fixture-owned, so no personal Journey is published.
import fs from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const artifactDir = "artifacts/route-candidates";
const style = {
  version: 8,
  sources: {},
  layers: [{ id: "qa-road-background", type: "background", paint: { "background-color": "#173d43" } }],
};
const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const evidence = { requests: [], writes: [], stages: [], searches: [], pointSuggestions: [] };
let failNext = false;
let availabilityRequests = 0;
let pendingCandidateGate = null;
let pendingShapeSearchGate = null;
let pendingPointSuggestionGate = null;
let nextSnapOffsetMeters = 0;
const latch = () => {
  let resolve;
  const promise = new Promise((ready) => { resolve = ready; });
  return { promise, resolve };
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const layoutJourneys = Array.from({ length: 11 }, (_, index) => {
  const id = `qa-layout-journey-${index}`;
  return {
    id, atlasId: "qa-atlas", title: `Synthetic journey ${index + 1}`,
    startedOn: "2026-04-06", endedOn: null, note: "", lightColor: "#77c8c2", lightEffect: null,
    coverMediaAssetId: null, revision: 1, createdByUserId: "qa-user",
    createdAt: "2026-04-06T00:00:00.000Z", updatedAt: "2026-04-06T00:00:00.000Z", media: [],
    routePoints: [[50.9375, 6.9603], [50.1109, 8.6821]].map(([latitude, longitude], pointIndex) => ({
      id: `${id}-point-${pointIndex}`, journeyId: id, sortOrder: pointIndex,
      latitude, longitude, label: `Route point ${pointIndex + 1}`, isStop: true,
      occurredAt: null, note: null, createdAt: "2026-04-06T00:00:00.000Z",
    })),
  };
});
const layoutHome = {
  id: "qa-layout-home", label: "Synthetic Home Base", startedOn: "2020-01-01", endedOn: null,
  latitude: 50.5, longitude: 7.8, source: "manual",
};

async function openPage(policy = "default", { owner = false, viewport = { width: 1280, height: 900 }, touch = false, home = false,
  profiles = ["driving", "walking", "cycling"] } = {}) {
  const page = await browser.newPage({ viewport, hasTouch: touch, reducedMotion: "reduce" });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => json(route, null));
  if (owner) {
    await page.route("**/api/journeys", (route) => json(route, { journeys: layoutJourneys }));
    await page.route("**/api/home-bases", (route) => json(route, { periods: home ? [layoutHome] : [] }));
    await page.route("**/api/home-bases/dismissal", (route) => json(route, { dismissals: [] }));
    await page.route("**/api/journey-recorded-tracks/*", (route) => json(route, { recordedTracks: [] }));
    await page.route("**/api/everyday-fragments**", (route) => json(route, { fragments: [] }));
  }
  await page.route(/\/api\/mapstyle\?path=styles(?:%2F|\/)fiord/i, (route) => json(route, style));
  await page.route("**/api/journey-route-segments/availability", (route) => {
    availabilityRequests += 1;
    return json(route, { profiles });
  });
  await page.route("**/api/journey-route-segments/point-suggestions", async (route) => {
    const body = route.request().postDataJSON();
    evidence.pointSuggestions.push(body);
    const gate = pendingPointSuggestionGate;
    pendingPointSuggestionGate = null;
    if (gate) { gate.started.resolve(); await gate.release.promise; }
    try {
      await json(route, { suggestions: [1, 2, 3].map((index) => ({
        id: `qa-nearby-${body.profile}-${index}`, label: `${body.profile} nearby road ${index}`,
        coordinate: { lat: body.coordinate.lat + index * 0.003, lon: body.coordinate.lon + index * 0.003 },
        distanceMeters: index * 470, connected: true,
      })) });
    } catch (error) {
      if (!gate || route.request().failure()?.errorText !== "net::ERR_ABORTED") throw error;
    } finally { gate?.completed.resolve(); }
  });
  await page.route("**/api/locations/search?**", async (route) => {
    const parameters = new URL(route.request().url()).searchParams;
    const query = parameters.get("q");
    evidence.searches.push({ query, latitude: parameters.get("lat"), longitude: parameters.get("lon") });
    const gate = pendingShapeSearchGate;
    if (gate) { gate.started.resolve(); await gate.release.promise; }
    try {
      await json(route, { results: [{
        id: "qa-shape-place", label: query, context: "Synthetic pass", countryCode: "DE",
        latitude: 50.5, longitude: 7.65,
      }], attribution: { label: "Synthetic search", url: "https://example.com" } });
    } finally { gate?.completed.resolve(); }
  });
  await page.route(/\/api\/journey-route-segments\/journeys\/.*\/segments\/.*\/candidates$/, async (route) => {
    const body = route.request().postDataJSON();
    evidence.requests.push({ sourceKey: body.sourceKey, revision: body.revision, profile: body.profile,
      allowFerries: body.allowFerries, accessPoints: body.accessPoints });
    const gate = pendingCandidateGate;
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    if (failNext) {
      failNext = false;
      return json(route, { error: "ROUTING_UNAVAILABLE", message: "Road routing is temporarily unavailable" }, 503);
    }
    const [, fromLat, fromLon, , toLat, toLon] = JSON.parse(body.sourceKey);
    const ordered = [[fromLon, fromLat], ...(evidence.writes.at(-1)?.record.shapePoints ?? []).map(({ lon, lat }) => [lon, lat]), [toLon, toLat]];
    const offsetMeters = nextSnapOffsetMeters;
    nextSnapOffsetMeters = 0;
    const selected = ordered.map((coordinate, index) => {
      const access = index === 0 ? body.accessPoints?.from : index === ordered.length - 1 ? body.accessPoints?.to : null;
      return access ? [access.lon, access.lat] : coordinate;
    });
    const snapped = selected.map((coordinate, index) => index === 0 && offsetMeters
      ? [coordinate[0], coordinate[1] + offsetMeters / 111_195] : coordinate);
    const middle = (bend) => [(fromLon + toLon) / 2, (fromLat + toLat) / 2 + bend];
    const candidates = [0.12, -0.12].map((bend, index) => ({
      candidate: {
        id: `qa-candidate-${body.profile}-${index + 1}-${body.revision}`,
        geometry: [snapped[0], ...snapped.slice(1, -1), middle(bend), snapped.at(-1)],
        distanceMeters: 210_000 + index * 10_000,
        durationSeconds: 9_000 + index * 700,
        provider: "osrm", profile: body.profile, relevance: 100 - index,
        ...(body.allowFerries ? { includesFerry: true } : {}),
        snapping: { maxDistanceMeters: body.profile === "driving" ? 10_000 : 750, waypoints: ordered.map((coordinate, index) => ({
          requested: coordinate, snapped: snapped[index], distanceMeters: index === 0 ? offsetMeters : 0,
          ...(selected[index] !== coordinate ? { selected: selected[index] } : {}),
          providerDistanceMeters: index === 0 ? offsetMeters : 0,
        })) },
      },
      confirmationToken: `qa-token-${index + 1}`,
    }));
    try {
      return await json(route, { sourceKey: body.sourceKey, revision: body.revision, candidates });
    } catch (error) {
      if (!gate || route.request().failure()?.errorText !== "net::ERR_ABORTED") throw error;
    } finally {
      gate?.completed.resolve();
    }
  });
  await page.route(/\/api\/journey-route-segments\/journeys\/.*\/segments\/[^/]+\/[^/]+$/, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON();
    const parts = new URL(route.request().url()).pathname.split("/");
    const record = {
      fromRoutePointId: parts.at(-2), toRoutePointId: parts.at(-1),
      sourceKey: body.sourceKey, revision: body.expectedRevision + 1,
      shapePoints: body.action === "shape" ? body.shapePoints : evidence.writes.at(-1)?.record.shapePoints ?? [],
      decision: body.action === "confirm" ? "confirmed" : body.action === "none" ? "none" : "open",
      confirmedCandidate: body.action === "confirm" ? body.candidate : null,
    };
    evidence.writes.push({ action: body.action, record });
    return json(route, { segment: record });
  });
  const url = new URL(owner
    ? "/?qaState=living-atlas&qaMode=globe-chrome&qaRoutePointContext=1&qaRealRoutePointScene=1"
    : `/?qaState=earth-dive&qaRouteCandidates=true&qaPolicy=${policy}`, baseUrl);
  // Generic QA disables private Home reads. This fixture owns their API
  // boundary and uses the existing opt-in to mount the actual Home context.
  if (home) url.searchParams.set("qaHomeBaseSuggestion", "1");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 25_000 });
  return { page, pageErrors };
}

function readMap(page) {
  return page.locator(".detailed-earth-map").evaluate((host) => ({
    stage: host.dataset.diveStage,
    pointCount: Number(host.dataset.journeyOverlayPointCount ?? 0),
    confirmedCount: Number(host.dataset.journeyOverlayConfirmedCount ?? 0),
    previewCount: Number(host.dataset.routeCandidatePreviewCount ?? 0),
    renderedPreviewCount: window.__detailedEarthMapRenderedFeatureCount?.("startrips-road-candidate-preview-lines", "selected", true) ?? 0,
    renderedConfirmedCount: window.__detailedEarthMapRenderedFeatureCount?.("startrips-active-journey-route", "provenance", "user-confirmed-route") ?? 0,
    renderedEditedVertexCount: window.__detailedEarthMapRenderedSegmentVertexCount?.("qa-p-9", "qa-p-10") ?? 0,
    previewLayer: window.__detailedEarthMapLayerState?.("startrips-road-candidate-preview", "startrips-road-candidate-preview-lines") ?? null,
    projectedFrom: window.__detailedEarthMapProject?.(6.9603, 50.9375) ?? null,
    projectedTo: window.__detailedEarthMapProject?.(8.6821, 50.1109) ?? null,
    mapError: host.dataset.mapError ?? "",
    revision: host.dataset.journeyOverlayRevision ?? "",
    camera: host.dataset.mapCameraObservation ?? "",
  }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function enterDetail(page) {
  await page.locator('[data-earth-dive-intent="true"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".living-atlas-globe")?.dataset.earthDiveOwner === "detail", null, { timeout: 25_000 });
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.journeyOverlayReady === "true", null, { timeout: 15_000 });
  await page.locator('.route-candidate-editor[data-route-editor-positioned="true"]').waitFor({ timeout: 15_000 });
}

async function assertEditorLayout(page, name) {
  // Viewport emulation acknowledges the size before window.resize and the
  // editor's ResizeObserver have committed placement. Wait for the actual
  // geometry; retain the same hit-testing and overlap assertions afterwards.
  await page.waitForFunction(() => {
    const editor = document.querySelector(".route-candidate-editor");
    if (!editor) return false;
    const box = editor.getBoundingClientRect();
    if (box.width < 160 || box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
    return [...document.querySelectorAll(
      ".living-atlas__journey-rail, .living-atlas__active, .living-atlas__home-base-context, .living-atlas__header, .mobile-v2__header, .mobile-v2__chrome, .globe-time-scrubber",
    )].every((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display === "none" || style.visibility === "hidden" || rect.width <= 0
        || Math.min(box.right, rect.right) - Math.max(box.left, rect.left) <= 0.5
        || Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top) <= 0.5;
    });
  }, null, { timeout: 5_000 });
  const layout = await page.locator(".route-candidate-editor").evaluate((editor) => {
    const rect = (element) => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const box = rect(editor);
    const chrome = [...document.querySelectorAll(
      ".living-atlas__journey-rail, .living-atlas__active, .living-atlas__home-base-context, .living-atlas__header, .mobile-v2__header, .mobile-v2__chrome, .globe-time-scrubber",
    )].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 0;
    }).map((element) => ({ name: element.className, ...rect(element) }));
    const overlaps = chrome.filter((other) => Math.min(box.right, other.right) - Math.max(box.left, other.left) > 0.5
      && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 0.5);
    const panel = editor.querySelector(".route-candidate-editor__panel");
    return {
      box, chrome, overlaps, viewport: { width: innerWidth, height: innerHeight },
      positioned: editor.dataset.routeEditorPositioned === "true",
      horizontalOverflow: panel ? panel.scrollWidth > panel.clientWidth : false,
    };
  });
  evidence.stages.push({ name, layout });
  assert(layout.positioned, `${name}: route editor placement was not committed`);
  assert(layout.chrome.length > 0, `${name}: real Atlas chrome was absent`);
  assert(layout.overlaps.length === 0, `${name}: editor overlaps Atlas chrome: ${JSON.stringify(layout)}`);
  assert(layout.box.width >= 160 && layout.box.left >= 0 && layout.box.top >= 0
    && layout.box.right <= layout.viewport.width && layout.box.bottom <= layout.viewport.height,
  `${name}: editor outside visible viewport: ${JSON.stringify(layout)}`);
  assert(!layout.horizontalOverflow, `${name}: route panel has horizontal overflow`);
}

async function assertControlHit(control, name, { scroll = true } = {}) {
  if (scroll) await control.scrollIntoViewIfNeeded();
  const hit = await control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return { width: bounds.width, height: bounds.height, reachable: target === element || element.contains(target) };
  });
  assert(hit.width >= 44 && hit.height >= 44 && hit.reachable, `${name}: control blocked or too small: ${JSON.stringify(hit)}`);
}

await fs.mkdir(artifactDir, { recursive: true });
try {
  const { page, pageErrors } = await openPage();
  const intent = page.locator('[data-earth-dive-intent="true"]');
  await intent.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".living-atlas-globe")?.dataset.earthDiveOwner === "detail", null, { timeout: 25_000 });
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.journeyOverlayReady === "true", null, { timeout: 15_000 });
  const baseline = await readMap(page);
  evidence.stages.push({ name: "baseline", ...baseline });
  assert(baseline.pointCount === 3 && baseline.confirmedCount === 0, `baseline topology wrong: ${JSON.stringify(baseline)}`);
  assert(availabilityRequests === 0, "closed route editor requested provider availability");
  await page.getByRole("button", { name: "贴合道路" }).click();
  await page.locator(".route-candidate-editor select").first().selectOption("1");
  assert(await page.getByRole("button", { name: "查看候选", exact: true }).isDisabled(), "a transport mode was chosen implicitly");
  await page.getByRole("group", { name: "交通方式" }).getByRole("button", { name: "驾车", exact: true }).click();
  assert(availabilityRequests === 1, "opening route editor did not request provider availability once");
  await page.getByRole("button", { name: "查看候选" }).click();
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.routeCandidatePreviewCount === "2");
  await page.getByRole("button", { name: "路线 2" }).click();
  try {
    await page.waitForFunction(() => window.__detailedEarthMapRenderedFeatureCount?.("startrips-road-candidate-preview-lines", "selected", true) > 0);
  } catch (error) {
    evidence.stages.push({ name: "preview-render-failed", ...await readMap(page) });
    await page.screenshot({ path: `${artifactDir}/preview-render-failed.png` });
    throw error;
  }
  const alternatives = await readMap(page);
  evidence.stages.push({ name: "alternatives", ...alternatives });
  assert(alternatives.confirmedCount === 0 && alternatives.previewCount === 2 && alternatives.renderedPreviewCount > 0
    && alternatives.camera === baseline.camera, "candidates changed history or camera before confirmation");
  await page.screenshot({ path: `${artifactDir}/alternatives.png` });

  await page.getByRole("button", { name: "就是这条" }).click();
  await page.waitForFunction(() => document.querySelector("[data-qa-route-segment-decision]")?.getAttribute("data-qa-route-segment-decision") === "confirmed");
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.journeyOverlayConfirmedCount === "1");
  await page.waitForFunction(() => window.__detailedEarthMapRenderedFeatureCount?.("startrips-active-journey-route", "provenance", "user-confirmed-route") > 0
    && window.__detailedEarthMapRenderedFeatureCount?.("startrips-road-candidate-preview-lines") === 0);
  const confirmed = await readMap(page);
  evidence.stages.push({ name: "confirmed", ...confirmed });
  assert(confirmed.pointCount === baseline.pointCount && confirmed.previewCount === 0 && confirmed.renderedConfirmedCount > 0,
    "confirmation did not render the selected route without changing Route Point topology");
  assert(evidence.writes[0].record.confirmedCandidate.snapping.waypoints.length === 2,
    "confirmation lost candidate snap measurements");
  await page.screenshot({ path: `${artifactDir}/confirmed.png` });

  await page.getByRole("button", { name: "调整经过位置" }).click();
  await page.getByRole("button", { name: "在地图上连续选点" }).click();
  const shapeScreen = await page.evaluate(() => window.__detailedEarthMapProject?.(7.8212, 50.7242));
  assert(shapeScreen, "detail map missing for shape edit");
  await page.mouse.click(shapeScreen.x, shapeScreen.y);
  await page.locator(".route-shape-handle").waitFor();
  assert(await page.locator(".route-shape-handle").count() === 1, "edit-only shape handle was not mounted");
  const secondShapeScreen = await page.evaluate(() => window.__detailedEarthMapProject?.(8.1, 50.35));
  assert(secondShapeScreen, "detail map missing for the second shape point");
  await page.mouse.click(secondShapeScreen.x, secondShapeScreen.y);
  await page.waitForFunction(() => document.querySelectorAll(".route-shape-handle").length === 2);
  assert(await page.locator(".route-shape-handle").count() === 2, "continuous map picking stopped after one point");
  await page.getByRole("button", { name: "结束地图选点" }).click();

  const picker = page.locator(".route-shape-picker");
  await picker.getByRole("textbox", { name: "搜索经过的地点" }).fill("Synthetic pass");
  await picker.getByRole("button", { name: "搜索", exact: true }).click();
  await picker.getByRole("button", { name: /添加到这段路线/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".route-shape-handle").length === 3);
  assert(await page.locator(".route-shape-handle").count() === 3, "search selection did not append a third shape point");
  assert(evidence.searches[0].latitude === "50.9375" && evidence.searches[0].longitude === "6.9603",
    "shape search lost its current Journey focus");
  await picker.getByText("输入经纬度", { exact: true }).click();
  await picker.getByRole("textbox", { name: "经度", exact: true }).fill("7.7");
  await picker.getByRole("button", { name: "添加这组坐标" }).click();
  await picker.getByRole("alert").filter({ hasText: "有效的纬度" }).waitFor();
  assert(await page.locator(".route-shape-handle").count() === 3, "empty coordinates silently became a zero-valued shape point");
  await picker.getByRole("textbox", { name: "纬度", exact: true }).fill("50.4");
  await picker.getByRole("button", { name: "添加这组坐标" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".route-shape-handle").length === 4);
  assert(await page.locator(".route-shape-handle").count() === 4, "manual coordinates did not append a fourth shape point");
  await page.getByRole("button", { name: "上移第 3 个修正点", exact: true }).click();
  await page.getByRole("button", { name: "上移第 2 个修正点", exact: true }).click();
  await page.getByRole("button", { name: "移除第 3 个修正点", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".route-shape-handle").length === 3);
  assert((await page.locator(".route-candidate-editor__shape").first().textContent()).includes("Synthetic pass"),
    "shape reordering did not preserve the searched place");
  assert(await page.locator(".route-shape-handle").count() === 3, "shape deletion removed the wrong number of points");
  await page.screenshot({ path: `${artifactDir}/multiple-shapes.png` });
  await page.getByRole("button", { name: "保存修正点" }).click();
  await page.waitForFunction(() => document.querySelector("[data-qa-route-segment-decision]")?.getAttribute("data-qa-route-segment-decision") === "open");
  assert(evidence.writes[1].record.shapePoints.length === 3
    && evidence.writes[1].record.shapePoints[0].label === "Synthetic pass"
    && evidence.writes[1].record.shapePoints[2].lat === 50.4
    && evidence.writes[1].record.shapePoints[2].lon === 7.7, "saved shape points lost labels, order or manual coordinates");
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.journeyOverlayConfirmedCount === "0");
  await page.waitForFunction(() => window.__detailedEarthMapRenderedFeatureCount?.("startrips-active-journey-route", "provenance", "user-confirmed-route") === 0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => window.__detailedEarthMapRenderedSegmentVertexCount?.("qa-p-9", "qa-p-10") >= 5);
  const shaped = await readMap(page);
  evidence.stages.push({ name: "shape-invalidated", ...shaped });
  assert(shaped.pointCount === baseline.pointCount && shaped.renderedEditedVertexCount >= 5
    && shaped.revision !== baseline.revision && await page.locator(".route-shape-handle").count() === 0,
    "saved shape geometry disappeared or shape point leaked into ordinary Journey topology");
  await page.screenshot({ path: `${artifactDir}/shape-preserved.png` });

  await page.getByRole("button", { name: "贴合道路", exact: true }).click();
  nextSnapOffsetMeters = 6_500;
  await page.getByRole("button", { name: "查看候选" }).click();
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.routeCandidatePreviewCount === "2");
  await page.locator(".route-candidate-editor__offsets").filter({ hasText: "6.5 公里" }).waitFor();
  assert(evidence.writes.length === 2 && (await readMap(page)).confirmedCount === 0,
    "park road offsets were silently saved before the member's choice");
  await page.screenshot({ path: `${artifactDir}/park-road-offsets.png` });
  await page.getByRole("button", { name: "都不是／不记得" }).click();
  await page.waitForFunction(() => document.querySelector("[data-qa-route-segment-decision]")?.getAttribute("data-qa-route-segment-decision") === "none");
  const rejected = await readMap(page);
  evidence.stages.push({ name: "rejected", ...rejected });
  assert(rejected.confirmedCount === 0 && rejected.previewCount === 0, "rejection saved a candidate");
  await page.screenshot({ path: `${artifactDir}/rejected.png` });

  failNext = true;
  await page.getByRole("button", { name: "查看候选" }).click();
  await page.getByRole("status").filter({ hasText: "temporarily unavailable" }).waitFor();
  const failed = await readMap(page);
  evidence.stages.push({ name: "provider-failed", ...failed });
  assert(failed.pointCount === baseline.pointCount && failed.confirmedCount === 0 && failed.previewCount === 0,
    "provider failure hid or promoted the original route");
  assert(evidence.requests.length === 3 && evidence.writes.map((write) => write.action).join(",") === "confirm,shape,none",
    `unexpected request/save sequence: ${JSON.stringify(evidence)}`);

  const gate = { started: latch(), release: latch(), completed: latch() };
  pendingCandidateGate = gate;
  const abortedRequest = page.waitForEvent("requestfailed", {
    predicate: (request) => /\/candidates$/.test(new URL(request.url()).pathname),
  });
  await page.getByRole("button", { name: "查看候选" }).click();
  await gate.started.promise;
  await page.getByRole("group", { name: "交通方式" }).getByRole("button", { name: "步行", exact: true }).click();
  const aborted = await abortedRequest;
  gate.release.resolve();
  await gate.completed.promise;
  pendingCandidateGate = null;
  const cancelled = await readMap(page);
  evidence.stages.push({ name: "profile-cancelled", ...cancelled, requestFailure: aborted.failure()?.errorText });
  assert(cancelled.previewCount === 0 && cancelled.renderedPreviewCount === 0
    && await page.getByRole("button", { name: "路线 1", exact: true }).count() === 0
    && await page.getByRole("button", { name: "步行", exact: true }).getAttribute("aria-pressed") === "true",
    "late candidate response survived the changed routing profile");
  assert(evidence.requests.length === 4 && evidence.writes.length === 3, "cancelled candidate request wrote route history");
  await page.getByRole("button", { name: "调整经过位置" }).click();
  const searchGate = { started: latch(), release: latch(), completed: latch() };
  pendingShapeSearchGate = searchGate;
  await page.getByRole("textbox", { name: "搜索经过的地点" }).fill("Delayed synthetic pass");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await searchGate.started.promise;
  await page.locator(".route-candidate-editor select").first().selectOption("0");
  await page.locator(".route-shape-picker").waitFor({ state: "detached" });
  searchGate.release.resolve();
  await searchGate.completed.promise;
  pendingShapeSearchGate = null;
  assert(await page.locator(".route-shape-picker").count() === 0
    && await page.getByText("Delayed synthetic pass", { exact: true }).count() === 0
    && evidence.writes.length === 3, "late shape search changed another segment or survived closing the picker");
  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join(" | ")}`);
  await page.close();

  const particle = await openPage("particle-only");
  await particle.page.locator('[data-earth-policy="particle-only"]').waitFor();
  assert(await particle.page.locator(".detailed-earth-map").count() === 0, "particle-only mounted MapLibre");
  assert(await particle.page.locator(".route-candidate-editor").count() === 0, "particle-only mounted candidate editor");
  await particle.page.close();

  const modal = await openPage("default", { touch: true });
  await enterDetail(modal.page);
  await modal.page.getByRole("button", { name: "贴合道路", exact: true }).tap();
  const modePointCount = (await readMap(modal.page)).pointCount;
  for (const [profile, name] of [["walking", "步行"], ["cycling", "骑行"]]) {
    const button = modal.page.getByRole("group", { name: "交通方式" }).getByRole("button", { name, exact: true });
    await assertControlHit(button, `${profile}-touch`);
    await button.tap();
    await modal.page.getByRole("button", { name: "查看候选", exact: true }).tap();
    await modal.page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.routeCandidatePreviewCount === "2");
    assert(evidence.requests.at(-1).profile === profile, `${profile}: request used the wrong graph profile`);
    if (profile === "cycling") await modal.page.getByText("骑行候选可能包含推行路段，请核对。", { exact: true }).waitFor();
    await modal.page.getByRole("button", { name: "就是这条", exact: true }).tap();
    await modal.page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.routeCandidatePreviewCount === "0");
    const saved = await readMap(modal.page);
    assert(evidence.writes.at(-1).record.confirmedCandidate.profile === profile
      && saved.confirmedCount === 1 && saved.pointCount === modePointCount,
    `${profile}: confirmation changed the mode or Route Point topology`);
    evidence.stages.push({ name: `${profile}-confirmed`, ...saved });
    await modal.page.screenshot({ path: `${artifactDir}/${profile}-confirmed.png` });
  }
  assert(modal.pageErrors.length === 0, `mode browser errors: ${modal.pageErrors.join(" | ")}`);
  await modal.page.close();

  const limited = await openPage("default", { profiles: ["driving"] });
  await enterDetail(limited.page);
  await limited.page.getByRole("button", { name: "贴合道路", exact: true }).click();
  await limited.page.getByRole("button", { name: "驾车", exact: true }).click();
  assert(await limited.page.getByRole("button", { name: "步行", exact: true }).isDisabled()
    && await limited.page.getByRole("button", { name: "骑行", exact: true }).isDisabled(),
  "unconfigured transport modes became selectable");
  await limited.page.close();

  const assist = await openPage("default", { touch: true, viewport: { width: 390, height: 844 } });
  await enterDetail(assist.page);
  await assist.page.getByRole("button", { name: "贴合道路", exact: true }).tap();
  await assist.page.getByRole("group", { name: "交通方式" }).getByRole("button", { name: "驾车", exact: true }).tap();
  const assistBaseline = await readMap(assist.page);
  const writesBeforeAssist = evidence.writes.length;
  await assist.page.locator(".route-candidate-editor__access summary").tap();
  await assist.page.getByRole("button", { name: "推荐终点附近", exact: true }).tap();
  const nearby = assist.page.getByRole("region", { name: "附近可达点" });
  await nearby.getByRole("button").filter({ hasText: "driving nearby road 1" }).waitFor();
  await assist.page.locator(".route-nearby-handle").first().waitFor();
  assert(evidence.writes.length === writesBeforeAssist && (await readMap(assist.page)).pointCount === assistBaseline.pointCount,
    "nearby suggestions changed Journey topology or saved before selection");
  await assertControlHit(nearby.locator("li button").first(), "nearby-mobile-choice");
  await assist.page.screenshot({ path: `${artifactDir}/nearby-mobile-points.png` });
  const chosenAccess = { lat: evidence.pointSuggestions.at(-1).coordinate.lat + 0.003, lon: evidence.pointSuggestions.at(-1).coordinate.lon + 0.003 };
  await nearby.locator("li button").first().tap();
  await assist.page.getByRole("button", { name: "查看候选", exact: true }).tap();
  await assist.page.getByRole("button", { name: "路线 1", exact: true }).waitFor();
  assert(JSON.stringify(evidence.requests.at(-1).accessPoints.to) === JSON.stringify(chosenAccess)
    && (await readMap(assist.page)).pointCount === assistBaseline.pointCount, "selected road access did not reach routing or changed a Journey point");
  await assist.page.getByRole("checkbox", { name: "允许包含轮渡", exact: true }).check();
  await assist.page.getByRole("button", { name: "查看候选", exact: true }).tap();
  await assist.page.getByText("这条路线包含轮渡，请核对班次和车辆运载限制。", { exact: true }).waitFor();
  assert(evidence.requests.at(-1).allowFerries === true && (await readMap(assist.page)).camera === assistBaseline.camera,
    "ferry was not explicitly requested or candidate preparation stole the map camera");
  await assist.page.getByRole("button", { name: "就是这条", exact: true }).tap();
  await assist.page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.journeyOverlayConfirmedCount === "1");
  assert(evidence.writes.at(-1).record.confirmedCandidate.includesFerry
    && evidence.writes.at(-1).record.confirmedCandidate.snapping.waypoints.at(-1).selected,
    "confirmation lost ferry or selected access-point metadata");

  await assist.page.getByRole("button", { name: "调整经过位置", exact: true }).tap();
  await assist.page.getByRole("textbox", { name: "搜索经过的地点" }).fill("Approximate synthetic bend");
  await assist.page.getByRole("button", { name: "搜索", exact: true }).tap();
  await assist.page.locator(".route-shape-picker__results button").first().tap();
  await nearby.locator("li button").first().waitFor();
  const coarseShape = evidence.pointSuggestions.at(-1).coordinate;
  await nearby.locator("li button").first().tap();
  await assist.page.getByRole("button", { name: "保存修正点", exact: true }).tap();
  await assist.page.getByRole("status").filter({ hasText: "修正点已保存" }).waitFor();
  const savedShape = evidence.writes.at(-1).record.shapePoints.at(-1);
  assert(savedShape.lat === coarseShape.lat + 0.003 && savedShape.lon === coarseShape.lon + 0.003
    && (await readMap(assist.page)).pointCount === assistBaseline.pointCount, "a recommended shape point did not shape the route independently of Journey nodes");

  const pointGate = { started: latch(), release: latch(), completed: latch() };
  pendingPointSuggestionGate = pointGate;
  const failedPointRequest = assist.page.waitForEvent("requestfailed", { predicate: (request) => /\/point-suggestions$/.test(new URL(request.url()).pathname) });
  await assist.page.getByRole("button", { name: "推荐起点附近", exact: true }).tap();
  await pointGate.started.promise;
  await assist.page.getByRole("group", { name: "交通方式" }).getByRole("button", { name: "步行", exact: true }).tap();
  await failedPointRequest;
  pointGate.release.resolve();
  await pointGate.completed.promise;
  await nearby.getByRole("button").filter({ hasText: "walking nearby road 1" }).waitFor();
  assert(await nearby.getByText("driving nearby road 1", { exact: true }).count() === 0,
    "late nearby-point response survived a transport mode change");
  await nearby.getByRole("button", { name: "使用原点", exact: true }).tap();
  await assist.page.locator(".route-nearby-handle").first().waitFor({ state: "detached" });
  assert(assist.pageErrors.length === 0, `nearby browser errors: ${assist.pageErrors.join(" | ")}`);
  await assist.page.close();

  const composer = await openPage();
  await composer.page.goto(new URL("/?qaState=journey-composer&qaMode=route-points", baseUrl).toString(), { waitUntil: "domcontentloaded" });
  const draftRow = composer.page.locator(".journey-route-draft > li[data-route-point-draft-id]").first();
  await draftRow.locator(".journey-route-draft__summary").click();
  const draftBefore = { lat: Number(await draftRow.getAttribute("data-route-point-latitude")), lon: Number(await draftRow.getAttribute("data-route-point-longitude")) };
  const draftCount = await composer.page.locator(".journey-route-draft > li[data-route-point-draft-id]").count();
  await draftRow.getByRole("button", { name: "附近可达点", exact: true }).click();
  const draftNearby = draftRow.getByRole("region", { name: "附近可达点" });
  await draftNearby.getByRole("button", { name: "步行", exact: true }).click();
  await draftNearby.locator("li button").first().click();
  assert(Number(await draftRow.getAttribute("data-route-point-latitude")) === draftBefore.lat + 0.003
    && Number(await draftRow.getAttribute("data-route-point-longitude")) === draftBefore.lon + 0.003
    && await composer.page.locator(".journey-route-draft > li[data-route-point-draft-id]").count() === draftCount,
    "composer nearby selection replaced the wrong point or added a pseudo-place");
  await composer.page.screenshot({ path: `${artifactDir}/composer-nearby-point.png` });
  assert(composer.pageErrors.length === 0, `composer nearby errors: ${composer.pageErrors.join(" | ")}`);
  await composer.page.close();

  const writesBeforeLayout = evidence.writes.length;
  for (const fixture of [
    { name: "desktop", viewport: { width: 1280, height: 900 } },
    { name: "fold-desktop", viewport: { width: 1100, height: 768 }, touch: true },
    { name: "narrow-desktop", viewport: { width: 800, height: 700 } },
    { name: "narrow-desktop-home", viewport: { width: 800, height: 700 }, home: true },
    { name: "phone", viewport: { width: 390, height: 844 }, touch: true },
    { name: "phone-landscape", viewport: { width: 844, height: 390 }, touch: true },
  ]) {
    const { page: ownerPage, pageErrors: ownerErrors } = await openPage("default", { owner: true, ...fixture });
    if (fixture.home) {
      // Home is a projected geographic target. Focus the synthetic Journey
      // through its ordinary rail before activating the nearby Home anchor.
      await ownerPage.locator(".living-atlas__journey-rail button.is-active").click();
      const homeMarker = ownerPage.locator(`.living-atlas-globe__home-base[data-home-base-period-id="${layoutHome.id}"]`);
      await homeMarker.waitFor({ state: "visible", timeout: 25_000 });
      await homeMarker.focus();
      await ownerPage.keyboard.press("Enter");
      await ownerPage.locator("[data-home-base-context]").waitFor();
    }
    await enterDetail(ownerPage);
    if (fixture.home) assert(await ownerPage.locator("[data-home-base-context]").isVisible(),
      `${fixture.name}: Home Base context disappeared before layout coverage`);
    const compact = await ownerPage.locator(".living-atlas").getAttribute("data-mobile-v2") === "on";
    if (!compact) assert(await ownerPage.locator(".living-atlas__journey-rail li").count() === 11,
      `${fixture.name}: long Journey list missing`);
    await assertEditorLayout(ownerPage, `${fixture.name}-launcher`);
    const launcher = ownerPage.getByRole("button", { name: "贴合道路", exact: true });
    await assertControlHit(launcher, `${fixture.name}-launcher`);
    await launcher.click();
    const modes = ownerPage.getByRole("group", { name: "交通方式" });
    for (const name of ["步行", "骑行", "驾车"]) {
      const button = modes.getByRole("button", { name, exact: true });
      await assertControlHit(button, `${fixture.name}-${name}`);
      if (fixture.touch) await button.tap();
      else await button.click();
      assert(await button.getAttribute("aria-pressed") === "true"
        && await modes.locator('[aria-pressed="true"]').count() === 1, `${fixture.name}: mode did not respond to a real pointer`);
    }
    await assertEditorLayout(ownerPage, `${fixture.name}-open`);
    const generate = ownerPage.getByRole("button", { name: "查看候选", exact: true });
    await assertControlHit(generate, `${fixture.name}-generate`);
    await generate.click();
    await ownerPage.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.routeCandidatePreviewCount === "2");
    if (fixture.home) assert(await ownerPage.locator("[data-home-base-context]").isVisible(),
      `${fixture.name}: Home Base context disappeared while the route panel was open`);
    await assertEditorLayout(ownerPage, `${fixture.name}-candidates`);
    await assertControlHit(ownerPage.getByRole("button", { name: "就是这条", exact: true }), `${fixture.name}-confirm`);
    const close = ownerPage.locator(".route-candidate-editor").getByRole("button", { name: "关闭", exact: true });
    await assertControlHit(close, `${fixture.name}-close-after-scroll`, { scroll: false });
    await ownerPage.screenshot({ path: `${artifactDir}/${fixture.name}-layout.png` });
    if (fixture.name === "desktop" || fixture.name === "fold-desktop" || fixture.name === "phone") {
      const originalViewport = ownerPage.viewportSize();
      for (const viewport of fixture.name === "phone"
        ? [{ width: 844, height: 390 }, { width: 390, height: 844 }]
        : [{ width: 1024, height: 768 }, { width: 800, height: 700 }, originalViewport]) {
        await ownerPage.setViewportSize(viewport);
        await assertEditorLayout(ownerPage, `${fixture.name}-open-resize-${viewport.width}`);
        for (const [profile, name] of [["walking", "步行"], ["cycling", "骑行"], ["driving", "驾车"]]) {
          const button = modes.getByRole("button", { name, exact: true });
          await assertControlHit(button, `${fixture.name}-resize-${viewport.width}-${name}`);
          if (fixture.touch) await button.tap();
          else await button.click();
          assert(await button.getAttribute("aria-pressed") === "true", `${fixture.name}: mode blocked after viewport change`);
          await generate.click();
          await ownerPage.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.routeCandidatePreviewCount === "2");
          assert(evidence.requests.at(-1).profile === profile, `${fixture.name}: resize request used the wrong mode`);
        }
        await ownerPage.screenshot({ path: `${artifactDir}/${fixture.name}-resize-${viewport.width}.png` });
      }
    }
    await ownerPage.getByRole("button", { name: "调整经过位置", exact: true }).click();
    const shapePicker = ownerPage.locator(".route-shape-picker");
    const searchInput = shapePicker.getByRole("textbox", { name: "搜索经过的地点" });
    await assertControlHit(searchInput, `${fixture.name}-shape-search-input`);
    await searchInput.fill("Synthetic pass");
    await shapePicker.getByRole("button", { name: "搜索", exact: true }).click();
    await assertControlHit(shapePicker.getByRole("button", { name: /添加到这段路线/ }), `${fixture.name}-shape-search-result`);
    const coordinates = shapePicker.locator("summary");
    await assertControlHit(coordinates, `${fixture.name}-shape-coordinate-toggle`);
    await coordinates.click();
    await assertControlHit(shapePicker.getByRole("textbox", { name: "纬度", exact: true }), `${fixture.name}-shape-latitude`);
    await assertControlHit(shapePicker.getByRole("textbox", { name: "经度", exact: true }), `${fixture.name}-shape-longitude`);
    await assertControlHit(shapePicker.getByRole("button", { name: "添加这组坐标" }), `${fixture.name}-shape-coordinate-add`);
    await assertEditorLayout(ownerPage, `${fixture.name}-shape-picker`);
    await assertControlHit(close, `${fixture.name}-shape-close-after-scroll`, { scroll: false });
    await ownerPage.screenshot({ path: `${artifactDir}/${fixture.name}-shape-picker.png` });
    await close.click();
    await assertEditorLayout(ownerPage, `${fixture.name}-closed`);
    if (fixture.name === "desktop") {
      await ownerPage.setViewportSize({ width: 1024, height: 768 });
      await ownerPage.waitForFunction(() => {
        const editor = document.querySelector(".route-candidate-editor")?.getBoundingClientRect();
        const rail = document.querySelector(".living-atlas__journey-rail")?.getBoundingClientRect();
        const card = document.querySelector(".living-atlas__active")?.getBoundingClientRect();
        return editor && rail && card && editor.left >= rail.right + 10 && editor.right <= card.left - 10
          && editor.bottom <= innerHeight && editor.right <= innerWidth;
      });
      await assertEditorLayout(ownerPage, "desktop-live-resize");
      await assertControlHit(launcher, "desktop-live-resize-launcher");
    }
    if (!compact) {
      await ownerPage.locator(".living-atlas__journey-rail button:not(.is-active)").first().click();
      await ownerPage.locator('[data-route-editor-open="false"]').waitFor();
      await assertEditorLayout(ownerPage, `${fixture.name}-journey-switched`);
    }
    assert(ownerErrors.length === 0, `${fixture.name}: browser errors: ${ownerErrors.join(" | ")}`);
    await ownerPage.close();
  }
  assert(evidence.writes.length === writesBeforeLayout, "layout interactions changed Journey history");
  console.log(JSON.stringify({ result: "PASS", evidence }));
} catch (error) {
  await fs.writeFile(`${artifactDir}/failure.json`, JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  }, null, 2));
  throw error;
} finally {
  pendingCandidateGate?.release.resolve();
  pendingPointSuggestionGate?.release.resolve();
  await fs.writeFile(`${artifactDir}/evidence.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
