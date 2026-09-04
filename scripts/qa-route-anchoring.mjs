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
  console.log("[qa-route-anchoring] route endpoints stay anchored and the arc attenuates with zoom");
} finally {
  await context.close();
  await browser.close();
}
