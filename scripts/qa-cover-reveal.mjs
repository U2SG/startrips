// #367 slice 3 - the vendored cover reveal renderer, driven in a real browser.
//
// What this lane exists to prove, and nothing else: the first painted frame is
// the supplied generated image, the final frame is the canonical original
// cover, a viewer interruption ends the reveal at the cover immediately,
// teardown leaves no animation-frame loop, WebGL context or listener behind,
// and every honest degradation - reduced motion, no WebGL2, a failed generated
// asset, a hidden tab, a lost graphics context and a renderer that cannot be
// constructed - still ends on the canonical original cover.
import { mkdirSync, writeFileSync } from "node:fs";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const artifactDir = "artifacts/cover-reveal";
mkdirSync(artifactDir, { recursive: true });

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

async function openPreview({ mode, reducedMotion = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 620 },
    deviceScaleFactor: 2,
    ...(reducedMotion ? { reducedMotion: "reduce" } : {}),
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const query = mode ? `&qaMode=${mode}` : "";
  await page.goto(`${origin}/?qaState=cover-reveal${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__coverRevealDebug === "function");
  return { context, page, errors };
}

const debugState = (page) => page.evaluate(() => window.__coverRevealDebug());

try {
  // 1. A full reveal: first painted frame is the generated image, final frame
  //    is the original cover.
  {
    const run = await openPreview();
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "revealing");
    await page.waitForFunction(
      () => window.__coverRevealDebug().phase === "settled",
      undefined,
      { timeout: 30_000 },
    );
    const state = await debugState(page);
    await page.screenshot({ path: `${artifactDir}/full-reveal-settled.png` });
    record("reveal:first-frame-is-generated-image", { state, errors: run.errors },
      state.firstFrame?.image === "generated-first" && state.firstFrame?.progress === 0);
    record("reveal:final-frame-is-original-cover", { lastFrame: state.lastFrame },
      state.lastFrame?.image === "original-cover" && state.progress === 1);
    record("reveal:used-the-webgl2-backend", {
      backend: state.backend,
      degraded: state.degraded,
      settleReason: state.settleReason,
      frameCount: state.frameCount,
    }, state.backend === "webgl2" && state.degraded === false
      && state.settleReason === "completed" && state.frameCount > 1);
    const canvasBudget = await page.evaluate(() => {
      const container = document.querySelector("[data-cover-reveal-max-pixels]");
      const canvas = container?.querySelector("canvas");
      return {
        cap: Number(container?.getAttribute("data-cover-reveal-max-pixels")),
        resolved: Number(container?.getAttribute("data-cover-reveal-budget-pixels")),
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
      };
    });
    record("reveal:canvas-stays-inside-the-declared-budget", { canvasBudget },
      canvasBudget.width > 0 && canvasBudget.height > 0 && canvasBudget.cap > 0
      && canvasBudget.width * canvasBudget.height <= canvasBudget.cap
      && canvasBudget.resolved <= canvasBudget.cap);
    record("reveal:no-page-errors", { errors: run.errors }, run.errors.length === 0);
    await run.context.close();
  }

  // 2. A viewer interruption ends the reveal at the cover immediately.
  {
    const run = await openPreview();
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "revealing");
    await page.waitForFunction(() => window.__coverRevealDebug().progress > 0.05);
    const before = await debugState(page);
    await page.locator("[data-cover-reveal-phase]").click({ position: { x: 20, y: 20 } });
    const after = await debugState(page);
    await page.screenshot({ path: `${artifactDir}/interrupted.png` });
    record("interrupt:settles-immediately", {
      progressBefore: before.progress,
      phaseBefore: before.phase,
      after: { phase: after.phase, settleReason: after.settleReason, progress: after.progress },
    }, before.phase === "revealing" && before.progress < 1
      && after.phase === "settled" && after.settleReason === "interrupted");
    record("interrupt:final-frame-is-original-cover", { lastFrame: after.lastFrame },
      after.lastFrame?.image === "original-cover");

    // No further frames may arrive once the viewer has ended the reveal.
    const framesAtInterrupt = after.frames;
    await page.waitForTimeout(600);
    const settled = await debugState(page);
    record("interrupt:no-frames-after-settling", {
      framesAtInterrupt,
      framesLater: settled.frames,
      phase: settled.phase,
      errors: run.errors,
    }, settled.frames === framesAtInterrupt && settled.phase === "settled"
      && run.errors.length === 0);
    await run.context.close();
  }

  // 3. Teardown leaves nothing running.
  {
    const run = await openPreview();
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "revealing");
    await page.locator("[data-qa-cover-reveal-teardown]").click();
    await page.waitForFunction(() => window.__coverRevealDebug().mounted === false);
    // Poke the listeners the renderer installs. A surviving handler would
    // schedule work or throw here.
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(700);
    const state = await debugState(page);
    const framesAfter = state.frames;
    await page.waitForTimeout(500);
    const later = await debugState(page);
    record("teardown:no-animation-frame-loop-remains", {
      pendingAnimationFrames: state.pendingAnimationFrames,
      framesAfter,
      framesLater: later.frames,
    }, state.pendingAnimationFrames === 0 && later.frames === framesAfter);
    record("teardown:webgl-context-released", {
      canvasConnected: state.canvasConnected,
      webglContextLost: state.webglContextLost,
    }, state.canvasConnected === false && state.webglContextLost === true);
    record("teardown:no-listener-errors", { errors: run.errors }, run.errors.length === 0);
    await run.context.close();
  }

  // 4. Reduced motion resolves straight to the cover with no reveal frames.
  {
    const run = await openPreview({ mode: "reduced-motion", reducedMotion: true });
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "settled");
    // The settled surface is an image element, so wait for its first sample.
    await page.waitForFunction(() => window.__coverRevealDebug().lastFrame !== null);
    const state = await debugState(page);
    await page.screenshot({ path: `${artifactDir}/reduced-motion.png` });
    record("reduced-motion:settles-on-original-cover-without-frames", {
      state: {
        phase: state.phase,
        settleReason: state.settleReason,
        frameCount: state.frameCount,
        degraded: state.degraded,
        lastFrame: state.lastFrame,
      },
      errors: run.errors,
    }, state.phase === "settled" && state.settleReason === "reduced-motion"
      && state.frameCount === 0 && state.degraded === false
      && state.lastFrame?.image === "original-cover" && run.errors.length === 0);
    await run.context.close();
  }

  // 5. Without WebGL2 the fallback is honest: the cover, and a degraded flag.
  {
    const run = await openPreview({ mode: "no-webgl2" });
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "settled");
    await page.waitForFunction(() => window.__coverRevealDebug().lastFrame !== null);
    const state = await debugState(page);
    await page.screenshot({ path: `${artifactDir}/no-webgl2.png` });
    record("no-webgl2:degrades-truthfully-to-the-original-cover", {
      state: {
        phase: state.phase,
        settleReason: state.settleReason,
        degraded: state.degraded,
        frameCount: state.frameCount,
        lastFrame: state.lastFrame,
      },
      errors: run.errors,
    }, state.phase === "settled" && state.settleReason === "no-webgl2"
      && state.degraded === true && state.frameCount === 0
      && state.lastFrame?.image === "original-cover" && run.errors.length === 0);
    await run.context.close();
  }
  // 6. A failed generated asset hands the viewer the real cover, not an
  //    unpainted canvas.
  {
    const run = await openPreview({ mode: "load-failure" });
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "settled");
    await page.waitForFunction(() => window.__coverRevealDebug().lastFrame !== null);
    const state = await debugState(page);
    const surfaces = await page.evaluate(() => ({
      coverImage: Boolean(document.querySelector('[data-cover-reveal-image="original-cover"]')),
      canvases: document.querySelectorAll("[data-cover-reveal-phase] canvas").length,
    }));
    await page.screenshot({ path: `${artifactDir}/load-failure.png` });
    record("load-failure:shows-the-original-cover-not-an-unpainted-canvas", {
      state: {
        phase: state.phase,
        settleReason: state.settleReason,
        degraded: state.degraded,
        lastFrame: state.lastFrame,
      },
      surfaces,
    }, state.phase === "settled" && state.settleReason === "load-failed"
      && state.degraded === true && state.lastFrame?.image === "original-cover"
      && surfaces.coverImage === true && surfaces.canvases === 0);
    await run.context.close();
  }

  // 7. Hiding and re-showing the tab must not strand the reveal on a partially
  //    dissolved generated image.
  {
    const run = await openPreview();
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "revealing");
    await page.waitForFunction(() => window.__coverRevealDebug().progress > 0.05);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(400);
    const hidden = await debugState(page);
    // Sampled twice across the hidden window: without this a reveal that simply
    // kept running would satisfy the resume assertion below.
    await page.waitForTimeout(400);
    const stillHidden = await debugState(page);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(
      () => window.__coverRevealDebug().phase === "settled",
      undefined,
      { timeout: 30_000 },
    );
    const resumed = await debugState(page);
    record("visibility:hidden-tab-actually-stops-the-reveal", {
      hidden: { phase: hidden.phase, progress: hidden.progress, frames: hidden.frames },
      stillHidden: {
        phase: stillHidden.phase,
        progress: stillHidden.progress,
        frames: stillHidden.frames,
        pendingAnimationFrames: stillHidden.pendingAnimationFrames,
      },
    }, hidden.phase === "revealing" && hidden.progress > 0 && hidden.progress < 1
      && stillHidden.progress === hidden.progress && stillHidden.frames === hidden.frames
      && stillHidden.pendingAnimationFrames === 0);
    record("visibility:reveal-resumes-and-settles-on-the-original-cover", {
      hidden: { phase: hidden.phase, progress: hidden.progress, frames: hidden.frames },
      resumed: {
        phase: resumed.phase,
        settleReason: resumed.settleReason,
        progress: resumed.progress,
        lastFrame: resumed.lastFrame,
      },
      errors: run.errors,
    }, stillHidden.phase === "revealing" && stillHidden.progress < 1
      && resumed.phase === "settled" && resumed.progress === 1
      && resumed.frames > stillHidden.frames
      && resumed.lastFrame?.image === "original-cover" && run.errors.length === 0);
    await run.context.close();
  }

  // 8. A lost graphics context settles on the canonical cover, and a later
  //    restoration must not resurrect the reveal the viewer already left.
  {
    const run = await openPreview();
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "revealing");
    await page.waitForFunction(() => window.__coverRevealDebug().progress > 0.05);
    const before = await debugState(page);
    const lost = await page.evaluate(() => {
      const canvas = document.querySelector("[data-cover-reveal-phase] canvas");
      const extension = canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context");
      if (!canvas || !extension) return false;
      // Kept for the restoration poke below: settling detaches this canvas.
      window.__coverRevealQaCanvas = canvas;
      extension.loseContext();
      return true;
    });
    await page.waitForFunction(
      () => window.__coverRevealDebug().phase === "settled",
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      () => window.__coverRevealDebug().lastFrame?.image === "original-cover",
      undefined,
      { timeout: 15_000 },
    );
    const settled = await debugState(page);
    const surfaces = await page.evaluate(() => ({
      coverImage: Boolean(document.querySelector('[data-cover-reveal-image="original-cover"]')),
      canvases: document.querySelectorAll("[data-cover-reveal-phase] canvas").length,
    }));
    await page.screenshot({ path: `${artifactDir}/context-loss.png` });
    record("context-loss:settles-on-the-original-cover", {
      lost,
      before: { phase: before.phase, progress: before.progress },
      settled: {
        phase: settled.phase,
        settleReason: settled.settleReason,
        degraded: settled.degraded,
        progress: settled.progress,
        lastFrame: settled.lastFrame,
      },
      surfaces,
    }, lost === true && before.phase === "revealing" && before.progress < 1
      && settled.phase === "settled" && settled.settleReason === "renderer-failed"
      && settled.degraded === true && settled.lastFrame?.image === "original-cover"
      && surfaces.coverImage === true && surfaces.canvases === 0);

    // The renderer was released, so the browser restoring the context has
    // nothing left to repaint: no new frames, no reattached canvas, no loop.
    const framesAtLoss = settled.frames;
    await page.evaluate(() => {
      window.__coverRevealQaCanvas?.dispatchEvent(new Event("webglcontextrestored"));
    });
    await page.waitForTimeout(700);
    const restored = await debugState(page);
    const afterRestore = await page.evaluate(
      () => document.querySelectorAll("[data-cover-reveal-phase] canvas").length,
    );
    record("context-loss:restoration-does-not-resurrect-the-reveal", {
      framesAtLoss,
      restored: {
        phase: restored.phase,
        settleReason: restored.settleReason,
        frames: restored.frames,
        pendingAnimationFrames: restored.pendingAnimationFrames,
        lastFrame: restored.lastFrame,
      },
      canvasesAfterRestore: afterRestore,
      errors: run.errors,
    }, restored.phase === "settled" && restored.settleReason === "renderer-failed"
      && restored.lastFrame?.image === "original-cover"
      && restored.pendingAnimationFrames === 0 && afterRestore === 0
      && run.errors.length === 0);
    await run.context.close();
  }

  // 9. A renderer that cannot be constructed at all - the WebGL2 probe passed,
  //    the renderer still refused - hands the viewer the canonical cover.
  {
    const run = await openPreview({ mode: "construct-failure" });
    const { page } = run;
    await page.waitForFunction(() => window.__coverRevealDebug().phase === "settled");
    await page.waitForFunction(() => window.__coverRevealDebug().lastFrame !== null);
    const state = await debugState(page);
    const surfaces = await page.evaluate(() => ({
      coverImage: Boolean(document.querySelector('[data-cover-reveal-image="original-cover"]')),
      canvases: document.querySelectorAll("[data-cover-reveal-phase] canvas").length,
    }));
    await page.screenshot({ path: `${artifactDir}/construct-failure.png` });
    record("construct-failure:settles-on-the-original-cover", {
      state: {
        phase: state.phase,
        settleReason: state.settleReason,
        degraded: state.degraded,
        backend: state.backend,
        frameCount: state.frameCount,
        lastFrame: state.lastFrame,
      },
      surfaces,
      errors: run.errors,
    }, state.phase === "settled" && state.settleReason === "renderer-failed"
      && state.degraded === true && state.backend === "webgl2"
      && state.frameCount === 0 && state.lastFrame?.image === "original-cover"
      && surfaces.coverImage === true && surfaces.canvases === 0
      && run.errors.length === 0);
    await run.context.close();
  }
  // 10. A context loss arriving after the reveal already finished must leave the
  //     settled cover on screen - not detach the canvas that is showing it.
  {
    const run = await openPreview();
    const { page } = run;
    await page.waitForFunction(
      () => window.__coverRevealDebug().phase === "settled",
      undefined,
      { timeout: 30_000 },
    );
    const settled = await debugState(page);
    const lost = await page.evaluate(() => {
      const canvas = document.querySelector("[data-cover-reveal-phase] canvas");
      const extension = canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context");
      if (!extension) return false;
      extension.loseContext();
      return true;
    });
    await page.waitForTimeout(700);
    const after = await debugState(page);
    const surfaces = await page.evaluate(() => ({
      coverImage: Boolean(document.querySelector('[data-cover-reveal-image="original-cover"]')),
      canvases: document.querySelectorAll("[data-cover-reveal-phase] canvas").length,
    }));
    await page.screenshot({ path: `${artifactDir}/context-loss-after-settled.png` });
    record("context-loss-after-settled:keeps-the-cover-on-screen", {
      lost,
      settled: { phase: settled.phase, settleReason: settled.settleReason },
      after: {
        phase: after.phase,
        settleReason: after.settleReason,
        degraded: after.degraded,
        lastFrame: after.lastFrame,
      },
      surfaces,
      errors: run.errors,
    }, lost === true && settled.settleReason === "completed"
      // The finished reveal is not retroactively degraded ...
      && after.phase === "settled" && after.settleReason === "completed"
      && after.degraded === false
      // ... and a surface showing the canonical cover is still mounted.
      && (surfaces.canvases === 1 || surfaces.coverImage === true)
      && run.errors.length === 0);
    await run.context.close();
  }
} finally {
  await browser.close();
  writeFileSync(`${artifactDir}/results.json`, `${JSON.stringify(results, null, 2)}\n`);
}

console.log(`cover-reveal checks: ${results.length}, failed: ${results.filter((row) => row.failed).length}`);
if (failed) process.exit(1);
