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
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";

// A surface point projects exactly onto the silhouette at the limb, so the
// budget only has to absorb the 0.01px the anchor is published at.
const CONTAINMENT_LIMIT = 1.005;
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

// #196 QA asks for each fixture to be measured centred, well off-centre and
// near the visible limb. The bands are checked against the whole measured
// label population rather than one named place: #79 collision legitimately
// drops any individual label, so requiring a specific city to survive every
// frame would test the collision budget instead of the anchoring.
const POSITION_BANDS = [
  { key: "centred", min: 0, max: 0.12 },
  { key: "off-centre", min: 0.22, max: 0.6 },
  { key: "near-limb", min: 0.68, max: CONTAINMENT_LIMIT },
];

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
      focus: {
        x: Number(host.dataset.personalPointX),
        y: Number(host.dataset.personalPointY),
      },
    };
  });
}

function containment(sample, anchor) {
  return Math.hypot(anchor.x - sample.centre.x, anchor.y - sample.centre.y)
    / sample.silhouettePx;
}

/**
 * The largest containment ratio this frame can physically produce. At max zoom
 * the globe is far wider than the window, so its limb is off-screen and no
 * label can be rendered near it; asserting a near-limb sample there would be
 * asserting something the projection makes impossible.
 */
function reachableContainment(sample) {
  const halfDiagonal = Math.hypot(VIEWPORT.width / 2, VIEWPORT.height / 2);
  return Math.min(CONTAINMENT_LIMIT, halfDiagonal / sample.silhouettePx);
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

async function setZoom(page, targetZoom) {
  const before = await debug(page);
  if (!before) throw new Error("Particle Earth debug state is unavailable");
  if (Math.abs(before.zoom - targetZoom) > 0.02) {
    await canvasOf(page).evaluate((node, init) => node.dispatchEvent(new WheelEvent("wheel", init)), {
      bubbles: true,
      cancelable: true,
      clientX: VIEWPORT.width / 2,
      clientY: VIEWPORT.height / 2,
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

/**
 * Camera distance in globe-local units, derived from the two published pixel
 * radii rather than hard-coded. Both share the same focal length, so
 * silhouette/interaction = (d - R) / sqrt(d^2 - R^2) = sqrt((d - R)/(d + R)),
 * which inverts to d = R (1 + r^2) / (1 - r^2). Used only to size the drag
 * that walks the framing out toward the limb.
 */
function horizonRadians(sample) {
  const worldRadius = sample.surfaceRadius * sample.scale;
  const ratioSquared = (sample.silhouettePx / sample.interactionRadiusPx) ** 2;
  const cameraDistance = worldRadius * (1 + ratioSquared) / (1 - ratioSquared);
  return Math.acos(Math.min(1, worldRadius / cameraDistance));
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
  let worst = { ratio: 0, label: null };
  for (const label of sample.labels) {
    const ratio = containment(sample, label.anchor);
    if (ratio > worst.ratio) worst = { ratio, label };
  }
  if (worst.ratio > worstContainment.ratio) {
    worstContainment = { ratio: worst.ratio, where, name: worst.label?.name ?? "" };
  }
  check(
    worst.ratio <= CONTAINMENT_LIMIT,
    `${where}: place label "${worst.label?.name}" projects ${worst.ratio.toFixed(4)} of the way out of the geographic silhouette (limit ${CONTAINMENT_LIMIT}) - it is anchored above the map surface`,
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

      const seenBands = new Map(POSITION_BANDS.map((band) => [band.key, false]));
      const observed = [];
      const record = (sample) => {
        for (const item of sample.labels) {
          const ratio = containment(sample, item.anchor);
          for (const band of POSITION_BANDS) {
            if (ratio >= band.min && ratio <= band.max) seenBands.set(band.key, true);
          }
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

      const reachable = reachableContainment(settled);
      for (const band of POSITION_BANDS) {
        if (band.min > reachable) continue;
        check(
          seenBands.get(band.key) === true,
          `${label}: no place label was ever measured ${band.key} (containment ${band.min}-${band.max}) across ${steps + 1} frames, though ${reachable.toFixed(2)} was reachable`,
        );
      }

      console.log([
        `[qa-city-label-anchoring] ${fixture.key}`,
        `zoom=${settled.zoom.toFixed(3)}`,
        `labels=${settled.labels.length}`,
        `silhouettePx=${settled.silhouettePx.toFixed(1)}`,
        `reachable=${reachable.toFixed(3)}`,
        `rotated=${rotated.toFixed(3)}rad`,
        `fixture=${observed.length > 0 ? `${Math.min(...observed).toFixed(3)}..${Math.max(...observed).toFixed(3)}` : "not rendered"}`,
        `bands=${[...seenBands.entries()].map(([key, seen]) => `${key}:${seen ? "yes" : "-"}`).join(",")}`,
      ].join(" "));
    }

    // #196 acceptance: clicking a place name focuses the place it claimed.
    // The label anchor and the focus signal are projected by two different
    // subsystems, so their agreement after the focus settles is the check that
    // the click does not reveal a hidden geographic mismatch.
    await setZoom(page, 3);
    await page.waitForTimeout(220);
    const beforeClick = await measure(page);
    const target = beforeClick.labels
      .map((item) => ({ item, distance: containment(beforeClick, item.anchor) }))
      .sort((one, two) => one.distance - two.distance)[0]?.item ?? null;
    check(Boolean(target), `${fixture.key}: no place label to click at max zoom`);
    if (target) {
      await page
        .locator(`.particle-earth-city[data-city-lat="${target.lat.toFixed(4)}"][data-city-lon="${target.lon.toFixed(4)}"]`)
        .first()
        .click({ force: true });
      // Focusing a picked point flies the globe and drops it to a low zoom for
      // the flight. Zooming before the flight ends would cancel it - a wheel
      // claims manual interaction - and measure a half-finished framing.
      await waitForFocusToSettle(page);
      await setZoom(page, 3);
      await page.waitForTimeout(500);
      const afterClick = await measure(page);
      const focused = findFixture(afterClick, { lat: target.lat, lon: target.lon });
      check(Boolean(focused), `${fixture.key}: the "${target.name}" label was not rendered after being clicked and focused`);
      if (focused) {
        const drift = Math.hypot(
          afterClick.focus.x - focused.anchor.x,
          afterClick.focus.y - focused.anchor.y,
        );
        check(
          drift <= FOCUS_MATCH_TOLERANCE_PX,
          `${fixture.key}: clicking "${target.name}" focused a point ${drift.toFixed(2)}px from where the label claimed it was (limit ${FOCUS_MATCH_TOLERANCE_PX}px)`,
        );
        checkFrame(afterClick, `${fixture.key} after click`);
        console.log([
          `[qa-city-label-anchoring] ${fixture.key} click "${target.name}"`,
          `clicked=(${target.anchor.x.toFixed(1)}, ${target.anchor.y.toFixed(1)})`,
          `focusSignal=(${afterClick.focus.x.toFixed(1)}, ${afterClick.focus.y.toFixed(1)})`,
          `labelAnchor=(${focused.anchor.x.toFixed(1)}, ${focused.anchor.y.toFixed(1)})`,
          `focusToLabelPx=${drift.toFixed(3)}`,
        ].join(" "));
      }
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
