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

async function openFixture({ width, height, dpr }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?qaState=journey-routes&qaRenderBudget=1&qaQuality=high&qaMotion=animate`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await page.waitForFunction(() => window.__particleEarthDebug?.().drawingBufferPixels > 0);
  return { context, page, errors };
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
