// #193 route anchoring QA: measure the rendered route line against the
// rendered Route Point markers at 1x, 2x and 3x zoom, and check that the
// decorative arc attenuates and stays inside its screen ceiling instead of
// growing with magnification. Screenshots prove nothing here; numbers do.
import { launchQaBrowser } from "./qa-browser.mjs";
import { setParticleZoom } from "./qa-particle-zoom.mjs";

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
// qa-route-southwest in src/preview/qaEntry.tsx - so the focus signal the journey
// connector terminates on can be measured against the marker of the very Route
// Point it represents. The framing above is left alone on purpose.
const FOCUS_ROUTE_POINT_INDEX = 2;
const focusRoutePoint = { lat: 36.1699, lon: -115.1398 };
const focusQaUrl = new URL(
  `/?qaState=journey-routes&qaQuality=high&qaFocusLat=${focusRoutePoint.lat}&qaFocusLon=${focusRoutePoint.lon}`,
  baseUrl,
).toString();

// #242 short-leg framing. A synthetic evenly spaced chain of ~0.5 degree legs
// (qa-route-short-legs in src/preview/qaEntry.tsx, generated from one origin and a
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

// #478 mixed-leg regression. This fixture is intentionally separate from the
// #193 route above so the existing optics/focus assertions keep their pinned
// identities while the whisker check can use LA → Vegas → Kingman → Page →
// Grand Canyon exactly.
const whiskerRouteId = "qa-route-southwest-whisker";
const whiskerFocus = { lat: 35.75, lon: -114.15 };
const whiskerQaUrl = new URL(
  `/?qaState=journey-routes&qaQuality=high&qaFocusLat=${whiskerFocus.lat}&qaFocusLon=${whiskerFocus.lon}`,
  baseUrl,
).toString();
const ANCHOR_HALF_PLANE_TOLERANCE_PX = 0.35;

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

function debug(page) {
  return page.evaluate(() => window.__particleEarthDebug?.() ?? null);
}

function setZoom(page, targetZoom) {
  return setParticleZoom(page, targetZoom);
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
 * Route paths and Route Point markers are published by the scene projection
 * frame, not by wall-clock delay. A visible-marker count alone can still read
 * the PREVIOUS zoom's anchors, so every real zoom change must publish a new
 * finite endpoint signature before measurement. A genuine projection failure
 * still times out instead of being accepted.
 */
function routeEndpointProjection(page, routeIdentifier) {
  return page.evaluate((identifier) => {
    const group = document.querySelector(`[data-journey-route="${identifier}"]`);
    if (!group) return null;
    const visibleMarkers = [...group.querySelectorAll(".particle-earth-route__point")]
      .filter((element) => (
        element.style.display !== "none"
        && Number.isFinite(Number(element.dataset.anchorX))
        && Number.isFinite(Number(element.dataset.anchorY))
      ))
      .sort((left, right) => Number(left.dataset.routePointIndex) - Number(right.dataset.routePointIndex));
    if (visibleMarkers.length < 4) return null;
    return visibleMarkers.map((element) => [
      element.dataset.routePointIndex,
      element.dataset.anchorX,
      element.dataset.anchorY,
    ].join(":"))
      .join("|");
  }, routeIdentifier);
}

function waitForRouteEndpoints(page, routeIdentifier, expectedZoom, previousProjection = null) {
  return page.waitForFunction(({ identifier, expectedZoom, previousProjection }) => {
    const state = window.__particleEarthDebug?.();
    if (!state || Math.abs(state.zoom - expectedZoom) > 0.03) return false;
    const group = document.querySelector(`[data-journey-route="${identifier}"]`);
    if (!group) return false;
    const visibleMarkers = [...group.querySelectorAll(".particle-earth-route__point")]
      .filter((element) => (
        element.style.display !== "none"
        && Number.isFinite(Number(element.dataset.anchorX))
        && Number.isFinite(Number(element.dataset.anchorY))
      ))
      .sort((left, right) => Number(left.dataset.routePointIndex) - Number(right.dataset.routePointIndex));
    if (visibleMarkers.length < 4) return false;
    const projection = visibleMarkers.map((element) => [
      element.dataset.routePointIndex,
      element.dataset.anchorX,
      element.dataset.anchorY,
    ].join(":"))
      .join("|");
    return previousProjection === null || projection !== previousProjection;
  }, { identifier: routeIdentifier, expectedZoom, previousProjection }, { timeout: 5_000 });
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
 * #478: grade the projected path on both sides of every interior Route Point.
 * The last incoming samples must remain on the pre-anchor half-plane and the
 * first outgoing samples on the post-anchor half-plane of their shared screen
 * tangent. A tiny spline whisker is exactly a sample that crosses that plane,
 * turns around, then returns to the main path.
 */
async function measureAnchorPassage(page, routeIdentifier) {
  return page.evaluate((identifier) => {
    const group = document.querySelector(`[data-journey-route="${identifier}"]`);
    if (!group) return { error: "whisker route group not rendered" };
    const legs = [...group.querySelectorAll(".particle-earth-route__leg")];
    if (legs.length < 2) return { error: "whisker route drew fewer than two legs" };

    const fragmentsOf = (leg) => {
      const fragments = [];
      for (const command of (leg.getAttribute("d") ?? "").match(/[ML]-?[\d.]+ -?[\d.]+/g) ?? []) {
        const [x, y] = command.slice(1).split(" ").map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (command.startsWith("M") || fragments.length === 0) fragments.push([]);
        fragments[fragments.length - 1].push({ x, y });
      }
      return fragments.filter((fragment) => fragment.length >= 2);
    };
    const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);
    const measurements = [];

    for (let anchorIndex = 1; anchorIndex < legs.length; anchorIndex += 1) {
      const marker = group.querySelector(`[data-route-point-index="${anchorIndex}"]`);
      if (!marker || marker.style.display === "none") continue;
      const anchor = {
        x: Number(marker.dataset.anchorX),
        y: Number(marker.dataset.anchorY),
      };
      if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) continue;

      const incoming = fragmentsOf(legs[anchorIndex - 1])
        .map((fragment) => ({ fragment, distance: distance(fragment.at(-1), anchor) }))
        .sort((left, right) => left.distance - right.distance)[0];
      const outgoing = fragmentsOf(legs[anchorIndex])
        .map((fragment) => ({ fragment, distance: distance(fragment[0], anchor) }))
        .sort((left, right) => left.distance - right.distance)[0];
      if (!incoming || !outgoing || incoming.distance > 1.5 || outgoing.distance > 1.5) continue;

      const previous = incoming.fragment.at(-2);
      const next = outgoing.fragment[1];
      const incomingVector = { x: anchor.x - previous.x, y: anchor.y - previous.y };
      const outgoingVector = { x: next.x - anchor.x, y: next.y - anchor.y };
      const incomingLength = Math.hypot(incomingVector.x, incomingVector.y);
      const outgoingLength = Math.hypot(outgoingVector.x, outgoingVector.y);
      if (incomingLength < 0.01 || outgoingLength < 0.01) continue;
      let tangent = {
        x: (incomingVector.x / incomingLength) + (outgoingVector.x / outgoingLength),
        y: (incomingVector.y / incomingLength) + (outgoingVector.y / outgoingLength),
      };
      let tangentLength = Math.hypot(tangent.x, tangent.y);
      if (tangentLength < 0.01) {
        tangent = { x: outgoingVector.x, y: outgoingVector.y };
        tangentLength = outgoingLength;
      }
      tangent.x /= tangentLength;
      tangent.y /= tangentLength;
      if ((tangent.x * outgoingVector.x) + (tangent.y * outgoingVector.y) < 0) {
        tangent.x *= -1;
        tangent.y *= -1;
      }

      const side = (point) => (
        ((point.x - anchor.x) * tangent.x) + ((point.y - anchor.y) * tangent.y)
      );
      const incomingLocal = incoming.fragment.slice(-Math.min(8, incoming.fragment.length));
      const outgoingLocal = outgoing.fragment.slice(0, Math.min(8, outgoing.fragment.length));
      const incomingCrossPx = Math.max(0, ...incomingLocal.map(side));
      const outgoingCrossPx = Math.max(0, ...outgoingLocal.map((point) => -side(point)));
      measurements.push({
        anchorIndex,
        incomingCrossPx,
        outgoingCrossPx,
        incomingEndpointErrorPx: incoming.distance,
        outgoingEndpointErrorPx: outgoing.distance,
      });
    }

    return { legCount: legs.length, measurements };
  }, routeIdentifier);
}

/**
 * #478/ST-144: record the four visually similar stroke layers separately.
 * The label leader is an annotation tether; travel leader/core/legs are route
 * geometry. Keeping this evidence separate prevents another label whisker from
 * being misdiagnosed as a spline regression.
 */
async function measureWhiskerLayers(page, routeIdentifier) {
  return page.evaluate((identifier) => {
    const group = document.querySelector(`[data-journey-route="${identifier}"]`);
    if (!group) return { error: "whisker route group not rendered" };
    const core = group.querySelector(".particle-earth-route__core");
    const travelLeader = group.querySelector(".particle-earth-route__travel-leader");
    const legs = [...group.querySelectorAll(".particle-earth-route__leg")];
    if (!core || !travelLeader || legs.length === 0) {
      return { error: "route core/travel-leader/legs were not all rendered" };
    }

    const labelLeaders = [...group.querySelectorAll(".particle-earth-route__label .particle-earth-route__leader")]
      .filter((leader) => leader.closest(".particle-earth-route__label")?.style.display !== "none")
      .map((leader) => {
        const label = leader.closest(".particle-earth-route__label");
        const pointIndex = Number(label?.getAttribute("data-route-point-index"));
        const marker = [...group.querySelectorAll(".particle-earth-route__point")]
          .find((candidate) => Number(candidate.getAttribute("data-route-point-index")) === pointIndex);
        const d = leader.getAttribute("d") ?? "";
        const start = d.match(/^M(-?[\d.]+) (-?[\d.]+)/);
        const anchorX = Number(marker?.getAttribute("data-anchor-x"));
        const anchorY = Number(marker?.getAttribute("data-anchor-y"));
        const startX = Number(start?.[1]);
        const startY = Number(start?.[2]);
        const style = getComputedStyle(leader);
        return {
          pointIndex,
          path: d,
          lengthPx: leader.getTotalLength(),
          anchorGapPx: Number.isFinite(startX) && Number.isFinite(startY)
            && Number.isFinite(anchorX) && Number.isFinite(anchorY)
            ? Math.hypot(startX - anchorX, startY - anchorY)
            : Number.NaN,
          strokeWidth: Number.parseFloat(style.strokeWidth),
          opacity: Number.parseFloat(style.opacity),
          dashArray: style.strokeDasharray,
        };
      });

    const corePath = core.getAttribute("d") ?? "";
    const travelPath = travelLeader.getAttribute("d") ?? "";
    return {
      labelLeaders,
      travelLeader: {
        path: travelPath,
        lengthPx: travelLeader.getTotalLength(),
        opacity: Number.parseFloat(getComputedStyle(travelLeader).opacity),
        sharesCoreGeometry: travelPath === corePath,
      },
      core: {
        path: corePath,
        lengthPx: core.getTotalLength(),
      },
      legs: legs.map((leg) => ({
        path: leg.getAttribute("d") ?? "",
        lengthPx: leg.getTotalLength(),
      })),
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

async function measureRouteOptics(page, routeIdentifier) {
  return page.evaluate((identifier) => {
    const group = document.querySelector(`[data-journey-route="${identifier}"]`);
    if (!group) return { error: "route group not rendered" };
    const readWidth = (selector) => {
      const node = group.querySelector(selector);
      return node ? Number.parseFloat(getComputedStyle(node).strokeWidth) : Number.NaN;
    };
    const points = [...group.querySelectorAll(".particle-earth-route__point")].map((node) => ({
      id: node.getAttribute("data-route-point-id"),
      semanticRole: node.getAttribute("data-semantic-role"),
      attentionRole: node.getAttribute("data-attention-role"),
      temporalVisible: node.getAttribute("data-temporal-visible"),
      temporalReveal: node.getAttribute("data-temporal-reveal"),
      radius: Number(node.getAttribute("r")),
      opacity: Number.parseFloat(getComputedStyle(node).opacity),
      fill: getComputedStyle(node).fill,
      stroke: getComputedStyle(node).stroke,
      strokeWidth: Number.parseFloat(getComputedStyle(node).strokeWidth),
      filter: getComputedStyle(node).filter,
      anchorX: Number(node.getAttribute("data-anchor-x")),
      anchorY: Number(node.getAttribute("data-anchor-y")),
    }));
    const labelLeaders = [...group.querySelectorAll(".particle-earth-route__label .particle-earth-route__leader")]
      .filter((node) => node.closest(".particle-earth-route__label")?.style.display !== "none");
    const labelLeaderStyle = labelLeaders[0] ? getComputedStyle(labelLeaders[0]) : null;
    return {
      devicePixelRatio: window.devicePixelRatio,
      compact: document.querySelector(".particle-earth-scene")?.getAttribute("data-mobile-v2") ?? null,
      routeAttentionRole: group.getAttribute("data-attention-role"),
      narrativeRouteIds: [...document.querySelectorAll('.particle-earth-route[data-journey-route][data-attention-role="narrative-current"]')]
        .map((node) => node.getAttribute("data-journey-route")),
      coreWidth: readWidth(".particle-earth-route__core"),
      glowWidth: readWidth(".particle-earth-route__glow"),
      leaderOpacity: Number.parseFloat(getComputedStyle(group.querySelector(".particle-earth-route__travel-leader")).opacity),
      labelLeaderCount: labelLeaders.length,
      labelLeaderWidth: labelLeaderStyle ? Number.parseFloat(labelLeaderStyle.strokeWidth) : Number.NaN,
      labelLeaderOpacity: labelLeaderStyle ? Number.parseFloat(labelLeaderStyle.opacity) : Number.NaN,
      labelLeaderDashArray: labelLeaderStyle?.strokeDasharray ?? null,
      points,
    };
  }, routeIdentifier);
}

function near(value, expected, tolerance = 0.06) {
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

async function runRouteOpticsCase({ dpr, viewport, reducedMotion = false, mobile = false }) {
  const opticsContext = await browser.newContext({
    viewport,
    deviceScaleFactor: dpr,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    isMobile: mobile,
    hasTouch: mobile,
  });
  const opticsPage = await opticsContext.newPage();
  await opticsPage.route("**/api/auth/get-session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  const url = new URL(qaUrl);
  url.searchParams.set("qaRouteOptics", "1");
  url.searchParams.set("qaMotion", reducedMotion ? "reduce" : "animate");
  try {
    await opticsPage.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await opticsPage.locator('[data-scene-ready="true"]').waitFor({ timeout: 30_000 });
    await opticsPage.waitForFunction((identifier) => document.querySelectorAll(`[data-journey-route="${identifier}"] .particle-earth-route__point`).length >= 6, routeId);
    await setZoom(opticsPage, 1);
    await waitForRenderedFrame(opticsPage);
    const browse1 = await measureRouteOptics(opticsPage, routeId);
    await setZoom(opticsPage, 3);
    await waitForRenderedFrame(opticsPage);
    const browse3 = await measureRouteOptics(opticsPage, routeId);
    await opticsPage.locator('[data-qa-route-optics-stage="playing"]').click();
    await opticsPage.waitForFunction((identifier) => {
      const group = document.querySelector(`[data-journey-route="${identifier}"]`);
      const future = group?.querySelector('[data-route-point-id="qa-p-18"]');
      const core = group?.querySelector(".particle-earth-route__core");
      // Every future point fades independently, so wait for all of them
      // (e.g. the ordinary qa-p-19), not only the selected qa-p-18.
      const hidden = [...(group?.querySelectorAll('.particle-earth-route__point[data-temporal-visible="false"]') ?? [])];
      return group?.getAttribute("data-attention-role") === "narrative-current"
        && future?.getAttribute("data-temporal-reveal") === "0.000"
        && Number.parseFloat(getComputedStyle(future).opacity) === 0
        && hidden.every((point) => Number.parseFloat(getComputedStyle(point).opacity) === 0)
        && Number.parseFloat(getComputedStyle(core).strokeWidth) >= 1.19;
    }, routeId);
    await waitForRenderedFrame(opticsPage);
    const playing = await measureRouteOptics(opticsPage, routeId);
    await opticsPage.locator('[data-qa-route-optics-stage="rewound"]').click();
    await opticsPage.waitForFunction((identifier) => {
      const group = document.querySelector(`[data-journey-route="${identifier}"]`);
      return group?.querySelector('[data-route-point-id="qa-p-16"]')?.getAttribute("data-attention-role") === "narrative-current"
        && group?.querySelector('[data-route-point-id="qa-p-17"]')?.getAttribute("data-temporal-reveal") === "0.000";
    }, routeId);
    await waitForRenderedFrame(opticsPage);
    const rewound = await measureRouteOptics(opticsPage, routeId);
    return { dpr, viewport, reducedMotion, mobile, browse1, browse3, playing, rewound };
  } finally {
    await opticsContext.close();
  }
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
  let previousProjection = await routeEndpointProjection(page, routeId);
  for (const zoom of [1, 2, 3]) {
    const before = await debug(page);
    const state = await setZoom(page, zoom);
    const changedZoom = before && Number.isFinite(before.zoom)
      && Math.abs(before.zoom - state.zoom) > 0.03;
    await waitForRouteEndpoints(
      page,
      routeId,
      state.zoom,
      changedZoom ? previousProjection : null,
    );
    previousProjection = await routeEndpointProjection(page, routeId);
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

  // #373/ST-077: optical grammar is CSS-pixel bounded across zoom/DPR, while
  // semantic Stop/passthrough and selected/narrative-current remain independent.
  const opticsCases = [
    await runRouteOpticsCase({ dpr: 1, viewport: { width: 1280, height: 800 } }),
    await runRouteOpticsCase({ dpr: 2, viewport: { width: 1280, height: 800 }, reducedMotion: true }),
    await runRouteOpticsCase({ dpr: 3, viewport: { width: 844, height: 390 }, mobile: true }),
  ];
  for (const sample of opticsCases) {
    const { browse1, browse3, playing, rewound } = sample;
    const byId = (state, id) => state.points.find((point) => point.id === id);
    const sameA = byId(browse1, "qa-p-15");
    const sameB = byId(browse1, "qa-p-20");
    const selected = byId(browse1, "qa-p-18");
    const browseStop = byId(browse1, "qa-p-17");
    const narrative = byId(playing, "qa-p-17");
    const future = byId(playing, "qa-p-18");
    // The selected future point above was already exempt from the ordinary
    // browse-emphasis rule, so it cannot prove the time cursor outranks that
    // rule. qa-p-19 is future during playing and neither selected nor
    // narrative-current, i.e. the one point the ordinary rule actually paints.
    const futureOrdinary = byId(playing, "qa-p-19");
    const rewoundCurrent = byId(rewound, "qa-p-16");
    console.log("[qa-route-anchoring] route-optics", JSON.stringify(sample));
    if (!near(browse1.coreWidth, 1.15) || !near(browse3.coreWidth, 1.15)) failures.push(`DPR ${sample.dpr}: selected core changed with zoom (${browse1.coreWidth} -> ${browse3.coreWidth})`);
    if (!near(browse1.glowWidth, 2.8) || !near(browse3.glowWidth, 2.8)) failures.push(`DPR ${sample.dpr}: selected halo changed with zoom (${browse1.glowWidth} -> ${browse3.glowWidth})`);
    if (browse1.devicePixelRatio !== sample.dpr) failures.push(`DPR ${sample.dpr}: browser reported ${browse1.devicePixelRatio}`);
    if (!selected || selected.attentionRole !== "selected" || selected.semanticRole !== "passthrough" || !near(selected.radius, 3, 0.02)) failures.push(`DPR ${sample.dpr}: browse-selected passthrough role/radius is wrong`);
    if (browse1.routeAttentionRole !== "selected" || browse1.narrativeRouteIds.length !== 0) failures.push(`DPR ${sample.dpr}: browse selection was incorrectly projected as narrative-current`);
    if (!browseStop || browseStop.semanticRole !== "stop" || browseStop.fill === selected?.fill || browseStop.fill === browseStop.stroke || browseStop.strokeWidth < 1.24) failures.push(`DPR ${sample.dpr}: Stop ring paint collapsed into passthrough bead paint`);
    if (!selected?.filter.includes("brightness") || !selected.filter.includes("drop-shadow")) failures.push(`DPR ${sample.dpr}: selected point filter did not compose active-route brightness with attention shadow`);
    if (!sameA || !sameB || Math.hypot(sameA.anchorX - sameB.anchorX, sameA.anchorY - sameB.anchorY) > 0.05) failures.push(`DPR ${sample.dpr}: same-coordinate records no longer share one anchor`);
    if (!narrative || narrative.attentionRole !== "narrative-current" || !near(narrative.radius, 3.2, 0.02)) failures.push(`DPR ${sample.dpr}: narrative-current role did not outrank browse selection`);
    if (!narrative || narrative.semanticRole !== "stop" || narrative.fill !== browseStop?.fill) failures.push(`DPR ${sample.dpr}: narrative attention overwrote the Stop ring fill`);
    if (!narrative?.filter.includes("brightness") || !narrative.filter.includes("drop-shadow")) failures.push(`DPR ${sample.dpr}: narrative-current filter did not compose active-route brightness with attention shadow`);
    if (!future || future.temporalVisible !== "false" || future.temporalReveal !== "0.000" || future.opacity !== 0) failures.push(`DPR ${sample.dpr}: future selected Route Point remained visible`);
    if (!futureOrdinary || futureOrdinary.attentionRole !== "ordinary" || futureOrdinary.temporalVisible !== "false" || futureOrdinary.temporalReveal !== "0.000" || futureOrdinary.opacity !== 0) failures.push(`DPR ${sample.dpr}: future ordinary Route Point remained visible`);
    if (!near(playing.coreWidth, 1.2) || !near(playing.glowWidth, 3)) failures.push(`DPR ${sample.dpr}: narrative optical weight is outside the bounded target`);
    if (playing.narrativeRouteIds.join(",") !== routeId || rewound.narrativeRouteIds.join(",") !== routeId) failures.push(`DPR ${sample.dpr}: overlapping temporal ranges created more than one narrative-current Journey`);
    if (!rewoundCurrent || rewoundCurrent.attentionRole !== "narrative-current") failures.push(`DPR ${sample.dpr}: rewind did not move narrative-current to the last visible point`);
    for (const [stateName, state] of [["browse-1x", browse1], ["browse-3x", browse3], ["playing", playing], ["rewound", rewound]]) {
      if (state.labelLeaderCount === 0) continue;
      if (!(state.labelLeaderWidth <= 0.75)) failures.push(`DPR ${sample.dpr} ${stateName}: label leader is too route-like at ${state.labelLeaderWidth}px`);
      if (!(state.labelLeaderOpacity <= 0.45)) failures.push(`DPR ${sample.dpr} ${stateName}: label leader opacity ${state.labelLeaderOpacity} is too close to route emphasis`);
      if (!state.labelLeaderDashArray || state.labelLeaderDashArray === "none") failures.push(`DPR ${sample.dpr} ${stateName}: label leader remained a solid route-like stroke`);
    }
    if (browse1.labelLeaderCount === 0 || browse3.labelLeaderCount === 0) failures.push(`DPR ${sample.dpr}: no visible label leader remained to associate Route Point text at overview/near framing`);
    if (sample.reducedMotion && playing.leaderOpacity !== 0) failures.push(`DPR ${sample.dpr}: reduced motion left the travelling leader visible`);
  }
  if (failures.length > 0) throw new Error(`[qa-route-anchoring] ${failures.join("; ")}`);

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

  // #478: use the exact mixed-leg Southwest sequence and inspect projected
  // samples around every interior Route Point. The route is centred so all
  // three joins are visible; missing measurements are a QA failure, not a skip.
  await page.goto(whiskerQaUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await page.waitForFunction((identifier) => Boolean(
    document.querySelector(`[data-journey-route="${identifier}"] .particle-earth-route__leg`),
  ), whiskerRouteId, { timeout: 30_000 });
  await page.waitForTimeout(400);
  // Label leaders exist only for the active Journey in the product renderer.
  // Enter that real QA state before grading the annotation layer; the old
  // fixture left every Journey inactive and therefore asserted on a layer the
  // product correctly had not made visible.
  await page.locator(`[data-qa-route="${whiskerRouteId}"]`).click();
  await page.waitForFunction((identifier) => (
    document.querySelector(`[data-journey-route="${identifier}"]`)?.classList.contains("is-active") === true
  ), whiskerRouteId, { timeout: 5_000 });
  await page.waitForFunction((identifier) => (
    [...document.querySelectorAll(
      `[data-journey-route="${identifier}"] .particle-earth-route__label .particle-earth-route__leader`,
    )].some((leader) => leader.closest(".particle-earth-route__label")?.style.display !== "none")
  ), whiskerRouteId, { timeout: 5_000 });
  await setZoom(page, 2);
  await waitForRenderedFrame(page);
  const anchorPassage = await measureAnchorPassage(page, whiskerRouteId);
  if (anchorPassage.error) throw new Error(`[qa-route-anchoring] ${anchorPassage.error}`);
  const layerEvidence = await measureWhiskerLayers(page, whiskerRouteId);
  if (layerEvidence.error) throw new Error(`[qa-route-anchoring] ${layerEvidence.error}`);
  const independentCoreLegDefect = anchorPassage.measurements.some((measurement) => (
    measurement.incomingCrossPx > ANCHOR_HALF_PLANE_TOLERANCE_PX
    || measurement.outgoingCrossPx > ANCHOR_HALF_PLANE_TOLERANCE_PX
  ));
  console.log("[qa-route-anchoring] southwest-whisker", JSON.stringify(anchorPassage));
  console.log("[qa-route-anchoring] southwest-whisker-layers", JSON.stringify({
    ...layerEvidence,
    independentCoreLegDefect,
  }));
  if (layerEvidence.labelLeaders.length === 0) {
    failures.push("southwest whisker fixture rendered no visible label-leader layer to grade");
  }
  if (!layerEvidence.travelLeader.sharesCoreGeometry) {
    failures.push("travel leader no longer shares the canonical route core geometry");
  }
  for (const leader of layerEvidence.labelLeaders) {
    if (!(leader.lengthPx > 0)) failures.push(`Route Point ${leader.pointIndex}: label leader has no visible annotation length`);
    if (!(leader.anchorGapPx >= 4.5)) failures.push(`Route Point ${leader.pointIndex}: label leader still touches the route anchor (${leader.anchorGapPx}px gap)`);
    if (!(leader.strokeWidth <= 0.75)) failures.push(`Route Point ${leader.pointIndex}: label leader width ${leader.strokeWidth}px still competes with the route core`);
    if (!(leader.opacity <= 0.45)) failures.push(`Route Point ${leader.pointIndex}: label leader opacity ${leader.opacity} still competes with the route core`);
    if (!leader.dashArray || leader.dashArray === "none") failures.push(`Route Point ${leader.pointIndex}: label leader is still a solid route-like stroke`);
  }
  if (anchorPassage.measurements.length !== 3) {
    failures.push(`southwest whisker fixture measured ${anchorPassage.measurements.length}/3 interior Route Points`);
  }
  for (const measurement of anchorPassage.measurements) {
    if (measurement.incomingCrossPx > ANCHOR_HALF_PLANE_TOLERANCE_PX) {
      failures.push(`southwest Route Point ${measurement.anchorIndex}: incoming spline crossed ${measurement.incomingCrossPx.toFixed(2)}px past the shared anchor half-plane`);
    }
    if (measurement.outgoingCrossPx > ANCHOR_HALF_PLANE_TOLERANCE_PX) {
      failures.push(`southwest Route Point ${measurement.anchorIndex}: outgoing spline crossed ${measurement.outgoingCrossPx.toFixed(2)}px back across the shared anchor half-plane`);
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
