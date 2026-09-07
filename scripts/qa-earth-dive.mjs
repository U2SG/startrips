// #252 Semantic Earth Dive QA.
//
// The product claim is that moving from the particle Earth into detailed
// geography is zoom navigation, not a mode switch. Three things have to be true
// in a real browser for that claim to hold, and none of them is visible in a
// screenshot or in a unit test:
//
//   1. the wheel alone walks `data-earth-dive` through every stage in order and
//      back again - no click on the fallback control, no stage skipped;
//   2. the place the user is looking at does not move when ownership transfers;
//   3. a detail surface that cannot load leaves the particle Earth fully usable,
//      with no loading dialog and no premature reveal.
//
// The second one is a measurement, not an assertion. `DetailedEarthMap`
// publishes the two screen-space quantities #252 section 2 asks for - where the
// focused anchor projects, and how many CSS pixels a degree of latitude spans
// there - through MapLibre's own projection, plus the map zoom that produced
// them. Latitude is deliberate: a degree of longitude shrinks with latitude, so
// a north-south probe measures the projection rather than the anchor's place on
// the globe.
//
// Crossing the commit edge is a zoom step, so the raw scale ratio across the
// handoff contains the user's own deliberate zoom. That part is legitimate
// motion. The handoff error is what is left after it is divided out: a map
// whose scale changed by exactly 2^(zoom change) did nothing of its own, and
// anything else is the seam this lane exists to catch.
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const focus = { lat: 22.3193, lon: 114.1694 }; // Hong Kong / Shenzhen regional view.
const qaUrl = new URL(
  `/?qaState=earth-dive&qaFocusLat=${focus.lat}&qaFocusLon=${focus.lon}`,
  baseUrl,
).toString();

// The stated tolerances for the handoff, matching #252's measurement goals.
const ANCHOR_TOLERANCE_PX = 2;
const LOCAL_SCALE_TOLERANCE = 0.03;
// The wheel step that crosses the commit edge. Small on purpose: the smaller
// the deliberate zoom inside the sample interval, the less there is to divide
// out of the scale measurement.
const COMMIT_WHEEL_DELTA = -12;
const VIEWPORT = { width: 1440, height: 1024 };

const EMPTY_STYLE = {
  version: 8,
  name: "QA empty detailed-earth style",
  sources: {},
  layers: [],
};
const MAP_STYLE_PATTERN = /\/api\/mapstyle\?path=styles(?:%2F|\/)fiord(?:$|&)/i;

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

function particleCanvas(page) {
  return page.locator('canvas[data-three-scene="particle-earth"]');
}

/**
 * The gesture point: the centre of the particle globe's own canvas, which the
 * detail layer covers exactly when that layer is allowed to be touched. Every
 * wheel in this lane is a REAL wheel at that one point, so which surface
 * receives it is decided by hit testing rather than by the lane - the ownership
 * contract is graded rather than assumed.
 */
async function gesturePoint(page) {
  const bounds = await particleCanvas(page).boundingBox();
  if (!bounds) throw new Error("particle-earth canvas has no browser bounds");
  return {
    x: Math.max(4, Math.min(VIEWPORT.width - 4, bounds.x + bounds.width / 2)),
    y: Math.max(4, Math.min(VIEWPORT.height - 4, bounds.y + bounds.height / 2)),
  };
}

async function wheelAt(page, point, deltaY) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, deltaY);
}

/** Which element a real gesture at this point would reach. */
async function hitTarget(page, point) {
  return page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element instanceof Element
      ? { tag: element.tagName, className: element.getAttribute("class") }
      : null;
  }, point);
}

async function readDive(page) {
  return page.evaluate(() => {
    const section = document.querySelector(".living-atlas-globe");
    const host = document.querySelector('[data-persistent-earth-host]');
    const scene = document.querySelector(".particle-earth-scene");
    const map = document.querySelector(".detailed-earth-map");
    return {
      stage: section?.getAttribute("data-earth-dive") ?? null,
      owner: section?.getAttribute("data-earth-dive-owner") ?? null,
      earthMode: section?.getAttribute("data-earth-mode") ?? null,
      semanticZoom: scene?.getAttribute("data-semantic-zoom") ?? null,
      localProgress: scene?.dataset?.localProgress ?? null,
      mapZoom: map?.dataset?.handoffZoom ? Number(map.dataset.handoffZoom) : null,
      interactive: host?.getAttribute("data-interactive") ?? null,
      readiness: map?.getAttribute("data-map-readiness") ?? null,
      mapError: map?.getAttribute("data-map-error") ?? null,
      particleZoom: window.__particleEarthDebug?.().zoom ?? null,
      particleRotationY: window.__particleEarthDebug?.().rotationY ?? null,
    };
  });
}

/** The stage ladder as the DOM published it, in order, with duplicates dropped. */
async function installStageRecorder(page) {
  await page.evaluate(() => {
    const section = document.querySelector(".living-atlas-globe");
    if (!section) throw new Error("living-atlas-globe section is absent");
    const sample = () => {
      const map = document.querySelector(".detailed-earth-map");
      return {
        stage: section.getAttribute("data-earth-dive"),
        owner: section.getAttribute("data-earth-dive-owner"),
        anchorX: map?.dataset?.handoffAnchorX ? Number(map.dataset.handoffAnchorX) : null,
        anchorY: map?.dataset?.handoffAnchorY ? Number(map.dataset.handoffAnchorY) : null,
        scale: map?.dataset?.handoffScale ? Number(map.dataset.handoffScale) : null,
        mapZoom: map?.dataset?.handoffZoom ? Number(map.dataset.handoffZoom) : null,
      };
    };
    window.__qaEarthDiveStages = [sample()];
    // A stage change is a DOM write, so the observer sees every one of them -
    // including a pair that happens inside a single animation frame, which a
    // poll would miss and report as a skipped stage.
    const observer = new MutationObserver(() => {
      const next = sample();
      const last = window.__qaEarthDiveStages.at(-1);
      if (last && last.stage === next.stage) return;
      window.__qaEarthDiveStages.push(next);
    });
    observer.observe(section, { attributes: true, attributeFilter: ["data-earth-dive"] });
    window.__qaEarthDiveReset = () => {
      window.__qaEarthDiveStages = [sample()];
    };
  });
}

async function stages(page) {
  return page.evaluate(() => window.__qaEarthDiveStages.map((entry) => entry.stage));
}

/** The published frame at the moment the map's dive stage is exactly `stage`. */
async function frameAt(page, stage) {
  return page.evaluate((wanted) => (
    window.__qaEarthDiveStages.filter((entry) => entry.stage === wanted).at(-1) ?? null
  ), stage);
}

async function wheelUntil(page, point, deltaY, predicate, label, maxSteps = 60) {
  for (let step = 0; step < maxSteps; step += 1) {
    const state = await readDive(page);
    if (predicate(state)) return state;
    await wheelAt(page, point, deltaY);
    await page.waitForTimeout(120);
  }
  const state = await readDive(page);
  if (predicate(state)) return state;
  throw new Error(`${label} never happened: ${JSON.stringify({
    state,
    hit: await hitTarget(page, point),
    stages: await stages(page),
  })}`);
}

async function openDivePage(context, { blockStyle }) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  // The app reads its map style through its own origin, so the lane stubs that
  // one request rather than reaching a real provider. Blocking it instead is
  // how the unloadable-detail case is produced.
  await page.route(MAP_STYLE_PATTERN, (route) => (
    blockStyle
      ? route.abort("failed")
      : route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(EMPTY_STYLE),
      })
  ));
  await page.goto(qaUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 25_000 });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()), null, { timeout: 25_000 });
  await page.waitForTimeout(300);
  await installStageRecorder(page);
  return { page, consoleErrors, pageErrors };
}

const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
});

const result = { baseUrl, viewport: VIEWPORT, focus };

try {
  // ---------------------------------------------------------------- round A
  // Wheel alone, in both directions, with a detail surface that can load.
  const forward = await openDivePage(context, { blockStyle: false });
  const point = await gesturePoint(forward.page);

  const entered = await wheelUntil(
    forward.page,
    point,
    -120,
    (state) => state.stage === "blending",
    "the dive never reached blending on wheel zoom alone",
  );
  const blendingHit = await hitTarget(forward.page, point);

  // Park just short of the commit edge, quiescent, then cross it with one
  // small step so the handoff is measured across as little deliberate zoom as
  // possible.
  await forward.page.waitForTimeout(400);
  const beforeCommit = await readDive(forward.page);
  const blendingFrame = await frameAt(forward.page, "blending");
  await wheelAt(forward.page, point, COMMIT_WHEEL_DELTA);
  const committed = await wheelUntil(
    forward.page,
    point,
    COMMIT_WHEEL_DELTA,
    (state) => state.stage === "detail",
    "the dive never committed to detail on wheel zoom alone",
  );
  await forward.page.waitForTimeout(400);
  const detailFrame = await frameAt(forward.page, "detail");

  const forwardStages = await stages(forward.page);

  // Zoom out again at the SAME point. The map owns the wheel now and its layer
  // is the hit-test winner, so this is the reverse handoff through the owner
  // that actually has the camera.
  const detailHit = await hitTarget(forward.page, point);
  const released = await wheelUntil(
    forward.page,
    point,
    240,
    (state) => state.stage === "prewarm",
    "the detail surface never handed the camera back on wheel zoom-out",
  );
  const returned = await wheelUntil(
    forward.page,
    point,
    240,
    (state) => state.stage === "particle",
    "the dive never returned to the particle Earth on wheel zoom-out",
  );

  const stageLadder = await stages(forward.page);
  const anchorDeltaPx = blendingFrame && detailFrame
    ? Math.hypot(
      detailFrame.anchorX - blendingFrame.anchorX,
      detailFrame.anchorY - blendingFrame.anchorY,
    )
    : Number.NaN;
  // The deliberate zoom inside the sample interval scales the projection by
  // 2^(zoom change); what is left over is the handoff's own error.
  const zoomChange = blendingFrame && detailFrame
    ? detailFrame.mapZoom - blendingFrame.mapZoom
    : Number.NaN;
  const localScaleError = blendingFrame && detailFrame
    ? Math.abs((detailFrame.scale / blendingFrame.scale) / 2 ** zoomChange - 1)
    : Number.NaN;

  result.forward = {
    stageLadder,
    stagesToDetail: forwardStages,
    gesturePoint: point,
    hitTargets: { blending: blendingHit, detail: detailHit },
    entered: { stage: entered.stage, owner: entered.owner, semanticZoom: entered.semanticZoom },
    beforeCommit: {
      stage: beforeCommit.stage,
      owner: beforeCommit.owner,
      localProgress: beforeCommit.localProgress,
      readiness: beforeCommit.readiness,
    },
    committed: {
      stage: committed.stage,
      owner: committed.owner,
      earthMode: committed.earthMode,
      readiness: committed.readiness,
    },
    released: {
      stage: released.stage,
      owner: released.owner,
      semanticZoom: released.semanticZoom,
      mapZoom: released.mapZoom,
    },
    returned: {
      stage: returned.stage,
      owner: returned.owner,
      earthMode: returned.earthMode,
      semanticZoom: returned.semanticZoom,
    },
    handoff: {
      blendingFrame,
      detailFrame,
      anchorDeltaPx,
      anchorTolerancePx: ANCHOR_TOLERANCE_PX,
      mapZoomChange: zoomChange,
      localScaleError,
      localScaleTolerance: LOCAL_SCALE_TOLERANCE,
    },
    consoleErrors: forward.consoleErrors,
    pageErrors: forward.pageErrors,
  };

  const expectedLadder = ["particle", "prewarm", "blending", "detail", "blending", "prewarm", "particle"];
  const ladderFailures = [];
  if (JSON.stringify(stageLadder) !== JSON.stringify(expectedLadder)) {
    ladderFailures.push("stage ladder is not the ordered progression and its exact reverse");
  }
  if (entered.owner !== "particle" || beforeCommit.owner !== "particle") {
    ladderFailures.push("the particle Earth lost input ownership before the commit");
  }
  if (committed.owner !== "detail" || committed.earthMode !== "detail") {
    ladderFailures.push("ownership did not transfer on the commit edge");
  }
  if (released.owner !== "particle" || returned.owner !== "particle") {
    ladderFailures.push("ownership did not come home on the reverse handoff");
  }
  if (blendingHit && blendingHit.className && blendingHit.className.includes("detailed-earth-map")) {
    ladderFailures.push("the blending detail surface was already the hit-test owner");
  }
  if (!(anchorDeltaPx <= ANCHOR_TOLERANCE_PX)) {
    ladderFailures.push(`focused anchor moved ${anchorDeltaPx} CSS px across the handoff`);
  }
  if (!(localScaleError <= LOCAL_SCALE_TOLERANCE)) {
    ladderFailures.push(`local geographic scale moved ${localScaleError} across the handoff`);
  }
  if (forward.pageErrors.length > 0) {
    ladderFailures.push("the page raised an error during the dive");
  }
  await forward.page.close();

  // ---------------------------------------------------------------- round B
  // The same wheel gesture with the detail style unreachable. #252: the
  // particle Earth stays fully usable, nothing is revealed, and there is no
  // loading dialog.
  const blocked = await openDivePage(context, { blockStyle: true });
  const blockedPoint = await gesturePoint(blocked.page);
  await wheelUntil(
    blocked.page,
    blockedPoint,
    -120,
    (state) => state.stage === "prewarm",
    "the dive never prewarmed with the map style blocked",
  );
  const deep = await wheelUntil(
    blocked.page,
    blockedPoint,
    -120,
    (state) => state.semanticZoom === "local" && Number(state.localProgress) >= 0.95,
    "the particle Earth would not zoom into the local band with the map style blocked",
  );
  // Hold. No timeout may reveal an unready map, so the stage must still be
  // prewarm after far longer than any load would have taken.
  await blocked.page.waitForTimeout(4_000);
  const held = await readDive(blocked.page);
  const blockedStages = await stages(blocked.page);

  // The particle Earth is still answering the wheel and the drag.
  const beforeGesture = await readDive(blocked.page);
  await wheelAt(blocked.page, blockedPoint, 600);
  await blocked.page.waitForTimeout(250);
  const afterWheel = await readDive(blocked.page);
  await blocked.page.mouse.move(blockedPoint.x, blockedPoint.y);
  await blocked.page.mouse.down();
  await blocked.page.mouse.move(blockedPoint.x + 140, blockedPoint.y + 18, { steps: 8 });
  await blocked.page.mouse.up();
  await blocked.page.waitForTimeout(250);
  const afterDrag = await readDive(blocked.page);
  const chrome = await blocked.page.evaluate(() => ({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    statuses: document.querySelectorAll('[role="status"]').length,
    legacyTransitionStatus: document.querySelectorAll(".living-atlas-globe__transition-status").length,
    loading: document.querySelectorAll(".living-atlas-globe__loading").length,
  }));

  result.blocked = {
    gesturePoint: blockedPoint,
    hit: await hitTarget(blocked.page, blockedPoint),
    stages: blockedStages,
    deep: { stage: deep.stage, semanticZoom: deep.semanticZoom, localProgress: deep.localProgress },
    held: {
      stage: held.stage,
      owner: held.owner,
      earthMode: held.earthMode,
      readiness: held.readiness,
      interactive: held.interactive,
      mapError: held.mapError,
    },
    gestures: {
      beforeGesture: {
        zoom: beforeGesture.particleZoom,
        semanticZoom: beforeGesture.semanticZoom,
        rotationY: beforeGesture.particleRotationY,
      },
      afterWheel: {
        zoom: afterWheel.particleZoom,
        semanticZoom: afterWheel.semanticZoom,
        rotationY: afterWheel.particleRotationY,
      },
      afterDrag: {
        zoom: afterDrag.particleZoom,
        semanticZoom: afterDrag.semanticZoom,
        rotationY: afterDrag.particleRotationY,
      },
    },
    chrome,
    pageErrors: blocked.pageErrors,
  };

  const blockedFailures = [];
  if (held.stage !== "prewarm") {
    blockedFailures.push("an unreachable detail style did not hold the dive at prewarm");
  }
  if (held.owner !== "particle" || held.earthMode !== "particle") {
    blockedFailures.push("the particle Earth was not the input owner while the map was unreachable");
  }
  if (held.interactive !== "true") {
    blockedFailures.push("the particle host stopped being interactive");
  }
  // The recorder starts at `particle`, so a run that revealed nothing has
  // exactly one further entry.
  if (JSON.stringify(blockedStages) !== JSON.stringify(["particle", "prewarm"])) {
    blockedFailures.push("the dive moved past prewarm with the map style blocked");
  }
  // The wheel is a zoom, so it moves the published semantic zoom; a drag is a
  // rotation, so it moves the published rotation. Both have to still reach the
  // particle Earth while the detail surface is stuck warming.
  if (
    afterWheel.semanticZoom === beforeGesture.semanticZoom
    && afterWheel.particleZoom === beforeGesture.particleZoom
  ) {
    blockedFailures.push("the wheel no longer changed the particle camera");
  }
  if (afterDrag.particleRotationY === afterWheel.particleRotationY) {
    blockedFailures.push("the drag no longer rotated the particle Earth");
  }
  if (chrome.dialogs > 0 || chrome.statuses > 0 || chrome.legacyTransitionStatus > 0 || chrome.loading > 0) {
    blockedFailures.push("a loading dialog or status element was present");
  }
  if (blocked.pageErrors.length > 0) {
    blockedFailures.push("the page raised an error while the map style was blocked");
  }
  await blocked.page.close();

  result.failures = [...ladderFailures, ...blockedFailures];
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length > 0) {
    throw new Error(`Semantic Earth Dive QA failed: ${JSON.stringify(result.failures)}`);
  }
} finally {
  await context.close();
  await browser.close();
}
