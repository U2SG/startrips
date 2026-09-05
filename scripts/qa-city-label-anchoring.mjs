// #196 place-label anchoring QA.
//
// A place name is an annotation of a geographic point, so its screen anchor
// must be the projection of that point on the map surface - not of a point on
// some larger shell that happens to share the latitude/longitude. The failure
// this lane exists to catch is invisible in a screenshot and grows with zoom:
// an annotation lifted above the surface travels along a different projected
// trajectory than the geography it names, so it drifts while dragging.
//
// The measurement is a containment ratio, and it needs no reference
// implementation of the projection. The globe's own interaction geometry
// publishes the projected silhouette of the geographic surface - centre and
// radius in CSS pixels, computed from GLOBE_SURFACE_RADIUS through a code path
// that has nothing to do with label projection. A point ON that surface can
// never project outside its own silhouette, so for every rendered label:
//
//     hypot(anchor - silhouetteCentre) / silhouetteRadius <= 1
//
// On the superseded 1.46 shell this ratio reached 1.056 at 1x, 1.081 at 2x and
// 1.340 at max zoom - the drift, quantified. Anything at or under 1 is a label
// that lives on the map.
//
// One correction makes that exact rather than approximate. A sphere seen
// off-axis projects to an ELLIPSE, not a circle, so a surface point near the
// far limb legitimately sits slightly outside the on-axis silhouette radius.
// The globe is deliberately off-axis in focus mode - it is offset so the
// focused place lands on the focus centre rather than the middle of the window
// - and at 1x that alone buys a real 6% excess, which is more than the defect
// being looked for. `offAxisAllowance` computes it exactly from published
// pixel quantities instead of absorbing it into a loose tolerance.
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";

// A surface point projects exactly onto the silhouette at the limb, so on top
// of the exact off-axis allowance the budget only has to absorb the 0.01px the
// anchor is published at.
const CONTAINMENT_MARGIN = 0.005;
// Two projection paths for one clicked place: the label anchor goes through
// the city vector layer, the focus signal through the focus solver.
const FOCUS_MATCH_TOLERANCE_PX = 1.5;
// The readability offset the place-label layer applies after projection.
const TEXT_OFFSET = { x: 6, y: -5 };

// #196 acceptance: a dense-coastline city, a large US city, an island city and
// an inland control. Coordinates are the fixture framing; the label matched in
// the DOM is whichever rendered place is nearest to them.
const FIXTURES = [
  { key: "dense-coastline", name: "Shenzhen", lat: 22.54554, lon: 114.0683 },
  { key: "large-us", name: "San Francisco", lat: 37.77493, lon: -122.41942 },
  { key: "island", name: "Singapore", lat: 1.28967, lon: 103.85007 },
  { key: "inland-control", name: "Denver", lat: 39.73915, lon: -104.9847 },
];

// A frame must measure at least one place this close to the view centre, and
// must reach at least this fraction of the way out to whatever the framing can
// physically reach.
const CENTRED_WITHIN = 0.12;
const OUTWARD_COVERAGE = 0.8;

const VIEWPORT = { width: 1280, height: 800 };

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

function debug(page) {
  return page.evaluate(() => window.__particleEarthDebug?.() ?? null);
}

/**
 * Every rendered place label with its published geographic anchor, measured
 * against the projected silhouette of the geographic surface.
 */
function measure(page) {
  return page.evaluate(() => {
    const host = document.querySelector(".particle-earth-scene");
    const state = window.__particleEarthDebug?.();
    if (!host || !state) return { error: "scene debug state is unavailable" };
    const labels = [];
    for (const element of document.querySelectorAll(".particle-earth-city")) {
      // A pooled label keeps its last anchor after it is hidden.
      if (element.style.display === "none") continue;
      const x = Number(element.dataset.anchorX);
      const y = Number(element.dataset.anchorY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const box = element.getBBox();
      labels.push({
        name: element.textContent ?? "",
        lat: Number(element.dataset.cityLat),
        lon: Number(element.dataset.cityLon),
        anchor: { x, y },
        // The typography offset is applied after projection, so the drawn text
        // is allowed to sit away from the anchor - by a constant.
        text: { x: Number(element.getAttribute("x")), y: Number(element.getAttribute("y")) },
        box: { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height },
      });
    }
    return {
      labels,
      centre: state.projectedGlobeCenterPx,
      silhouettePx: state.projectedGlobeRadiusPx,
      interactionRadiusPx: 1 / state.effectiveDragRadiansPerPixel,
      rotationY: state.rotationY,
      zoom: state.zoom,
      scale: state.scale,
      surfaceRadius: Number(host.dataset.geographicSurfaceRadius),
      labelAnchorRadius: Number(host.dataset.cityLabelAnchorRadius),
      viewport: { width: host.clientWidth, height: host.clientHeight },
      focus: {
        x: Number(host.dataset.personalPointX),
        y: Number(host.dataset.personalPointY),
        lat: Number(host.dataset.focusPointLat),
        lon: Number(host.dataset.focusPointLon),
      },
    };
  });
}

function containment(sample, anchor) {
  return Math.hypot(anchor.x - sample.centre.x, anchor.y - sample.centre.y)
    / sample.silhouettePx;
}

/**
 * Camera geometry in globe-local units, derived from the two published pixel
 * radii rather than hard-coded. Both share the same focal length, so
 * silhouette/interaction = (d - R) / sqrt(d^2 - R^2) = sqrt((d - R)/(d + R)),
 * which inverts to d = R (1 + r^2) / (1 - r^2).
 */
function cameraGeometry(sample) {
  const worldRadius = sample.surfaceRadius * sample.scale;
  const ratioSquared = (sample.silhouettePx / sample.interactionRadiusPx) ** 2;
  const distance = worldRadius * (1 + ratioSquared) / (1 - ratioSquared);
  const focalPx = sample.silhouettePx * Math.sqrt(distance * distance - worldRadius * worldRadius)
    / worldRadius;
  return { worldRadius, distance, focalPx };
}

/**
 * How far outside the on-axis silhouette radius a genuine surface point may
 * project, given how far off-axis the globe is in this frame.
 *
 * With the globe centre at off-axis angle b and the sphere subtending a
 * half-angle p, the projected silhouette reaches f*tan(b + p) from the image
 * centre while the centre itself projects at f*tan(b). The outer extent
 * measured from the centre is therefore f*(tan(b + p) - tan(b)) against the
 * on-axis f*tan(p), and the ratio of the two is the allowance. It is 1 when
 * the globe is centred, which is what makes the max-zoom measurement - where
 * the globe fills the window - the strict one.
 */
function offAxisAllowance(sample) {
  const { worldRadius, distance, focalPx } = cameraGeometry(sample);
  const centreOffsetPx = Math.hypot(
    sample.centre.x - sample.viewport.width / 2,
    sample.centre.y - sample.viewport.height / 2,
  );
  const offAxis = Math.atan(centreOffsetPx / focalPx);
  const halfAngle = Math.asin(Math.min(1, worldRadius / distance));
  return (Math.tan(offAxis + halfAngle) - Math.tan(offAxis)) / Math.tan(halfAngle);
}

/**
 * The largest containment ratio this frame can physically produce. At max zoom
 * the globe is far wider than the window, so its limb is off-screen and no
 * label can be rendered near it; asserting a near-limb sample there would be
 * asserting something the projection makes impossible.
 */
function reachableContainment(sample) {
  // The nearest edge, not the far corner: a label only appears where there is
  // geography to name, so requiring one in the corners of a globe that
  // overflows the window would be a statement about place density.
  const halfEdge = Math.min(sample.viewport.width, sample.viewport.height) / 2;
  return Math.min(offAxisAllowance(sample), halfEdge / sample.silhouettePx);
}

/** The label nearest to the fixture coordinates, if the frame rendered it. */
function findFixture(sample, fixture) {
  let best = null;
  for (const label of sample.labels) {
    const distance = Math.hypot(label.lat - fixture.lat, label.lon - fixture.lon);
    if (distance <= 0.25 && (!best || distance < best.distance)) best = { label, distance };
  }
  return best?.label ?? null;
}

/**
 * Wheel and pointer gestures are dispatched onto the canvas directly rather
 * than driven through page coordinates. Coordinate input hit-tests the topmost
 * element, and the scene sits under the overlay that carries the place labels,
 * so a coordinate drag lands on the overlay and rotates nothing at all - it
 * fails silently, which is worse than failing. `scripts/qa-globe-interaction.mjs`
 * already drives the identical listener path this way.
 */
function canvasOf(page) {
  return page.locator('canvas[data-three-scene="particle-earth"]');
}

/**
 * `anchor` is the screen point the zoom keeps still. It defaults to the middle
 * of the window, but zooming toward a place that is NOT in the middle has to
 * name that place: the scene anchors a wheel zoom on the cursor, so zooming on
 * the window centre magnifies whatever offset the framing already had and
 * pushes an off-centre place off the screen entirely.
 */
async function setZoom(page, targetZoom, anchor = null) {
  const before = await debug(page);
  if (!before) throw new Error("Particle Earth debug state is unavailable");
  if (Math.abs(before.zoom - targetZoom) > 0.02) {
    const point = anchor ?? { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    await canvasOf(page).evaluate((node, init) => node.dispatchEvent(new WheelEvent("wheel", init)), {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      deltaY: -Math.log(targetZoom / before.zoom) / 0.0012,
    });
    await page.waitForTimeout(160);
  }
  const after = await debug(page);
  if (!after || Math.abs(after.zoom - targetZoom) > 0.03) {
    throw new Error(`Unable to set city QA zoom: ${JSON.stringify({ targetZoom, after })}`);
  }
  return after;
}

/** Pointer capture on a synthetic pointer breaks the gesture, so it is stubbed. */
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

/** Angular radius of the visible cap; sizes the drag out toward the limb. */
function horizonRadians(sample) {
  const { worldRadius, distance } = cameraGeometry(sample);
  return Math.acos(Math.min(1, worldRadius / distance));
}

/** Wait until the focus flight has stopped moving the focus signal. */
async function waitForFocusToSettle(page) {
  let previous = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await measure(page);
    const current = `${state.focus.x?.toFixed(2)},${state.focus.y?.toFixed(2)},${state.zoom.toFixed(4)}`;
    if (current === previous) return state;
    previous = current;
    await page.waitForTimeout(250);
  }
  return measure(page);
}

const context = await browser.newContext({ viewport: VIEWPORT });
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
let checks = 0;
let framesMeasured = 0;
let labelsMeasured = 0;
let worstContainment = { ratio: 0, where: "none", name: "" };

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

/** The invariant, applied to every label in one frame. */
function checkFrame(sample, where) {
  framesMeasured += 1;
  labelsMeasured += sample.labels.length;
  const limit = offAxisAllowance(sample) + CONTAINMENT_MARGIN;
  let worst = { ratio: 0, label: null };
  for (const label of sample.labels) {
    const ratio = containment(sample, label.anchor);
    if (ratio > worst.ratio) worst = { ratio, label };
  }
  // Normalised so frames with different framings are comparable in the log.
  const normalised = worst.ratio / offAxisAllowance(sample);
  if (normalised > worstContainment.ratio) {
    worstContainment = { ratio: normalised, where, name: worst.label?.name ?? "" };
  }
  check(
    worst.ratio <= limit,
    `${where}: place label "${worst.label?.name}" projects ${worst.ratio.toFixed(4)} of the way out of the geographic silhouette (this framing allows ${limit.toFixed(4)}) - it is anchored above the map surface`,
  );
  return worst;
}

/** #79 must be untouched: rendered labels still never overlap one another. */
function checkNoOverlap(sample, where) {
  let overlaps = 0;
  for (let a = 0; a < sample.labels.length; a += 1) {
    for (let b = a + 1; b < sample.labels.length; b += 1) {
      const one = sample.labels[a].box;
      const two = sample.labels[b].box;
      if (
        one.left < two.right && two.left < one.right
        && one.top < two.bottom && two.top < one.bottom
      ) overlaps += 1;
    }
  }
  check(overlaps === 0, `${where}: ${overlaps} rendered place labels overlap, #79 collision handling regressed`);
}

try {
  for (const fixture of FIXTURES) {
    const url = new URL(
      `/?qaState=journey-routes&qaQuality=high&qaFocusLat=${fixture.lat}&qaFocusLon=${fixture.lon}`,
      baseUrl,
    ).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
    // City data is fetched, so the first frames legitimately have no labels.
    await page.waitForFunction(() => Number(
      document.querySelector(".particle-earth-scene")?.dataset.journeyCityLabelCount ?? 0,
    ) > 0, null, { timeout: 30_000 });
    await page.waitForTimeout(400);

    const opening = await measure(page);
    if (opening.error) throw new Error(`[qa-city-label-anchoring] ${fixture.key}: ${opening.error}`);
    check(
      opening.labelAnchorRadius === opening.surfaceRadius,
      `${fixture.key}: the place-label anchor radius ${opening.labelAnchorRadius} is not the geographic surface radius ${opening.surfaceRadius}`,
    );
    // The offset that keeps the text readable must be a screen-space constant
    // applied after projection - never a different geographic anchor.
    for (const label of opening.labels) {
      check(
        Math.abs(label.text.x - label.anchor.x - TEXT_OFFSET.x) < 0.06
        && Math.abs(label.text.y - label.anchor.y - TEXT_OFFSET.y) < 0.06,
        `${fixture.key}: label "${label.name}" text offset (${(label.text.x - label.anchor.x).toFixed(2)}, ${(label.text.y - label.anchor.y).toFixed(2)}) is not the constant screen-space offset (${TEXT_OFFSET.x}, ${TEXT_OFFSET.y})`,
      );
    }

    for (const zoom of [1, 2, 3]) {
      const state = await setZoom(page, zoom);
      await page.waitForTimeout(220);
      const label = `${fixture.key} @${state.zoom.toFixed(2)}x`;

      const settled = await measure(page);
      checkFrame(settled, `${label} settled`);
      checkNoOverlap(settled, `${label} settled`);

      let nearestSeen = Number.POSITIVE_INFINITY;
      let farthestSeen = 0;
      const observed = [];
      const record = (sample) => {
        for (const item of sample.labels) {
          const ratio = containment(sample, item.anchor);
          if (ratio < nearestSeen) nearestSeen = ratio;
          if (ratio > farthestSeen) farthestSeen = ratio;
        }
        const found = findFixture(sample, fixture);
        if (found) observed.push(containment(sample, found.anchor));
      };
      record(settled);

      // The reported symptom is differential motion during a CONTINUOUS drag,
      // so the pointer goes down once and every intermediate frame is measured
      // while it is still down.
      const origin = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
      const steps = 14;
      const stepPx = (horizonRadians(settled) * 0.9 * settled.interactionRadiusPx) / steps;
      await beginDrag(page, origin);
      for (let step = 1; step <= steps; step += 1) {
        await dragTo(page, { x: origin.x + stepPx * step, y: origin.y });
        const sample = await measure(page);
        checkFrame(sample, `${label} drag step ${step}`);
        record(sample);
      }
      const dragged = await measure(page);
      // Drag back so the next zoom starts from the same framing.
      for (let step = steps - 1; step >= 0; step -= 1) {
        await dragTo(page, { x: origin.x + stepPx * step, y: origin.y });
      }
      await endDrag(page, origin);
      await page.waitForTimeout(200);

      const rotated = Math.abs(dragged.rotationY - settled.rotationY);
      // A drag that silently rotated nothing would make every assertion above
      // pass on fourteen copies of one frame, so the gesture is verified.
      check(
        rotated > 0.05,
        `${label}: dragging ${(stepPx * steps).toFixed(0)}px rotated the globe by ${rotated.toFixed(4)} rad - the gesture never reached the canvas`,
      );

      // #196 QA asks for each fixture to be measured centred, well off-centre
      // and near the visible limb. That is stated as a spread rather than three
      // fixed rings: which individual place survives #79 collision in a given
      // frame is the collision budget's business, and at max zoom the globe is
      // wider than the window so its limb genuinely cannot be reached.
      const reachable = reachableContainment(settled);
      check(
        nearestSeen <= CENTRED_WITHIN,
        `${label}: no place label was measured near the view centre across ${steps + 1} frames; nearest was ${nearestSeen.toFixed(3)}`,
      );
      check(
        farthestSeen >= reachable * OUTWARD_COVERAGE,
        `${label}: place labels only ever reached ${farthestSeen.toFixed(3)} of the silhouette across ${steps + 1} frames, short of ${(reachable * OUTWARD_COVERAGE).toFixed(3)} - ${reachable.toFixed(3)} was reachable in this framing`,
      );

      console.log([
        `[qa-city-label-anchoring] ${fixture.key}`,
        `zoom=${settled.zoom.toFixed(3)}`,
        `labels=${settled.labels.length}`,
        `silhouettePx=${settled.silhouettePx.toFixed(1)}`,
        `offAxisAllowance=${offAxisAllowance(settled).toFixed(4)}`,
        `reachable=${reachable.toFixed(3)}`,
        `rotated=${rotated.toFixed(3)}rad`,
        `fixture=${observed.length > 0 ? `${Math.min(...observed).toFixed(3)}..${Math.max(...observed).toFixed(3)}` : "not rendered"}`,
        `spread=${nearestSeen.toFixed(3)}..${farthestSeen.toFixed(3)}`,
      ].join(" "));
    }

    // #196 acceptance: clicking a place name focuses the place it claimed.
    // The label anchor and the focus signal are projected by two different
    // subsystems, so their agreement after the focus settles is the check that
    // the click does not reveal a hidden geographic mismatch.
    await setZoom(page, 3);
    await page.waitForTimeout(220);
    const beforeClick = await measure(page);
    // The scene ignores a label activation while any pointer is still tracked,
    // so the drag pointer is explicitly released before clicking. Without this
    // a click is swallowed silently and the measurement below runs against the
    // place that was never focused.
    await canvasOf(page).evaluate((node) => {
      for (const type of ["pointerup", "pointercancel"]) {
        node.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons: 0,
          isPrimary: true,
          pointerId: 71,
          pointerType: "mouse",
        }));
      }
    });
    await page.waitForTimeout(120);
    // Choosing the label and activating it happen in ONE page turn. The label
    // pool is rewritten every frame, so selecting an element in Node and
    // clicking it in a second round trip can activate a recycled element - or
    // nothing at all, silently.
    const activateNearestLabel = (viewCentre) => page.evaluate((centre) => {
      let best = null;
      for (const element of document.querySelectorAll(".particle-earth-city")) {
        if (element.style.display === "none") continue;
        const x = Number(element.dataset.anchorX);
        const y = Number(element.dataset.anchorY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const distance = Math.hypot(x - centre.x, y - centre.y);
        if (!best || distance < best.distance) {
          best = { distance, element, name: element.textContent ?? "" };
        }
      }
      if (!best) return null;
      best.element.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: Number(best.element.dataset.anchorX),
        clientY: Number(best.element.dataset.anchorY),
        isPrimary: true,
        pointerId: 73,
        pointerType: "mouse",
      }));
      return {
        name: best.name,
        lat: Number(best.element.dataset.cityLat),
        lon: Number(best.element.dataset.cityLon),
      };
    }, viewCentre);

    // Activation is confirmed rather than assumed. A swallowed click leaves the
    // globe on its original framing, and every measurement after it would then
    // be describing a place nobody clicked.
    let target = null;
    for (let attempt = 0; attempt < 3 && !target; attempt += 1) {
      const candidate = await activateNearestLabel(beforeClick.centre);
      if (!candidate) break;
      for (let poll = 0; poll < 12; poll += 1) {
        const state = await measure(page);
        if (
          Math.abs(state.focus.lat - candidate.lat) < 0.0002
          && Math.abs(state.focus.lon - candidate.lon) < 0.0002
        ) {
          target = candidate;
          break;
        }
        await page.waitForTimeout(120);
      }
    }
    check(Boolean(target), `${fixture.key}: no place label at max zoom accepted an activation`);
    if (target) {
      // Focusing a picked point flies the globe and drops it to a low zoom for
      // the flight. Zooming before the flight ends would cancel it - a wheel
      // claims manual interaction - and measure a half-finished framing.
      const settledFocus = await waitForFocusToSettle(page);
      // The label claimed a latitude/longitude; the app now says which one it
      // focused. This half of the acceptance does not depend on that label
      // surviving the coarse tier the flight passes through.
      check(
        Math.abs(settledFocus.focus.lat - target.lat) < 0.0002
        && Math.abs(settledFocus.focus.lon - target.lon) < 0.0002,
        `${fixture.key}: clicking "${target.name}" at (${target.lat}, ${target.lon}) settled on (${settledFocus.focus.lat}, ${settledFocus.focus.lon})`,
      );
      // The other half - no visible jump - needs the label on screen. Which
      // zoom renders it depends on the place's tier and on #79 collision, so
      // every supported zoom is tried before giving up.
      let afterClick = settledFocus;
      let focused = findFixture(settledFocus, { lat: target.lat, lon: target.lon });
      checkFrame(settledFocus, `${fixture.key} after click, settled`);
      // The flight ends at a low zoom, where the coarse tier shows only the
      // largest places. Zoom back in ANCHORED ON THE FOCUS SIGNAL so the place
      // that was just focused stays where it is while its tier becomes visible.
      for (const zoom of [2, 3]) {
        if (focused) break;
        const anchor = { x: afterClick.focus.x, y: afterClick.focus.y };
        await setZoom(page, zoom, Number.isFinite(anchor.x) ? anchor : null);
        await page.waitForTimeout(600);
        afterClick = await measure(page);
        checkFrame(afterClick, `${fixture.key} after click @${zoom}x`);
        focused = findFixture(afterClick, { lat: target.lat, lon: target.lon });
      }
      const drift = focused
        ? Math.hypot(
          afterClick.focus.x - focused.anchor.x,
          afterClick.focus.y - focused.anchor.y,
        )
        : null;
      if (drift !== null) {
        check(
          drift <= FOCUS_MATCH_TOLERANCE_PX,
          `${fixture.key}: clicking "${target.name}" focused a point ${drift.toFixed(2)}px from where the label claimed it was (limit ${FOCUS_MATCH_TOLERANCE_PX}px)`,
        );
      }
      console.log([
        `[qa-city-label-anchoring] ${fixture.key} click "${target.name}"`,
        `clicked=(${target.lat}, ${target.lon})`,
        `focused=(${settledFocus.focus.lat}, ${settledFocus.focus.lon})`,
        `measuredAtZoom=${afterClick ? afterClick.zoom.toFixed(2) : "n/a"}`,
        `focusToLabelPx=${drift === null ? "label not re-rendered at any zoom" : drift.toFixed(3)}`,
      ].join(" "));
    }
  }

  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    failures.push(`page errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
  }
  console.log([
    `[qa-city-label-anchoring] ${checks} checks,`,
    `${failures.length} failed,`,
    `${framesMeasured} frames,`,
    `${labelsMeasured} label measurements,`,
    `worst containment ${worstContainment.ratio.toFixed(4)}`,
    `(${worstContainment.where}${worstContainment.name ? `, "${worstContainment.name}"` : ""})`,
  ].join(" "));
  if (failures.length > 0) {
    throw new Error(`[qa-city-label-anchoring] ${failures.join("; ")}`);
  }
  console.log("[qa-city-label-anchoring] place labels stay on the geographic surface at every zoom and through continuous drag");
} finally {
  await context.close();
  await browser.close();
}
