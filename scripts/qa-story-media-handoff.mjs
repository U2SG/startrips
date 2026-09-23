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
 * the stage on every DOM mutation and on every animation frame its chain
 * delivers, and records which asset owns the painted foreground at points
 * inside the presented media's own aperture. That is evidence about those
 * points on those frames, not a proof about every pixel of every refresh, and
 * each graded window reports its tick count so the two sources stay separable.
 */
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const storyPath = "/?qaState=journey-story&qaMode=mixed-media-pair";

// The preview journey is image -> video -> video -> image -> image inside one
// scope, so every handoff class the acceptance names has an adjacent pair:
// image<->video (I1/V1), video<->video (V1/V2), video<->image (V2/I2) and
// image<->image (I2/I3).
const I1 = "00000000-0000-4000-8000-000000000100";
const V1 = "00000000-0000-4000-8000-000000000152";
const V2 = "00000000-0000-4000-8000-000000000153";
const I2 = "00000000-0000-4000-8000-000000000102";
const I3 = "00000000-0000-4000-8000-000000000103";
const SEQUENCE = [I1, V1, V2, I2, I3];
// Checked-in artworks and clips with deliberately different aspect ratios, so
// every handoff above is also a mixed-aspect-ratio handoff: a wide scroll, a
// square clip, a vertical clip, a tall coffin lid and a second wide picture.
const WIDE_PHOTO = "/artworks/china-handscroll.jpg";
const TALL_PHOTO = "/artworks/egypt-coffin.jpg";
const SECOND_WIDE_PHOTO = "/artworks/hokusai-wave.jpg";
const CLIP = "/demo-media/east-star-orbit.webm";
const VERTICAL_CLIP = "/demo-media/qa-vertical-drift.webm";

const ASSET_URLS = {
  [I1]: WIDE_PHOTO,
  [V1]: CLIP,
  [V2]: VERTICAL_CLIP,
  [I2]: TALL_PHOTO,
  [I3]: SECOND_WIDE_PHOTO,
};

const STAGE = ".journey-story__media";
const FULLSCREEN = ".journey-story-fullscreen";

const checks = [];
let failed = false;

function record(entry) {
  checks.push(entry);
  if (entry.failed) failed = true;
}

const browser = await launchQaBrowser();

/**
 * `readDelays` and `byteDelays` hold the read-url and the media response of one
 * asset back by a fixed number of milliseconds. This is the acceptance matrix's
 * own row -- delayed image decode, delayed video first frame, a representative
 * frame ready while the live transport is not, a stale result arriving late --
 * and it makes the readiness gating do work that a file served off localhost
 * never asks of it. It is a scenario, not a wait inserted to pass: nothing is
 * asserted about the delay itself, and no assertion is relaxed while it runs.
 */
async function createStoryPage({
  mobile = false, viewport, reducedMotion = "no-preference",
  readDelays = {}, byteDelays = {},
} = {}) {
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
  const hold = (ms) => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null;
  await page.route("**/api/uploads/assets/*/read-url", async (route) => {
    const request = route.request().url();
    const asset = Object.keys(ASSET_URLS).find((id) => request.includes(id));
    await hold(readDelays[asset] ?? 0);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: ASSET_URLS[asset] ?? WIDE_PHOTO,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
    });
  });
  for (const [asset, ms] of Object.entries(byteDelays)) {
    if (!ms) continue;
    await page.route(`**${ASSET_URLS[asset]}`, async (route) => {
      await hold(ms);
      return route.continue();
    });
  }
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
  const state = { running: false, frames: [], roots: [], gestures: [], unmeasurable: 0 };
  window.__qaStage = state;
  // A bounded trace of the input the product actually received. A drag that
  // never commits is attributable to a missing axis lock, a missing neighbour
  // or a lost capture only with this, and none of it changes behaviour.
  const note = (entry) => {
    state.gestures.push({ at: Math.round(performance.now()), ...entry });
    if (state.gestures.length > 240) state.gestures.shift();
  };
  for (const type of [
    "pointerdown", "pointerup", "pointercancel", "lostpointercapture", "click",
    "dragstart", "drag", "selectstart",
  ]) {
    document.addEventListener(type, (event) => {
      const target = event.target;
      note({
        type,
        pointerId: event.pointerId ?? null,
        x: Math.round(event.clientX ?? 0),
        y: Math.round(event.clientY ?? 0),
        tag: target instanceof Element ? target.tagName : null,
        cls: target instanceof Element ? String(target.className).slice(0, 60) : null,
        ...(type === "pointercancel" ? {
          selection: String(getSelection?.() ?? "").slice(0, 40),
          focused: document.hasFocus(),
          targetConnected: target instanceof Element ? target.isConnected : null,
        } : {}),
      });
    }, true);
  }
  document.addEventListener("pointermove", (event) => {
    const last = state.gestures.at(-1);
    if (last?.type === "pointermove") {
      last.x = Math.round(event.clientX);
      last.samples += 1;
      last.at = Math.round(performance.now());
      return;
    }
    note({ type: "pointermove", x: Math.round(event.clientX), y: Math.round(event.clientY), samples: 1 });
  }, true);
  new MutationObserver((records) => {
    // A reveal-then-hide is a DOM/style change, so mutations sample too. An
    // animation-frame chain alone can go quiet in a window that contains no
    // pointer input, and a window with no observation is not evidence.
    sample();
    for (const mutation of records) {
      for (const [list, change] of [[mutation.addedNodes, "added"], [mutation.removedNodes, "removed"]]) {
        for (const node of list) {
          if (!(node instanceof Element)) continue;
          if (node.matches("[data-story-hit-surface]") || node.querySelector?.("[data-story-hit-surface]")) {
            note({ type: `hit-surface-${change}` });
          }
        }
      }
      if (mutation.type === "attributes") {
        note({ type: "stage-attribute", name: mutation.attributeName,
          value: mutation.target.getAttribute(mutation.attributeName) });
      }
    }
  // `document` is the observation root on purpose: this script runs before the
  // document element exists, and observing a null target throws away the whole
  // instrumentation.
  }).observe(document, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-current-media-kind", "data-media-presentation", "data-media-page-ready"],
  });
  for (const type of ["story-media-grab", "story-media-recover"]) {
    document.addEventListener(type, (event) => {
      note({ type, neighborId: event.detail?.neighborId ?? null });
    }, true);
  }
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
  // The rectangle the presented media actually occupies under `contain`. The
  // coverage claim is made inside this aperture only; the surrounding letterbox
  // is correct emptiness, not an uncovered stage.
  const aperture = (pages) => {
    const owner = pages.querySelector('[data-media-page="current"]');
    const node = owner?.querySelector("img:not([hidden]), canvas:not([hidden])")
      ?? pages.querySelector('.story-media-pages__video video:not([hidden])');
    const box = (node ?? owner ?? pages).getBoundingClientRect();
    const natural = node instanceof HTMLImageElement ? [node.naturalWidth, node.naturalHeight]
      : node instanceof HTMLVideoElement ? [node.videoWidth, node.videoHeight]
        : node instanceof HTMLCanvasElement ? [node.width, node.height] : [0, 0];
    if (!natural[0] || !natural[1] || !box.width || !box.height) return box;
    const scale = Math.min(box.width / natural[0], box.height / natural[1]);
    const width = natural[0] * scale;
    const height = natural[1] * scale;
    return new DOMRect(box.left + (box.width - width) / 2, box.top + (box.height - height) / 2, width, height);
  };
  // A shared-element morph runs through the View Transitions API, whose
  // snapshots are browser-composited pseudo-elements rather than nodes, so
  // `elementsFromPoint` cannot see them. Recording which view-transition
  // groups are animating on a frame is what makes an uncovered stage during
  // entry or exit attributable: either a morph owns the picture on that frame,
  // or nothing does and the stage really was bare.
  const viewTransitions = () => {
    try {
      return document.getAnimations()
        .filter((animation) => String(animation.effect?.pseudoElement ?? "").startsWith("::view-transition"))
        .map((animation) => animation.effect.pseudoElement)
        .slice(0, 6);
    } catch { return []; }
  };
  function sampleRoot(selector, morphs) {
    const root = document.querySelector(selector);
    const pages = root?.querySelector("[data-story-media-pages]");
    const measurable = pages ? pages.getBoundingClientRect() : null;
    if (!pages || !(measurable.width > 0) || !(measurable.height > 0)) return null;
    const bounds = aperture(pages);
    const points = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
    const drawables = bounds.width > 0 && bounds.height > 0
      ? points.map(([fx, fy]) => drawableAt(bounds.left + bounds.width * fx, bounds.top + bounds.height * fy))
      : [];
    const current = pages.querySelector('[data-media-page="current"]');
    const incoming = pages.querySelector('[data-media-incoming="true"]');
    const videos = [...pages.querySelectorAll("video")];
    return {
      root: selector,
      at: Math.round(performance.now()),
      presentation: pages.getAttribute("data-media-presentation"),
      kind: pages.getAttribute("data-current-media-kind"),
      currentId: current?.getAttribute("data-media-page-id") ?? null,
      incomingId: incoming?.getAttribute("data-media-page-id") ?? null,
      centre: drawables[0] ?? null,
      drawables,
      aperture: { width: Math.round(bounds.width), height: Math.round(bounds.height) },
      uncovered: drawables.filter((entry) => entry === null).length,
      waiting: Boolean(root.querySelector(".starlight-media-state.is-waiting")),
      videoCount: videos.length,
      videoOwner: videos.map((video) => video.getAttribute("data-shared-media-id")),
      morphs,
    };
  }
  function sample() {
    if (!state.running) return;
    const morphs = viewTransitions();
    // Every root is read on the same frame, so a window that spans a surface
    // change grades the union rather than one stage that has already gone.
    const observed = state.roots.map((selector) => sampleRoot(selector, morphs)).filter(Boolean);
    if (!observed.length) { state.unmeasurable += 1; return; }
    if (observed.length === 1) { state.frames.push(observed[0]); return; }
    // One logical frame per tick: the surface presenting the picture owns it,
    // and a stage that is present but drawing nothing is the weaker claim.
    const owner = observed.find((entry) => entry.uncovered === 0 && entry.currentId)
      ?? observed.find((entry) => entry.currentId) ?? observed[0];
    state.frames.push({ ...owner, surfaces: observed.map((entry) => ({
      root: entry.root, currentId: entry.currentId, uncovered: entry.uncovered,
      videoCount: entry.videoCount,
    })) });
  }
  // Each window owns its own chain, retired by generation. A chain started at
  // document-start is not reliably carried into the committed document, and a
  // chain that only restarts on demand can be lost when a window closes.
  window.__qaStageStart = (rootSelector) => {
    state.roots = Array.isArray(rootSelector) ? rootSelector : [rootSelector];
    state.frames = [];
    state.gestures = [];
    state.unmeasurable = 0;
    state.running = true;
    state.generation = (state.generation ?? 0) + 1;
    const generation = state.generation;
    state.ticks = 0;
    const loop = () => {
      if (state.generation !== generation) return;
      state.ticks += 1;
      requestAnimationFrame(loop);
      sample();
    };
    requestAnimationFrame(loop);
  };
  window.__qaStageStop = () => {
    state.running = false;
    return { frames: state.frames, gestures: state.gestures, unmeasurable: state.unmeasurable, ticks: state.ticks };
  };
}
/* eslint-enable no-undef */

async function startSampler(page, rootSelector) {
  await page.evaluate((selector) => window.__qaStageStart(selector), rootSelector);
}

async function stopSampler(page) {
  return await page.evaluate(() => window.__qaStageStop());
}

async function stopSamplerFrames(page) {
  const { frames, unmeasurable, ticks } = await stopSampler(page);
  frames.unmeasurable = unmeasurable;
  frames.ticks = ticks;
  return frames;
}

/** Grade one recorded window against the B/C continuity acceptance. */
function gradeContinuity(frames, { allowedAssets, requireCoverage = true }) {
  const owned = new Set(allowedAssets);
  const staleFrames = frames.filter((frame) => frame.centre?.asset && !owned.has(frame.centre.asset));
  if (!frames.length) {
    return {
      sampledFrames: 0, failed: true,
      unmeasurableFrames: frames.unmeasurable ?? null,
      samplerTicks: frames.ticks ?? null,
      reason: "the sampler recorded no measurable frame for this window",
    };
  }
  // A frame whose aperture is uncovered while a view-transition group is
  // animating is owned by the morph snapshot, which no DOM hit test can see.
  // Those frames are counted and reported separately instead of being graded
  // as a bare stage or silently dropped from the claim.
  const morphCovered = frames.filter((frame) =>
    frame.currentId && frame.uncovered > 0 && frame.morphs?.length > 0);
  const blankFrames = requireCoverage
    ? frames.filter((frame) => frame.currentId && frame.uncovered > 0 && !(frame.morphs?.length > 0))
    : [];
  const waitingFrames = frames.filter((frame) => frame.waiting && frame.currentId);
  const multiVideoFrames = frames.filter((frame) => frame.videoCount > 1);
  // A foreground that goes new -> old -> new inside ONE transition is the
  // V1/V7 reversal. A deliberate A -> B -> A navigation legitimately brings A
  // back, so the chain is partitioned by the committed owner and each segment
  // is graded on its own.
  const owners = [];
  const reversals = [];
  let segment = [];
  let committed = null;
  for (const frame of frames) {
    if (frame.currentId !== committed) {
      committed = frame.currentId;
      segment = [];
    }
    const asset = frame.centre?.asset ?? null;
    if (!asset) continue;
    if (owners.at(-1) !== asset) owners.push(asset);
    if (segment.at(-1) === asset) continue;
    segment.push(asset);
    if (segment.length >= 3 && segment.at(-3) === asset) {
      reversals.push({ at: frame.at, committed, sequence: segment.slice(-3) });
    }
  }
  return {
    sampledFrames: frames.length,
    morphCoveredFrames: morphCovered.length,
    morphNames: [...new Set(morphCovered.flatMap((frame) => frame.morphs))].slice(0, 6),
    // Frames arrive from the animation-frame chain and from DOM mutations. The
    // tick count says which, so a claim about frames is never broader than the
    // observation that produced them.
    samplerTicks: frames.ticks ?? null,
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

/** The navigating half of a photograph's stationary click surface. */
async function photoClickPoint(page, rootSelector, direction) {
  return await page.evaluate(({ selector, direction: step }) => {
    const surface = document.querySelector(selector)?.querySelector("[data-story-hit-surface]");
    if (!surface) throw new Error("the photograph has no stationary click surface");
    const bounds = surface.getBoundingClientRect();
    return {
      x: bounds.left + bounds.width * (step < 0 ? 0.25 : 0.75),
      y: bounds.top + bounds.height * 0.5,
    };
  }, { selector: rootSelector, direction });
}

/**
 * Real mouse drag across the stage, above any native control chrome.
 *
 * The moves are paced like a hand rather than emitted in one tight loop: the
 * product derives release velocity from consecutive pointer samples, and a
 * burst with a zero millisecond delta carries no velocity at all. This is
 * gesture fidelity, not a wait inserted to make an assertion pass.
 */
async function swipeStage(page, rootSelector, direction) {
  const geometry = await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const bounds = pages.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * 0.35, width: bounds.width };
  }, rootSelector);
  const travel = Math.min(320, geometry.width * 0.45) * (direction > 0 ? -1 : 1);
  await page.mouse.move(geometry.x, geometry.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(geometry.x + travel * (step / 10), geometry.y);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  return { ...geometry, travel };
}

/** Everything needed to attribute a stuck navigation to an instance. */
async function stageDiagnostic(page, rootSelector) {
  return await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const pages = root?.querySelector("[data-story-media-pages]");
    const video = pages?.querySelector(".story-media-pages__video video");
    return {
      presentation: pages?.getAttribute("data-media-presentation") ?? null,
      kind: pages?.getAttribute("data-current-media-kind") ?? null,
      clickDirection: pages?.getAttribute("data-click-direction") ?? null,
      hitSurfaces: pages?.querySelectorAll("[data-story-hit-surface]").length ?? 0,
      slots: [...(pages?.querySelectorAll("[data-media-page]") ?? [])].map((slot) => ({
        id: slot.getAttribute("data-media-page-id"),
        role: slot.getAttribute("data-media-page"),
        ready: slot.getAttribute("data-media-page-ready"),
        incoming: slot.getAttribute("data-media-incoming"),
        layer: slot.getAttribute("data-media-layer"),
        zIndex: getComputedStyle(slot).zIndex,
        transform: getComputedStyle(slot).transform,
      })),
      video: video instanceof HTMLVideoElement ? {
        asset: video.getAttribute("data-shared-media-id"), hidden: video.hidden,
        paused: video.paused, currentTime: Number(video.currentTime.toFixed(3)),
        readyState: video.readyState, controls: video.controls,
      } : null,
    };
  }, rootSelector);
}

/**
 * One gesture-driven step. A step that never settles returns its diagnostic
 * instead of throwing, so a single stuck transition cannot hide the rest of
 * the lane's evidence.
 */
async function navigateByGesture(page, rootSelector, direction, expectedId) {
  const gesture = await swipeStage(page, rootSelector, direction);
  try {
    await waitForSettledAsset(page, expectedId, rootSelector);
    return { ok: true, gesture, expectedId };
  } catch {
    return {
      ok: false, gesture, expectedId,
      diagnostic: await stageDiagnostic(page, rootSelector),
      trace: await page.evaluate(() => (window.__qaStage?.gestures ?? []).slice(-60)),
    };
  }
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
      const photo = await photoClickPoint(page, STAGE, 1);
      await page.mouse.click(photo.x, photo.y);
      await waitForSettledAsset(page, V1);
      const toVideoFrames = await stopSamplerFrames(page);

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
      // Chromium's shadow controls may legitimately contain their own pointer
      // events, so the claim is the input path plus the absence of navigation
      // -- real hit-testing and real mouse input -- not a particular play state.
      const controlBefore = await samplePlayback(page, surface.root, { samples: 1, everyMs: 0 });
      await page.mouse.click(controls.x, controls.y);
      const controlAfter = await samplePlayback(page, surface.root, { samples: 2, everyMs: 150 });
      const controlState = await currentAsset(page, surface.root);
      const stillPresented = await page.locator(surface.root).isVisible();
      record({
        name: `story-${surface.label}-video-native-controls-reachable`,
        claim: "Chromium's lower-left native control region hit-tests to the video itself and a real click there neither navigates nor dismisses the surface; the reachability of individual controls beyond that region is not asserted here",
        controls, controlBefore, controlAfter, controlState, stillPresented,
        failed: !controls.controls || !controls.hitIsVideo || !stillPresented
          || controlState.id !== V1 || controlState.kind !== "video"
          || controlState.presentation !== "settled" || controlState.hitSurfaces !== 0,
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
      const toVideo = await navigateByGesture(page, STAGE, 1, V1);
      const afterFirstSwipe = await currentAsset(page);

      await startSampler(page, STAGE);
      // V1 -> V2 is the video<->video class: one transport, two sources.
      const offVideo = await navigateByGesture(page, STAGE, 1, V2);
      const swipeFrames = await stopSamplerFrames(page);
      const afterVideoSwipe = await currentAsset(page);
      const playbackAfterSwipe = await samplePlayback(page, STAGE, { samples: 2, everyMs: 120 });

      // Back onto the first video, then advertise-driven keyboard navigation.
      const backToVideo = await navigateByGesture(page, STAGE, -1, V1);
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
      const keyboardSettled = await waitForSettledAsset(page, V2).then(() => true, () => false);
      const afterKeyboard = keyboardSettled ? await currentAsset(page) : await stageDiagnostic(page, STAGE);

      record({
        name: "story-video-navigation-preserved",
        claim: "a swipe over the video lands exactly one step away -- onto the second, differently shaped video -- without starting playback, so its compatibility click did not add a second step, and the stage's advertised arrow keys still navigate",
        toVideo, offVideo, backToVideo,
        afterFirstSwipe, afterVideoSwipe, playbackAfterSwipe, stageRole, keyboardSettled, afterKeyboard,
        handoff: gradeContinuity(swipeFrames, { allowedAssets: [V1, V2] }),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !toVideo.ok || !offVideo.ok || !backToVideo.ok || !keyboardSettled
          || afterFirstSwipe.id !== V1 || afterVideoSwipe.id !== V2
          || playbackAfterSwipe.paused !== true
          || stageRole.tabIndex !== 0 || !stageRole.focused
          || stageRole.keyshortcuts !== "ArrowLeft ArrowRight"
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
      const halves = await photoClickPoint(page, STAGE, 1);
      await page.mouse.click(halves.x, halves.y);
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
    { label: "phone-portrait-reduced", mobile: true, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" },
    { label: "phone-landscape", mobile: true, viewport: { width: 844, height: 390 }, reducedMotion: "no-preference" },
    { label: "phone-landscape-reduced", mobile: true, viewport: { width: 844, height: 390 }, reducedMotion: "reduce" },
  ]) {
    const session = await createStoryPage(profile);
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await startSampler(page, STAGE);
      const visited = [I1];
      const steps = [];
      // Forward through every adjacent pair -- image->video, video->video,
      // video->image, image->image -- and back again, so each class is graded
      // in both directions on this viewport and motion mode.
      const route = [[V1, 1], [V2, 1], [I2, 1], [I3, 1], [I2, -1], [V2, -1], [V1, -1], [I1, -1]];
      for (const [target, direction] of route) {
        const step = await navigateByGesture(page, STAGE, direction, target);
        steps.push(step);
        if (!step.ok) break;
        visited.push(target);
      }
      const frames = await stopSamplerFrames(page);
      const continuity = gradeContinuity(frames, { allowedAssets: SEQUENCE });
      const stuck = steps.filter((step) => !step.ok);
      record({
        name: `story-handoff-continuity-${profile.label}`,
        claim: "sampled on every DOM mutation and on every animation frame the chain delivers, the stage points inside the presented aperture always show an asset the navigation currently owns, never an uncovered aperture, never the waiting indicator, and never a second live transport",
        viewport: profile.viewport, reducedMotion: profile.reducedMotion, visited, stuck,
        ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed || stuck.length > 0
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // B (continued). Readiness under latency. Served off a local preview server
  // every asset is ready almost immediately, which never asks currentReady /
  // targetReady / the retained frame to do their job. These two windows hold
  // the read URL and the media bytes back so the handoff has to wait, and the
  // continuity assertions are exactly the ones above -- unchanged.
  // ---------------------------------------------------------------------
  {
    const session = await createStoryPage({
      mobile: false,
      byteDelays: { [I2]: 1_200, [V2]: 900 },
      readDelays: { [I3]: 900 },
    });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await startSampler(page, STAGE);
      const steps = [];
      for (const [target, direction] of [[V1, 1], [V2, 1], [I2, 1], [I3, 1]]) {
        const step = await navigateByGesture(page, STAGE, direction, target);
        steps.push(step);
        if (!step.ok) break;
      }
      const frames = await stopSamplerFrames(page);
      const continuity = gradeContinuity(frames, { allowedAssets: SEQUENCE });
      const stuck = steps.filter((step) => !step.ok);
      record({
        name: "story-handoff-continuity-delayed-readiness",
        claim: "with the media bytes and one read URL deliberately held back, every handoff still keeps a legitimate drawable inside the aperture, never shows the waiting indicator while a page owns the stage, and never spawns a second transport",
        delays: { bytes: { [I2]: 1_200, [V2]: 900 }, read: { [I3]: 900 } },
        stuck, ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed || stuck.length > 0
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  {
    // The reversal happens while the abandoned target is still unreadable, so
    // its read resolves after the user has already committed elsewhere. The
    // stale result must not take the stage back.
    const session = await createStoryPage({ mobile: false, readDelays: { [V2]: 2_500 } });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await navigateByGesture(page, STAGE, 1, V1);
      await startSampler(page, STAGE);
      await swipeStage(page, STAGE, 1);
      await swipeStage(page, STAGE, -1);
      await waitForSettledAsset(page, I1);
      const afterReversal = await currentAsset(page);
      // Outlive the held read, then look again: this window exists to catch a
      // late completion, so it has to still be recording when the read lands.
      await page.waitForTimeout(3_000);
      const frames = await stopSamplerFrames(page);
      const afterLateRead = await currentAsset(page);
      const transports = await page.evaluate((selector) =>
        document.querySelector(selector).querySelectorAll("video").length, STAGE);
      // A neighbour that peeks during the drag is the stack's own grammar, so
      // the whole sequence is allowed here; what this window forbids is the
      // committed owner moving, or the stage going bare, once the late read
      // finally lands.
      const continuity = gradeContinuity(frames, { allowedAssets: SEQUENCE });
      record({
        name: "story-late-read-never-takes-the-stage",
        claim: "a read URL that resolves after its navigation was abandoned neither moves the committed owner nor leaves the aperture uncovered",
        afterReversal, afterLateRead, transports, ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed || afterReversal.id !== I1 || afterLateRead.id !== I1
          || afterLateRead.presentation !== "settled" || transports !== 1
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
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
      // Start from the middle of the sequence on purpose. From the first asset
      // a reverse swipe has no previous neighbour, so the first intent wins by
      // default and the check could pass while a stale completion decided the
      // outcome. Here both directions address a real, different asset, so the
      // latest intent is a named target rather than "either is legitimate".
      await navigateByGesture(page, STAGE, 1, V1);
      await navigateByGesture(page, STAGE, 1, V2);
      const startedFrom = await currentAsset(page);
      const abandonedIntent = I2;
      const latestIntent = V1;
      await startSampler(page, STAGE);
      await swipeStage(page, STAGE, 1);
      // No wait: reverse while the previous intent is still in flight.
      await swipeStage(page, STAGE, -1);
      await page.waitForFunction((selector) => {
        const pages = document.querySelector(selector).querySelector("[data-story-media-pages]");
        return pages.getAttribute("data-media-presentation") === "settled";
      }, STAGE, { polling: "raf", timeout: 10_000 });
      const frames = await stopSamplerFrames(page);
      const settled = await currentAsset(page);
      const transports = await page.evaluate((selector) =>
        document.querySelector(selector).querySelectorAll("video").length, STAGE);
      const stable = await page.evaluate(async (selector) => {
        const read = () => document.querySelector(selector)
          .querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id");
        const first = read();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { first, second: read() };
      }, STAGE);
      record({
        name: "story-reversal-commits-latest-intent",
        claim: "a reversal fired before the first navigation settles commits the reversal's own target, never the abandoned one, and leaves exactly one settled owner, one live transport and no late write-back",
        startedFrom, abandonedIntent, latestIntent, settled, transports, stable,
        sampledFrames: frames.length,
        concurrentLiveVideos: frames.filter((frame) => frame.videoCount > 1).slice(0, 2),
        failed: settled.presentation !== "settled" || !settled.ready
          || settled.id !== latestIntent
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
      const half = await photoClickPoint(page, STAGE, 1);
      await page.mouse.click(half.x, half.y);
      await waitForSettledAsset(page, V1);
      const toSecondVideo = await navigateByGesture(page, STAGE, 1, V2);
      const toLastVisible = await navigateByGesture(page, STAGE, 1, I2);
      const lastVisible = await currentAsset(page);

      // Both windows observe the immersive surface, opened and closed. It
      // exists in the tree while closed, so its unmeasurable frames are counted
      // separately rather than graded as an uncovered stage -- and the window
      // has to open BEFORE the entry gesture, or the reveal it exists to watch
      // has already happened by the time recording starts.
      // Both stages are observed on the same frames, and a morph snapshot is
      // now attributable, so coverage across the surface change is graded
      // rather than excused.
      await startSampler(page, [STAGE, FULLSCREEN]);
      await page.getByRole("button", { name: "全屏查看媒体", exact: true }).click();
      await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
      await waitForSettledAsset(page, I2, FULLSCREEN);
      const entryFrames = await stopSamplerFrames(page);
      const entered = await currentAsset(page, FULLSCREEN);

      await startSampler(page, [STAGE, FULLSCREEN]);
      await page.keyboard.press("Escape");
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      await waitForSettledAsset(page, I2);
      const exitFrames = await stopSamplerFrames(page);
      const exited = await currentAsset(page);

      // The reveal is carried by the shared-element morph, whose snapshots are
      // View Transitions pseudo-elements rather than nodes. The sampler now
      // records which view-transition groups animate on each frame, so an
      // uncovered aperture is either owned by a running morph -- reported as
      // morphCoveredFrames -- or is a genuinely bare stage, which fails.
      const entry = gradeContinuity(entryFrames, { allowedAssets: [I2] });
      const exit = gradeContinuity(exitFrames, { allowedAssets: [I2] });
      record({
        name: "story-entry-exit-object-continuity",
        claim: "entering immersive viewing presents only the targeted asset and leaving restores the same last-visible asset, with no other asset owning the foreground, no second transport, and no frame in which neither stage draws the picture while no shared-element morph owns it",
        entryFrames: entryFrames.length, exitFrames: exitFrames.length,
        toSecondVideo, toLastVisible, lastVisible, entered, exited, entry, exit,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !toSecondVideo.ok || !toLastVisible.ok || lastVisible.id !== I2 || entered.id !== I2 || exited.id !== I2
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
