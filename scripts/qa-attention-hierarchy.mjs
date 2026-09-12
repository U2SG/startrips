// ST-037 / #246 — cross-state attention hierarchy optical measurement lane.
// This lane records existing values only. It never retunes particle size,
// opacity, motion tokens or shader behavior.
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const VIEWPORT = { width: 1200, height: 800 };
const TARGET_ZOOM = 2.7;
const CSS_SIZE_TOLERANCE_PX = 0.01;
const OPACITY_TOLERANCE = 0.005;
const EXPECTED_LAYER_IDS = [
  "base-particle-surface",
  "spatial-lod-refinement",
  "archive-signal",
  "archive-cluster",
  "cyan-cluster",
  "particle-shell",
  "particle-halo",
  "personal-focus-signal",
];

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const results = [];
let failed = false;

function record(name, data, condition) {
  const row = { name, ...data, failed: !condition };
  results.push(row);
  console.log(JSON.stringify(row));
  if (!condition) failed = true;
}

function parseAttention(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function debug(page) {
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
  }
  await page.waitForFunction((zoom) => {
    const state = window.__particleEarthDebug?.();
    return Boolean(state && Math.abs(state.zoom - zoom) <= 0.03);
  }, targetZoom, { timeout: 10_000 });
}

async function captureAtDpr(deviceDpr) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: deviceDpr,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const url = new URL(
    "/?qaState=journey-routes&qaQuality=high&qaMotion=reduce&qaFocusLat=30&qaFocusLon=110",
    baseUrl,
  ).toString();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.particle-earth-scene[data-scene-ready="true"]').waitFor({ timeout: 25_000 });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await setZoom(page, TARGET_ZOOM);
  await page.waitForFunction(() => {
    const host = document.querySelector(".particle-earth-scene");
    const state = window.__particleEarthDebug?.();
    if (!host || !state || state.particleRefinementBuild !== "ready") return false;
    try {
      const payload = JSON.parse(host.getAttribute("data-attention-layers") ?? "");
      const refinement = payload.layers?.find((layer) => layer.id === "spatial-lod-refinement");
      return Boolean(refinement?.present);
    } catch {
      return false;
    }
  }, null, { timeout: 25_000 });
  // Reduced motion makes the semantic state deterministic, but allow the
  // async refinement layer one rendered frame to publish its final opacity.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));

  const captured = await page.evaluate(() => {
    const host = document.querySelector(".particle-earth-scene");
    const routeCore = document.querySelector(".particle-earth-route.is-active .particle-earth-route__core")
      ?? document.querySelector(".particle-earth-route__core");
    const placeLabel = document.querySelector(".particle-earth-city");
    const routeStyle = routeCore instanceof SVGElement ? getComputedStyle(routeCore) : null;
    const labelStyle = placeLabel instanceof Element ? getComputedStyle(placeLabel) : null;
    return {
      attentionRaw: host?.getAttribute("data-attention-layers") ?? null,
      scene: {
        routeFocusPhase: host?.getAttribute("data-route-focus-phase") ?? null,
        semanticZoom: host?.getAttribute("data-semantic-zoom") ?? null,
      },
      unaffectedReferences: {
        routeCoreStrokeWidth: routeStyle?.strokeWidth ?? null,
        routeCoreOpacity: routeStyle?.opacity ?? null,
        placeLabelFontSize: labelStyle?.fontSize ?? null,
        placeLabelOpacity: labelStyle?.opacity ?? null,
      },
      devicePixelRatio: window.devicePixelRatio,
    };
  });
  const attention = parseAttention(captured.attentionRaw);
  await context.close();
  return { deviceDpr, attention, pageErrors, ...captured };
}

function byId(capture) {
  return new Map((capture.attention?.layers ?? []).map((layer) => [layer.id, layer]));
}

try {
  const captures = [];
  for (const dpr of [1, 2, 3]) {
    const capture = await captureAtDpr(dpr);
    captures.push(capture);
    const ids = (capture.attention?.layers ?? []).map((layer) => layer.id);
    const strong = (capture.attention?.layers ?? []).filter((layer) => layer.strongGlow);
    record(`attention:dpr-${dpr}`, {
      deviceDpr: dpr,
      rendererDpr: capture.attention?.rendererPixelRatio ?? null,
      layers: capture.attention?.layers ?? null,
      unaffectedReferences: capture.unaffectedReferences,
      pageErrors: capture.pageErrors,
    }, Boolean(capture.attention)
      && JSON.stringify(ids) === JSON.stringify(EXPECTED_LAYER_IDS)
      && capture.attention.layers.every((layer) => layer.present)
      && strong.length <= 1
      && capture.pageErrors.length === 0);
  }

  const baseline = byId(captures[0]);
  for (const capture of captures.slice(1)) {
    const current = byId(capture);
    for (const id of EXPECTED_LAYER_IDS) {
      const base = baseline.get(id);
      const next = current.get(id);
      const sizeDelta = Math.abs((next?.cssOpticalSizePx ?? Number.NaN) - (base?.cssOpticalSizePx ?? Number.NaN));
      const opacityDelta = Math.abs((next?.opacity ?? Number.NaN) - (base?.opacity ?? Number.NaN));
      record(`attention:dpr-invariant:${id}:${capture.deviceDpr}`, {
        id,
        deviceDpr: capture.deviceDpr,
        baseline: base ?? null,
        measured: next ?? null,
        sizeDelta,
        opacityDelta,
        cssSizeTolerancePx: CSS_SIZE_TOLERANCE_PX,
        opacityTolerance: OPACITY_TOLERANCE,
      }, Boolean(base && next)
        && sizeDelta <= CSS_SIZE_TOLERANCE_PX
        && opacityDelta <= OPACITY_TOLERANCE);
    }
  }

  record("attention:single-strong-glow-owner", {
    captures: captures.map((capture) => ({
      deviceDpr: capture.deviceDpr,
      strongGlowLayers: (capture.attention?.layers ?? [])
        .filter((layer) => layer.strongGlow)
        .map((layer) => layer.id),
    })),
  }, captures.every((capture) => (
    (capture.attention?.layers ?? []).filter((layer) => layer.strongGlow).length <= 1
  )));

  console.log(JSON.stringify({
    summary: "attention-hierarchy",
    viewport: VIEWPORT,
    targetZoom: TARGET_ZOOM,
    cssSizeTolerancePx: CSS_SIZE_TOLERANCE_PX,
    opacityTolerance: OPACITY_TOLERANCE,
    captures: captures.map((capture) => ({
      deviceDpr: capture.deviceDpr,
      rendererDpr: capture.attention?.rendererPixelRatio ?? null,
      layers: capture.attention?.layers ?? [],
      unaffectedReferences: capture.unaffectedReferences,
    })),
    failed,
  }, null, 2));
} finally {
  await browser.close();
}

if (failed) process.exitCode = 1;
