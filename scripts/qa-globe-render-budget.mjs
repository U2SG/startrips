// #247 - finite Particle drawing-buffer cost + product-state cover suspension.
// #88 - visited-imprint field stays bounded and captures real visual evidence.
import { mkdirSync } from "node:fs";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const imprintArtifactDir = "artifacts/visited-imprint";
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

async function openFixture({ width, height, dpr, routeOptics = false }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?qaState=journey-routes&qaRenderBudget=1&qaQuality=high&qaMotion=animate${routeOptics ? "&qaRouteOptics=1" : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await page.waitForFunction(() => window.__particleEarthDebug?.().drawingBufferPixels > 0);
  return { context, page, errors };
}

async function checkParticleBackendDegradation() {
  for (const failure of ["no-webgl", "renderer-throw"]) {
    for (const motion of ["animate", "reduce"]) {
      const context = await browser.newContext({ viewport: { width: 932, height: 620 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      const consoleErrors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.goto(
        `${origin}/?qaState=earth-dive&qaMotion=${motion}&qaParticleEarthFailure=${failure}`,
        { waitUntil: "domcontentloaded" },
      );
      await page.waitForFunction(() => (
        document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-particle-earth-backend") === "unavailable"
      ));
      const beforeJourneyId = await page.locator("[data-qa-earth-dive-route-point]").getAttribute("data-journey-id");
      await page.locator('[data-qa-earth-dive-route-switch="next"]').click();
      await page.waitForFunction((before) => (
        document.querySelector("[data-qa-earth-dive-route-point]")?.getAttribute("data-journey-id") !== before
      ), beforeJourneyId);
      const snapshot = await page.evaluate(() => {
        const host = document.querySelector("[data-persistent-earth-host]");
        return {
          backend: host?.getAttribute("data-particle-earth-backend"),
          canvases: host?.querySelectorAll("canvas").length ?? -1,
          routeSwitchPresent: Boolean(document.querySelector('[data-qa-earth-dive-route-switch="next"]')),
          refocusPresent: Boolean(document.querySelector("[data-qa-earth-dive-refocus]")),
        };
      });
      const webglCreationErrors = consoleErrors.filter((message) => (
        /WebGLRenderer|Could not create a WebGL context|WebGL context.*could not/i.test(message)
      ));
      record(`backend:${failure}:${motion}`, {
        snapshot,
        errors,
        consoleErrors: webglCreationErrors,
      }, snapshot.backend === "unavailable"
        && snapshot.canvases === 0
        && snapshot.routeSwitchPresent
        && snapshot.refocusPresent
        && errors.length === 0
        && webglCreationErrors.length === 0);
      await context.close();
    }
  }

  const context = await browser.newContext({ viewport: { width: 932, height: 620 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?qaState=earth-dive&qaMotion=animate`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (
    document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-particle-earth-backend") === "webgl2"
  ));
  const beforeJourneyId = await page.locator("[data-qa-earth-dive-route-point]").getAttribute("data-journey-id");
  await page.locator(".particle-earth-scene canvas").evaluate((canvas) => {
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  });
  await page.waitForFunction(() => (
    document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-particle-earth-backend") === "unavailable"
  ));
  await page.locator('[data-qa-earth-dive-route-switch="next"]').click();
  await page.waitForFunction((before) => (
    document.querySelector("[data-qa-earth-dive-route-point]")?.getAttribute("data-journey-id") !== before
  ), beforeJourneyId);
  const lost = await page.evaluate(() => {
    const host = document.querySelector("[data-persistent-earth-host]");
    return {
      backend: host?.getAttribute("data-particle-earth-backend"),
      canvases: host?.querySelectorAll("canvas").length ?? -1,
    };
  });
  record("backend:runtime-context-loss", { lost, errors }, lost.backend === "unavailable"
    && lost.canvases === 0
    && errors.length === 0);
  await context.close();
}

async function checkRouteReuse() {
  const run = await openFixture({ width: 1280, height: 900, dpr: 1, routeOptics: true });
  const { page } = run;
  const southwest = "qa-route-southwest";
  const rhine = "qa-route-rhine";
  const geometrySelector = ".particle-earth-route, .particle-earth-route > path, .particle-earth-route > circle";
  const click = async (selector) => page.locator(selector).evaluate((button) => button.click());
  const waitForProjection = () => page.waitForFunction(() => (
    window.__particleEarthDebug?.().journeyRouteProjectionReady === true
  ));
  await waitForProjection();
  const initial = await page.evaluate((selector) => {
    window.__routeReuseNodes = [...document.querySelectorAll(selector)];
    return window.__particleEarthDebug();
  }, geometrySelector);
  record("routes:initial-build-once", { builds: initial.journeyRouteBuilds }, initial.journeyRouteBuilds === 1);

  const snapshot = () => page.evaluate((selector) => {
    const debug = window.__particleEarthDebug();
    const nodes = [...document.querySelectorAll(selector)];
    const groups = [...document.querySelectorAll(".particle-earth-route")];
    return {
      builds: debug.journeyRouteBuilds,
      buildMs: debug.journeyRouteBuildMs,
      geometry: debug.journeyRoutePointGeometry,
      sameNodes: nodes.length === window.__routeReuseNodes.length
        && nodes.every((node, index) => node === window.__routeReuseNodes[index]),
      routes: groups.map((group) => ({
        id: group.dataset.journeyRoute,
        state: ["is-active", "is-muted", "is-idle"].find((value) => group.classList.contains(value)),
        labels: [...group.querySelectorAll(".particle-earth-route__label")].map((label) => ({
          index: Number(label.dataset.routePointIndex),
          text: label.dataset.routeLabel,
          visible: label.style.display !== "none",
        })),
        temporal: group.dataset.temporalReveal ?? null,
        points: [...group.querySelectorAll(".particle-earth-route__point")].map((point) => ({
          id: point.dataset.routePointId,
          attention: point.dataset.attentionRole,
          temporalVisible: point.dataset.temporalVisible,
          temporal: point.dataset.temporalReveal ?? null,
        })),
        legs: [...group.querySelectorAll(".particle-earth-route__leg")].map((leg) => leg.dataset.temporalReveal ?? null),
        stroke: group.querySelector(".particle-earth-route__core")?.getAttribute("stroke"),
      })),
    };
  }, geometrySelector);
  const unchangedGeometry = (state) => state.sameNodes
    && state.builds === initial.journeyRouteBuilds
    && state.buildMs === initial.journeyRouteBuildMs
    && state.geometry === initial.journeyRoutePointGeometry;
  const selectedCorrectly = (state, activeId) => state.routes.every((route) => (
    route.state === (activeId ? (route.id === activeId ? "is-active" : "is-muted") : "is-idle")
    && (route.id === activeId ? route.labels.length > 0 && route.labels.length <= 24 : route.labels.length === 0)
  ));

  const before = await snapshot();
  record("routes:active-stop-and-selected-labels", { before }, unchangedGeometry(before)
    && selectedCorrectly(before, southwest)
    && before.routes.find((route) => route.id === southwest).labels.map((label) => label.index).sort().join(",") === "0,1,2,3,4,5");
  await click(`[data-qa-route="${rhine}"]`);
  await page.waitForFunction((id) => document.querySelector(`.particle-earth-route[data-journey-route="${id}"]`)?.classList.contains("is-active"), rhine);
  await waitForProjection();
  const switched = await snapshot();
  record("routes:A-to-B-reuses-geometry-and-replaces-label-pool", { switched }, unchangedGeometry(switched)
    && selectedCorrectly(switched, rhine)
    && switched.routes.find((route) => route.id === rhine).labels.map((label) => label.index).join(",") === "0,1");
  await click("[data-qa-route-clear]");
  await page.waitForFunction(() => document.querySelectorAll(".particle-earth-route.is-active, .particle-earth-route.is-muted").length === 0);
  await waitForProjection();
  const cleared = await snapshot();
  record("routes:B-to-none-reuses-geometry-and-clears-labels", { cleared }, unchangedGeometry(cleared)
    && selectedCorrectly(cleared, null));

  await click('[data-qa-route-optics-stage="rewound"]');
  await page.waitForFunction((id) => document.querySelector(`.particle-earth-route[data-journey-route="${id}"]`)?.dataset.temporalReveal === "0.220", southwest);
  await click(`[data-qa-route="${southwest}"]`);
  await page.waitForFunction((id) => document.querySelector(`.particle-earth-route[data-journey-route="${id}"]`)?.classList.contains("is-active"), southwest);
  await waitForProjection();
  const rewound = await snapshot();
  const rewoundRoute = rewound.routes.find((route) => route.id === southwest);
  record("routes:reactivation-keeps-rewind-and-narrative-labels", { rewound }, unchangedGeometry(rewound)
    && selectedCorrectly(rewound, southwest)
    && rewoundRoute.temporal === "0.220"
    && rewoundRoute.points[1].attention === "narrative-current"
    && rewoundRoute.labels.some((label) => label.index === 1)
    && rewoundRoute.points.slice(2).every((point) => point.temporalVisible === "false")
    && rewoundRoute.points.slice(2).every((point) => point.temporal === "0.000")
    && rewoundRoute.legs.slice(1).every((progress) => progress === "0.000")
    && rewoundRoute.labels.filter((label) => label.index >= 2).every((label) => !label.visible));

  await click('[data-qa-route-data="updated"]');
  await page.waitForFunction((builds) => window.__particleEarthDebug?.().journeyRouteBuilds > builds, initial.journeyRouteBuilds);
  await waitForProjection();
  const updated = await snapshot();
  const updatedRoute = updated.routes.find((route) => route.id === southwest);
  record("routes:same-IDs-with-new-data-rebuild-geometry", { updated }, !updated.sameNodes
    && updated.builds === initial.journeyRouteBuilds + 1
    && updated.geometry !== initial.journeyRoutePointGeometry
    && updatedRoute.stroke === "#e486b4"
    && updatedRoute.points.map((point) => point.id).join(",") === "qa-p-15,qa-p-17,qa-p-16,qa-p-18,qa-p-19,qa-p-20"
    && updatedRoute.points.slice(2).every((point) => point.temporal === "0.000")
    && updatedRoute.legs.slice(1).every((progress) => progress === "0.000")
    && selectedCorrectly(updated, southwest));
  await click('[data-qa-route-data="original"]');
  await page.waitForFunction((builds) => window.__particleEarthDebug?.().journeyRouteBuilds > builds, updated.builds);
  await waitForProjection();
  const restored = await snapshot();
  const restoredRoute = restored.routes.find((route) => route.id === southwest);
  record("routes:data-restore-rebuilds-and-restores-order", { restored, errors: run.errors }, restored.builds === updated.builds + 1
    && restored.geometry !== updated.geometry
    && restoredRoute.stroke === "#f4ce73"
    && restoredRoute.points.map((point) => point.id).join(",") === "qa-p-15,qa-p-16,qa-p-17,qa-p-18,qa-p-19,qa-p-20"
    && restoredRoute.points.slice(2).every((point) => point.temporal === "0.000")
    && restoredRoute.legs.slice(1).every((progress) => progress === "0.000")
    && run.errors.length === 0);
  await run.context.close();
}

async function captureImprintStage(stage) {
  const context = await browser.newContext({
    viewport: { width: 932, height: 620 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${origin}/?qaState=journey-routes&qaImprint=1&qaImprintStage=${stage}&qaQuality=high&qaFocusLat=30&qaFocusLon=110`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(() => {
    const state = window.__particleEarthDebug?.();
    return Boolean(state && state.particleBaseCount > 0 && state.visitedImprintRegions > 0);
  });
  await page.waitForTimeout(160);
  const state = await page.evaluate(() => window.__particleEarthDebug?.());
  await page.locator(".particle-earth-scene").screenshot({
    path: `${imprintArtifactDir}/${stage}.png`,
  });
  return { context, page, errors, state };
}

try {
  await checkParticleBackendDegradation();
  await checkRouteReuse();
  for (const fixture of [
    { key: "dpr-1", width: 430, height: 932, dpr: 1 },
    { key: "dpr-2", width: 430, height: 932, dpr: 2 },
    { key: "dpr-3", width: 430, height: 932, dpr: 3 },
    { key: "large-dpr-3", width: 1920, height: 1080, dpr: 3 },
  ]) {
    const run = await openFixture(fixture);
    const state = await run.page.evaluate(() => window.__particleEarthDebug?.());
    const finite = Boolean(state) && Number.isFinite(state.pixelRatio) && state.pixelRatio > 0
      && Number.isFinite(state.drawingBufferPixels) && state.drawingBufferPixels > 0
      && state.drawingBufferPixels <= 4_010_000;
    record(`budget:${fixture.key}`, { fixture, state, errors: run.errors }, finite && run.errors.length === 0);
    await run.context.close();
  }

  const run = await openFixture({ width: 932, height: 430, dpr: 3 });
  const { page } = run;
  const viewportBeforeQuality = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const highBefore = await page.evaluate(() => window.__particleEarthDebug?.());
  await page.locator('[data-qa-render-quality="low"]').click();
  await page.waitForFunction(() => window.__particleEarthDebug?.().quality === "low");
  const lowAfter = await page.evaluate(() => window.__particleEarthDebug?.());
  const viewportAfterLow = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.locator('[data-qa-render-quality="high"]').click();
  await page.waitForFunction(() => window.__particleEarthDebug?.().quality === "high");
  const highAfter = await page.evaluate(() => window.__particleEarthDebug?.());
  const viewportAfterHigh = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  record("budget:quality-high-low-high-without-resize", {
    viewportBeforeQuality,
    viewportAfterLow,
    viewportAfterHigh,
    highBefore,
    lowAfter,
    highAfter,
  }, Boolean(highBefore && lowAfter && highAfter)
    && viewportAfterLow.width === viewportBeforeQuality.width
    && viewportAfterLow.height === viewportBeforeQuality.height
    && viewportAfterHigh.width === viewportBeforeQuality.width
    && viewportAfterHigh.height === viewportBeforeQuality.height
    && highBefore.quality === "high"
    && lowAfter.quality === "low"
    && highAfter.quality === "high"
    && lowAfter.pixelRatio < highBefore.pixelRatio
    && highAfter.pixelRatio === highBefore.pixelRatio
    && lowAfter.drawingBufferPixels < highBefore.drawingBufferPixels
    && highAfter.drawingBufferPixels === highBefore.drawingBufferPixels);
  record("imprint:fixed-field-budget", {
    highBefore,
    lowAfter,
    highAfter,
  }, Boolean(highBefore && lowAfter && highAfter)
    && highBefore.visitedImprintRegions > 0
    && highBefore.visitedImprintMaxGain > 0
    && highBefore.visitedImprintMaxGain <= 0.15001
    && lowAfter.visitedImprintTextureUpdates === highBefore.visitedImprintTextureUpdates
    && highAfter.visitedImprintTextureUpdates === highBefore.visitedImprintTextureUpdates);

  const click = async (state) => page.locator(`[data-qa-render-visibility="${state}"]`).click();

  await click("partial");
  await page.waitForFunction(() => window.__particleEarthDebug?.().renderState === "rendering");
  const partial = await page.evaluate(() => window.__particleEarthDebug?.());
  record("visibility:partial", { state: partial }, partial?.renderState === "rendering");

  await click("transition");
  await page.waitForFunction(() => window.__particleEarthDebug?.().renderState === "rendering");
  const transition = await page.evaluate(() => window.__particleEarthDebug?.());
  record("visibility:transition", { state: transition }, transition?.renderState === "rendering");

  await click("covered");
  await page.waitForFunction(() => window.__particleEarthDebug?.().renderState === "covered");
  const covered = await page.evaluate(() => window.__particleEarthDebug?.());
  await page.waitForTimeout(120);
  const coveredLater = await page.evaluate(() => window.__particleEarthDebug?.());
  record("visibility:stable-cover", { state: covered, later: coveredLater },
    covered?.renderState === "covered"
      && covered?.particleRefinementBuild === "paused"
      && coveredLater?.renderState === "covered");

  await click("reveal");
  await page.waitForFunction(() => window.__particleEarthDebug?.().renderState === "rendering");
  await page.waitForTimeout(40);
  const revealed = await page.evaluate(() => window.__particleEarthDebug?.());
  record("visibility:reveal", { state: revealed, errors: run.errors },
    revealed?.renderState === "rendering"
      && revealed?.lastFrameDeltaMs <= 50.5
      && run.errors.length === 0);
  await run.context.close();

  mkdirSync(imprintArtifactDir, { recursive: true });
  const imprintStages = [];
  for (const stage of ["first", "mid", "now"]) {
    const capture = await captureImprintStage(stage);
    imprintStages.push(capture.state);
    record(`imprint:timeline-${stage}`, {
      state: capture.state,
      errors: capture.errors,
    }, Boolean(capture.state)
      && capture.state.visitedImprintRegions > 0
      && capture.state.visitedImprintMaxGain > 0
      && capture.state.visitedImprintMaxGain <= 0.15001
      && capture.errors.length === 0);
    if (stage === "now") {
      await capture.page.locator(".particle-earth-route-layer").evaluate((element) => {
        element.style.visibility = "hidden";
      });
      const routeHiddenState = await capture.page.evaluate(() => window.__particleEarthDebug?.());
      await capture.page.locator(".particle-earth-scene").screenshot({
        path: `${imprintArtifactDir}/route-strokes-hidden.png`,
      });
      record("imprint:route-strokes-hidden", {
        state: routeHiddenState,
      }, Boolean(routeHiddenState)
        && routeHiddenState.visitedImprintRegions === capture.state.visitedImprintRegions
        && routeHiddenState.visitedImprintMaxGain === capture.state.visitedImprintMaxGain);
    }
    await capture.context.close();
  }
  record("imprint:timeline-monotonic", { imprintStages },
    imprintStages.length === 3
      && imprintStages[0].visitedImprintJourneyContributions
        < imprintStages[1].visitedImprintJourneyContributions
      && imprintStages[1].visitedImprintJourneyContributions
        < imprintStages[2].visitedImprintJourneyContributions);
} finally {
  await browser.close();
}

if (failed) process.exitCode = 1;
