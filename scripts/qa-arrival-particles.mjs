import { mkdirSync, writeFileSync } from "node:fs";

// Called by the existing globe-render-budget CI suite. Synthetic routes only;
// software-rendered timing is deliberately not reported as mobile performance.
export async function checkArrivalParticles(browser, origin, record) {
  const dir = "artifacts/visited-imprint/arrival-particles";
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  // This standalone synthetic preview has no API process or signed-in user.
  await context.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const read = () => page.evaluate(() => {
    const host = document.querySelector(".particle-earth-scene");
    const debug = window.__particleEarthDebug?.();
    return {
      phase: host?.dataset.arrivalPhase, age: Number(host?.dataset.arrivalAge),
      glow: Number(host?.dataset.arrivalGlow), twist: Number(host?.dataset.arrivalTwist),
      variant: host?.dataset.arrivalVariant,
      blooms: document.querySelectorAll(".is-arrival-bloom").length,
      geometry: debug?.geometries, textures: debug?.textures,
      frames: debug?.sceneFrameRevision, calls: debug?.renderCallsTotal,
      points: debug?.renderPointsTotal, state: debug?.renderState,
      canvases: debug?.canvases, buffer: debug?.drawingBufferPixels,
      anchors: [...document.querySelectorAll('.particle-earth-route__point[data-journey-route="qa-route-southwest"]')]
        .map((node) => {
          const bounds = node.getBoundingClientRect();
          return [node.getAttribute("data-route-point-id"), bounds.x, bounds.y, bounds.width, bounds.height];
        }),
    };
  });
  const waitPhase = (phase) => page.waitForFunction(
    (value) => document.querySelector(".particle-earth-scene")?.dataset.arrivalPhase === value,
    phase, { timeout: 20_000 },
  );
  const frames = async (count = 3) => {
    const revision = await page.evaluate(() => window.__particleEarthDebug?.().sceneFrameRevision ?? 0);
    await page.waitForFunction(({ revision, count }) =>
      (window.__particleEarthDebug?.().sceneFrameRevision ?? 0) >= revision + count,
    { revision, count }, { timeout: 10_000 });
  };
  const active = async () => {
    await replay();
    await waitPhase("moving");
    const state = await read();
    if (state.age > 0.15 || state.phase !== "moving") throw new Error("Cancellation probe missed the start of arrival");
  };
  const replay = () => page.locator("[data-qa-arrival-replay]").click();
  const variant = (name) => page.locator(`[data-qa-arrival-variant="${name}"]`).click();
  const hidden = (value) => page.evaluate((next) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
  try {
    await page.goto(`${origin}/?qaState=journey-routes&qaArrival=particles&qaQuality=high&qaMotion=animate&qaRenderBudget=1`);
    await page.waitForSelector('[data-scene-ready="true"]');
    await page.waitForFunction(() => window.__particleEarthDebug?.().particleRefinementBuild === "ready");
    await replay();
    await waitPhase("moving");
    const moving = await read();
    record("arrival:shell-only-owner", moving, moving.blooms === 0 && moving.canvases === 1);
    await page.locator(".particle-earth-scene").screenshot({ path: `${dir}/particles.png` });
    await waitPhase("idle");

    await variant("bloom");
    await replay();
    await page.waitForSelector(".is-arrival-bloom");
    await page.locator(".particle-earth-scene").screenshot({ path: `${dir}/bloom.png` });
    // Use a fresh event for cancellation: capture may outlive the first bloom.
    await page.waitForFunction(() => !document.querySelector(".is-arrival-bloom"));
    await replay();
    await page.waitForSelector(".is-arrival-bloom");
    await page.evaluate(() => {
      if (!document.querySelector(".is-arrival-bloom")) throw new Error("Bloom is no longer active");
      document.querySelector("[data-qa-arrival-motion]").click();
    });
    await frames(2);
    record("arrival:active-bloom-reduced-motion", await read(), (await read()).blooms === 0);

    // Settled camera: A/B changes must not alter geographic bounds
    // or render work. Both variants retain the same warmed scene/LOD resources.
    const before = await read();
    await page.waitForTimeout(150);
    const baseline = await read();
    await variant("particles");
    await replay();
    await waitPhase("static");
    const staticLight = await read();
    await page.waitForTimeout(150);
    const after = await read();
    const anchorError = baseline.anchors.length === after.anchors.length && baseline.anchors.length > 0
      ? Math.max(...baseline.anchors.flatMap((anchor, i) => anchor[0] === after.anchors[i][0]
        ? anchor.slice(1).map((value, j) => Math.abs(value - after.anchors[i][j + 1])) : [Infinity]))
      : Infinity;
    const pointsPerFrame = (start, end) => (end.points - start.points) / (end.frames - start.frames);
    const callsPerFrame = (start, end) => (end.calls - start.calls) / (end.frames - start.frames);
    record("arrival:static-anchors-and-render-budget", { anchorError, baseline, staticLight, after },
      anchorError <= 0.1 && after.twist === 0 && after.glow > 0 && after.blooms === 0
      && after.geometry === baseline.geometry && after.textures === baseline.textures
      && after.canvases === baseline.canvases && after.buffer === baseline.buffer
      && Number.isFinite(callsPerFrame(before, baseline))
      && callsPerFrame(before, baseline) === callsPerFrame(staticLight, after)
      && pointsPerFrame(before, baseline) === pointsPerFrame(staticLight, after));

    // Switching effects never manufactures another first-arrival request.
    for (let i = 0; i < 20; i++) {
      await variant(i % 2 === 0 ? "bloom" : "particles");
    }
    await waitPhase("idle");
    const toggled = await read();
    record("arrival:twenty-switches", toggled, toggled.geometry === after.geometry
      && toggled.textures === after.textures && toggled.canvases === 1 && toggled.blooms === 0);

    await page.locator("[data-qa-arrival-motion]").click();
    await active();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await waitPhase("static");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await frames();
    record("arrival:live-preference-no-replay", await read(), (await read()).twist === 0);

    await active();
    await page.locator('[data-qa-render-quality="low"]').click();
    await waitPhase("static");
    record("arrival:quality-downgrade", await read(), (await read()).twist === 0);
    await page.locator('[data-qa-render-quality="high"]').click();
    await frames();
    record("arrival:quality-upgrade-no-replay", await read(), (await read()).phase === "static" && (await read()).twist === 0);
    await active();
    await hidden(true);
    const paused = await read();
    await hidden(false);
    await frames();
    record("arrival:hidden-resume-no-replay", await read(), (await read()).phase === "idle" && (await read()).twist === 0);
    record("arrival:synthetic-hidden-cancel", paused, paused.phase === "idle" && paused.twist === 0 && paused.state === "hidden");

    await active();
    await page.locator('[data-qa-render-visibility="covered"]').click();
    await waitPhase("idle");
    await page.locator('[data-qa-render-visibility="reveal"]').click();
    await frames();
    record("arrival:cover-no-replay", await read(), (await read()).glow === 0);
    await active();
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 100);
    await frames(2);
    record("arrival:manual-camera-cancel", await read(), (await read()).glow === 0);
    await active();
    await page.locator('[data-qa-route="qa-route-rhine"]').click();
    await frames(2);
    record("arrival:new-intent-cancel", await read(), (await read()).glow === 0);
    await page.waitForFunction(() => document.querySelector(".particle-earth-scene")?.dataset.routeFocusPhase === "settled");
    await frames();
    record("arrival:new-intent-no-replay", await read(), (await read()).phase === "idle" && (await read()).glow === 0);
    record("arrival:shader-and-runtime-errors", { errors }, errors.length === 0);
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ moving, baseline, after, anchorError, toggled, errors }, null, 2));
  } finally {
    await context.close();
  }
}
