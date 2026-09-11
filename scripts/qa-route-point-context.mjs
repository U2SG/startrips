// #291 - Route Point activation must reveal one truthful Atlas context surface
// before Story, without becoming a camera owner or inventing media locations.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const journeyId = "qa-context-journey";
const photoPointId = "qa-context-photo";
const textPointId = "qa-context-text";
const photoAssetId = "qa-context-photo-asset";
const siblingJourneyId = "qa-context-sibling-journey";
const siblingPointId = "qa-context-sibling-point";

const journey = {
  id: journeyId,
  atlasId: "qa-atlas",
  title: "维港的一天",
  startedOn: "2026-04-06",
  endedOn: null,
  note: "",
  lightColor: "#77c8c2",
  lightEffect: null,
  coverMediaAssetId: photoAssetId,
  revision: 1,
  createdByUserId: "qa-user",
  createdAt: "2026-04-06T00:00:00.000Z",
  updatedAt: "2026-04-06T00:00:00.000Z",
  routePoints: [
    {
      id: photoPointId,
      journeyId,
      sortOrder: 0,
      latitude: 22.2855,
      longitude: 114.1577,
      label: "中环码头",
      isStop: true,
      occurredAt: "2026-04-06T09:30:00.000Z",
      note: "海风很轻，船靠岸的时候没有说话。",
      createdAt: "2026-04-06T09:30:00.000Z",
    },
    {
      id: textPointId,
      journeyId,
      sortOrder: 1,
      latitude: 22.2931,
      longitude: 114.1694,
      label: "九龙海旁",
      isStop: true,
      occurredAt: null,
      note: "这一站只留下了一句话。",
      createdAt: "2026-04-06T10:00:00.000Z",
    },
  ],
  media: [{
    id: photoAssetId,
    journeyId,
    routePointId: photoPointId,
    storageDriver: "qa",
    storageKey: photoAssetId,
    fileName: "harbour.jpg",
    mimeType: "image/jpeg",
    bytes: 128,
    sortOrder: 0,
    uploadedByUserId: "qa-user",
    createdAt: "2026-04-06T09:31:00.000Z",
  }],
};

const siblingJourney = {
  ...journey,
  id: siblingJourneyId,
  title: "另一段可见旅程",
  coverMediaAssetId: null,
  revision: 1,
  routePoints: [{
    id: siblingPointId,
    journeyId: siblingJourneyId,
    sortOrder: 0,
    latitude: 22.31,
    longitude: 114.22,
    label: "另一段旅程的路线点",
    isStop: true,
    occurredAt: null,
    note: "",
    createdAt: "2026-04-05T10:00:00.000Z",
  }],
  media: [],
};

const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
let failed = false;

function record(name, data, condition) {
  const entry = { name, ...data, failed: !condition };
  checks.push(entry);
  if (entry.failed) failed = true;
}

async function stubAtlasApi(page) {
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys: [siblingJourney, journey] }),
  }));
  await page.route(`**/api/uploads/assets/${photoAssetId}/read-url`, async (route) => {
    // Delay the representative read so focus/camera ownership is graded both
    // at context reveal and when late media readiness settles.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='%23254a48'/%3E%3C/svg%3E",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
}

async function openFocusAtlas({
  viewport = { width: 1280, height: 720 },
  compact = false,
  reduceMotion = false,
} = {}) {
  const page = await browser.newPage({
    viewport,
    isMobile: compact,
    hasTouch: compact,
    reducedMotion: reduceMotion ? "reduce" : "no-preference",
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await stubAtlasApi(page);
  // #291 grades the Atlas route-point activation/context contract, not scene
  // startup throughput. The earlier real-scene version timed out before ready in
  // CI, so this dedicated flag keeps the existing deterministic QA globe while
  // still invoking the production `onJourneyRoutePointActivate` callback. The
  // ordinary globe-chrome lane remains on the real globe and continues to own
  // raycast/focus-mode chrome coverage.
  await page.goto(
    `${origin}/?qaState=living-atlas&qaMode=globe-chrome&qaLite=1&qaRoutePointContext=1&qaSpatialHandoff=1`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator("[data-qa-route-point-context-focus]").waitFor({ state: "attached", timeout: 20_000 });
  await page.locator(`[data-qa-route-point-context-activate="${photoPointId}"]`).waitFor({ state: "attached", timeout: 5_000 });
  if (!compact) {
    await page.locator(".living-atlas__active").waitFor({ state: "visible", timeout: 5_000 });
    await page.locator(".living-atlas__globe-focus").click();
    await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  } else {
    await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") === "on");
  }
  await page.waitForTimeout(80);
  return { page, pageErrors };
}

async function sceneFocusSnapshot(page) {
  return page.locator("[data-qa-route-point-context-focus]").evaluate((host) => ({
    focusRevision: host.getAttribute("data-focus-revision"),
    focusPoint: host.getAttribute("data-focus-point"),
    focusRoute: host.getAttribute("data-focus-route"),
    activeRoute: host.getAttribute("data-active-route"),
  }));
}

async function activateRoutePoint(page, pointIndex) {
  const pointId = journey.routePoints[pointIndex]?.id;
  if (!pointId) throw new Error(`route point ${pointIndex} is unavailable`);
  const trigger = page.locator(`[data-qa-route-point-context-activate="${pointId}"]`);
  await trigger.waitFor({ state: "attached", timeout: 5_000 });
  await trigger.evaluate((button) => button.click());
}

try {
  const photoRun = await openFocusAtlas();
  const { page } = photoRun;
  const beforeFocus = await sceneFocusSnapshot(page);
  const controlsBefore = await page.locator(".living-atlas-globe__controls").count();

  // Owner P2: the globe can expose hit targets for sibling Journeys, but Route
  // Point context is subordinate to the existing semantic active-Journey owner.
  // Attempting B while A is active must not reveal B or move focus/camera state.
  const siblingTrigger = page.locator(`[data-qa-route-point-context-activate="${siblingPointId}"]`);
  await siblingTrigger.waitFor({ state: "attached", timeout: 5_000 });
  await siblingTrigger.evaluate((button) => button.click());
  await page.waitForTimeout(80);
  const afterSiblingAttempt = await sceneFocusSnapshot(page);
  const siblingState = {
    contextCount: await page.locator("[data-route-point-context]").count(),
    activeRoute: afterSiblingAttempt.activeRoute,
  };
  record("sibling Journey Route Point cannot split semantic ownership", { beforeFocus, afterSiblingAttempt, siblingState },
    siblingState.contextCount === 0
    && siblingState.activeRoute === journeyId
    && JSON.stringify(beforeFocus) === JSON.stringify(afterSiblingAttempt));

  await activateRoutePoint(page, 0);
  const context = page.locator("[data-route-point-context]");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  const revealFocus = await sceneFocusSnapshot(page);
  const reveal = await context.evaluate((node) => ({
    count: document.querySelectorAll("[data-route-point-context]").length,
    routePointId: node.getAttribute("data-route-point-id"),
    precision: node.getAttribute("data-location-precision"),
    text: node.textContent ?? "",
    entryCount: node.querySelectorAll(".living-atlas__route-point-context-entry").length,
    controlsCount: document.querySelectorAll(".living-atlas-globe__controls").length,
  }));
  record("photo context reveal", { reveal },
    reveal.count === 1
    && reveal.routePointId === photoPointId
    && reveal.precision === "route-point"
    && reveal.text.includes("中环码头")
    && reveal.text.includes("1 项影像")
    && reveal.entryCount === 1
    && controlsBefore === 0
    && reveal.controlsCount === 0);
  record("context reveal keeps camera focus owner", { beforeFocus, revealFocus },
    JSON.stringify(beforeFocus) === JSON.stringify(revealFocus));

  await page.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  const readyFocus = await sceneFocusSnapshot(page);
  record("late representative readiness keeps camera focus owner", { revealFocus, readyFocus },
    JSON.stringify(revealFocus) === JSON.stringify(readyFocus));

  const marker = page.locator(`.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${photoPointId}"]`);
  await marker.waitFor({ state: "attached", timeout: 5_000 });
  const markerBefore = await marker.boundingBox();
  await page.locator(".living-atlas__route-point-context-entry").click();
  const departureAperture = page.locator("[data-place-media-observation]:not([data-shared-element-clone])");
  await departureAperture.waitFor({ state: "attached", timeout: 2_000 });
  const departureRect = await departureAperture.boundingBox();
  await page.locator(".journey-story").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${photoAssetId}"][data-media-page-ready="true"]`).waitFor({
    state: "attached", timeout: 5_000,
  });
  const storyIdentity = await page.locator(`.journey-story button[data-route-point-id="${photoPointId}"]`).evaluate((node) => ({
    pressed: node.getAttribute("aria-pressed"),
    label: node.textContent?.trim() ?? "",
  }));
  record("context entry preserves Journey + Route Point Story identity", { storyIdentity },
    storyIdentity.pressed === "true" && storyIdentity.label.includes("中环码头"));
  record("Route Point departure uses live geographic marker geometry", { markerBefore, departureRect }, Boolean(
    markerBefore && departureRect
    && Math.abs(departureRect.x - (markerBefore.x + markerBefore.width + 16)) < 28
    && Math.abs((departureRect.y + departureRect.height / 2) - (markerBefore.y + markerBefore.height / 2)) < 16
  ));

  // Camera/projection movement changes the SVG marker, not a stored React x/y.
  // Returning from Story must read this new geometry.
  await departureAperture.waitFor({ state: "detached", timeout: 5_000 });
  await marker.evaluate((node) => {
    node.setAttribute("cx", "470");
    node.setAttribute("cy", "250");
  });
  const markerAfterMove = await marker.boundingBox();
  await page.getByRole("button", { name: "退出旅程故事" }).click();
  const returnAperture = page.locator("[data-place-media-observation]:not([data-shared-element-clone])");
  await returnAperture.waitFor({ state: "attached", timeout: 2_000 });
  const returnRect = await returnAperture.boundingBox();
  record("Story return remeasures the current Route Point instead of stale opening coordinates", {
    markerBefore, markerAfterMove, departureRect, returnRect,
  }, Boolean(
    markerBefore && markerAfterMove && departureRect && returnRect
    && Math.abs(returnRect.x - (markerAfterMove.x + markerAfterMove.width + 16)) < 28
    && Math.abs(returnRect.x - departureRect.x) > 120
  ));
  await page.locator("[data-route-point-context]").waitFor({ state: "visible", timeout: 5_000 });
  record("photo page errors", { pageErrors: photoRun.pageErrors }, photoRun.pageErrors.length === 0);
  await page.close();

  const textRun = await openFocusAtlas();
  const textPage = textRun.page;
  const textFocusBefore = await sceneFocusSnapshot(textPage);
  await activateRoutePoint(textPage, 1);
  const textContext = textPage.locator("[data-route-point-context]");
  await textContext.waitFor({ state: "visible", timeout: 5_000 });
  const textState = await textContext.evaluate((node) => ({
    count: document.querySelectorAll("[data-route-point-context]").length,
    routePointId: node.getAttribute("data-route-point-id"),
    text: node.textContent ?? "",
    mediaCueCount: node.querySelectorAll("[data-route-point-context-media]").length,
    controlsCount: document.querySelectorAll(".living-atlas-globe__controls").length,
    permanentToolbarCount: document.querySelectorAll(".living-atlas__route-point-context nav, .living-atlas__route-point-context [role=toolbar]").length,
  }));
  const textFocusAfter = await sceneFocusSnapshot(textPage);
  record("text-only Route Point stays truthful", { textState },
    textState.count === 1
    && textState.routePointId === textPointId
    && textState.text.includes("九龙海旁")
    && textState.text.includes("仅文字记录")
    && !textState.text.includes("正在载入")
    && textState.mediaCueCount === 0
    && textState.controlsCount === 0
    && textState.permanentToolbarCount === 0);
  record("text-only reveal keeps camera focus owner", { textFocusBefore, textFocusAfter },
    JSON.stringify(textFocusBefore) === JSON.stringify(textFocusAfter));

  // Review P2: the context belongs only to the planet surface. Return from
  // focus mode, activate a point again in normal Atlas, then switch to Timeline;
  // no retained context may float over that sibling view.
  await textPage.locator(".living-atlas__globe-focus-exit").click();
  await textPage.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "off");
  await activateRoutePoint(textPage, 0);
  await textPage.locator("[data-route-point-context]").waitFor({ state: "visible", timeout: 5_000 });
  await textPage.getByRole("button", { name: "时间线" }).click();
  await textPage.waitForFunction(() => document.querySelectorAll("[data-route-point-context]").length === 0);
  const timelineState = {
    contextCount: await textPage.locator("[data-route-point-context]").count(),
    timelineVisible: await textPage.locator(".journey-timeline").isVisible(),
  };
  record("timeline view releases Route Point context", { timelineState },
    timelineState.contextCount === 0 && timelineState.timelineVisible);

  record("text page errors", { pageErrors: textRun.pageErrors }, textRun.pageErrors.length === 0);
  await textPage.close();

  const reducedRun = await openFocusAtlas({ reduceMotion: true });
  const reducedPage = reducedRun.page;
  await activateRoutePoint(reducedPage, 0);
  await reducedPage.locator("[data-route-point-context]").waitFor({ state: "visible", timeout: 5_000 });
  await reducedPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  await reducedPage.locator(".living-atlas__route-point-context-entry").click();
  await reducedPage.locator(".journey-story").waitFor({ state: "visible", timeout: 5_000 });
  const reducedState = await reducedPage.evaluate((assetId) => ({
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    observations: document.querySelectorAll("[data-place-media-observation]").length,
    placeMediaClones: document.querySelectorAll('[data-shared-element-clone^="place-media-"]').length,
    currentAsset: document.querySelector('.journey-story__media [data-media-page="current"]')?.getAttribute("data-media-page-id") ?? null,
  }), photoAssetId);
  record("reduced motion keeps same Story identity without spatial travel", { reducedState },
    reducedState.reduced
    && reducedState.observations === 0
    && reducedState.placeMediaClones === 0
    && reducedState.currentAsset === photoAssetId);
  record("reduced-motion page errors", { pageErrors: reducedRun.pageErrors }, reducedRun.pageErrors.length === 0);
  await reducedPage.close();

  for (const viewport of [
    { name: "landscape-844x390", width: 844, height: 390 },
    { name: "landscape-932x430", width: 932, height: 430 },
  ]) {
    const compactRun = await openFocusAtlas({
      viewport: { width: viewport.width, height: viewport.height },
      compact: true,
    });
    const compactPage = compactRun.page;
    const compactFocusBefore = await sceneFocusSnapshot(compactPage);
    await activateRoutePoint(compactPage, 0);
    const compactContext = compactPage.locator("[data-route-point-context]");
    await compactContext.waitFor({ state: "visible", timeout: 5_000 });
    const compactFocusAfter = await sceneFocusSnapshot(compactPage);
    const compactState = await compactContext.evaluate((node) => {
      const root = node.closest(".living-atlas");
      const panel = node.getBoundingClientRect();
      const entry = node.querySelector(".living-atlas__route-point-context-entry")?.getBoundingClientRect() ?? null;
      return {
        mobileV2: root?.getAttribute("data-mobile-v2") ?? null,
        contextCount: document.querySelectorAll("[data-route-point-context]").length,
        panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
        entry: entry ? { width: entry.width, height: entry.height } : null,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    record(`${viewport.name} uses compact context posture`, { compactState },
      compactState.mobileV2 === "on"
      && compactState.contextCount === 1
      && compactState.panel.left >= 0
      && compactState.panel.top >= 0
      && compactState.panel.right <= compactState.viewport.width
      && compactState.panel.bottom <= compactState.viewport.height
      && (compactState.entry?.height ?? 0) >= 44
      && (compactState.entry?.width ?? 0) >= 44);
    record(`${viewport.name} context keeps camera focus owner`, { compactFocusBefore, compactFocusAfter },
      JSON.stringify(compactFocusBefore) === JSON.stringify(compactFocusAfter));
    if (viewport.name === "landscape-844x390") {
      await compactPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
      const compactMarker = compactPage.locator(`.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${photoPointId}"]`);
      const compactMarkerRect = await compactMarker.boundingBox();
      await compactPage.locator(".living-atlas__route-point-context-entry").click();
      const compactAperture = compactPage.locator("[data-place-media-observation]:not([data-shared-element-clone])");
      await compactAperture.waitFor({ state: "attached", timeout: 2_000 });
      const compactApertureRect = await compactAperture.boundingBox();
      await compactPage.locator(".journey-story").waitFor({ state: "visible", timeout: 5_000 });
      record(`${viewport.name} uses a bounded short spatial handoff`, { compactMarkerRect, compactApertureRect }, Boolean(
        compactMarkerRect && compactApertureRect
        && compactApertureRect.width <= 92.5
        && compactApertureRect.height <= 78.5
        && compactApertureRect.x >= 0
        && compactApertureRect.y >= 0
        && compactApertureRect.x + compactApertureRect.width <= viewport.width
        && compactApertureRect.y + compactApertureRect.height <= viewport.height
        && Math.abs((compactApertureRect.y + compactApertureRect.height / 2)
          - (compactMarkerRect.y + compactMarkerRect.height / 2)) < 20
      ));
    }
    record(`${viewport.name} page errors`, { pageErrors: compactRun.pageErrors }, compactRun.pageErrors.length === 0);
    await compactPage.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ checks }, null, 2));
if (failed) process.exit(1);
