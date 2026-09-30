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
const evidence = { requests: [], writes: [], stages: [] };
let failNext = false;
let availabilityRequests = 0;
let pendingCandidateGate = null;
const latch = () => {
  let resolve;
  const promise = new Promise((ready) => { resolve = ready; });
  return { promise, resolve };
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function openPage(policy = "default") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => json(route, null));
  await page.route(/\/api\/mapstyle\?path=styles(?:%2F|\/)fiord/i, (route) => json(route, style));
  await page.route("**/api/journey-route-segments/availability", (route) => {
    availabilityRequests += 1;
    return json(route, { profiles: ["driving"] });
  });
  await page.route(/\/api\/journey-route-segments\/journeys\/.*\/segments\/.*\/candidates$/, async (route) => {
    const body = route.request().postDataJSON();
    evidence.requests.push({ sourceKey: body.sourceKey, revision: body.revision, profile: body.profile });
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
    const middle = (bend) => [(fromLon + toLon) / 2, (fromLat + toLat) / 2 + bend];
    const candidates = [0.12, -0.12].map((bend, index) => ({
      candidate: {
        id: `qa-candidate-${index + 1}-${body.revision}`,
        geometry: [[fromLon, fromLat], middle(bend), [toLon, toLat]],
        distanceMeters: 210_000 + index * 10_000,
        durationSeconds: 9_000 + index * 700,
        provider: "osrm", profile: "driving", relevance: 100 - index,
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
  const url = new URL(`/?qaState=earth-dive&qaRouteCandidates=true&qaPolicy=${policy}`, baseUrl);
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
  await page.locator(".route-candidate-editor select").nth(1).selectOption("driving");
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
  await page.screenshot({ path: `${artifactDir}/confirmed.png` });

  await page.getByRole("button", { name: "调整经过位置" }).click();
  await page.getByRole("button", { name: "添加形状点" }).click();
  const rect = await page.locator(".detailed-earth-map").boundingBox();
  assert(rect, "detail map missing for shape edit");
  await page.mouse.click(rect.x + rect.width * 0.75, rect.y + rect.height * 0.58);
  await page.locator(".route-shape-handle").waitFor();
  assert(await page.locator(".route-shape-handle").count() === 1, "edit-only shape handle was not mounted");
  await page.getByRole("button", { name: "保存形状点" }).click();
  await page.waitForFunction(() => document.querySelector("[data-qa-route-segment-decision]")?.getAttribute("data-qa-route-segment-decision") === "open");
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.journeyOverlayConfirmedCount === "0");
  await page.waitForFunction(() => window.__detailedEarthMapRenderedFeatureCount?.("startrips-active-journey-route", "provenance", "user-confirmed-route") === 0);
  const shaped = await readMap(page);
  evidence.stages.push({ name: "shape-invalidated", ...shaped });
  assert(shaped.pointCount === baseline.pointCount && await page.locator(".route-shape-handle").count() === 0,
    "shape point leaked into ordinary Journey topology");

  await page.getByRole("button", { name: "查看候选" }).click();
  await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.routeCandidatePreviewCount === "2");
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
  await page.locator(".route-candidate-editor select").nth(1).selectOption("");
  const aborted = await abortedRequest;
  gate.release.resolve();
  await gate.completed.promise;
  pendingCandidateGate = null;
  const cancelled = await readMap(page);
  evidence.stages.push({ name: "profile-cancelled", ...cancelled, requestFailure: aborted.failure()?.errorText });
  assert(cancelled.previewCount === 0 && cancelled.renderedPreviewCount === 0
    && await page.getByRole("button", { name: "路线 1", exact: true }).count() === 0
    && await page.getByRole("button", { name: "查看候选" }).isDisabled(),
    "late candidate response survived the changed routing profile");
  assert(evidence.requests.length === 4 && evidence.writes.length === 3, "cancelled candidate request wrote route history");
  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join(" | ")}`);
  await page.close();

  const particle = await openPage("particle-only");
  await particle.page.locator('[data-earth-policy="particle-only"]').waitFor();
  assert(await particle.page.locator(".detailed-earth-map").count() === 0, "particle-only mounted MapLibre");
  assert(await particle.page.locator(".route-candidate-editor").count() === 0, "particle-only mounted candidate editor");
  await particle.page.close();
  console.log(JSON.stringify({ result: "PASS", evidence }));
} finally {
  pendingCandidateGate?.release.resolve();
  await fs.writeFile(`${artifactDir}/evidence.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
