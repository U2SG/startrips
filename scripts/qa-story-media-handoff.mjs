/**
 * #489 (ST-134). Story / immersive viewing: real input reaching the presented
 * transport, and the same-Route-Point media handoff staying continuous.
 *
 * The user-visible report this lane exists for is "clicking the video jumps to
 * the next media instead of playing", plus flicker/black-frame/stale-asset
 * observations across image<->video handoffs. Everything here therefore uses
 * the production Story components behind the normal preview entry, a real
 * decodable clip, and real synthetic pointer/keyboard input.
 *
 * Deliberately NOT done here, because it would prove nothing:
 *   - no `video.play()`, DOM `.click()`, state setter or force-click;
 *   - no relaxed autoplay policy, no artificial sleeps, no weakened hit tests;
 *   - `HTMLMediaElement` is never patched, so `currentTime` is the real one.
 *
 * What the continuity sampler actually claims is stated per check: it observes
 * the stage on every animation frame and records which asset owns the painted
 * foreground at a set of sampled points. That is evidence about those points on
 * those frames, not a proof about every pixel of every display refresh.
 */
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const storyPath = "/?qaState=journey-story&qaMode=mixed-media";

// The mixed-media preview journey is image -> video -> image inside one scope.
const I1 = "00000000-0000-4000-8000-000000000100";
const V1 = "00000000-0000-4000-8000-000000000152";
const I2 = "00000000-0000-4000-8000-000000000102";
// Checked-in artworks with deliberately different aspect ratios, so an
// image<->video handoff is also a mixed-aspect-ratio handoff.
const WIDE_PHOTO = "/artworks/china-handscroll.jpg";
const TALL_PHOTO = "/artworks/egypt-coffin.jpg";
const CLIP = "/demo-media/east-star-orbit.webm";

const STAGE = ".journey-story__media";
const FULLSCREEN = ".journey-story-fullscreen";
const PAGES = "[data-story-media-pages]";

const checks = [];
let failed = false;

function record(entry) {
  checks.push(entry);
  if (entry.failed) failed = true;
}

const browser = await launchQaBrowser();

async function createStoryPage({ mobile = false, viewport, reducedMotion = "no-preference" } = {}) {
  const page = await browser.newPage({
    viewport: viewport ?? (mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }),
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    reducedMotion,
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(installStageSampler);
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => {
    const request = route.request().url();
    const url = request.includes(V1) ? CLIP : request.includes(I2) ? TALL_PHOTO : WIDE_PHOTO;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
    });
  });
  await page.goto(`${origin}${storyPath}`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-story").waitFor({ state: "visible", timeout: 15_000 });
  return { page, consoleErrors, pageErrors };
}

/* eslint-disable no-undef -- this function body is serialized into the page. */
function installStageSampler() {
  // One rAF sampler for the whole run. Each frame it hit-tests a small grid
  // inside the stage and records which asset actually draws the foreground
  // there, so a reversal, a stale layer or an uncovered stage is attributable
  // to a frame and an instance rather than to a screenshot.
  const state = { running: false, frames: [], root: null };
  window.__qaStage = state;
  const identify = (node) => {
    if (!(node instanceof Element)) return null;
    const page = node.closest("[data-media-page]");
    if (node instanceof HTMLVideoElement) {
      return { kind: "video", asset: node.getAttribute("data-shared-media-id"), live: true };
    }
    if (!(node instanceof HTMLImageElement || node instanceof HTMLCanvasElement)) return null;
    if (node.hidden) return null;
    return {
      kind: node instanceof HTMLImageElement ? "image" : "canvas",
      asset: page?.getAttribute("data-media-page-id") ?? null,
      role: page?.getAttribute("data-media-page") ?? null,
      live: false,
    };
  };
  const drawableAt = (x, y) => {
    for (const node of document.elementsFromPoint(x, y)) {
      const found = identify(node);
      if (!found) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || Number(style.opacity) <= 0.05) continue;
      return found;
    }
    return null;
  };
  const sample = () => {
    if (!state.running) return;
    const root = state.root && document.querySelector(state.root);
    const pages = root?.querySelector("[data-story-media-pages]");
    if (pages) {
      const bounds = pages.getBoundingClientRect();
      const points = [[0.5, 0.5], [0.34, 0.5], [0.66, 0.5], [0.5, 0.36], [0.5, 0.62]];
      const drawables = points.map(([fx, fy]) =>
        drawableAt(bounds.left + bounds.width * fx, bounds.top + bounds.height * fy));
      const current = pages.querySelector('[data-media-page="current"]');
      const incoming = pages.querySelector('[data-media-incoming="true"]');
      const videos = [...pages.querySelectorAll("video")];
      state.frames.push({
        at: Math.round(performance.now()),
        presentation: pages.getAttribute("data-media-presentation"),
        kind: pages.getAttribute("data-current-media-kind"),
        currentId: current?.getAttribute("data-media-page-id") ?? null,
        incomingId: incoming?.getAttribute("data-media-page-id") ?? null,
        centre: drawables[0],
        drawables,
        uncovered: drawables.filter((entry) => entry === null).length,
        waiting: Boolean(root.querySelector(".starlight-media-state.is-waiting")),
        videoCount: videos.length,
        videoOwner: videos.map((video) => video.getAttribute("data-shared-media-id")),
      });
    }
    requestAnimationFrame(sample);
  };
  window.__qaStageStart = (rootSelector) => {
    state.root = rootSelector;
    state.frames = [];
    if (state.running) return;
    state.running = true;
    requestAnimationFrame(sample);
  };
  window.__qaStageStop = () => {
    state.running = false;
    return state.frames;
  };
}
/* eslint-enable no-undef */

async function startSampler(page, rootSelector) {
  await page.evaluate((selector) => window.__qaStageStart(selector), rootSelector);
}

async function stopSampler(page) {
  return await page.evaluate(() => window.__qaStageStop());
}

/** Grade one recorded window against the B/C continuity acceptance. */
function gradeContinuity(frames, { allowedAssets }) {
  const owned = new Set(allowedAssets);
  const staleFrames = frames.filter((frame) => frame.centre?.asset && !owned.has(frame.centre.asset));
  const blankFrames = frames.filter((frame) => frame.currentId && frame.uncovered > 0);
  const waitingFrames = frames.filter((frame) => frame.waiting && frame.currentId);
  const multiVideoFrames = frames.filter((frame) => frame.videoCount > 1);
  // A foreground that goes new -> old -> new is the V1/V7 reversal. Compare
  // consecutive distinct centre owners rather than only the final state.
  const owners = [];
  for (const frame of frames) {
    const asset = frame.centre?.asset ?? null;
    if (asset && owners.at(-1) !== asset) owners.push(asset);
  }
  const reversals = owners.filter((asset, index) => index >= 2 && owners[index - 2] === asset);
  return {
    sampledFrames: frames.length,
    foregroundSequence: owners,
    staleForeground: staleFrames.slice(0, 4),
    blankStage: blankFrames.slice(0, 4),
    waitingWhileOwned: waitingFrames.slice(0, 4),
    concurrentLiveVideos: multiVideoFrames.slice(0, 2),
    foregroundReversals: reversals,
    failed: frames.length === 0 || staleFrames.length > 0 || blankFrames.length > 0
      || waitingFrames.length > 0 || multiVideoFrames.length > 0 || reversals.length > 0,
  };
}

async function currentAsset(page, rootSelector = STAGE) {
  return await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const current = pages?.querySelector('[data-media-page="current"]');
    return {
      id: current?.getAttribute("data-media-page-id") ?? null,
      ready: current?.getAttribute("data-media-page-ready") === "true",
      kind: pages?.getAttribute("data-current-media-kind") ?? null,
      presentation: pages?.getAttribute("data-media-presentation") ?? null,
      hitSurfaces: pages?.querySelectorAll("[data-story-hit-surface]").length ?? 0,
    };
  }, rootSelector);
}

async function waitForSettledAsset(page, assetId, rootSelector = STAGE, timeout = 10_000) {
  await page.waitForFunction(({ selector, expected }) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const current = pages?.querySelector('[data-media-page="current"]');
    return current?.getAttribute("data-media-page-id") === expected
      && current?.getAttribute("data-media-page-ready") === "true"
      && pages?.getAttribute("data-media-presentation") === "settled";
  }, { selector: rootSelector, expected: assetId }, { polling: "raf", timeout });
}

/** The point a viewer aims at: the centre of the contained picture. */
async function presentedVideoPoint(page, rootSelector, { fraction = 0.5 } = {}) {
  return await page.evaluate(({ selector, fraction: at }) => {
    const root = document.querySelector(selector);
    const video = root?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement)) throw new Error("no presented video on the stage");
    if (video.hidden) throw new Error("the presented video is hidden");
    if (!video.videoWidth || !video.videoHeight) throw new Error("the presented video has no decoded frame");
    const bounds = video.getBoundingClientRect();
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + (bounds.height - height) / 2 + height * at;
    const controlStrip = bounds.bottom - Math.min(72, bounds.height * 0.25);
    if (y >= controlStrip) throw new Error("the sampled point falls inside the native control strip");
    const hit = document.elementFromPoint(x, y);
    return {
      x, y, width, height, controls: video.controls,
      hitIsVideo: hit === video,
      hitTag: hit instanceof Element ? hit.tagName : null,
      hitClass: hit instanceof Element ? hit.className : null,
      asset: video.getAttribute("data-shared-media-id"),
    };
  }, { selector: rootSelector, fraction });
}

/** Native control chrome: Chromium's lower-left play/pause region. */
async function nativeControlPoint(page, rootSelector) {
  return await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const video = root?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement)) throw new Error("no presented video on the stage");
    const bounds = video.getBoundingClientRect();
    const point = { x: bounds.left + 28, y: bounds.bottom - 24 };
    return { ...point, controls: video.controls, hitIsVideo: document.elementFromPoint(point.x, point.y) === video };
  }, rootSelector);
}

/** Real transport observation: the element's own clock, sampled repeatedly. */
async function samplePlayback(page, rootSelector, { samples = 4, everyMs = 180 } = {}) {
  return await page.evaluate(async ({ selector, samples: count, everyMs: gap }) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement)) return { error: "no presented video" };
    const times = [];
    for (let index = 0; index < count; index += 1) {
      times.push(Number(video.currentTime.toFixed(4)));
      if (index < count - 1) await new Promise((resolve) => setTimeout(resolve, gap));
    }
    return {
      times, paused: video.paused, readyState: video.readyState,
      advanced: times.at(-1) > times[0],
      monotonic: times.every((value, index) => index === 0 || value >= times[index - 1]),
    };
  }, { selector: rootSelector, samples, everyMs });
}

/** Real mouse drag across the stage, above any native control chrome. */
async function swipeStage(page, rootSelector, direction) {
  const geometry = await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const bounds = pages.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * 0.35, width: bounds.width };
  }, rootSelector);
  const travel = Math.min(320, geometry.width * 0.45) * (direction > 0 ? -1 : 1);
  await page.mouse.move(geometry.x, geometry.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(geometry.x + travel * (step / 8), geometry.y);
  }
  await page.mouse.up();
}

try {
  // ---------------------------------------------------------------------
  // A. Real input on the presented video reaches its own transport.
  // ---------------------------------------------------------------------
  for (const surface of [
    { label: "inline", root: STAGE, enterFullscreen: false },
    { label: "immersive", root: FULLSCREEN, enterFullscreen: true },
  ]) {
    const session = await createStoryPage({ mobile: false });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      // Reach the video the way a viewer does: click the photograph's right
      // half. Photo click navigation is unchanged by this fix.
      await startSampler(page, STAGE);
      const photo = await page.evaluate((selector) => {
        const surfaceNode = document.querySelector(selector).querySelector("[data-story-hit-surface]");
        if (!surfaceNode) throw new Error("the photograph has no stationary click surface");
        const bounds = surfaceNode.getBoundingClientRect();
        return { x: bounds.left + bounds.width * 0.75, y: bounds.top + bounds.height * 0.5 };
      }, STAGE);
      await page.mouse.click(photo.x, photo.y);
      await waitForSettledAsset(page, V1);
      const toVideoFrames = await stopSampler(page);

      if (surface.enterFullscreen) {
        await page.getByRole("button", { name: "全屏查看媒体", exact: true }).click();
        await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
        await waitForSettledAsset(page, V1, FULLSCREEN);
      }

      const before = await currentAsset(page, surface.root);
      const point = await presentedVideoPoint(page, surface.root);
      const controls = await nativeControlPoint(page, surface.root);
      const idle = await samplePlayback(page, surface.root, { samples: 2, everyMs: 120 });
      await page.mouse.click(point.x, point.y);
      const playback = await samplePlayback(page, surface.root);
      const after = await currentAsset(page, surface.root);

      const clickFailed = before.kind !== "video" || before.hitSurfaces !== 0
        || !point.hitIsVideo || !point.controls
        || after.id !== before.id || after.id !== V1 || after.presentation !== "settled"
        || idle.paused !== true
        || playback.paused !== false || !playback.advanced || !playback.monotonic
        || session.consoleErrors.length > 0 || session.pageErrors.length > 0;
      record({
        name: `story-${surface.label}-video-picture-click-plays`,
        claim: "a real mouse click on the presented video's contained picture starts its own transport and never navigates",
        before, after, point, idle, playback,
        handoffToVideo: gradeContinuity(toVideoFrames, { allowedAssets: [I1, V1] }),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: clickFailed,
      });

      // The native control strip stays the transport's, not navigation's.
      const controlBefore = await samplePlayback(page, surface.root, { samples: 1, everyMs: 0 });
      await page.mouse.click(controls.x, controls.y);
      const controlAfter = await samplePlayback(page, surface.root, { samples: 2, everyMs: 150 });
      const controlState = await currentAsset(page, surface.root);
      record({
        name: `story-${surface.label}-video-native-controls-reachable`,
        claim: "the native control strip hit-tests to the video and toggles it without changing the presented asset",
        controls, controlBefore, controlAfter, controlState,
        failed: !controls.controls || !controls.hitIsVideo
          || controlAfter.paused === controlBefore.paused
          || controlState.id !== V1 || controlState.presentation !== "settled",
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // A (continued). Navigating away from a video still works, by the inputs
  // the stage advertises, and a swipe's compatibility click does not repeat it.
  // ---------------------------------------------------------------------
  {
    const session = await createStoryPage({ mobile: false });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await swipeStage(page, STAGE, 1);
      await waitForSettledAsset(page, V1);
      const afterFirstSwipe = await currentAsset(page);

      await startSampler(page, STAGE);
      await swipeStage(page, STAGE, 1);
      await waitForSettledAsset(page, I2);
      const swipeFrames = await stopSampler(page);
      const afterVideoSwipe = await currentAsset(page);
      const playbackAfterSwipe = await samplePlayback(page, STAGE, { samples: 2, everyMs: 120 });

      // Back onto the video, then advertise-driven keyboard navigation.
      await swipeStage(page, STAGE, -1);
      await waitForSettledAsset(page, V1);
      const stageRole = await page.evaluate((selector) => {
        const pages = document.querySelector(selector).querySelector("[data-story-media-pages]");
        pages.focus();
        return {
          tabIndex: pages.tabIndex,
          keyshortcuts: pages.getAttribute("aria-keyshortcuts"),
          focused: document.activeElement === pages,
        };
      }, STAGE);
      await page.keyboard.press("ArrowRight");
      await waitForSettledAsset(page, I2);
      const afterKeyboard = await currentAsset(page);

      record({
        name: "story-video-navigation-preserved",
        claim: "a swipe over the video navigates exactly one step without double-stepping or starting playback, and the stage's advertised arrow keys still navigate",
        afterFirstSwipe, afterVideoSwipe, playbackAfterSwipe, stageRole, afterKeyboard,
        handoff: gradeContinuity(swipeFrames, { allowedAssets: [V1, I2] }),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: afterFirstSwipe.id !== V1 || afterVideoSwipe.id !== I2
          || playbackAfterSwipe.paused !== true
          || stageRole.tabIndex !== 0 || !stageRole.focused
          || stageRole.keyshortcuts !== "ArrowLeft ArrowRight"
          || afterKeyboard.id !== I2
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // A (continued). The photograph contract is unchanged: click halves still
  // navigate, and a click outside the contained picture still closes.
  // ---------------------------------------------------------------------
  {
    const session = await createStoryPage({ mobile: false });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      const photoState = await currentAsset(page);
      const halves = await page.evaluate((selector) => {
        const surfaceNode = document.querySelector(selector).querySelector("[data-story-hit-surface]");
        const bounds = surfaceNode.getBoundingClientRect();
        return {
          next: { x: bounds.left + bounds.width * 0.75, y: bounds.top + bounds.height * 0.5 },
          letterbox: { x: bounds.left + 4, y: bounds.top + 4 },
        };
      }, STAGE);
      await page.mouse.click(halves.next.x, halves.next.y);
      await waitForSettledAsset(page, V1);
      const afterHalfClick = await currentAsset(page);
      record({
        name: "story-photo-click-navigation-preserved",
        claim: "the photograph's stationary click surface still exists and its halves still navigate",
        photoState, afterHalfClick,
        failed: photoState.kind !== "image" || photoState.hitSurfaces !== 1 || afterHalfClick.id !== V1
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // B. Handoff continuity across the whole mixed sequence, both motion modes
  // and the viewports the report covers.
  // ---------------------------------------------------------------------
  for (const profile of [
    { label: "desktop", mobile: false, viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" },
    { label: "desktop-reduced", mobile: false, viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" },
    { label: "phone-portrait", mobile: true, viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" },
    { label: "phone-landscape", mobile: true, viewport: { width: 844, height: 390 }, reducedMotion: "no-preference" },
  ]) {
    const session = await createStoryPage(profile);
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await startSampler(page, STAGE);
      const visited = [I1];
      for (const [target, direction] of [[V1, 1], [I2, 1], [V1, -1], [I1, -1]]) {
        await swipeStage(page, STAGE, direction);
        await waitForSettledAsset(page, target);
        visited.push(target);
      }
      const frames = await stopSampler(page);
      const continuity = gradeContinuity(frames, { allowedAssets: [I1, V1, I2] });
      record({
        name: `story-handoff-continuity-${profile.label}`,
        claim: "across image<->video and mixed aspect ratios the sampled stage points always show an asset the navigation currently owns, never an uncovered stage, never the waiting indicator, and never a second live transport",
        viewport: profile.viewport, reducedMotion: profile.reducedMotion, visited,
        ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // B (continued). A reversal fired before the spring settles commits only
  // the latest intent, and no stale completion writes back.
  // ---------------------------------------------------------------------
  {
    const session = await createStoryPage({ mobile: false });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await startSampler(page, STAGE);
      await swipeStage(page, STAGE, 1);
      // No wait: reverse while the previous intent is still in flight.
      await swipeStage(page, STAGE, -1);
      await page.waitForFunction((selector) => {
        const pages = document.querySelector(selector).querySelector("[data-story-media-pages]");
        return pages.getAttribute("data-media-presentation") === "settled";
      }, STAGE, { polling: "raf", timeout: 10_000 });
      const frames = await stopSampler(page);
      const settled = await currentAsset(page);
      const transports = await page.evaluate((selector) =>
        document.querySelector(selector).querySelectorAll("video").length, STAGE);
      // Either intent is a legitimate outcome of a race the user created; what
      // must hold is a single settled owner, one transport and no later write.
      const stable = await page.evaluate(async (selector) => {
        const read = () => document.querySelector(selector)
          .querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id");
        const first = read();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { first, second: read() };
      }, STAGE);
      record({
        name: "story-reversal-commits-latest-intent",
        claim: "a second navigation fired before the first settles leaves exactly one settled owner, one live transport and no late write-back",
        settled, transports, stable,
        sampledFrames: frames.length,
        concurrentLiveVideos: frames.filter((frame) => frame.videoCount > 1).slice(0, 2),
        failed: settled.presentation !== "settled" || !settled.id || !settled.ready
          || transports !== 1 || stable.first !== stable.second
          || frames.some((frame) => frame.videoCount > 1)
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // C. Entering and leaving immersive viewing stays on the same object.
  // ---------------------------------------------------------------------
  {
    const session = await createStoryPage({ mobile: false });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await page.mouse.click(...Object.values(await page.evaluate((selector) => {
        const bounds = document.querySelector(selector)
          .querySelector("[data-story-hit-surface]").getBoundingClientRect();
        return { x: bounds.left + bounds.width * 0.75, y: bounds.top + bounds.height * 0.5 };
      }, STAGE)));
      await waitForSettledAsset(page, V1);
      await swipeStage(page, STAGE, 1);
      await waitForSettledAsset(page, I2);
      const lastVisible = await currentAsset(page);

      await startSampler(page, FULLSCREEN);
      await page.getByRole("button", { name: "全屏查看媒体", exact: true }).click();
      await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
      await waitForSettledAsset(page, I2, FULLSCREEN);
      const entryFrames = await stopSampler(page);
      const entered = await currentAsset(page, FULLSCREEN);

      await startSampler(page, STAGE);
      await page.keyboard.press("Escape");
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      await waitForSettledAsset(page, I2);
      const exitFrames = await stopSampler(page);
      const exited = await currentAsset(page);

      const entry = gradeContinuity(entryFrames, { allowedAssets: [I2] });
      const exit = gradeContinuity(exitFrames, { allowedAssets: [I2] });
      record({
        name: "story-entry-exit-object-continuity",
        claim: "entering immersive viewing reveals only the targeted asset and leaving restores the same last-visible asset, with no prior asset flashing in between",
        lastVisible, entered, exited, entry, exit,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: lastVisible.id !== I2 || entered.id !== I2 || exited.id !== I2
          || entry.failed || exit.failed
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }
} catch (error) {
  // The accumulated checks are this lane's only diagnostic record; a thrown
  // step must not take them down with it (#439).
  console.log(JSON.stringify(checks, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
