// #193 route anchoring QA: measure the rendered route line against the
// rendered Route Point markers at 1x, 2x and 3x zoom, and check that the
// decorative arc attenuates and stays inside its screen ceiling instead of
// growing with magnification. Screenshots prove nothing here; numbers do.
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
// The reported US Southwest reproduction, framed on its own centre.
const routeId = "qa-route-southwest";
const focus = { lat: 36.1, lon: -116.4 };
const qaUrl = new URL(
  `/?qaState=journey-routes&qaQuality=high&qaFocusLat=${focus.lat}&qaFocusLon=${focus.lon}`,
  baseUrl,
).toString();
// A Route Point marker and the route line meeting it must stay within about
// 1-2 CSS px of each other at every supported zoom (#193 acceptance).
const ENDPOINT_TOLERANCE_PX = 1.5;

// #219 focus-signal framing. A separate page load that frames the focus point
// on a REAL Route Point of the same fixture - qa-p-17 "Las Vegas", index 2 of
// qa-route-southwest in src/main.tsx - so the focus signal the journey
// connector terminates on can be measured against the marker of the very Route
// Point it represents. The framing above is left alone on purpose.
const FOCUS_ROUTE_POINT_INDEX = 2;
const focusRoutePoint = { lat: 36.1699, lon: -115.1398 };
const focusQaUrl = new URL(
  `/?qaState=journey-routes&qaQuality=high&qaFocusLat=${focusRoutePoint.lat}&qaFocusLon=${focusRoutePoint.lon}`,
  baseUrl,
).toString();

// #242 short-leg framing. A synthetic evenly spaced chain of ~0.5 degree legs
// (qa-route-short-legs in src/main.tsx, generated from one origin and a
// constant step - no real itinerary is committed here), framed on its own
// centre and then rotated out to the limb. Short legs are where the retired
// sqrt lift policy stood tallest relative to the leg it decorated: about 1.18
// chord lengths at 1.9 degrees, drawn as two straight segments through one
// elevated midpoint, which is a literal triangular peak.
const shortLegRouteId = "qa-route-short-legs";
const shortLegFocus = { lat: 13.22, lon: 9.4 };
const shortLegQaUrl = new URL(
  `/?qaState=journey-routes&qaQuality=high&qaFocusLat=${shortLegFocus.lat}&qaFocusLon=${shortLegFocus.lon}`,
  baseUrl,
).toString();
// A drawn leg may not bulge more than this fraction of its own projected
// length away from the straight line between its endpoints. The retired policy
// produced 1.18 at 1.9 degrees, so this both fails that and leaves room for
// genuine sphere curvature and the 0.1px path quantisation.
const LEG_BULGE_FRACTION = 0.35;
const LEG_BULGE_FLOOR_PX = 1.5;

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

function debug(page) {
  return page.evaluate(() => window.__particleEarthDebug?.() ?? null);
}

async function setZoom(page, targetZoom) {
  const before = await debug(page);
  if (!before) throw new Error("Particle Earth debug state is unavailable");
  if (Math.abs(before.zoom - targetZoom) > 0.02) {
    const canvas = page.locator('canvas[data-three-scene="particle-earth"]');
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Particle Earth canvas has no bounds");
    await canvas.evaluate((node, init) => node.dispatchEvent(new WheelEvent("wheel", init)), {
      bubbles: true,
      cancelable: true,
      clientX: bounds.x + bounds.width / 2,
      clientY: bounds.y + bounds.height / 2,
      deltaY: -Math.log(targetZoom / before.zoom) / 0.0012,
    });
    await page.waitForTimeout(160);
  }
  const after = await debug(page);
  if (!after || Math.abs(after.zoom - targetZoom) > 0.03) {
    throw new Error(`Unable to set route QA zoom: ${JSON.stringify({ targetZoom, after })}`);
  }
  return after;
}

/**
 * #242: pointer gestures are dispatched onto the canvas directly. Coordinate
 * input hit-tests the topmost element and the scene sits under the route
 * overlay, so a coordinate drag rotates nothing at all and fails silently.
 * Pointer capture on a synthetic pointer breaks the gesture, so it is stubbed.
 */
function canvasOf(page) {
  return page.locator('canvas[data-three-scene="particle-earth"]');
}

async function beginDrag(page, origin) {
  await canvasOf(page).evaluate((node, start) => {
    node.setPointerCapture = () => undefined;
    node.hasPointerCapture = () => false;
    node.releasePointerCapture = () => undefined;
    node.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: start.x,
      clientY: start.y,
      isPrimary: true,
      pointerId: 71,
      pointerType: "mouse",
    }));
  }, origin);
}

async function dragTo(page, point) {
  await canvasOf(page).evaluate((node, position) => {
    node.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: position.x,
      clientY: position.y,
      isPrimary: true,
      pointerId: 71,
      pointerType: "mouse",
    }));
  }, point);
}

async function endDrag(page, point) {
  await canvasOf(page).evaluate((node, position) => {
    node.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      clientX: position.x,
      clientY: position.y,
      isPrimary: true,
      pointerId: 71,
      pointerType: "mouse",
    }));
  }, point);
}

/**
 * The scene writes its route paths inside requestAnimationFrame, so reading
 * the DOM straight after a pointermove returns the PREVIOUS frame - a sample
 * that compares perfectly while measuring nothing. Two frames deep because the
 * pointer handler and the path write land in different ones.
 */
function waitForRenderedFrame(page) {
  return page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  }));
}

/**
 * #242: grade the INTERIOR of every drawn leg, which is where the sawtooth
 * lives. Endpoint anchoring (#193) and geographic motion (#196) say nothing
 * about the shape between two Route Points.
 *
 * Per leg path: split it into fragments at every `M`, then for each fragment
 * measure how far its interior vertices bulge away from the straight line
 * between that fragment's own endpoints, relative to that line's length. A
 * two-segment leg lifted to 1.18 chord lengths reads as a bulge of 1.18; a
 * restrained, well-sampled curve reads as a small fraction.
 *
 * The same pass records the largest step WITHIN a fragment. A fragment is a
 * continuously visible span, so a step that suddenly covers a large part of
 * the globe would be two visible spans joined across hidden geometry.
 */
async function measureLegShape(page, routeIdentifier) {
  return page.evaluate((identifier) => {
    const group = document.querySelector(`[data-journey-route="${identifier}"]`);
    if (!group) return { error: "short-leg route group not rendered" };
    const host = document.querySelector(".particle-earth-scene");
    const legs = [...group.querySelectorAll(".particle-earth-route__leg")];
    if (legs.length === 0) return { error: "short-leg route drew no legs" };

    let worstBulge = null;
    let widestStepPx = 0;
    let drawnFragments = 0;
    let interiorVertices = 0;
    let minSegmentsPerFragment = Number.POSITIVE_INFINITY;

    legs.forEach((leg, legIndex) => {
      const d = leg.getAttribute("d") ?? "";
      const fragments = [];
      for (const command of d.match(/[ML]-?[\d.]+ -?[\d.]+/g) ?? []) {
        const [x, y] = command.slice(1).split(" ").map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (command.startsWith("M") || fragments.length === 0) fragments.push([]);
        fragments[fragments.length - 1].push({ x, y });
      }
      for (const fragment of fragments) {
        if (fragment.length < 2) continue;
        drawnFragments += 1;
        minSegmentsPerFragment = Math.min(
          minSegmentsPerFragment,
          fragment.length - 1,
        );
        for (let index = 1; index < fragment.length; index += 1) {
          widestStepPx = Math.max(widestStepPx, Math.hypot(
            fragment[index].x - fragment[index - 1].x,
            fragment[index].y - fragment[index - 1].y,
          ));
        }
        const first = fragment[0];
        const last = fragment[fragment.length - 1];
        const dx = last.x - first.x;
        const dy = last.y - first.y;
        const chordPx = Math.hypot(dx, dy);
        if (chordPx < 1) continue;
        let bulgePx = 0;
        for (let index = 1; index < fragment.length - 1; index += 1) {
          interiorVertices += 1;
          bulgePx = Math.max(bulgePx, Math.abs(
            ((fragment[index].x - first.x) * dy)
            - ((fragment[index].y - first.y) * dx),
          ) / chordPx);
        }
        const ratio = bulgePx / chordPx;
        if (!worstBulge || ratio > worstBulge.ratio) {
          worstBulge = { legIndex, ratio, bulgePx, chordPx };
        }
      }
    });

    return {
      legCount: legs.length,
      drawnFragments,
      interiorVertices,
      minSegmentsPerFragment: Number.isFinite(minSegmentsPerFragment)
        ? minSegmentsPerFragment
        : 0,
      widestStepPx,
      worstBulge,
      projectedGlobeRadiusPx: window.__particleEarthDebug?.().projectedGlobeRadiusPx ?? 0,
      arcLift: Number(host?.dataset.routeArcLift),
    };
  }, routeIdentifier);
}

/**
 * Read the rendered SVG and measure, per Route Point, the distance from the
 * marker anchor to the end of the route line that should meet it. Marker
 * anchors are cross-checked against the drawn graphic wherever the graphic
 * defines its own centre exactly (circle centre, star centroid).
 */
async function measureRoute(page, id) {
  return page.evaluate((routeIdentifier) => {
    const group = document.querySelector(`[data-journey-route="${routeIdentifier}"]`);
    if (!group) return { error: "route group not rendered" };

    const markers = new Map();
    let graphicMismatchPx = 0;
    let checkedGraphics = 0;
    for (const element of group.querySelectorAll(".particle-earth-route__point")) {
      if (element.style.display === "none") continue;
      const index = Number(element.dataset.routePointIndex);
      const anchor = {
        x: Number(element.dataset.anchorX),
        y: Number(element.dataset.anchorY),
      };
      if (!Number.isFinite(index) || !Number.isFinite(anchor.x)) continue;
      markers.set(index, anchor);
      if (element.tagName === "circle") {
        checkedGraphics += 1;
        graphicMismatchPx = Math.max(graphicMismatchPx, Math.hypot(
          Number(element.getAttribute("cx")) - anchor.x,
          Number(element.getAttribute("cy")) - anchor.y,
        ));
      } else if (element.tagName === "polygon") {
        // The star's vertices are two regular pentagons about its centre, so
        // their centroid is the centre the marker was drawn around.
        const pairs = element.getAttribute("points").trim().split(/\s+/)
          .map((pair) => pair.split(",").map(Number));
        const centroid = pairs.reduce(
          (sum, [x, y]) => ({ x: sum.x + x / pairs.length, y: sum.y + y / pairs.length }),
          { x: 0, y: 0 },
        );
        checkedGraphics += 1;
        graphicMismatchPx = Math.max(graphicMismatchPx, Math.hypot(
          centroid.x - anchor.x,
          centroid.y - anchor.y,
        ));
      }
    }

    const readCommand = (command) => {
      const values = command.slice(1).trim().split(/[ ,]+/).map(Number);
      return values.length >= 2 && values.every(Number.isFinite)
        ? { x: values[0], y: values[1] }
        : null;
    };
    const measurements = [];
    const legs = [...group.querySelectorAll(".particle-earth-route__leg")];
    legs.forEach((leg, legIndex) => {
      const d = leg.getAttribute("d") ?? "";
      const commands = d.match(/[ML][^ML]*/g);
      if (!commands || commands.length < 2) return;
      const first = readCommand(commands[0]);
      const last = readCommand(commands[commands.length - 1]);
      for (const [pointIndex, projected] of [
        [legIndex, first],
        [legIndex + 1, last],
      ]) {
        const marker = markers.get(pointIndex);
        if (!marker || !projected) continue;
        measurements.push({
          pointIndex,
          distancePx: Math.hypot(projected.x - marker.x, projected.y - marker.y),
        });
      }
    });

    const host = document.querySelector(".particle-earth-scene");
    return {
      legCount: legs.length,
      markerCount: markers.size,
      checkedGraphics,
      graphicMismatchPx,
      measurements,
      maxDistancePx: measurements.reduce(
        (largest, entry) => Math.max(largest, entry.distancePx),
        0,
      ),
      arcProfile: host?.dataset.routeArcProfile ?? null,
      arcLift: Number(host?.dataset.routeArcLift),
      arcLiftPx: Number(host?.dataset.routeArcLiftPx),
      arcLiftCapPx: Number(host?.dataset.routeArcLiftCapPx),
      sceneEndpointMaxErrorPx: Number(host?.dataset.routeEndpointMaxErrorPx),
    };
  }, id);
}

/**
 * #219: the focus signal and the Route Point marker are two renderings of ONE
 * geographic object, so read both projections back and return their distance.
 * data-personal-point-* is the focus signal the journey connector reads;
 * data-anchor-* is the canonical anchor the marker graphic was drawn around.
 */
async function measureFocusSignal(page, routeIdentifier, pointIndex) {
  return page.evaluate(([identifier, index]) => {
    const host = document.querySelector(".particle-earth-scene");
    const personal = {
      x: Number(host?.dataset.personalPointX),
      y: Number(host?.dataset.personalPointY),
    };
    if (!Number.isFinite(personal.x) || !Number.isFinite(personal.y)) {
      return { error: "the focus signal published no data-personal-point-x/y" };
    }
    const group = document.querySelector(`[data-journey-route="${identifier}"]`);
    if (!group) return { error: "route group not rendered" };
    const marker = [...group.querySelectorAll(".particle-earth-route__point")]
      .find((element) => Number(element.dataset.routePointIndex) === index);
    if (!marker) return { error: `Route Point ${index} rendered no marker` };
    if (marker.style.display === "none") {
      return { error: `Route Point ${index} marker is hidden, nothing to measure` };
    }
    const anchor = {
      x: Number(marker.dataset.anchorX),
      y: Number(marker.dataset.anchorY),
    };
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
      return { error: `Route Point ${index} marker carries no anchor` };
    }
    return {
      personal,
      anchor,
      deltaPx: Math.hypot(personal.x - anchor.x, personal.y - anchor.y),
    };
  }, [routeIdentifier, pointIndex]);
}

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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

const failures = [];

try {
  await page.goto(qaUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await page.waitForFunction((identifier) => Boolean(
    document.querySelector(`[data-journey-route="${identifier}"] .particle-earth-route__leg`),
  ), routeId, { timeout: 30_000 });
  await page.waitForTimeout(400);

  const samples = [];
  for (const zoom of [1, 2, 3]) {
    const state = await setZoom(page, zoom);
    await page.waitForTimeout(220);
    const measured = await measureRoute(page, routeId);
    if (measured.error) throw new Error(measured.error);
    samples.push({ requestedZoom: zoom, zoom: state.zoom, ...measured });
  }

  for (const sample of samples) {
    console.log([
      `[qa-route-anchoring] zoom=${sample.zoom.toFixed(3)}`,
      `endpointMaxErrorPx=${sample.maxDistancePx.toFixed(3)}`,
      `measuredEndpoints=${sample.measurements.length}`,
      `markers=${sample.markerCount}`,
      `legs=${sample.legCount}`,
      `graphicMismatchPx=${sample.graphicMismatchPx.toFixed(3)} (${sample.checkedGraphics} graphics)`,
      `arcProfile=${sample.arcProfile}`,
      `arcLift=${sample.arcLift.toFixed(4)}`,
      `arcLiftPx=${sample.arcLiftPx.toFixed(2)}/${sample.arcLiftCapPx.toFixed(2)}`,
      `sceneEndpointMaxErrorPx=${sample.sceneEndpointMaxErrorPx.toFixed(3)}`,
    ].join(" "));
  }

  for (const sample of samples) {
    if (sample.measurements.length < 4) {
      failures.push(`zoom ${sample.zoom.toFixed(2)}: only ${sample.measurements.length} endpoints measured`);
    }
    if (!(sample.maxDistancePx <= ENDPOINT_TOLERANCE_PX)) {
      failures.push(`zoom ${sample.zoom.toFixed(2)}: endpoint error ${sample.maxDistancePx.toFixed(2)}px exceeds ${ENDPOINT_TOLERANCE_PX}px`);
    }
    // The graphic writes its centre at 0.1px precision, the anchor at 0.01px.
    if (!(sample.graphicMismatchPx <= 0.08)) {
      failures.push(`zoom ${sample.zoom.toFixed(2)}: marker graphic is ${sample.graphicMismatchPx.toFixed(3)}px off its own anchor`);
    }
    if (!(sample.arcLiftPx <= sample.arcLiftCapPx + 0.01)) {
      failures.push(`zoom ${sample.zoom.toFixed(2)}: arc lift ${sample.arcLiftPx.toFixed(1)}px exceeds the ${sample.arcLiftCapPx.toFixed(1)}px screen ceiling`);
    }
  }
  // Semantic zoom: closer must mean more geographic, never more theatrical.
  if (!(samples[1].arcLift < samples[0].arcLift)) {
    failures.push(`arc lift did not attenuate from 1x (${samples[0].arcLift}) to 2x (${samples[1].arcLift})`);
  }
  if (!(samples[2].arcLift < samples[1].arcLift)) {
    failures.push(`arc lift did not attenuate from 2x (${samples[1].arcLift}) to 3x (${samples[2].arcLift})`);
  }
  if (!(samples[2].arcLiftPx <= samples[0].arcLiftPx)) {
    failures.push(`projected arc altitude grew with zoom: ${samples[0].arcLiftPx}px -> ${samples[2].arcLiftPx}px`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    failures.push(`page errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
  }

  if (failures.length > 0) {
    throw new Error(`[qa-route-anchoring] ${failures.join("; ")}`);
  }

  // #219: same page (the console and pageerror listeners keep accumulating),
  // new framing - the focus point now sits on a Route Point of the fixture.
  await page.goto(focusQaUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await page.waitForFunction((identifier) => Boolean(
    document.querySelector(`[data-journey-route="${identifier}"] .particle-earth-route__leg`),
  ), routeId, { timeout: 30_000 });
  await page.waitForFunction(() => Number.isFinite(
    Number(document.querySelector(".particle-earth-scene")?.dataset.personalPointX),
  ), null, { timeout: 30_000 });
  await page.waitForTimeout(400);

  const focusSamples = [];
  for (const zoom of [1, 2, 3]) {
    const state = await setZoom(page, zoom);
    await page.waitForTimeout(220);
    const measured = await measureFocusSignal(page, routeId, FOCUS_ROUTE_POINT_INDEX);
    if (measured.error) {
      throw new Error(`[qa-route-anchoring] focus signal: ${measured.error}`);
    }
    focusSamples.push({ zoom: state.zoom, ...measured });
  }

  for (const sample of focusSamples) {
    console.log([
      `[qa-route-anchoring] focus zoom=${sample.zoom.toFixed(3)}`,
      `routePointIndex=${FOCUS_ROUTE_POINT_INDEX}`,
      `focusSignal=(${sample.personal.x.toFixed(2)}, ${sample.personal.y.toFixed(2)})`,
      `markerAnchor=(${sample.anchor.x.toFixed(2)}, ${sample.anchor.y.toFixed(2)})`,
      `focusSignalToMarkerPx=${sample.deltaPx.toFixed(3)}`,
    ].join(" "));
  }

  for (const sample of focusSamples) {
    if (!(sample.deltaPx <= ENDPOINT_TOLERANCE_PX)) {
      failures.push(`focus zoom ${sample.zoom.toFixed(2)}: the focus signal is ${sample.deltaPx.toFixed(2)}px from the Route Point marker it represents, over ${ENDPOINT_TOLERANCE_PX}px`);
    }
  }

  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    failures.push(`page errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
  }
  if (failures.length > 0) {
    throw new Error(`[qa-route-anchoring] ${failures.join("; ")}`);
  }
  // #242: the reported symptom is a shape defect that appears as a Journey
  // rotates toward the limb, at overview scale rather than max zoom only. Same
  // page, new framing on the synthetic short-leg chain.
  await page.goto(shortLegQaUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await page.waitForFunction((identifier) => Boolean(
    document.querySelector(`[data-journey-route="${identifier}"] .particle-earth-route__leg`),
  ), shortLegRouteId, { timeout: 30_000 });
  await page.waitForTimeout(400);

  const shortLegSamples = [];
  for (const zoom of [1, 2, 3]) {
    const state = await setZoom(page, zoom);
    await page.waitForTimeout(220);
    const origin = { x: 640, y: 400 };
    // A CONTINUOUS drag from globe centre out toward the limb: the pointer
    // goes down once and every intermediate frame is graded, because the
    // symptom is what the route does WHILE it rotates, not where it ends.
    await beginDrag(page, origin);
    const settled = await debug(page);
    const steps = 12;
    const stepPx = Math.max(
      18,
      (state.projectedGlobeRadiusPx * 0.85) / steps,
    );
    for (let step = 1; step <= steps; step += 1) {
      await dragTo(page, { x: origin.x + (stepPx * step), y: origin.y });
      await waitForRenderedFrame(page);
      const measured = await measureLegShape(page, shortLegRouteId);
      if (measured.error) throw new Error(`[qa-route-anchoring] ${measured.error}`);
      shortLegSamples.push({ zoom: state.zoom, step, ...measured });
    }
    const dragged = await debug(page);
    await endDrag(page, { x: origin.x + (stepPx * steps), y: origin.y });
    await page.waitForTimeout(220);
    const rotated = Math.abs(dragged.rotationY - settled.rotationY);
    // A drag that silently rotated nothing would make every reading above a
    // measurement of the same unrotated frame.
    if (!(rotated > 0.05)) {
      failures.push(`short-leg zoom ${state.zoom.toFixed(2)}: dragging ${(stepPx * steps).toFixed(0)}px rotated the globe by ${rotated.toFixed(4)} rad - the gesture never reached the canvas`);
    }
    // Rotation is cumulative, so the next zoom starts from where this left off;
    // reload to bring the chain back to the centre of the view.
    if (zoom !== 3) {
      await page.goto(shortLegQaUrl, { waitUntil: "domcontentloaded" });
      await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
      await page.waitForFunction((identifier) => Boolean(
        document.querySelector(`[data-journey-route="${identifier}"] .particle-earth-route__leg`),
      ), shortLegRouteId, { timeout: 30_000 });
      await page.waitForTimeout(400);
    }
  }

  const graded = shortLegSamples.filter((sample) => sample.worstBulge);
  const worstSample = graded.reduce(
    (worst, sample) => (!worst || sample.worstBulge.ratio > worst.worstBulge.ratio)
      ? sample
      : worst,
    null,
  );
  const widestStep = shortLegSamples.reduce(
    (worst, sample) => Math.max(worst, sample.widestStepPx),
    0,
  );
  const leastSegments = shortLegSamples.reduce(
    (fewest, sample) => Math.min(fewest, sample.minSegmentsPerFragment || Infinity),
    Infinity,
  );
  console.log([
    "[qa-route-anchoring] short-leg rotation to limb",
    `gradedFrames=${graded.length}/${shortLegSamples.length}`,
    `legs=${shortLegSamples[0]?.legCount ?? 0}`,
    `interiorVertices=${shortLegSamples[0]?.interiorVertices ?? 0}`,
    `minSegmentsPerFragment=${Number.isFinite(leastSegments) ? leastSegments : "n/a"}`,
    `worstBulgeRatio=${worstSample ? worstSample.worstBulge.ratio.toFixed(4) : "n/a"}`,
    `worstBulgePx=${worstSample ? worstSample.worstBulge.bulgePx.toFixed(3) : "n/a"}`,
    `overLegPx=${worstSample ? worstSample.worstBulge.chordPx.toFixed(2) : "n/a"}`,
    `atZoom=${worstSample ? worstSample.zoom.toFixed(2) : "n/a"}`,
    `widestStepPx=${widestStep.toFixed(2)}`,
    `globeRadiusPx=${(shortLegSamples.at(-1)?.projectedGlobeRadiusPx ?? 0).toFixed(1)}`,
  ].join(" "));

  if (graded.length < 12) {
    failures.push(`short-leg rotation graded only ${graded.length} frames of ${shortLegSamples.length} - the chain was never drawn while rotating`);
  }
  // Every drawn leg is a restrained trace, not a raised tooth.
  for (const sample of graded) {
    const { worstBulge } = sample;
    const allowance = LEG_BULGE_FRACTION + (LEG_BULGE_FLOOR_PX / worstBulge.chordPx);
    if (!(worstBulge.ratio <= allowance)) {
      failures.push(`short-leg zoom ${sample.zoom.toFixed(2)} step ${sample.step}: leg ${worstBulge.legIndex} bulges ${worstBulge.bulgePx.toFixed(2)}px over its own ${worstBulge.chordPx.toFixed(2)}px length (ratio ${worstBulge.ratio.toFixed(3)}, allowed ${allowance.toFixed(3)}) - a raised tooth, not a route`);
      break;
    }
  }
  // A lifted leg is never one or two straight segments through a peak.
  if (!(leastSegments >= 2)) {
    failures.push(`short-leg rotation drew a fragment of ${leastSegments} segments`);
  }
  // No visible fragment is joined across an occluded span.
  for (const sample of shortLegSamples) {
    const bridgeLimitPx = Math.max(24, sample.projectedGlobeRadiusPx * 0.25);
    if (!(sample.widestStepPx <= bridgeLimitPx)) {
      failures.push(`short-leg zoom ${sample.zoom.toFixed(2)} step ${sample.step}: one drawn step covers ${sample.widestStepPx.toFixed(1)}px against a ${bridgeLimitPx.toFixed(1)}px limit - a fragment was joined across hidden geometry`);
      break;
    }
  }

  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    failures.push(`page errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
  }
  if (failures.length > 0) {
    throw new Error(`[qa-route-anchoring] ${failures.join("; ")}`);
  }
  console.log("[qa-route-anchoring] route endpoints stay anchored, the arc attenuates with zoom, and short legs stay restrained out to the limb");
} finally {
  await context.close();
  await browser.close();
}
