// #465 / ST-126. Real presentation, readiness and intent races; GitHub CI only.
import assert from "node:assert/strict";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const image = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const browser = await launchQaBrowser();
const reports = [];

async function open({ mobile = false, reduced = false, video = false, interrupt = null } = {}) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    reducedMotion: reduced ? "reduce" : "no-preference" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ interrupt }) => {
    const trace = { samples: [], interrupted: false };
    window.__qaMapBridge = trace;
    const observer = new MutationObserver(() => {
      const root = document.querySelector(".journey-playback");
      if (!root) return;
      const stage = root.querySelector("[data-media-presentation]");
      const entry = {
        step: Number(root.dataset.playbackStep), bridge: root.dataset.playbackMapBridge,
        point: root.dataset.playbackMapBridgePoint, intent: root.dataset.playbackIntent,
        presentation: stage?.dataset.mediaPresentation, shown: stage?.dataset.presentedAsset,
        videos: root.querySelectorAll("video").length,
      };
      if (JSON.stringify(trace.samples.at(-1)) !== JSON.stringify(entry)) trace.samples.push(entry);
      const atInterruption = interrupt === "outgoing-seek"
        ? entry.step === 5 && entry.bridge === "media-to-map"
        : entry.step === 4 && entry.presentation === "moving";
      if (!interrupt || trace.interrupted || !atInterruption) return;
      trace.interrupted = true;
      const key = (value) => window.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
      if (interrupt === "next") { key("ArrowRight"); key("ArrowRight"); }
      if (interrupt === "seek" || interrupt === "outgoing-seek") {
        const range = root.querySelector('input[type="range"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(range, "1000");
        range.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (interrupt === "back") key("ArrowLeft");
      if (interrupt === "pause") key(" ");
      if (interrupt === "exit") key("Escape");
      if (interrupt === "orientation") window.dispatchEvent(new Event("orientationchange"));
    });
    observer.observe(document, { attributes: true, childList: true, subtree: true });
  }, { interrupt });
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({ status: 200,
    contentType: "application/json", body: JSON.stringify({
      url: video && route.request().url().includes("st109-p1-m0") ? `${origin}/demo-media/east-star-orbit.webm` : image,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  }));
  const query = new URLSearchParams({ qaState: "journey-playback", qaMode: "continuity",
    qaReduceMotion: reduced ? "1" : "0", qaMapBridgeVideo: video ? "1" : "0" });
  await page.goto(`${origin}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-playback").waitFor();
  await page.locator(".journey-playback__tempo select").selectOption("fast");
  return { page, errors };
}

try {
  for (const mobile of [false, true]) for (const reduced of [false, true]) {
    const { page, errors } = await open({ mobile, reduced });
    try {
      await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.playbackPhase === "outro"
        && window.__qaPlaybackContinuity?.cameraTargets.at(-1)?.key === "route", null, { timeout: 90_000 });
      const trace = await page.evaluate(() => ({ ...window.__qaMapBridge, camera: window.__qaPlaybackContinuity.cameraTargets }));
      const seams = [...new Set(trace.samples.filter((s) => s.bridge !== "none").map((s) => `${s.step}:${s.bridge}:${s.point}`))];
      assert.deepEqual(seams, ["4:map-to-media:1", "5:media-to-map:1", "7:map-to-media:2", "10:media-to-map:2"]);
      assert.deepEqual([...new Set(trace.samples.map((s) => s.step))], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.deepEqual(trace.camera.map((c) => c.key), ["route", "point:0", "point:1", "point:2", "route"]);
      for (const step of [4, 7, 8, 9]) {
        assert.ok(trace.samples.some((s) => s.step === step && s.presentation === "settled" && s.shown), `presented step ${step}`);
        assert.equal(trace.samples.some((s) => s.step === step && s.presentation === "moving"), !reduced, `motion at step ${step}`);
      }
      assert.deepEqual(errors, []);
      reports.push({ mobile, reduced, seams });
    } finally { await page.close(); }
  }

  for (const interrupt of ["seek", "outgoing-seek", "next", "back", "pause", "orientation", "exit"]) {
    const { page, errors } = await open({ interrupt });
    try {
      await page.waitForFunction(() => window.__qaMapBridge.interrupted, null, { timeout: 45_000 });
      if (interrupt === "exit") {
        await page.locator(".journey-playback").waitFor({ state: "detached" });
      } else if (interrupt === "back") {
        await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.playbackStep === "1");
      } else if (interrupt === "seek" || interrupt === "outgoing-seek") {
        await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.playbackStep === "10");
        assert.equal(await page.locator("[data-presented-asset]").count(), 0);
        // Let the obsolete spring's completion opportunity pass; it must not
        // re-focus point 2 after the seek has committed the journey framing.
        await page.waitForTimeout(800);
        assert.equal(await page.evaluate(() => window.__qaPlaybackContinuity.cameraTargets.at(-1).key), "route");
      } else {
        const step = interrupt === "next" ? "8" : "4";
        await page.waitForFunction((step) => document.querySelector(".journey-playback")?.dataset.playbackStep === step
          && document.querySelector("[data-media-presentation]")?.dataset.mediaPresentation === "settled", step);
        if (interrupt === "pause") assert.ok(await page.locator(".journey-playback.is-paused").count());
        const trace = await page.evaluate(() => window.__qaMapBridge.samples);
        const newest = trace.at(-1).intent;
        // Once a new intent renders, an obsolete first-media completion cannot
        // come back and claim the old asset over the newer requested beat.
        if (interrupt === "next") assert.equal(trace.at(-1).shown, "st109-p2-m1");
        assert.ok(Number(newest) >= 2);
      }
      assert.deepEqual(errors, []);
      reports.push({ interrupt, passed: true });
    } finally { await page.close(); }
  }

  const { page, errors } = await open({ video: true });
  try {
    await page.waitForFunction(() => document.querySelector('[data-presented-asset="st109-p1-m0"]')
      ?.getAttribute("data-media-presentation") === "settled", null, { timeout: 45_000 });
    const frame = await page.locator(".journey-playback video").evaluate((video) => ({ ready: video.readyState, width: video.videoWidth }));
    assert.ok(frame.ready >= 2 && frame.width > 0, "video committed a presentable frame");
    const trace = await page.evaluate(() => window.__qaMapBridge.samples);
    assert.ok(trace.some((s) => s.step === 4 && s.presentation === "waiting"), "video uses the existing readiness gate");
    assert.ok(trace.some((s) => s.step === 4 && s.bridge === "map-to-media" && s.presentation === "moving"));
    assert.ok(trace.every((s) => s.videos <= 1), "one live video transport");
    assert.deepEqual(errors, []);
    reports.push({ video: "presentable frame, single transport" });
  } finally { await page.close(); }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ lane: "qa-playback-map-bridge", reports }, null, 2));
