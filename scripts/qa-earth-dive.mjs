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
// The second one is a measurement, and it has to compare the TWO RENDERERS -
// not one renderer against itself. Both publish the two screen-space
// quantities #252 section 2 asks for, in the same unit and the same frame of
// reference: where the focused anchor lands in viewport CSS pixels, and how
// many of those pixels a degree of LATITUDE spans there. The particle Earth
// reads them from the shared projection frame its place labels use; the detail
// map reads them from MapLibre's own `project`. Latitude is deliberate: a
// degree of longitude shrinks with latitude, so a north-south probe measures
// how large the world is drawn rather than where the anchor sits on it.
//
// Comparing the map to the map would report a perfect handoff even if the
// particle Earth were visibly a different scale at the ownership edge, which is
// exactly the mistake this lane exists to make impossible.
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
// The anchor this lane measures is a Route Point of a Journey the fixture
// mounts - the thing #252 says must not move - not an arbitrary coordinate.
// The fixture publishes which one it focused, and the lane checks that the
// place both renderers are holding is that Route Point's own position.
const qaUrl = (focus) => new URL(
  `/?qaState=earth-dive${focus === "route" ? "&qaFocus=route" : ""}`,
  baseUrl,
).toString();

// The stated tolerances for the handoff, matching #252's measurement goals.
const ANCHOR_TOLERANCE_PX = 2;
const LOCAL_SCALE_TOLERANCE = 0.03;
// Wheel deltas. The approach is coarse because the particle band is wide, but
// the blend band is only a third of `local` and one coarse notch can cross the
// whole of it - so the last part of the descent, and the commit itself, use a
// step small enough to park inside the band and to keep the deliberate zoom
// inside the measurement interval small.
const APPROACH_WHEEL_DELTA = -120;
const FINE_WHEEL_DELTA = -10;
const RETREAT_WHEEL_DELTA = 240;
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
 * Where to put a real wheel so it reaches whichever surface currently owns the
 * gestures. Every wheel in this lane is a REAL wheel, so the receiving surface
 * is decided by hit testing rather than by the lane - the ownership contract is
 * graded rather than assumed.
 *
 * The point cannot simply be the canvas centre: the globe draws its place
 * labels as DOM text above the canvas, and a wheel over one of those never
 * reaches the canvas listener at all. So the point is re-resolved before every
 * step by walking outwards from the centre until hit testing lands on a
 * surface that steers - the particle canvas, or the detail map once it owns the
 * view. A label that drifts under the cursor mid-gesture therefore costs one
 * step rather than the run.
 */
async function gesturePoint(page, fallback = null) {
  const resolved = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const steers = (element) => Boolean(
      element === canvas
      || (element instanceof Element && element.closest(".detailed-earth-map")),
    );
    for (let radius = 0; radius <= 200; radius += 20) {
      for (let arm = 0; arm < 8; arm += 1) {
        const angle = (arm * Math.PI) / 4;
        const x = centre.x + Math.cos(angle) * radius;
        const y = centre.y + Math.sin(angle) * radius;
        if (x < 8 || y < 8 || x > window.innerWidth - 8 || y > window.innerHeight - 8) continue;
        const hit = document.elementFromPoint(x, y);
        if (!steers(hit)) continue;
        return {
          x,
          y,
          hit: { tag: hit.tagName, className: hit.getAttribute("class") },
        };
      }
    }
    return null;
  });
  if (resolved) return resolved;
  if (fallback) return fallback;
  throw new Error("no point on the globe reaches a surface that steers");
}

async function wheelAt(page, point, deltaY) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, deltaY);
}

/** The Route Point the fixture focused, straight from its own published marker. */
async function readRoutePoint(page) {
  return page.evaluate(() => {
    const marker = document.querySelector("[data-qa-earth-dive-route-point]");
    if (!marker) return null;
    return {
      id: marker.dataset.routePointId ?? null,
      lat: Number(marker.dataset.routePointLat),
      lon: Number(marker.dataset.routePointLon),
      focusShape: document.querySelector(".living-atlas")?.dataset?.qaEarthDiveFocus ?? null,
    };
  });
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
      particleRotationX: window.__particleEarthDebug?.().rotationX ?? null,
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

async function wheelUntil(page, point, deltaY, predicate, label, maxSteps = 90) {
  let target = point;
  for (let step = 0; step <= maxSteps; step += 1) {
    const state = await readDive(page);
    // The predicate reads the recorded ladder as well as the live state,
    // because a stage the wheel passed through between two polls is a real
    // published stage and the recorder saw it even when a poll did not.
    if (predicate(state, await stages(page))) return state;
    if (step === maxSteps) break;
    target = await gesturePoint(page, target);
    await wheelAt(page, target, deltaY);
    await page.waitForTimeout(100);
  }
  throw new Error(`${label} never happened: ${JSON.stringify({
    state: await readDive(page),
    hit: await hitTarget(page, point),
    stages: await stages(page),
  })}`);
}

/**
 * What each renderer is publishing right now, plus the error between them.
 * Both anchors are viewport CSS pixels and both scales are viewport CSS pixels
 * per degree of latitude, so the comparison is dimensionally honest.
 */
async function readFrames(page) {
  return page.evaluate(() => {
    const read = (value) => (value === undefined ? null : Number(value));
    const scene = document.querySelector(".particle-earth-scene");
    const map = document.querySelector(".detailed-earth-map");
    const particle = scene
      ? {
        anchorX: read(scene.dataset.focusAnchorViewportX),
        anchorY: read(scene.dataset.focusAnchorViewportY),
        scale: read(scene.dataset.focusAnchorScale),
      }
      : null;
    const detail = map
      ? {
        anchorX: read(map.dataset.handoffAnchorX),
        anchorY: read(map.dataset.handoffAnchorY),
        scale: read(map.dataset.handoffScale),
        mapZoom: read(map.dataset.handoffZoom),
      }
      : null;
    const comparable = Boolean(
      particle && detail
      && Number.isFinite(particle.anchorX) && Number.isFinite(detail.anchorX)
      && particle.scale > 0 && detail.scale > 0,
    );
    return {
      particle,
      detail,
      anchorDeltaPx: comparable
        ? Math.hypot(particle.anchorX - detail.anchorX, particle.anchorY - detail.anchorY)
        : null,
      localScaleError: comparable ? Math.abs(detail.scale / particle.scale - 1) : null,
    };
  });
}

async function openDivePage(context, { blockStyle, focusShape = "route-point" }) {
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
  await page.goto(qaUrl(focusShape), { waitUntil: "domcontentloaded" });
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

const result = { baseUrl, viewport: VIEWPORT };

try {
  // ---------------------------------------------------------------- round A
  // Wheel alone, in both directions, with a detail surface that can load.
  const forward = await openDivePage(context, { blockStyle: false });
  const routePoint = await readRoutePoint(forward.page);
  const point = await gesturePoint(forward.page);

  // Approach coarsely to the door of the `local` band, then descend in small
  // steps so the run parks INSIDE the blend band instead of crossing it whole.
  await wheelUntil(
    forward.page,
    point,
    APPROACH_WHEEL_DELTA,
    (state) => state.semanticZoom === "local",
    "the particle Earth never reached the local band on wheel zoom alone",
  );
  const entered = await wheelUntil(
    forward.page,
    point,
    FINE_WHEEL_DELTA,
    (state) => state.stage === "blending",
    "the dive never reached blending on wheel zoom alone",
  );
  const blendingHit = await hitTarget(forward.page, point);

  // Park just short of the commit edge, quiescent, then cross it with one
  // small step so the handoff is measured across as little deliberate zoom as
  // possible.
  await forward.page.waitForTimeout(500);
  const beforeCommit = await readDive(forward.page);
  const blendingFrames = await readFrames(forward.page);
  const committed = await wheelUntil(
    forward.page,
    point,
    FINE_WHEEL_DELTA,
    (state) => state.stage === "detail",
    "the dive never committed to detail on wheel zoom alone",
  );
  await forward.page.waitForTimeout(500);
  const detailFrames = await readFrames(forward.page);

  const forwardStages = await stages(forward.page);

  // Zoom out again at the SAME point. The map owns the wheel now and its layer
  // is the hit-test winner, so this is the reverse handoff through the owner
  // that actually has the camera.
  const detailHit = await hitTarget(forward.page, point);
  const released = await wheelUntil(
    forward.page,
    point,
    RETREAT_WHEEL_DELTA,
    (state) => state.stage === "prewarm",
    "the detail surface never handed the camera back on wheel zoom-out",
  );
  const returned = await wheelUntil(
    forward.page,
    point,
    RETREAT_WHEEL_DELTA,
    (state) => state.stage === "particle",
    "the dive never returned to the particle Earth on wheel zoom-out",
  );

  const stageLadder = await stages(forward.page);
  // The two renderers, at the last frame before ownership moved and at the
  // first frame after. Both edges are graded: a surface that only agrees once
  // it owns the view still moved the place the user was looking at.
  const worstAnchorDeltaPx = Math.max(
    blendingFrames.anchorDeltaPx ?? Number.NaN,
    detailFrames.anchorDeltaPx ?? Number.NaN,
  );
  const worstLocalScaleError = Math.max(
    blendingFrames.localScaleError ?? Number.NaN,
    detailFrames.localScaleError ?? Number.NaN,
  );
  // The map's own continuity across the commit, kept as a second, weaker fact:
  // the frame must not jump as ownership transfers. The deliberate zoom inside
  // the interval scales the projection by 2^(zoom change), so it is divided out.
  const mapZoomChange = (detailFrames.detail?.mapZoom ?? Number.NaN)
    - (blendingFrames.detail?.mapZoom ?? Number.NaN);
  const mapSelfContinuityError = Math.abs(
    ((detailFrames.detail?.scale ?? Number.NaN) / (blendingFrames.detail?.scale ?? Number.NaN))
    / 2 ** mapZoomChange - 1,
  );

  result.forward = {
    stageLadder,
    stagesToDetail: forwardStages,
    routePoint,
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
      atBlending: blendingFrames,
      atDetail: detailFrames,
      worstAnchorDeltaPx,
      anchorTolerancePx: ANCHOR_TOLERANCE_PX,
      worstLocalScaleError,
      localScaleTolerance: LOCAL_SCALE_TOLERANCE,
      mapZoomChange,
      mapSelfContinuityError,
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
  if (routePoint?.focusShape !== "route-point" || !Number.isFinite(routePoint?.lat)) {
    ladderFailures.push(`the fixture did not focus a Route Point: ${JSON.stringify(routePoint)}`);
  }
  if (!(worstAnchorDeltaPx <= ANCHOR_TOLERANCE_PX)) {
    ladderFailures.push(`the two renderers put the focused anchor ${worstAnchorDeltaPx} CSS px apart`);
  }
  if (!(worstLocalScaleError <= LOCAL_SCALE_TOLERANCE)) {
    ladderFailures.push(`the two renderers disagree on local scale by ${worstLocalScaleError}`);
  }
  if (!(mapSelfContinuityError <= LOCAL_SCALE_TOLERANCE)) {
    ladderFailures.push(`the detail frame jumped by ${mapSelfContinuityError} as ownership transferred`);
  }
  if (forward.pageErrors.length > 0) {
    ladderFailures.push("the page raised an error during the dive");
  }
  await forward.page.close();

  // ---------------------------------------------------------------- round B
  // The same handoff for a focused JOURNEY, which publishes no focus point at
  // all: its anchor is the route frame's own centre. Without this round the
  // whole route branch could hand over uncalibrated and nothing would notice.
  const routeRun = await openDivePage(context, { blockStyle: false, focusShape: "route" });
  const routeRunPoint = await gesturePoint(routeRun.page);
  await wheelUntil(
    routeRun.page,
    routeRunPoint,
    APPROACH_WHEEL_DELTA,
    (state) => state.semanticZoom === "local",
    "the particle Earth never reached the local band with a focused Journey",
  );
  const routeBlending = await wheelUntil(
    routeRun.page,
    routeRunPoint,
    FINE_WHEEL_DELTA,
    (state) => state.stage === "blending",
    "the dive never reached blending with a focused Journey",
  );
  await routeRun.page.waitForTimeout(500);
  const routeFrames = await readFrames(routeRun.page);
  result.routeFocus = {
    focusShape: (await readRoutePoint(routeRun.page))?.focusShape ?? null,
    stage: routeBlending.stage,
    owner: routeBlending.owner,
    frames: routeFrames,
    pageErrors: routeRun.pageErrors,
  };
  const routeFailures = [];
  if (!(routeFrames.anchorDeltaPx <= ANCHOR_TOLERANCE_PX)) {
    routeFailures.push(`with a focused Journey the two renderers put the anchor ${routeFrames.anchorDeltaPx} CSS px apart`);
  }
  if (!(routeFrames.localScaleError <= LOCAL_SCALE_TOLERANCE)) {
    routeFailures.push(`with a focused Journey the two renderers disagree on local scale by ${routeFrames.localScaleError}`);
  }
  if (routeRun.pageErrors.length > 0) {
    routeFailures.push("the page raised an error during the focused-Journey dive");
  }
  await routeRun.page.close();

  // ---------------------------------------------------------------- round C
  // The same wheel gesture with the detail style unreachable. #252: the
  // particle Earth stays fully usable, nothing is revealed, and there is no
  // loading dialog.
  const blocked = await openDivePage(context, { blockStyle: true });
  const blockedPoint = await gesturePoint(blocked.page);
  await wheelUntil(
    blocked.page,
    blockedPoint,
    APPROACH_WHEEL_DELTA,
    (state) => state.stage === "prewarm",
    "the dive never prewarmed with the map style blocked",
  );
  const deep = await wheelUntil(
    blocked.page,
    blockedPoint,
    APPROACH_WHEEL_DELTA,
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
  await wheelAt(blocked.page, await gesturePoint(blocked.page, blockedPoint), RETREAT_WHEEL_DELTA);
  await blocked.page.waitForTimeout(250);
  const afterWheel = await readDive(blocked.page);
  // Re-resolve first: a place label that drifted under the cursor would take
  // the pointerdown for a pick and the globe would never rotate.
  const dragPoint = await gesturePoint(blocked.page, blockedPoint);
  await blocked.page.mouse.move(dragPoint.x, dragPoint.y);
  await blocked.page.mouse.down();
  await blocked.page.mouse.move(dragPoint.x + 56, dragPoint.y + 30, { steps: 5 });
  await blocked.page.mouse.up();
  await blocked.page.waitForTimeout(400);
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
        rotationX: afterDrag.particleRotationX,
        rotationY: afterDrag.particleRotationY,
        point: dragPoint,
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
  const rotated = Math.abs(afterDrag.particleRotationY - afterWheel.particleRotationY) > 0.01
    || Math.abs(afterDrag.particleRotationX - afterWheel.particleRotationX) > 0.01;
  if (!rotated) {
    blockedFailures.push("the drag no longer rotated the particle Earth");
  }
  if (chrome.dialogs > 0 || chrome.statuses > 0 || chrome.legacyTransitionStatus > 0 || chrome.loading > 0) {
    blockedFailures.push("a loading dialog or status element was present");
  }
  if (blocked.pageErrors.length > 0) {
    blockedFailures.push("the page raised an error while the map style was blocked");
  }
  await blocked.page.close();

  result.failures = [...ladderFailures, ...routeFailures, ...blockedFailures];
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length > 0) {
    throw new Error(`Semantic Earth Dive QA failed: ${JSON.stringify(result.failures)}`);
  }
} finally {
  await context.close();
  await browser.close();
}
