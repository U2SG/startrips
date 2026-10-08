// #247 - Particle Earth render-work harness.
//
// CI runs this in SwiftShader (CPU-emulated GPU), so wall-clock frame time says
// almost nothing about a real phone. The PRIMARY metrics are therefore work
// counts that do not depend on GPU speed: frames the scene actually rendered in
// a fixed window, cumulative renderer draw calls / points, drawing-buffer size
// and effective pixel ratio, refinement requests, GPU resource counts, and the
// page's live timer / listener / rAF counts across repeated cover cycles.
// Frame intervals are reported only under a "swiftshaderNotRepresentative" key.
//
// Diagnostics are whitelisted fields from `window.__particleEarthDebug`: no
// coordinates, Route Point data or media URLs are copied into the artifact.
import { mkdirSync, writeFileSync } from "node:fs";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const artifactDir = process.env.QA_PERF_GLOBE_DIR ?? "artifacts/perf-globe";
const repetitions = Number(process.env.QA_PERF_GLOBE_REPS ?? 3);
const WARMUP_MS = 2_000;
const WINDOW_MS = 2_000;
const LONG_FRAME_MS = 50;
const SCENE_VIEWPORT = { width: 430, height: 932, dpr: 3 };
// The overview fixture has no active Route and no temporal reveal: every Route
// is fully revealed and the camera rests on the preview's fixed focus point.
// Route optics (an active, partly revealed Route) is enabled only for the
// covered narrative-update case, which needs its temporal-reveal stages.
const FIXTURE_PATH = "/?qaState=journey-routes&qaRenderBudget=1&qaMotion=animate";
const OPTICS_QUERY = "&qaRouteOptics=1";

const errors = [];
const apiAbsent = {};
const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

// Page-side instrumentation, installed before any app code. It only counts;
// it never changes scheduling. The harness's own sampler uses the saved
// original rAF so it is not counted as app work.
function installProbe() {
  const live = { timeouts: new Set(), intervals: new Set(), raf: new Set() };
  let rafCallbacks = 0;
  const original = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  window.__perfOriginalRaf = original.requestAnimationFrame;
  window.setTimeout = (handler, ms, ...args) => {
    let id = 0;
    const run = typeof handler === "function"
      ? (...callArgs) => { live.timeouts.delete(id); return handler(...callArgs); }
      : handler;
    id = original.setTimeout(run, ms, ...args);
    live.timeouts.add(id);
    return id;
  };
  window.clearTimeout = (id) => { live.timeouts.delete(id); original.clearTimeout(id); };
  window.setInterval = (handler, ms, ...args) => {
    const id = original.setInterval(handler, ms, ...args);
    live.intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => { live.intervals.delete(id); original.clearInterval(id); };
  window.requestAnimationFrame = (callback) => {
    let id = 0;
    id = original.requestAnimationFrame((time) => {
      live.raf.delete(id);
      rafCallbacks += 1;
      callback(time);
    });
    live.raf.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => { live.raf.delete(id); original.cancelAnimationFrame(id); };

  const listenerKeys = new WeakMap();
  const listenerCounts = { window: 0, document: 0, other: 0 };
  const kindOf = (target) => (target === window ? "window" : target === document ? "document" : "other");
  const keyOf = (type, options) => `${type}|${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    if (listener && !(typeof options === "object" && (options?.once || options?.signal))) {
      let byKey = listenerKeys.get(this);
      if (!byKey) { byKey = new Map(); listenerKeys.set(this, byKey); }
      const key = keyOf(type, options);
      let set = byKey.get(key);
      if (!set) { set = new Set(); byKey.set(key, set); }
      if (!set.has(listener)) { set.add(listener); listenerCounts[kindOf(this)] += 1; }
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
    const set = listenerKeys.get(this)?.get(keyOf(type, options));
    if (set?.delete(listener)) listenerCounts[kindOf(this)] -= 1;
    return remove.call(this, type, listener, options);
  };

  window.__perfProbe = () => ({
    liveTimeouts: live.timeouts.size,
    liveIntervals: live.intervals.size,
    pendingRaf: live.raf.size,
    rafCallbacks,
    listeners: { ...listenerCounts },
  });
}

const DEBUG_FIELDS = [
  "canvases", "geometries", "textures", "quality", "pixelRatio", "drawingBufferPixels",
  "drawingBufferWidth", "drawingBufferHeight", "renderState", "lastFrameDeltaMs",
  "sceneFrameRevision", "renderCallsTotal", "renderPointsTotal", "particleRefinementRequests",
  "coastlineRefinementRequests", "particleCount", "particleRefinementCount", "particleRefinementBuild",
  "coastlineRefinement", "semanticLod", "manualFocusOwner",
];

async function read(page) {
  return page.evaluate((fields) => {
    const debug = window.__particleEarthDebug?.() ?? null;
    const picked = debug ? Object.fromEntries(fields.map((field) => [field, debug[field] ?? null])) : null;
    return {
      debug: picked,
      probe: window.__perfProbe?.() ?? null,
      canvasCount: document.querySelectorAll('canvas[data-three-scene="particle-earth"]').length,
      canvasMarked: document.querySelector('canvas[data-three-scene="particle-earth"]')?.dataset.perfMark === "1",
      cssViewport: { width: window.innerWidth, height: window.innerHeight },
      deviceDpr: window.devicePixelRatio,
      at: performance.now(),
    };
  }, DEBUG_FIELDS);
}

// Sample frame timestamps from the scene's own per-frame revision attribute.
async function startSampler(page) {
  await page.evaluate(() => {
    const host = document.querySelector('canvas[data-three-scene="particle-earth"]')?.parentElement;
    const sampler = { stamps: [], running: true, last: host?.dataset.sceneFrameRevision ?? null };
    window.__perfSampler = sampler;
    const tick = () => {
      if (!sampler.running) return;
      const revision = host?.dataset.sceneFrameRevision ?? null;
      if (revision !== sampler.last) {
        sampler.last = revision;
        sampler.stamps.push(performance.now());
      }
      window.__perfOriginalRaf(tick);
    };
    window.__perfOriginalRaf(tick);
  });
}

async function stopSampler(page) {
  return page.evaluate(() => {
    const sampler = window.__perfSampler;
    sampler.running = false;
    return sampler.stamps;
  });
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function intervalStats(stamps) {
  const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]).sort((a, b) => a - b);
  return {
    samples: intervals.length,
    medianMs: quantile(intervals, 0.5),
    p95Ms: quantile(intervals, 0.95),
    maxMs: intervals.at(-1) ?? null,
    longFramesOver50Ms: intervals.filter((value) => value > LONG_FRAME_MS).length,
  };
}

function delta(start, end, field) {
  const a = start.debug?.[field];
  const b = end.debug?.[field];
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

async function measure(page, name, { windowMs = WINDOW_MS, during = null } = {}) {
  const start = await read(page);
  await startSampler(page);
  const began = Date.now();
  if (during) await during();
  const remaining = windowMs - (Date.now() - began);
  if (remaining > 0) await page.waitForTimeout(remaining);
  const stamps = await stopSampler(page);
  const end = await read(page);
  const elapsedMs = end.at - start.at;
  return {
    name,
    windowMs: Math.round(elapsedMs),
    framesRendered: delta(start, end, "sceneFrameRevision"),
    renderCalls: delta(start, end, "renderCallsTotal"),
    renderPoints: delta(start, end, "renderPointsTotal"),
    particleRefinementRequests: delta(start, end, "particleRefinementRequests"),
    coastlineRefinementRequests: delta(start, end, "coastlineRefinementRequests"),
    rafCallbacks: start.probe && end.probe ? end.probe.rafCallbacks - start.probe.rafCallbacks : null,
    renderStateStart: start.debug?.renderState ?? null,
    renderStateEnd: end.debug?.renderState ?? null,
    quality: end.debug?.quality ?? null,
    pixelRatio: end.debug?.pixelRatio ?? null,
    drawingBuffer: {
      width: end.debug?.drawingBufferWidth ?? null,
      height: end.debug?.drawingBufferHeight ?? null,
      pixels: end.debug?.drawingBufferPixels ?? null,
    },
    particleCount: end.debug?.particleCount ?? null,
    particleRefinementCount: end.debug?.particleRefinementCount ?? null,
    particleRefinementBuild: end.debug?.particleRefinementBuild ?? null,
    coastlineRefinement: end.debug?.coastlineRefinement ?? null,
    semanticLod: end.debug?.semanticLod ?? null,
    geometries: end.debug?.geometries ?? null,
    textures: end.debug?.textures ?? null,
    swiftshaderNotRepresentative: intervalStats(stamps),
  };
}

const clickQa = (page, selector) => page.locator(selector).evaluate((button) => button.click());

async function globeCenter(page) {
  const box = await page.locator('canvas[data-three-scene="particle-earth"]').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.45 };
}

async function drag(page, steps, stepPx) {
  const center = await globeCenter(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  for (let index = 0; index < steps; index += 1) {
    const direction = Math.floor(index / 10) % 2 === 0 ? 1 : -1;
    await page.mouse.move(center.x + direction * stepPx * (index % 10), center.y + 2 * (index % 5));
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
}

async function setDocumentHidden(page, hidden) {
  await page.evaluate((nextHidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => nextHidden });
    Object.defineProperty(document, "visibilityState", {
      configurable: true, get: () => (nextHidden ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

// The first frame after a resume: its wall-clock delta must be clamped (no
// catch-up animation) and the canvas must be the same element (no remount).
async function firstFrameAfter(page, action) {
  const before = await read(page);
  await action();
  await page.waitForFunction((revision) => (
    (window.__particleEarthDebug?.().sceneFrameRevision ?? 0) > revision
  ), before.debug.sceneFrameRevision, { timeout: 10_000, polling: "raf" });
  const after = await read(page);
  return {
    firstFrameDeltaMs: after.debug.lastFrameDeltaMs,
    sameCanvas: after.canvasMarked && after.canvasCount === 1,
    renderState: after.debug.renderState,
  };
}

async function openScene({ width, height, dpr }, quality, extraQuery = "") {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  await context.addInitScript(installProbe);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push({ source: "pageerror", message: error.message }));
  // Browser QA serves the client from Vite with no API behind it, so an
  // unstubbed `/api/*` read answers 5xx from the proxy. That is a property of
  // the harness, not of the scene: record those paths separately and keep
  // every other failed resource and console error as a harness error.
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const { pathname } = new URL(response.url());
    if (pathname.startsWith("/api/")) {
      apiAbsent[pathname] = (apiAbsent[pathname] ?? 0) + 1;
    } else {
      errors.push({ source: "response", message: `${response.status()} ${pathname}` });
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource:")) return;
    errors.push({ source: "console", message: message.text() });
  });
  await page.goto(`${origin}${FIXTURE_PATH}${extraQuery}&qaQuality=${quality}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const debug = window.__particleEarthDebug?.();
    return Boolean(debug && debug.drawingBufferPixels > 0 && debug.particleCount > 0
      && debug.journeyRouteProjectionReady);
  }, null, { timeout: 60_000 });
  await page.locator('canvas[data-three-scene="particle-earth"]').evaluate((canvas) => { canvas.dataset.perfMark = "1"; });
  await page.waitForTimeout(WARMUP_MS);
  return { context, page };
}

async function runScenarioPass(pass) {
  const { context, page } = await openScene(SCENE_VIEWPORT, "high");
  const scenarios = [];
  const events = {};
  try {
    events.overviewFixture = await fixtureState(page);
    // 1. Atlas overview, idle and with manual rotation.
    scenarios.push(await measure(page, "overview-idle"));
    scenarios.push(await measure(page, "overview-manual-drag", { during: () => drag(page, 40, 6) }));
    // 2. Near LOD with dense routes: zoom in, drag, then a focus flight.
    for (let step = 0; step < 6; step += 1) {
      const center = await globeCenter(page);
      await page.mouse.move(center.x, center.y);
      await page.mouse.wheel(0, -360);
      await page.waitForTimeout(120);
    }
    scenarios.push(await measure(page, "near-lod-drag", { during: () => drag(page, 40, 4) }));
    scenarios.push(await measure(page, "focus-flight", {
      during: () => clickQa(page, '[data-qa-route="qa-route-rhine"]'),
    }));
    await clickQa(page, '[data-qa-route="qa-route-southwest"]');
    await page.waitForTimeout(1_500);
    // 3. Story in context: part of the globe stays visible.
    await clickQa(page, '[data-qa-render-visibility="partial"]');
    scenarios.push(await measure(page, "story-partial"));
    // 5. Enter transition: media and globe visible together.
    await clickQa(page, '[data-qa-render-visibility="transition"]');
    scenarios.push(await measure(page, "cover-transition", { windowMs: 1_500 }));
    // 4. Opaque fullscreen media stable: the globe is fully invisible.
    await clickQa(page, '[data-qa-render-visibility="covered"]');
    await page.waitForTimeout(500);
    scenarios.push(await measure(page, "covered-stable", { windowMs: 3_000 }));
    // 5b. Exit: the first frame resumes on the same canvas with a clamped delta.
    events.reveal = await firstFrameAfter(page, () => clickQa(page, '[data-qa-render-visibility="reveal"]'));
    scenarios.push(await measure(page, "revealed", { windowMs: 1_500 }));
    // 6. hidden -> visible (synthetic: document.hidden is overridden in-page).
    await setDocumentHidden(page, true);
    await page.waitForTimeout(200);
    scenarios.push(await measure(page, "document-hidden-synthetic"));
    events.visibleAgain = await firstFrameAfter(page, () => setDocumentHidden(page, false));
    scenarios.push(await measure(page, "document-visible-again", { windowMs: 1_500 }));

    // 5 fullscreen -> return cycles: nothing may keep growing.
    const before = await read(page);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await clickQa(page, '[data-qa-render-visibility="transition"]');
      await page.waitForTimeout(150);
      await clickQa(page, '[data-qa-render-visibility="covered"]');
      await page.waitForTimeout(400);
      await clickQa(page, '[data-qa-render-visibility="transition"]');
      await page.waitForTimeout(150);
      await clickQa(page, '[data-qa-render-visibility="reveal"]');
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(500);
    const after = await read(page);
    events.coverCycles = {
      cycles: 5,
      before: { probe: before.probe, geometries: before.debug.geometries, textures: before.debug.textures },
      after: { probe: after.probe, geometries: after.debug.geometries, textures: after.debug.textures },
      growth: {
        liveTimeouts: after.probe.liveTimeouts - before.probe.liveTimeouts,
        liveIntervals: after.probe.liveIntervals - before.probe.liveIntervals,
        pendingRaf: after.probe.pendingRaf - before.probe.pendingRaf,
        windowListeners: after.probe.listeners.window - before.probe.listeners.window,
        documentListeners: after.probe.listeners.document - before.probe.listeners.document,
        otherListeners: after.probe.listeners.other - before.probe.listeners.other,
        geometries: after.debug.geometries - before.debug.geometries,
        textures: after.debug.textures - before.debug.textures,
      },
      sameCanvas: after.canvasMarked && after.canvasCount === 1,
    };
  } finally {
    await context.close();
  }

  // 4b. Covered while narrative state keeps changing underneath, as Playback
  // does when it advances temporal reveal behind media. Its own page enables
  // Route optics; the cover is measured only once the initial Route focus
  // flight has settled and the loop itself reports `covered`.
  const optics = await openScene(SCENE_VIEWPORT, "high", OPTICS_QUERY);
  try {
    events.opticsFixture = await fixtureState(optics.page);
    await clickQa(optics.page, '[data-qa-render-visibility="covered"]');
    await optics.page.waitForFunction(() => window.__particleEarthDebug?.().renderState === "covered", null, { timeout: 30_000 });
    await optics.page.waitForTimeout(500);
    scenarios.push(await measure(optics.page, "covered-narrative-updates", {
      windowMs: 3_000,
      during: async () => {
        for (const stage of ["playing", "rewound", "browse", "playing", "rewound", "browse", "playing", "browse"]) {
          await clickQa(optics.page, `[data-qa-route-optics-stage="${stage}"]`);
          await optics.page.waitForTimeout(300);
        }
      },
    }));
  } finally {
    await optics.context.close();
  }
  return { pass, viewport: SCENE_VIEWPORT, scenarios, events };
}

// What the fixture claims: active Routes and Routes carrying a temporal reveal.
async function fixtureState(page) {
  return page.evaluate(() => {
    const routes = [...document.querySelectorAll(".particle-earth-route")];
    return {
      routes: routes.length,
      activeRoutes: routes.filter((route) => route.classList.contains("is-active")).length,
      temporallyRevealedRoutes: routes.filter((route) => route.dataset.temporalReveal !== undefined).length,
    };
  });
}

async function runBudgetMatrix() {
  const rows = [];
  const viewports = [
    { width: 390, height: 844, dpr: 3 },
    { width: 430, height: 932, dpr: 3 },
    { width: 1280, height: 800, dpr: 1 },
    { width: 1280, height: 800, dpr: 2 },
    { width: 1920, height: 1080, dpr: 2 },
    { width: 2560, height: 1440, dpr: 2 },
  ];
  for (const viewport of viewports) {
    for (const quality of ["high", "low"]) {
      const { context, page } = await openScene(viewport, quality);
      try {
        const state = await read(page);
        rows.push({
          cssViewport: state.cssViewport,
          deviceDpr: state.deviceDpr,
          quality: state.debug.quality,
          effectivePixelRatio: state.debug.pixelRatio,
          drawingBufferWidth: state.debug.drawingBufferWidth,
          drawingBufferHeight: state.debug.drawingBufferHeight,
          drawingBufferPixels: state.debug.drawingBufferWidth * state.debug.drawingBufferHeight,
          budgetPixels: state.debug.drawingBufferPixels,
          particleCount: state.debug.particleCount,
        });
      } finally {
        await context.close();
      }
    }
  }
  return rows;
}

const VISIBLE_SCENARIOS = [
  "overview-idle", "overview-manual-drag", "near-lod-drag", "focus-flight",
  "story-partial", "cover-transition", "revealed", "document-visible-again",
];
const INVISIBLE_SCENARIOS = ["covered-stable", "covered-narrative-updates", "document-hidden-synthetic"];

function summarize(passes) {
  const names = passes[0]?.scenarios.map((scenario) => scenario.name) ?? [];
  const range = (values) => {
    const finite = values.filter(Number.isFinite);
    return finite.length ? { min: Math.min(...finite), max: Math.max(...finite) } : null;
  };
  return names.map((name) => {
    const rows = passes.map((pass) => pass.scenarios.find((scenario) => scenario.name === name)).filter(Boolean);
    return {
      name,
      framesRendered: range(rows.map((row) => row.framesRendered)),
      renderCalls: range(rows.map((row) => row.renderCalls)),
      renderPoints: range(rows.map((row) => row.renderPoints)),
      particleRefinementRequests: range(rows.map((row) => row.particleRefinementRequests)),
      coastlineRefinementRequests: range(rows.map((row) => row.coastlineRefinementRequests)),
      renderStateEnd: [...new Set(rows.map((row) => row.renderStateEnd))],
      drawingBufferPixels: range(rows.map((row) => row.drawingBuffer.pixels)),
      pixelRatio: range(rows.map((row) => row.pixelRatio)),
    };
  });
}

let passes = [];
let budget = [];
let fatal = null;
try {
  for (let pass = 0; pass < repetitions; pass += 1) passes.push(await runScenarioPass(pass));
  budget = await runBudgetMatrix();
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser.close();
}

const summary = summarize(passes);
const proofFailures = [];
for (const name of VISIBLE_SCENARIOS) {
  const row = summary.find((entry) => entry.name === name);
  if (!row || !(row.framesRendered?.min > 0)) proofFailures.push(`${name}: no frames rendered`);
}
// #247 budget: a globe the user cannot see does no render or refinement work.
for (const name of INVISIBLE_SCENARIOS) {
  const row = summary.find((entry) => entry.name === name);
  const work = ["framesRendered", "renderCalls", "renderPoints", "particleRefinementRequests", "coastlineRefinementRequests"];
  if (!row || work.some((field) => row[field]?.max !== 0)) proofFailures.push(`${name}: render work while invisible`);
}
for (const pass of passes) {
  const overview = pass.events.overviewFixture;
  if (!overview || overview.routes === 0 || overview.activeRoutes !== 0 || overview.temporallyRevealedRoutes !== 0) {
    proofFailures.push(`pass ${pass.pass}: overview fixture is focused or partly revealed`);
  }
  for (const key of ["reveal", "visibleAgain"]) {
    const event = pass.events[key];
    if (!event?.sameCanvas) proofFailures.push(`pass ${pass.pass} ${key}: canvas remounted`);
  }
}
const result = {
  harness: "qa-perf-globe",
  issue: 247,
  sourceSha: process.env.QA_BUILD_SHA ?? null,
  environment: {
    gpu: "SwiftShader (CPU-emulated WebGL); frame intervals are not representative of any device",
    warmupMs: WARMUP_MS,
    defaultWindowMs: WINDOW_MS,
    repetitions,
    sceneViewport: SCENE_VIEWPORT,
    fixture: "qaState=journey-routes (synthetic QA routes), quality high, motion animate; overview has no active Route and no temporal reveal; qaRouteOptics=1 only for covered-narrative-updates",
  },
  errorCount: errors.length + (fatal ? 1 : 0),
  errors: errors.slice(0, 20),
  harnessApiAbsent: apiAbsent,
  fatal,
  proof: { visibleScenarios: VISIBLE_SCENARIOS, invisibleScenarios: INVISIBLE_SCENARIOS, failures: proofFailures },
  summary,
  budget,
  passes,
};

mkdirSync(artifactDir, { recursive: true });
writeFileSync(`${artifactDir}/perf-globe.json`, `${JSON.stringify(result, null, 2)}\n`);
const md = [
  `## Particle Earth render work (#247) ${result.sourceSha ? `@ ${result.sourceSha.slice(0, 8)}` : ""}`,
  "",
  `errors: ${result.errorCount}; proof failures: ${proofFailures.length}; repetitions: ${repetitions}`,
  "",
  "| scenario | frames (min-max) | draw calls | points | particle refine req | coast refine req | end state |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...summary.map((row) => {
    const fmt = (value) => (value ? `${value.min}-${value.max}` : "n/a");
    return `| ${row.name} | ${fmt(row.framesRendered)} | ${fmt(row.renderCalls)} | ${fmt(row.renderPoints)} | ${fmt(row.particleRefinementRequests)} | ${fmt(row.coastlineRefinementRequests)} | ${row.renderStateEnd.join(",")} |`;
  }),
  "",
  "| css viewport | device DPR | quality | effective DPR | buffer | pixels |",
  "| --- | --- | --- | --- | --- | --- |",
  ...budget.map((row) => `| ${row.cssViewport.width}x${row.cssViewport.height} | ${row.deviceDpr} | ${row.quality} | ${row.effectivePixelRatio.toFixed(3)} | ${row.drawingBufferWidth}x${row.drawingBufferHeight} | ${row.drawingBufferPixels} |`),
  "",
].join("\n");
writeFileSync(`${artifactDir}/summary.md`, md);
console.log(md);
if (fatal) console.error(fatal);
if (proofFailures.length) console.error(JSON.stringify(proofFailures));
if (result.errorCount > 0 || proofFailures.length > 0) process.exitCode = 1;
