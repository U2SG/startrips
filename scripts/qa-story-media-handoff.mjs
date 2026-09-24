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
import { mkdir, readFile, writeFile } from "node:fs/promises";

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
// Checked against the files themselves rather than their names: 1920x1167,
// 1280x1916 and 1280x893. The previous `TALL_PHOTO` here was 1920x873 -- also
// landscape -- so the sequence claimed a mixed-aspect handoff it never ran.
const WIDE_PHOTO = "/artworks/china-handscroll.jpg";
const TALL_PHOTO = "/artworks/mughal-akbarnama.jpg";
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

function deferred() {
  let resolve;
  const promise = new Promise((ready) => { resolve = ready; });
  return { promise, resolve };
}

async function waitForFixture(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} did not occur within ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timeout); }
}

const browser = await launchQaBrowser();

/**
 * Input modality is part of what this lane claims, so it is part of what the
 * lane produces. A phone-shaped viewport with `hasTouch` driven by `page.mouse`
 * still delivers `pointerType: "mouse"`, and the product branches on exactly
 * that:
 *
 *   - `JourneyStory.handleStorySheetPointerDown` returns early for
 *     `pointerType === "mouse"`, so the compact story sheet's own gesture never
 *     runs under a mouse;
 *   - the video owns all pointer streams starting on its picture or controls;
 *     Story navigation from video uses the separate visible step buttons;
 *   - `pointercancel` effectively never fires for a mouse, leaving the stage's
 *     cancellation and capture-loss paths unexercised.
 *
 * So every compact-mobile profile below drives real browser touch input. The
 * points go through CDP `Input.dispatchTouchEvent` -- the same browser-level
 * injection `page.touchscreen.tap` uses -- and never through page-script
 * `dispatchEvent`, which would produce untrusted events and prove nothing about
 * hit testing, capture or native control ownership.
 */
const inputDrivers = new WeakMap();

function mouseDriver(page) {
  return {
    kind: "mouse",
    down: async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); },
    move: async (x, y) => { await page.mouse.move(x, y); },
    up: async () => { await page.mouse.up(); },
    click: async (x, y) => { await page.mouse.click(x, y); },
  };
}

async function touchDriver(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  // One finger, one identifier for the whole stream. `touchEnd` carries no
  // points: the protocol expects the remaining contacts, and there are none.
  const finger = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  return {
    kind: "touch",
    down: async (x, y) => { await send("touchStart", finger(x, y)); },
    move: async (x, y) => { await send("touchMove", finger(x, y)); },
    up: async () => { await send("touchEnd", []); },
    click: async (x, y) => {
      // The step commits on pointerup, so this trusted touch can release
      // immediately without relying on a browser compatibility click.
      await send("touchStart", finger(x, y));
      await send("touchEnd", []);
    },
  };
}

/** The modality this page was opened with. Every gesture helper goes through it. */
function input(page) {
  const driver = inputDrivers.get(page);
  if (!driver) throw new Error("the page was opened without an input driver");
  return driver;
}

/**
 * What the page actually received, read back from the trusted events the
 * sampler recorded rather than from what this script believes it sent.
 */
async function observedPointerTypes(page) {
  return await page.evaluate(() => [...new Set((window.__qaStage?.gestures ?? [])
    .map((entry) => entry.pointerType).filter(Boolean))].sort());
}

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
  readDelays = {}, byteDelays = {}, renewPausedVideo = false,
  renewalByteFailure = false, renewalReadFailure = false, renewalSameUrlRetry = false,
  expiredRangeFailure = false,
} = {}) {
  const page = await browser.newPage({
    viewport: viewport ?? (mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }),
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    reducedMotion,
  });
  inputDrivers.set(page, mobile ? await touchDriver(page) : mouseDriver(page));
  const consoleErrors = [];
  const pageErrors = [];
  const mediaDelays = [];
  const renewalReads = [];
  const renewalBytes = [];
  const renewalReadStarted = deferred();
  const renewalByteStarted = deferred();
  const retryReadStarted = deferred();
  const retryByteStarted = deferred();
  const releaseRenewalRead = deferred();
  const releaseRenewalBytes = deferred();
  const releaseRetryRead = deferred();
  const releaseRetryBytes = deferred();
  const readCounts = new Map();
  const initialRead = { issuedAt: null, expiresAt: null };
  const expiredRanges = [];
  const expiredRangeDenied = deferred();
  const releaseExpiredRanges = deferred();
  const initialVideoBytes = expiredRangeFailure
    ? await readFile(new URL("../public/demo-media/east-star-orbit.webm", import.meta.url)) : null;
  let sameUrlRetryReadServed = false;
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
    const count = (readCounts.get(asset) ?? 0) + 1;
    readCounts.set(asset, count);
    if (renewPausedVideo && asset === V1 && count > 1) {
      const entry = { count, startedAt: Date.now(), releasedAt: null };
      renewalReads.push(entry);
      if ((renewalByteFailure || renewalReadFailure) && count === 3) {
        retryReadStarted.resolve(entry);
        await releaseRetryRead.promise;
      } else {
        renewalReadStarted.resolve(entry);
        await releaseRenewalRead.promise;
      }
      entry.releasedAt = Date.now();
      if (renewalReadFailure && count === 2) {
        entry.outcome = "failed";
        return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ error: "READ_TEMPORARILY_UNAVAILABLE", message: "signed read unavailable" }) });
      }
      entry.outcome = "ready";
      if (renewalSameUrlRetry && count === 3) sameUrlRetryReadServed = true;
    }
    await hold(readDelays[asset] ?? 0);
    const expiresAt = Date.now() + (renewPausedVideo && asset === V1 && count === 1
      ? 5_000 : 900_000);
    if (renewPausedVideo && asset === V1 && count === 1) {
      initialRead.issuedAt = Date.now();
      initialRead.expiresAt = expiresAt;
    }
    const url = renewPausedVideo && asset === V1
      ? `${CLIP}?storyRenewal=${renewalSameUrlRetry && count === 3 ? 2 : count}`
      : ASSET_URLS[asset] ?? WIDE_PHOTO;
    if (renewPausedVideo && asset === V1 && count > 1) renewalReads.at(-1).url = url;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url,
        expiresAt: new Date(expiresAt).toISOString(),
      }),
    });
  });
  if (renewPausedVideo) await page.route(/\/demo-media\/east-star-orbit\.webm\?storyRenewal=\d+$/, async (route) => {
    if (new URL(route.request().url()).searchParams.get("storyRenewal") === "1") {
      if (expiredRangeFailure && initialVideoBytes) {
        const range = route.request().headers().range ?? null;
        const start = Number(/^bytes=(\d+)-/.exec(range ?? "")?.[1] ?? 0);
        // Leave the later part of this real clip uncached. The first slice is
        // enough to paint the initial paused frame; native seek must fetch a
        // Range from the expired old capability before Retry can succeed.
        if (start >= 131_072) {
          const requestedAt = Date.now();
          const seekStartedAt = await releaseExpiredRanges.promise;
          if (requestedAt < seekStartedAt) {
            // A preload Range that began before the user's seek is not the
            // failure being tested. Give it only a short slice so the later
            // native seek still has to request its own uncached bytes.
            const end = Math.min(start + 1_023, initialVideoBytes.length - 1);
            return route.fulfill({ status: 206, contentType: "video/webm",
              headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${initialVideoBytes.length}` },
              body: initialVideoBytes.subarray(start, end + 1) });
          }
          const entry = { url: route.request().url(), range, requestedAt, status: 403, at: Date.now() };
          expiredRanges.push(entry);
          expiredRangeDenied.resolve(entry);
          return route.fulfill({ status: 403, contentType: "text/plain", body: "expired signed range" });
        }
        const end = Math.min(131_071, initialVideoBytes.length - 1);
        return route.fulfill({ status: 206, contentType: "video/webm",
          headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${initialVideoBytes.length}` },
          body: initialVideoBytes.subarray(start, end + 1) });
      }
      return route.continue();
    }
    const token = new URL(route.request().url()).searchParams.get("storyRenewal");
    const retryBytes = token === "3" || (renewalSameUrlRetry && sameUrlRetryReadServed);
    const entry = { url: route.request().url(), range: route.request().headers().range ?? null,
      startedAt: Date.now(), releasedAt: null, attempt: retryBytes ? "retry" : "renewal" };
    renewalBytes.push(entry);
    if ((renewalByteFailure || renewalReadFailure) && retryBytes) {
      retryByteStarted.resolve(entry);
      await releaseRetryBytes.promise;
    } else {
      renewalByteStarted.resolve(entry);
      await releaseRenewalBytes.promise;
    }
    entry.releasedAt = Date.now();
    if (renewalByteFailure && token === "2" && !retryBytes) {
      entry.outcome = "failed";
      return route.fulfill({ status: 503, contentType: "text/plain", body: "renewed media unavailable" });
    }
    entry.outcome = "continued";
    return route.continue();
  });
  for (const [asset, ms] of Object.entries(byteDelays)) {
    if (!ms) continue;
    await page.route(`**${ASSET_URLS[asset]}`, async (route) => {
      const delayed = { asset, startedAt: Date.now(), releasedAt: null, delayMs: ms,
        range: route.request().headers().range ?? null };
      mediaDelays.push(delayed);
      await hold(ms);
      delayed.releasedAt = Date.now();
      return route.continue();
    });
  }
  await page.goto(`${origin}${storyPath}`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-story").waitFor({ state: "visible", timeout: 15_000 });
  return { page, consoleErrors, pageErrors, mediaDelays,
    renewal: renewPausedVideo ? {
      reads: renewalReads, bytes: renewalBytes, initialRead, expiredRanges,
      expiredRangeDenied: expiredRangeDenied.promise,
      releaseExpiredRanges: (seekStartedAt = Number.POSITIVE_INFINITY) => releaseExpiredRanges.resolve(seekStartedAt),
      readStarted: renewalReadStarted.promise, byteStarted: renewalByteStarted.promise,
      retryReadStarted: retryReadStarted.promise, retryByteStarted: retryByteStarted.promise,
      releaseRead: () => releaseRenewalRead.resolve(),
      releaseBytes: () => releaseRenewalBytes.resolve(),
      releaseRetryRead: () => releaseRetryRead.resolve(),
      releaseRetryBytes: () => releaseRetryBytes.resolve(),
    } : null };
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
        // Which modality the page actually received. A phone-shaped viewport
        // proves nothing about this on its own, and the product branches on it.
        pointerType: event.pointerType ?? null,
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
    note({
      type: "pointermove", pointerType: event.pointerType ?? null,
      x: Math.round(event.clientX), y: Math.round(event.clientY), samples: 1,
    });
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
    attributeFilter: ["data-current-media-kind", "data-media-presentation", "data-media-page-ready", "data-media-requested"],
  });
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
  // A shared-element morph paints the handed-off picture from a clone that
  // `sharedElement.ts` appends to `document.body` with `pointer-events: none`
  // and strips of `data-shared-media-id`, while the destination image is held
  // at `visibility: hidden` for the whole morph. Neither node is reachable
  // through `elementsFromPoint`, so a point the morph is covering reads bare.
  // The clone publishes `data-shared-element-clone`, whose value is the morph
  // name `story-fullscreen-<assetId>`; a connected, sized clone whose box
  // contains the point is positive evidence that the picture WAS drawn there,
  // which is what separates a handoff from a blank stage. The asset is read
  // back out of that name on purpose: a morph carrying a picture this window
  // does not own is graded as a stale foreground like any other drawable,
  // rather than excusing the point because something was painted over it.
  const morphAt = (x, y) => {
    for (const clone of document.querySelectorAll("[data-shared-element-clone]")) {
      const box = clone.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) continue;
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      const style = getComputedStyle(clone);
      if (style.visibility === "hidden" || Number(style.opacity) <= 0.05) continue;
      const name = clone.dataset.sharedElementClone;
      return {
        kind: "morph", morph: name, live: false,
        asset: /^story-fullscreen-(.+)$/.exec(name)?.[1] ?? null,
      };
    }
    return null;
  };
  // Hit testing is document-wide, so a window that spans a surface change
  // reads one stage through whatever is painted over it. A point on the
  // inline stage that the immersive surface has taken over is owned by that
  // surface -- it is attributable, not a bare stage -- while a point owned by
  // nothing at all still is. `peers` carries the other surfaces this window is
  // already observing; nothing outside that set can excuse a bare point.
  const drawableAt = (x, y, own, peers) => {
    for (const node of document.elementsFromPoint(x, y)) {
      const peer = peers.find((entry) => entry.node !== own && entry.node.contains(node));
      if (peer) return { occludedBy: peer.selector };
      const found = identify(node);
      if (!found) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || Number(style.opacity) <= 0.05) continue;
      return found;
    }
    return morphAt(x, y);
  };
  // An uncovered point is only useful if it says what WAS there. Clip paths
  // remove a region from hit testing, so the element stack plus each page's
  // clip and the presented picture's own geometry distinguish "the stage was
  // bare" from "the current picture is clipped away from this point" from
  // "the sampler aimed outside the real picture".
  const probeAt = (x, y) => {
    const stack = document.elementsFromPoint(x, y).slice(0, 6).map((node) => {
      const style = getComputedStyle(node);
      return {
        tag: node.tagName,
        cls: String(node.className ?? "").slice(0, 48),
        page: node.closest?.("[data-media-page]")?.getAttribute("data-media-page-id") ?? null,
        clip: style.clipPath === "none" ? null : style.clipPath.slice(0, 72),
        opacity: style.opacity,
        visibility: style.visibility,
      };
    });
    const round = (rect) => rect ? {
      x: Math.round(rect.left), y: Math.round(rect.top),
      w: Math.round(rect.width), h: Math.round(rect.height),
    } : null;
    const pages = [...document.querySelectorAll("[data-media-page]")].map((page) => {
      const media = page.querySelector("img:not([hidden]), canvas:not([hidden])");
      return {
        id: page.getAttribute("data-media-page-id"),
        role: page.getAttribute("data-media-page"),
        ready: page.getAttribute("data-media-page-ready"),
        clip: getComputedStyle(page).clipPath.slice(0, 72),
        transform: getComputedStyle(page).transform.slice(0, 72),
        box: round(page.getBoundingClientRect()),
        media: media ? {
          tag: media.tagName,
          box: round(media.getBoundingClientRect()),
          natural: media instanceof HTMLImageElement
            ? [media.naturalWidth, media.naturalHeight] : [media.width, media.height],
          objectFit: getComputedStyle(media).objectFit,
          clip: getComputedStyle(media).clipPath.slice(0, 72),
        } : null,
      };
    });
    return { point: { x: Math.round(x), y: Math.round(y) }, stack, pages };
  };
  // The page whose aperture the coverage claim is graded against. A page's
  // clip inset is NOT an identity signal: `applyMediaDragTransform` never
  // writes clipPath, so every inset read during a drag or a settle is the
  // PREVIOUS settle's spring output, in which the base is deliberately clipped
  // into the neighbour's aperture while `data-media-page="current"` never
  // moved. Read the presented page from the identity the product publishes,
  // and use the clip only to narrow the probe rectangle to the pixels that
  // page is actually allowed to paint.
  const presentedPage = (pages) => {
    // Only the declared current page. An incoming page is by definition not
    // the presented one, so a stack whose current page is unmeasurable has no
    // aperture to grade and fails as stale rather than being graded against a
    // neighbour that is not yet showing the picture.
    const current = pages.querySelector('[data-media-page="current"]');
    return current && current.getBoundingClientRect().width > 0 ? current : null;
  };
  // `inset()` is a box shorthand and the computed value drops repeated sides,
  // so `inset(0% 0%)` reads back as `inset(0%)`. Expand it with the CSS
  // top/right/bottom/left omission rules before resolving the visible band.
  const clipBand = (page, box) => {
    const clip = getComputedStyle(page).clipPath;
    if (!clip.startsWith("inset(")) return box;
    // A computed inset can carry exponent notation (`7.06392e-05%`), and a
    // digits-only pattern reads its exponent back as a separate negative side.
    const sides = (clip.match(/-?\d*\.?\d+(?:e[-+]?\d+)?%/gi) ?? []).map((side) => Number(side.slice(0, -1)));
    if (!sides.length) return box;
    const [top, right = top, bottom = top, left = right] = sides;
    return new DOMRect(box.left + box.width * left / 100, box.top + box.height * top / 100,
      box.width * (1 - (left + right) / 100), box.height * (1 - (top + bottom) / 100));
  };
  const intersect = (a, b) => {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    return new DOMRect(left, top,
      Math.max(0, Math.min(a.right, b.right) - left), Math.max(0, Math.min(a.bottom, b.bottom) - top));
  };
  // The rectangle the presented media actually occupies under `contain`. The
  // coverage claim is made inside this aperture only; the surrounding letterbox
  // is correct emptiness, not an uncovered stage.
  const aperture = (pages, owner) => {
    if (!owner) return new DOMRect(0, 0, 0, 0);
    const node = owner.querySelector("img:not([hidden]), canvas:not([hidden])")
      ?? pages.querySelector('.story-media-pages__video video:not([hidden])');
    const box = (node ?? owner).getBoundingClientRect();
    const natural = node instanceof HTMLImageElement ? [node.naturalWidth, node.naturalHeight]
      : node instanceof HTMLVideoElement ? [node.videoWidth, node.videoHeight]
        : node instanceof HTMLCanvasElement ? [node.width, node.height] : [0, 0];
    const scale = natural[0] && natural[1] && box.width && box.height
      ? Math.min(box.width / natural[0], box.height / natural[1]) : 0;
    const fitted = scale > 0
      ? new DOMRect(box.left + (box.width - natural[0] * scale) / 2,
        box.top + (box.height - natural[1] * scale) / 2, natural[0] * scale, natural[1] * scale)
      : box;
    // The presented page may legitimately be clipped into a neighbour's
    // aperture mid-settle. Those pixels are not part of the picture it is
    // being asked to draw, so the claim is made inside the band its own clip
    // still allows -- never widened, only narrowed to what it may paint.
    return intersect(fitted, clipBand(owner, owner.getBoundingClientRect()));
  };
  // Which morph snapshots are on screen this frame. Both kinds are invisible
  // to a DOM hit test: a View Transitions snapshot is a browser-composited
  // pseudo-element, and this product's own `runSharedElementMorph` clone is a
  // `pointer-events: none` node on `document.body`. Recording them is what
  // makes an uncovered stage during entry or exit attributable: either a morph
  // owns the picture on that frame, or nothing does and the stage was bare.
  const morphSnapshots = () => {
    const clones = [...document.querySelectorAll("[data-shared-element-clone]")]
      .filter((clone) => {
        const box = clone.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((clone) => clone.dataset.sharedElementClone);
    try {
      return [...document.getAnimations()
        .filter((animation) => String(animation.effect?.pseudoElement ?? "").startsWith("::view-transition"))
        .map((animation) => animation.effect.pseudoElement), ...clones].slice(0, 6);
    } catch { return clones.slice(0, 6); }
  };
  // Video and its captured representative frame are separate paint sources.
  // A DOM hit test misses opacity on an ancestor (and the pointer-transparent
  // morph clone), so record their effective visibility across BOTH stages.
  const visualState = (node) => {
    if (!(node instanceof HTMLElement)) return { painted: false, reason: "absent" };
    const box = node.getBoundingClientRect();
    const intersect = (left, right) => ({
      left: Math.max(left.left, right.left), top: Math.max(left.top, right.top),
      right: Math.min(left.right, right.right), bottom: Math.min(left.bottom, right.bottom),
    });
    const intrinsic = node instanceof HTMLVideoElement ? [node.videoWidth, node.videoHeight]
      : node instanceof HTMLCanvasElement ? [node.width, node.height] : [0, 0];
    const fit = getComputedStyle(node).objectFit;
    const scale = intrinsic[0] && intrinsic[1] && (fit === "contain" || fit === "scale-down")
      ? Math.min(box.width / intrinsic[0], box.height / intrinsic[1], fit === "scale-down" ? 1 : Infinity) : 0;
    const picture = scale > 0 ? {
      left: box.left + (box.width - intrinsic[0] * scale) / 2,
      top: box.top + (box.height - intrinsic[1] * scale) / 2,
      right: box.right - (box.width - intrinsic[0] * scale) / 2,
      bottom: box.bottom - (box.height - intrinsic[1] * scale) / 2,
    } : box;
    let visible = intersect(picture, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    let opacity = 1;
    let reason = box.width > 0 && box.height > 0 ? null : "zero-box";
    for (let ancestor = node; ancestor && ancestor instanceof HTMLElement; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      opacity *= Number(style.opacity);
      if (ancestor.hidden || style.display === "none" || style.visibility !== "visible") {
        reason = `hidden:${ancestor.className || ancestor.tagName}`;
        break;
      }
      const bounds = ancestor.getBoundingClientRect();
      if (ancestor !== node && /^(hidden|clip|scroll|auto)$/.test(style.overflowX)) {
        visible = intersect(visible, bounds);
      }
      if (ancestor !== node && /^(hidden|clip|scroll|auto)$/.test(style.overflowY)) {
        visible = intersect(visible, bounds);
      }
      if (style.clipPath !== "none") {
        const inset = /^inset\(([^)]*)\)/.exec(style.clipPath);
        const sides = inset?.[1].split(" round ")[0].match(/-?\d*\.?\d+(?:e[-+]?\d+)?(?:%|px)/gi) ?? [];
        if (!inset || !sides.length) { reason = "unmeasurable-clip"; break; }
        const [top, right = top, bottom = top, left = right] = sides;
        const amount = (value, size) => value.endsWith("%")
          ? Number.parseFloat(value) * size / 100 : Number.parseFloat(value);
        visible = intersect(visible, {
          left: bounds.left + amount(left, bounds.width),
          top: bounds.top + amount(top, bounds.height),
          right: bounds.right - amount(right, bounds.width),
          bottom: bounds.bottom - amount(bottom, bounds.height),
        });
      }
    }
    if (!reason && opacity <= 0.01) reason = "zero-opacity";
    if (!reason && (visible.right - visible.left <= 1 || visible.bottom - visible.top <= 1)) {
      reason = "offscreen-or-fully-clipped";
    }
    return { painted: !reason, reason, opacity: Number(opacity.toFixed(3)),
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      visibleBox: { x: Math.round(visible.left), y: Math.round(visible.top),
        w: Math.round(Math.max(0, visible.right - visible.left)),
        h: Math.round(Math.max(0, visible.bottom - visible.top)) } };
  };
  const videoVisuals = (root, current) => {
    const video = root?.querySelector(".story-media-pages__video video");
    const frame = current?.querySelector("canvas:not([hidden])");
    return {
      video: { ...visualState(video), asset: video?.getAttribute("data-shared-media-id") ?? null,
        ready: video instanceof HTMLVideoElement && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && video.videoWidth > 0 && video.videoHeight > 0,
        paused: video instanceof HTMLVideoElement ? video.paused : null },
      frame: { ...visualState(frame), asset: current?.getAttribute("data-media-page-id") ?? null,
        ready: frame instanceof HTMLCanvasElement && frame.width > 0 && frame.height > 0 },
    };
  };
  // Capture before the entry/Close handler snapshots and pauses the source.
  // Mobile controls can activate on pointerup when a native scrub suppresses
  // the compatibility click; Back is captured before the surface listener.
  // The pixels stay in page memory; clone samples record only comparisons.
  const pixels64 = (source) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, 64, 64);
    return context.getImageData(0, 0, 64, 64).data;
  };
  // Compare light across areas rather than single star texels. Rotated and
  // shifted references are same-signal negative controls for a wrong picture.
  window.__qaSpatialFrameEvidence = (reference, visible) => {
    const source = Array(64).fill(0), screen = Array(64).fill(0);
    for (let y = 4; y < 60; y += 1) for (let x = 4; x < 60; x += 1) {
      const at = (y * 64 + x) * 4;
      const cell = Math.floor((y - 4) / 7) * 8 + Math.floor((x - 4) / 7);
      const light = (pixels) => Math.max(0,
        (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3 - 12);
      source[cell] += light(reference);
      screen[cell] += light(visible);
    }
    const correlation = (left, right) => {
      const meanLeft = left.reduce((sum, value) => sum + value, 0) / left.length;
      const meanRight = right.reduce((sum, value) => sum + value, 0) / right.length;
      let dot = 0, leftNorm = 0, rightNorm = 0;
      for (let index = 0; index < left.length; index += 1) {
        const a = left[index] - meanLeft, b = right[index] - meanRight;
        dot += a * b; leftNorm += a * a; rightNorm += b * b;
      }
      return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
    };
    const rotated = source.map((_, index) => source[(7 - index % 8) * 8 + Math.floor(index / 8)]);
    const shifted = source.map((_, index) => source[Math.floor(index / 8) * 8 + (index % 8 + 3) % 8]);
    const aligned = correlation(source, screen);
    const wrongRotation = correlation(rotated, screen);
    const wrongShift = correlation(shifted, screen);
    const sourceEnergy = source.reduce((sum, value) => sum + value, 0);
    const visibleEnergy = screen.reduce((sum, value) => sum + value, 0);
    return { aligned: Number(aligned.toFixed(3)), wrongRotation: Number(wrongRotation.toFixed(3)),
      wrongShift: Number(wrongShift.toFixed(3)),
      margin: Number((aligned - Math.max(wrongRotation, wrongShift)).toFixed(3)),
      sourceEnergy: Math.round(sourceEnergy), visibleEnergy: Math.round(visibleEnergy),
      energyRatio: sourceEnergy ? Number((visibleEnergy / sourceEnergy).toFixed(3)) : 0,
      sourceCells: source.filter((value) => value > 48).length,
      visibleCells: screen.filter((value) => value > 48).length };
  };
  const signalOf = (pixels) => {
    if (!pixels) return 0;
    let nonBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > 24) nonBlack += 1;
    }
    return nonBlack;
  };
  const snapshotPixels64 = (video) => {
    const snapshot = document.createElement("canvas");
    snapshot.width = video.videoWidth;
    snapshot.height = video.videoHeight;
    const context = snapshot.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0);
    return pixels64(snapshot);
  };
  const captureSource = (selector, trigger) => {
    if (!state.running) return;
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      // A rapid Back can reverse an unready destination while the entry clone
      // still owns the picture. Its already captured inline frame is the only
      // decoded source; do not replace it with the empty destination.
      if (trigger === "browser-back" && state.handoffSource?.pixels) return;
      state.handoffSource = { trigger, wallAt: Date.now(), error: "source has no decoded frame" };
      return;
    }
    try {
      const pixels = pixels64(video);
      const source = { trigger, wallAt: Date.now(), asset: video.getAttribute("data-shared-media-id"),
        time: video.currentTime, paused: video.paused, pixels, nonBlack: signalOf(pixels) };
      source.snapshotPixels = snapshotPixels64(video);
      source.snapshotNonBlack = signalOf(source.snapshotPixels);
      state.handoffSource = source;
      // The capture listener runs before React takes the snapshot and pauses a
      // playing video. A decoded frame can advance during that gesture. Read
      // the now-paused source after the handler, while its frame still exists.
      const capturePausedSource = () => {
        if (state.handoffSource !== source || source.paused || !video.paused
          || video.getAttribute("data-shared-media-id") !== source.asset
          || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        try {
          const settledPixels = pixels64(video);
          if (!settledPixels) return;
          source.settled = { time: video.currentTime, pixels: settledPixels,
            nonBlack: signalOf(settledPixels) };
          source.settled.snapshotPixels = snapshotPixels64(video);
          source.settled.snapshotNonBlack = signalOf(source.settled.snapshotPixels);
        } catch { /* The gesture frame remains the only admissible reference. */ }
      };
      queueMicrotask(() => {
        capturePausedSource();
        if (!source.settled) requestAnimationFrame(capturePausedSource);
      });
    } catch (error) {
      state.handoffSource = { trigger, wallAt: Date.now(), error: String(error) };
    }
  };
  const handoffControl = (target) => {
    if (!(target instanceof Element)) return null;
    if (target.closest(".journey-story__fullscreen-entry, .journey-story__mobile-media-fullscreen")) {
      return { kind: "entry", source: ".journey-story__media" };
    }
    if (target.closest(".journey-story-fullscreen__close")) {
      return { kind: "close", source: ".journey-story-fullscreen" };
    }
    return null;
  };
  let lastTouchHandoff = null;
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") lastTouchHandoff = null;
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "touch") return;
    const control = handoffControl(event.target);
    if (!control) return;
    captureSource(control.source, `${control.kind}-touch`);
    lastTouchHandoff = { kind: control.kind, at: performance.now() };
  }, true);
  document.addEventListener("click", (event) => {
    const control = handoffControl(event.target);
    if (!control) return;
    if (event.detail > 0 && lastTouchHandoff?.kind === control.kind
      && performance.now() - lastTouchHandoff.at < 1_000) {
      lastTouchHandoff = null;
      return;
    }
    captureSource(control.source, `${control.kind}-click`);
  }, true);
  window.addEventListener("popstate", () => captureSource(".journey-story-fullscreen", "browser-back"), true);
  const cloneFrameIdentity = (clone, asset) => {
    if (!(clone instanceof HTMLCanvasElement)) return { failed: true, reason: "video clone is not a canvas" };
    let pixels;
    try { pixels = pixels64(clone); } catch (error) {
      return { failed: true, reason: `clone canvas unreadable: ${String(error)}` };
    }
    const source = state.handoffSource;
    const nonBlack = signalOf(pixels);
    if (!pixels || !source?.pixels || source.asset !== asset) {
      return { failed: true, reason: "source frame missing or different asset",
        source: source ? { trigger: source.trigger, asset: source.asset, error: source.error } : null,
        nonBlack };
    }
    const compare = (candidate, label) => {
      let total = 0, retained = 0, signalDelta = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        total += Math.abs(pixels[index] - candidate.pixels[index]);
        total += Math.abs(pixels[index + 1] - candidate.pixels[index + 1]);
        total += Math.abs(pixels[index + 2] - candidate.pixels[index + 2]);
        if (Math.max(candidate.pixels[index], candidate.pixels[index + 1], candidate.pixels[index + 2]) <= 24) continue;
        const x = (index / 4) % 64, y = Math.floor(index / (64 * 4));
        let closest = 255;
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= 64 || ny >= 64) continue;
          const at = (ny * 64 + nx) * 4;
          if (Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) <= 24) continue;
          const delta = (Math.abs(pixels[at] - candidate.pixels[index])
            + Math.abs(pixels[at + 1] - candidate.pixels[index + 1])
            + Math.abs(pixels[at + 2] - candidate.pixels[index + 2])) / 3;
          closest = Math.min(closest, delta);
        }
        if (closest <= 45) retained += 1;
        signalDelta += closest;
      }
      const meanDelta = total / (64 * 64 * 3);
      const retainedRatio = candidate.nonBlack ? retained / candidate.nonBlack : 0;
      const signalMeanDelta = candidate.nonBlack ? signalDelta / candidate.nonBlack : 255;
      return { frame: label, frameTime: candidate.time, sourceNonBlack: candidate.nonBlack,
        meanDelta: Number(meanDelta.toFixed(2)), retainedRatio: Number(retainedRatio.toFixed(2)),
        signalMeanDelta: Number(signalMeanDelta.toFixed(1)),
        failed: candidate.nonBlack < 16 || nonBlack < candidate.nonBlack * 0.6
          || retainedRatio < 0.7 || signalMeanDelta > 35 || meanDelta > 8 };
    };
    const candidates = [compare(source, "click")];
    if (source.snapshotPixels) candidates.push(compare({
      ...source, pixels: source.snapshotPixels, nonBlack: source.snapshotNonBlack,
    }, "click-snapshot"));
    if (!source.paused && source.settled) candidates.push(compare(source.settled, "snapshot"));
    if (!source.paused && source.settled?.snapshotPixels) candidates.push(compare({
      ...source.settled, pixels: source.settled.snapshotPixels,
      nonBlack: source.settled.snapshotNonBlack,
    }, "settled-snapshot"));
    const matching = candidates.find((entry) => !entry.failed)
      ?? candidates.sort((left, right) => left.signalMeanDelta - right.signalMeanDelta)[0];
    return { trigger: source.trigger, sourceTime: source.time, pausedAtClick: source.paused,
      nonBlack, candidates, ...matching };
  };
  function sampleRoot(selector, morphs, peers) {
    const root = document.querySelector(selector);
    const pages = root?.querySelector("[data-story-media-pages]");
    const measurable = pages ? pages.getBoundingClientRect() : null;
    if (!pages || !(measurable.width > 0) || !(measurable.height > 0)) return null;
    const front = presentedPage(pages);
    const bounds = aperture(pages, front);
    const points = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
    const at = ([fx, fy]) => [bounds.left + bounds.width * fx, bounds.top + bounds.height * fy];
    const drawables = bounds.width > 0 && bounds.height > 0
      ? points.map((point) => drawableAt(...at(point), root, peers))
      : [];
    const bare = drawables.indexOf(null);
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
      centre: drawables[0]?.occludedBy ? null : drawables[0] ?? null,
      drawables,
      aperture: { width: Math.round(bounds.width), height: Math.round(bounds.height) },
      // The page this aperture was read from, and whether the stack offered a
      // usable one at all. A measurable stack that declares no presented page,
      // or whose presented page is clipped entirely out of its own picture,
      // cannot say where the picture is -- that frame fails as a stale
      // aperture rather than being graded against a rectangle nothing authored.
      front: front ? {
        id: front.getAttribute("data-media-page-id"),
        role: front.getAttribute("data-media-page"),
      } : null,
      staleAperture: !front || !(bounds.width > 0 && bounds.height > 0),
      occluded: drawables.filter((entry) => entry?.occludedBy).length,
      uncovered: drawables.filter((entry) => entry === null).length,
      bareProbe: bare >= 0 ? probeAt(...at(points[bare])) : undefined,
      // The presented page's own clip, every frame. A stale inset left over
      // from an earlier front is invisible in an end-state screenshot but
      // removes part of the picture from hit testing and from view, so the
      // frame that first wrote it is what separates "never reset" from
      // "reset and then overwritten".
      currentClip: current ? getComputedStyle(current).clipPath.slice(0, 40) : null,
      // #489 C/V6: whether the presented page is drawing its OWN picture this
      // frame. A destination that paints while a shared-element clone is still
      // flying is the recorded reveal-then-hide-then-smaller-reopen, and it is
      // invisible to the coverage grade because a painted destination reads as
      // perfectly covered.
      frontDrawn: (() => {
        const media = front?.querySelector("img:not([hidden]), canvas:not([hidden])");
        if (!media || !front) return false;
        const mediaStyle = getComputedStyle(media);
        const pageStyle = getComputedStyle(front);
        return mediaStyle.visibility !== "hidden" && Number(mediaStyle.opacity) > 0.05
          && pageStyle.visibility !== "hidden" && Number(pageStyle.opacity) > 0.05;
      })(),
      // Both waiting indicators acceptance item 3 names, kept apart because
      // they are different statements. `waiting` is the MEDIA STACK's own
      // "正在准备画面…" overlay, rendered by StoryMediaPages when it owns a
      // page it cannot present. `stageStatus` is JourneyStory's stage-level cue
      // for an asset whose read is still cold; over a stage NO page owns yet
      // that cue is correct product behaviour, which is why it is graded
      // against `currentReady` below rather than on its own.
      waiting: Boolean(pages.querySelector(":scope > .starlight-media-state.is-waiting")),
      stageStatus: Boolean(root.querySelector(".journey-story__media-state.is-waiting")),
      currentReady: current?.getAttribute("data-media-page-ready") === "true",
      videoCount: videos.length,
      videoOwner: videos.map((video) => video.getAttribute("data-shared-media-id")),
      videoVisuals: videoVisuals(root, current),
      morphs,
    };
  }
  function sample() {
    if (!state.running) return;
    const morphs = morphSnapshots();
    // Every root is read on the same frame, so a window that spans a surface
    // change grades the union rather than one stage that has already gone.
    const peers = state.roots
      .map((selector) => ({ selector, node: document.querySelector(selector) }))
      .filter((entry) => entry.node);
    const observed = state.roots.map((selector) => sampleRoot(selector, morphs, peers)).filter(Boolean);
    if (!observed.length) { state.unmeasurable += 1; return; }
    const clones = [...document.querySelectorAll("[data-shared-element-clone]")].map((node) => {
      const name = node.getAttribute("data-shared-element-clone") ?? "";
      const visual = visualState(node);
      const asset = name.startsWith("story-fullscreen-") ? name.slice("story-fullscreen-".length) : null;
      return { name, asset, ...visual,
        frame: visual.painted && asset ? cloneFrameIdentity(node, asset) : null };
    });
    const activeClones = clones.filter((entry) => entry.painted);
    const videoClone = activeClones.find((entry) => entry.asset) ?? { painted: false, asset: null };
    const surfaces = observed.map((entry) => ({
      root: entry.root, currentId: entry.currentId, uncovered: entry.uncovered,
      videoCount: entry.videoCount, videoVisuals: entry.videoVisuals,
    }));
    if (observed.length === 1) {
      state.frames.push({ ...observed[0], surfaces, clones, activeClones: activeClones.length, videoClone });
      return;
    }
    // One logical frame per tick: the surface presenting the picture owns it,
    // and a stage that is present but drawing nothing is the weaker claim.
    // A surface that only reports coverage because a peer is painted over it
    // is not the one drawing the picture, so a surface that actually draws is
    // preferred over a merely occluded one.
    const owner = observed.find((entry) => entry.uncovered === 0 && entry.centre && entry.currentId)
      ?? observed.find((entry) => entry.uncovered === 0 && entry.currentId)
      ?? observed.find((entry) => entry.currentId) ?? observed[0];
    state.frames.push({ ...owner, surfaces, clones, activeClones: activeClones.length, videoClone });
  }
  // Each window owns its own chain, retired by generation. A chain started at
  // document-start is not reliably carried into the committed document, and a
  // chain that only restarts on demand can be lost when a window closes.
  window.__qaStageStart = (rootSelector) => {
    state.roots = Array.isArray(rootSelector) ? rootSelector : [rootSelector];
    state.frames = [];
    state.gestures = [];
    state.unmeasurable = 0;
    state.handoffSource = null;
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
    const source = state.handoffSource;
    return { frames: state.frames, gestures: state.gestures, unmeasurable: state.unmeasurable,
      ticks: state.ticks, source: source ? { trigger: source.trigger, wallAt: source.wallAt, asset: source.asset,
        time: source.time, nonBlack: source.nonBlack, error: source.error } : null };
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
  const { frames, unmeasurable, ticks, source } = await stopSampler(page);
  frames.unmeasurable = unmeasurable;
  frames.ticks = ticks;
  frames.source = source;
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
  // A measurable stack that declares no presented page, or whose presented
  // page is clipped entirely out of its own picture, is showing an aperture
  // that belongs to nothing. That is the failure the front rule keeps
  // detectable.
  const staleApertureFrames = frames.filter((frame) => frame.staleAperture && frame.currentId);
  const waitingFrames = frames.filter((frame) => frame.waiting && frame.currentId);
  // #489 acceptance 3: the stage-level cue is forbidden "while a page is the
  // current owner", i.e. exactly when the stack has a presented page it can
  // already draw. The same cue over a stage that owns nothing yet is the cold
  // open and stays legal, so the grade is the cue AND a ready presented page.
  const stageWaitingFrames = frames.filter((frame) =>
    frame.stageStatus && frame.currentId && frame.currentReady);
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
    staleAperture: staleApertureFrames.slice(0, 4),
    // Points this surface no longer owns because another observed surface is
    // painted over them. Reported so a window that spans a surface change says
    // where its picture went rather than claiming it vanished.
    occludedFrames: frames.filter((frame) => frame.occluded > 0).length,
    waitingWhileOwned: waitingFrames.slice(0, 4),
    stageWaitingWhileOwned: stageWaitingFrames.slice(0, 4),
    concurrentLiveVideos: multiVideoFrames.slice(0, 2),
    foregroundReversals: reversals,
    failed: frames.length === 0 || staleFrames.length > 0 || blankFrames.length > 0
      || staleApertureFrames.length > 0
      || waitingFrames.length > 0 || stageWaitingFrames.length > 0
      || multiVideoFrames.length > 0 || reversals.length > 0,
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

/**
 * The point a viewer aims at: the centre of the contained picture, above the
 * transport's own control chrome. #489 forbids guessing where that chrome
 * begins from a fixed bottom inset, so `controlsTop` is the top of the real
 * control boxes `nativeControls` resolved from the browser itself.
 */
async function presentedVideoPoint(page, rootSelector, { fraction = 0.5, controlsTop = null } = {}) {
  return await page.evaluate(({ selector, fraction: at, controlsTop: chromeTop }) => {
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
    const controlStrip = chromeTop ?? bounds.bottom;
    if (y >= controlStrip) throw new Error("the sampled point falls inside the native control strip");
    const hit = document.elementFromPoint(x, y);
    return {
      x, y, width, height, controls: video.controls,
      hitIsVideo: hit === video,
      hitTag: hit instanceof Element ? hit.tagName : null,
      hitClass: hit instanceof Element ? hit.className : null,
      asset: video.getAttribute("data-shared-media-id"),
    };
  }, { selector: rootSelector, fraction, controlsTop });
}

const cdpSessions = new WeakMap();

async function cdpFor(page) {
  let session = cdpSessions.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    await session.send("Accessibility.enable");
    cdpSessions.set(page, session);
  }
  return session;
}

/**
 * The transport's own native control chrome, resolved from the browser rather
 * than guessed from the element box. #489 A says outright that a fixed bottom
 * inset must not stand in for the real hit range of the native controls, and
 * the guess this replaces was wrong in both directions: on desktop it aimed at
 * the time scrubber and silently seeked instead of reaching play/pause, and on
 * phone landscape it aimed below the fold and reported the whole strip out of
 * reach while play, mute and full screen were on screen all along.
 *
 * Each control comes back with its accessible name, the centre a finger aims
 * at, and whether that centre is on screen and hit-tests to the transport --
 * which is exactly what acceptance item 2 asks about each of them.
 */
async function nativeControls(page, rootSelector, { timeout = 4_000 } = {}) {
  // Chromium lays its control panel out from the element box, so a query taken
  // in the same frame as a resize can still see buttons parked in the overflow
  // menu. Poll until the panel reports a play entry rather than grading a
  // half-laid-out panel; the wait is a settle condition on the read, and every
  // assertion downstream is unchanged by it.
  const deadline = Date.now() + timeout;
  let resolved = await readNativeControls(page, rootSelector);
  while (!playEntry(resolved.controls) && Date.now() < deadline) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    resolved = await readNativeControls(page, rootSelector);
  }
  const reach = await page.evaluate(({ selector, points }) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    return points.map(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      const onScreen = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
      return {
        onScreen, hitIsVideo: hit === video,
        hitTag: hit instanceof Element ? hit.tagName : null,
        hitClass: hit instanceof Element ? String(hit.className).slice(0, 60) : null,
        reachable: onScreen && hit === video,
      };
    });
  }, { selector: rootSelector, points: resolved.controls.map(({ x, y }) => ({ x, y })) });
  const controls = resolved.controls.map((control, index) => ({ ...control, ...reach[index] }));
  // The whole accessibility view of the panel travels with the graded controls,
  // so a panel that really is missing a control reads as that rather than as a
  // script that failed to find one.
  controls.panel = resolved.panel;
  return controls;
}

async function readNativeControls(page, rootSelector) {
  const cdp = await cdpFor(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId, selector: `${rootSelector} .story-media-pages__video video`,
  });
  if (!nodeId) throw new Error("no presented video on the stage");
  const { nodes } = await cdp.send("Accessibility.queryAXTree", { nodeId });
  const resolved = [];
  const panel = [];
  for (const node of nodes ?? []) {
    const name = node.name?.value;
    const role = node.role?.value;
    if (role === "button" || role === "slider") panel.push({ role, name: name ?? null, ignored: Boolean(node.ignored) });
    if (!name || (role !== "button" && role !== "slider")) continue;
    let quad = null;
    try {
      quad = (await cdp.send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId })).model?.border ?? null;
    } catch { quad = null; }
    if (!Array.isArray(quad)) continue;
    const [left, top, , , right, bottom] = quad;
    resolved.push({
      name, role, ignored: Boolean(node.ignored),
      x: (left + right) / 2, y: (top + bottom) / 2,
      box: { left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) },
    });
  }
  return { controls: resolved, panel };
}

/** The play entry a viewer's finger aims at; named "pause" once it is running. */
function playEntry(controls) {
  return controls.find((control) => control.role === "button" && !control.ignored
    && /^(play|pause)$/i.test(control.name)) ?? null;
}

/** Controls the viewer cannot get to: off screen, or something else in front. */
function unreachableControls(controls) {
  return controls.filter((control) => !control.reachable)
    .map(({ name, box, onScreen, hitTag, hitClass }) => ({ name, box, onScreen, hitTag, hitClass }));
}

/** The top of the real control chrome, so a picture point can stay above it. */
function controlChromeTop(controls) {
  return controls.length ? Math.min(...controls.map((control) => control.box.top)) : null;
}

/** Drag Chromium's own timeline thumb using this page's actual input device. */
async function seekNativeTimeline(page, rootSelector, { targetFraction = 0.7 } = {}) {
  const picture = await presentedVideoPoint(page, rootSelector);
  if (!picture.hitIsVideo || !picture.controls) {
    return { picture, failed: true, reason: "native video picture is covered or controls are disabled" };
  }
  // Native chrome can fade after idle. Hover on desktop or tap the actual
  // video on touch, then wait for its accessible timeline to be exposed.
  if (input(page).kind === "mouse") await page.mouse.move(picture.x, picture.y);
  else await input(page).click(picture.x, picture.y);
  const timeline = (entries) => entries.filter((entry) => entry.role === "slider"
    && !entry.ignored && !/volume/i.test(entry.name))
    .sort((left, right) => (right.box.right - right.box.left) - (left.box.right - left.box.left))[0] ?? null;
  let controls = await nativeControls(page, rootSelector);
  let slider = timeline(controls);
  const deadline = Date.now() + 4_000;
  while ((!slider?.reachable || slider.box.right - slider.box.left < 32) && Date.now() < deadline) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    controls = await nativeControls(page, rootSelector, { timeout: 500 });
    slider = timeline(controls);
  }
  const before = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const stage = root?.querySelector("[data-story-media-pages]");
    const video = stage?.querySelector(".story-media-pages__video video");
    return {
      asset: video?.getAttribute("data-shared-media-id") ?? null,
      time: video instanceof HTMLVideoElement ? video.currentTime : null,
      duration: video instanceof HTMLVideoElement ? video.duration : null,
      paused: video instanceof HTMLVideoElement ? video.paused : null,
      presentation: stage?.getAttribute("data-media-presentation") ?? null,
    };
  }, rootSelector);
  if (!slider || !slider.reachable || slider.box.right - slider.box.left < 32
    || !Number.isFinite(before.duration) || before.duration <= 1) {
    return { picture, slider, controls: controls.panel, before, failed: true,
      reason: "no visible reachable native timeline or finite media duration" };
  }
  const y = slider.y;
  const width = slider.box.right - slider.box.left;
  const startX = slider.box.left + width * 0.2;
  const endX = slider.box.left + width * targetFraction;
  const hits = await page.evaluate(({ selector, points }) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    return points.map(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return { x, y, isVideo: target === video,
        tag: target instanceof Element ? target.tagName : null };
    });
  }, { selector: rootSelector, points: [{ x: startX, y }, { x: endX, y }] });
  if (hits.some((hit) => !hit.isVideo)) {
    return { picture, slider, controls: controls.panel, before, hits, failed: true,
      reason: "native timeline path is covered" };
  }
  // Install this only after the picture tap/hover that reveals Chromium's
  // controls. Playback can advance currentTime by itself; a seek event from
  // this exact video during the subsequent pointer drag is direct evidence
  // that the native timeline, rather than the play surface, handled input.
  await page.evaluate((selector) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement)) throw new Error("native seek target disappeared");
    const probe = { video, events: [], startedAt: null };
    for (const type of ["seeking", "seeked"]) {
      video.addEventListener(type, (event) => {
        probe.events.push({ type, trusted: event.isTrusted, time: video.currentTime,
          duration: video.duration, at: performance.now() });
      });
    }
    window.__qaNativeTimelineSeek = probe;
  }, rootSelector);
  await startSampler(page, rootSelector);
  const pointer = input(page);
  await page.evaluate(() => { window.__qaNativeTimelineSeek.startedAt = performance.now(); });
  await pointer.down(startX, y);
  for (let step = 1; step <= 8; step += 1) {
    await pointer.move(startX + (endX - startX) * step / 8, y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await pointer.up();
  const reached = await page.waitForFunction(({ selector, duration, target }) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    const probe = window.__qaNativeTimelineSeek;
    return video instanceof HTMLVideoElement && probe?.video === video && !video.seeking
      && probe.events.some((event) => event.type === "seeking" && event.trusted
        && event.at >= probe.startedAt)
      && probe.events.some((event) => event.type === "seeked" && event.trusted
        && event.at >= probe.startedAt && event.time >= duration * (target - 0.1))
      && video.currentTime >= duration * (target - 0.08);
  }, { selector: rootSelector, duration: before.duration, target: targetFraction }, { polling: "raf", timeout: 4_000 })
    .then(() => true, () => false);
  const observation = await stopSampler(page);
  const seekProbe = await page.evaluate(() => ({
    startedAt: window.__qaNativeTimelineSeek?.startedAt ?? null,
    events: window.__qaNativeTimelineSeek?.events ?? [],
  }));
  const after = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const stage = root?.querySelector("[data-story-media-pages]");
    const video = stage?.querySelector(".story-media-pages__video video");
    const current = stage?.querySelector('[data-media-page="current"]');
    return {
      asset: video?.getAttribute("data-shared-media-id") ?? null,
      current: current?.getAttribute("data-media-page-id") ?? null,
      time: video instanceof HTMLVideoElement ? video.currentTime : null,
      duration: video instanceof HTMLVideoElement ? video.duration : null,
      paused: video instanceof HTMLVideoElement ? video.paused : null,
      presentation: stage?.getAttribute("data-media-presentation") ?? null,
      requested: document.querySelector("[data-media-requested]")?.getAttribute("data-media-requested") ?? null,
    };
  }, rootSelector);
  const ownershipChanges = observation.frames.filter((frame) => frame.currentId !== before.asset
    || frame.presentation !== "settled");
  const claims = observation.gestures.filter((entry) => entry.type === "stage-attribute" && (
    (entry.name === "data-media-presentation" && entry.value !== "settled")
    || (entry.name === "data-media-requested" && entry.value !== null)
  ));
  const nativeSeek = seekProbe.startedAt !== null
    && seekProbe.events.some((event) => event.type === "seeking" && event.trusted
      && event.at >= seekProbe.startedAt)
    && seekProbe.events.some((event) => event.type === "seeked" && event.trusted
      && event.at >= seekProbe.startedAt && event.time >= before.duration * (targetFraction - 0.1));
  return {
    picture, slider, controls: controls.panel, before, after, hits, input: pointer.kind, targetFraction,
    seekProbe, nativeSeek, reached,
    observedFrames: observation.frames.length, ownershipChanges: ownershipChanges.slice(0, 3),
    claims: claims.slice(0, 4), trace: observation.gestures.slice(-24),
    failed: !nativeSeek || !reached || !observation.frames.length
      || ownershipChanges.length > 0 || claims.length > 0
      || before.asset !== after.asset || after.current !== before.asset
      || before.presentation !== "settled" || after.presentation !== "settled" || after.requested !== null
      || before.paused !== after.paused || !Number.isFinite(after.time)
      || after.time - before.time < Math.max(0.3, before.duration * Math.min(0.25, targetFraction - 0.3))
      || after.time < before.duration * (targetFraction - 0.1)
      || after.time > before.duration * Math.min(0.95, targetFraction + 0.2),
  };
}

/** A real native seek into an uncached portion of an expired signed clip. */
async function seekExpiredNativeTimeline(page, rootSelector, targetFraction = 0.85) {
  const picture = await presentedVideoPoint(page, rootSelector);
  if (!picture.hitIsVideo || !picture.controls) return { picture, failed: true, reason: "video target unavailable" };
  await page.mouse.move(picture.x, picture.y);
  const controls = await nativeControls(page, rootSelector);
  const slider = controls.filter((entry) => entry.role === "slider"
    && !entry.ignored && !/volume/i.test(entry.name))
    .sort((left, right) => (right.box.right - right.box.left) - (left.box.right - left.box.left))[0];
  if (!slider?.reachable || slider.box.right - slider.box.left < 32) {
    return { picture, controls: controls.panel, slider, failed: true, reason: "native timeline unavailable" };
  }
  const before = await videoHandoffState(page, rootSelector);
  await page.evaluate((selector) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement)) throw new Error("expired seek has no video");
    const probe = { video, startedAt: null, events: [] };
    for (const type of ["seeking", "seeked", "error"]) video.addEventListener(type, (event) => {
      probe.events.push({ type, trusted: event.isTrusted, time: video.currentTime, at: performance.now() });
    });
    window.__qaExpiredNativeSeek = probe;
  }, rootSelector);
  const width = slider.box.right - slider.box.left;
  const endX = slider.box.left + width * targetFraction;
  const y = slider.y;
  const hits = await page.evaluate(({ points, selector }) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    return points.map(({ x, y }) => document.elementFromPoint(x, y) === video);
  }, { selector: rootSelector, points: [{ x: endX, y }] });
  if (hits.some((hit) => !hit)) return { picture, before, slider, hits, failed: true,
    reason: "native timeline covered before expired seek" };
  await page.evaluate(() => { window.__qaExpiredNativeSeek.startedAt = performance.now(); });
  const pointer = input(page);
  await pointer.down(endX, y);
  await pointer.up();
  const probe = await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    startedAt: window.__qaExpiredNativeSeek.startedAt,
    events: window.__qaExpiredNativeSeek.events,
  }));
  const trustedEvent = probe.events.find((event) => event.type === "seeking" && event.trusted
    && event.at >= probe.startedAt && event.time >= before.duration * (targetFraction - 0.12));
  const trustedSeek = Boolean(trustedEvent);
  const seekStartedAt = trustedEvent ? probe.timeOrigin + trustedEvent.at : null;
  return { picture, before, slider, hits, probe, targetFraction, trustedSeek, seekStartedAt,
    failed: !trustedSeek || before.asset !== V1 || !before.paused };
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

/**
 * The presented transport's raw geometry. `presentedVideoPoint` refuses to
 * return a point it cannot defend, and on a narrow viewport a contained picture
 * really can be too short for one. This is what that refusal is attributed
 * with, so a bad box reads as a bad box instead of as a navigation defect.
 */
async function presentedVideoBox(page, rootSelector) {
  return await page.evaluate((selector) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement)) return { present: false };
    const bounds = video.getBoundingClientRect();
    return {
      present: true, hidden: video.hidden, controls: video.controls,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      box: {
        left: Math.round(bounds.left), top: Math.round(bounds.top),
        width: Math.round(bounds.width), height: Math.round(bounds.height),
      },
      controlGuard: Math.round(Math.min(72, bounds.height * 0.25)),
    };
  }, rootSelector);
}

/** How many transports the stack is actually holding, live and total. */
async function liveTransports(page, rootSelector) {
  return await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const videos = [...(pages?.querySelectorAll("video") ?? [])];
    return { total: videos.length, presented: videos.filter((video) => !video.hidden).length };
  }, rootSelector);
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
 * Real drag across the stage, above any native control chrome, in this page's
 * own modality: a mouse on desktop, a browser touch stream on compact mobile.
 *
 * Each move crosses a browser frame so the product receives distinct pointer
 * samples and can derive release velocity from the real event timestamps.
 */
async function swipeStage(page, rootSelector, direction) {
  const geometry = await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const bounds = pages.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * 0.35, width: bounds.width };
  }, rootSelector);
  const travel = Math.min(320, geometry.width * 0.45) * (direction > 0 ? -1 : 1);
  const pointer = input(page);
  await pointer.down(geometry.x, geometry.y);
  for (let step = 1; step <= 10; step += 1) {
    await pointer.move(geometry.x + travel * (step / 10), geometry.y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await pointer.up();
  return { ...geometry, travel, input: pointer.kind };
}

/**
 * One gesture that changes its mind: the finger travels past the commit
 * threshold one way and then back past it the other way without ever lifting.
 *
 * This is the only construction that exercises "a reversal fired before the
 * first navigation settles". Two separate swipes cannot: `swipeStage` ends in
 * `mouse.up()`, so the first navigation has already committed and the second
 * gesture addresses a stack that has already moved. Within one stream
 * the stage reselects the neighbour every time `dx` changes, so the
 * committed target must be the neighbour in the FINAL direction.
 */
async function reverseSwipeStage(page, rootSelector, firstDirection) {
  const geometry = await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const bounds = pages.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * 0.35, width: bounds.width };
  }, rootSelector);
  const reach = Math.min(320, geometry.width * 0.45);
  const offset = (direction) => (direction > 0 ? -1 : 1) * reach;
  const pointer = input(page);
  const orderedNeighbor = async () => page.evaluate(async (selector) => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const stage = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const current = stage?.querySelector('[data-media-page="current"]');
    if (!stage || !current) return null;
    const currentZ = Number(getComputedStyle(current).zIndex);
    const neighbor = [...stage.querySelectorAll("[data-media-page-id]")]
      .filter((node) => node !== current && node.getAttribute("data-media-page-ready") === "true")
      .sort((left, right) => Number(getComputedStyle(right).zIndex) - Number(getComputedStyle(left).zIndex))[0];
    const z = neighbor ? Number(getComputedStyle(neighbor).zIndex) : -Infinity;
    return z > currentZ && stage.getAttribute("data-media-presentation") === "dragging"
      ? { id: neighbor.getAttribute("data-media-page-id"), z, currentZ } : null;
  }, rootSelector);
  const glide = async (from, to, steps) => {
    for (let step = 1; step <= steps; step += 1) {
      await pointer.move(geometry.x + from + (to - from) * (step / steps), geometry.y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
  };
  await pointer.down(geometry.x, geometry.y);
  await glide(0, offset(firstDirection), 8);
  const firstOrderedNeighbor = await orderedNeighbor();
  await glide(offset(firstDirection), offset(-firstDirection), 16);
  const latestOrderedNeighbor = await orderedNeighbor();
  await pointer.up();
  return { ...geometry, reach, firstDirection, finalDirection: -firstDirection,
    input: pointer.kind, orderedNeighbors: [firstOrderedNeighbor, latestOrderedNeighbor] };
}

/**
 * The stack's own rest contract, read back from the DOM: the presented page is
 * the top-painted one and is not clipped out of its own picture, and every
 * retained page is clipped into the presented page's aperture. `expected` is
 * recomputed here from the presented picture's natural size rather than
 * trusting the product's numbers, so a residue left by an abandoned handoff is
 * attributable to the page that wears it.
 */
async function stackRestState(page, rootSelector) {
  return await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const slots = [...(pages?.querySelectorAll("[data-media-page-id]") ?? [])];
    const front = pages?.querySelector('[data-media-page="current"]') ?? null;
    const insets = (node) => {
      const clip = getComputedStyle(node).clipPath;
      if (!clip.startsWith("inset(")) return [0, 0, 0, 0];
      // A computed inset can carry exponent notation (`7.06392e-05%`), and a
    // digits-only pattern reads its exponent back as a separate negative side.
    const sides = (clip.match(/-?\d*\.?\d+(?:e[-+]?\d+)?%/gi) ?? []).map((side) => Number(side.slice(0, -1)));
      if (!sides.length) return [0, 0, 0, 0];
      const [top, right = top, bottom = top, left = right] = sides;
      return [top, right, bottom, left];
    };
    // The same fit the product computes for a rear page: the front picture's
    // aperture expressed as a percentage inset of the page box.
    const media = front?.querySelector("img:not([hidden]), canvas:not([hidden])") ?? null;
    const natural = media instanceof HTMLImageElement ? [media.naturalWidth, media.naturalHeight]
      : media instanceof HTMLCanvasElement ? [media.width, media.height] : [0, 0];
    const box = front ? { width: front.clientWidth, height: front.clientHeight } : { width: 0, height: 0 };
    const fit = natural[0] && natural[1] && box.width && box.height
      ? Math.min(box.width / natural[0], box.height / natural[1]) : 0;
    const expectedRear = fit > 0
      ? [(1 - natural[1] * fit / box.height) * 50, (1 - natural[0] * fit / box.width) * 50]
      : [0, 0];
    return {
      frontId: front?.getAttribute("data-media-page-id") ?? null,
      frontNatural: natural,
      expectedRear: expectedRear.map((value) => Number(value.toFixed(2))),
      pages: slots.map((slot) => {
        const [top, right, bottom, left] = insets(slot);
        return {
          id: slot.getAttribute("data-media-page-id"),
          role: slot.getAttribute("data-media-page"),
          ready: slot.getAttribute("data-media-page-ready"),
          zIndex: Number(getComputedStyle(slot).zIndex) || 0,
          clip: getComputedStyle(slot).clipPath.slice(0, 48),
          inset: [top, right, bottom, left].map((value) => Number(value.toFixed(2))),
        };
      }),
    };
  }, rootSelector);
}

/**
 * Grade one rest state. The presented page must be unclipped -- the product's
 * own `mediaStackClip` returns a zero inset for the front page, so any residue
 * there is an aperture nobody reclaimed -- must be painted above every other
 * page, and the retained pages must wear the presented picture's aperture.
 */
function gradeRestState(state, expectedFrontId, tolerance = 0.75) {
  const front = state.pages.find((slot) => slot.role === "current");
  const rear = state.pages.filter((slot) => slot.role !== "current");
  const frontResidue = front ? Math.max(...front.inset) : Number.POSITIVE_INFINITY;
  const misclipped = rear.filter((slot) =>
    Math.abs(slot.inset[0] - state.expectedRear[0]) > tolerance
    || Math.abs(slot.inset[1] - state.expectedRear[1]) > tolerance);
  const occluding = rear.filter((slot) => front && slot.zIndex >= front.zIndex);
  return {
    front, rear, frontResidue, expectedRear: state.expectedRear,
    misclipped, occluding,
    failed: !front || front.id !== expectedFrontId || frontResidue > tolerance
      || misclipped.length > 0 || occluding.length > 0,
  };
}

/**
 * Commit a program navigation so its springs are running, then take the stack
 * with a pointer. The grab cancels that presentation mid-flight; the current
 * picture must regain its own aperture even though its identity never changed.
 */
async function grabDuringNavigation(page, rootSelector) {
  // The arrow key the presented picture advertises, not a click half: a click
  // half is a point on the stationary surface, and on a portrait photograph
  // that point is outside the picture, where the surface correctly resolves to
  // the backdrop. Either input reaches the same `step()`; only this one is
  // aspect-ratio independent.
  await page.evaluate((selector) => {
    const image = document.querySelector(selector)
      ?.querySelector('[data-media-page="current"] img:not([hidden])');
    if (!image) throw new Error("the presented page has no focusable picture");
    image.focus();
  }, rootSelector);
  await page.keyboard.press("ArrowRight");
  const geometry = await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    if (!pages) throw new Error("the media stage left the tree before the grab");
    const bounds = pages.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * 0.35, width: bounds.width };
  }, rootSelector);
  const pointer = input(page);
  await pointer.down(geometry.x, geometry.y);
  // Past the 8px axis lock so the grab really fires, while 20px remains below
  // even the 36px minimum flick distance. Two browser frames per move preserve
  // a deliberate slow grab without a fixed millisecond hold.
  for (let step = 1; step <= 4; step += 1) {
    await pointer.move(geometry.x - step * 5, geometry.y);
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }
  await pointer.up();
  return { ...geometry, navigatedBy: "ArrowRight", input: pointer.kind };
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
      // What the viewer last asked for, cold targets included, so a dropped
      // navigation is attributable instead of looking like no navigation.
      requested: root?.closest("[data-media-requested]")?.getAttribute("data-media-requested")
        ?? document.querySelector("[data-media-requested]")?.getAttribute("data-media-requested") ?? null,
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

/** Which pages the stack currently reports as readable, and which own it. */
async function pageReadiness(page, rootSelector) {
  return await page.evaluate((selector) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const slots = [...(pages?.querySelectorAll("[data-media-page-id]") ?? [])];
    return {
      presentation: pages?.getAttribute("data-media-presentation") ?? null,
      current: pages?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id") ?? null,
      ready: Object.fromEntries(slots.map((slot) => [
        slot.getAttribute("data-media-page-id"),
        slot.getAttribute("data-media-page-ready") === "true",
      ])),
    };
  }, rootSelector);
}

async function waitForReadablePage(page, rootSelector, assetId, timeout = 10_000) {
  await page.waitForFunction(({ selector, expected }) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const slot = [...(pages?.querySelectorAll("[data-media-page-id]") ?? [])]
      .find((page) => page.getAttribute("data-media-page-id") === expected);
    return slot?.getAttribute("data-media-page-ready") === "true";
  }, { selector: rootSelector, expected: assetId }, { polling: "raf", timeout });
}

/**
 * One gesture-driven step. A step that never settles returns its diagnostic
 * instead of throwing, so a single stuck transition cannot hide the rest of
 * the lane's evidence.
 */
async function navigateByGesture(page, rootSelector, direction, expectedId) {
  const gesture = await swipeStage(page, rootSelector, direction);
  // Read the stack the moment the finger lifts. Whether the target was cold at
  // release is what decides between a stuck navigation and the stack's own
  // cold-neighbour resistance, and by the time a settle wait times out the
  // target has long since become readable.
  const atRelease = await pageReadiness(page, rootSelector);
  try {
    await waitForSettledAsset(page, expectedId, rootSelector);
    return { ok: true, gesture, input: gesture.input, method: "image swipe", expectedId, atRelease };
  } catch {
    return {
      ok: false, gesture, input: gesture.input, method: "image swipe", expectedId, atRelease,
      diagnostic: await stageDiagnostic(page, rootSelector),
      trace: await page.evaluate(() => (window.__qaStage?.gestures ?? []).slice(-60)),
    };
  }
}

/** Video has no page-drag owner. Its separate step button must itself be hit. */
async function navigateByVideoButton(page, rootSelector, direction, expectedId) {
  const step = direction < 0 ? "previous" : "next";
  const selector = rootSelector === FULLSCREEN
    ? `${FULLSCREEN} .journey-story-fullscreen__nav [data-video-step="${step}"]`
    : input(page).kind === "touch"
      ? `.journey-story__mobile-video-nav [data-video-step="${step}"]`
      : `.journey-story__media-nav [data-video-step="${step}"]`;
  const button = page.locator(selector);
  const count = await button.count();
  const visible = count === 1 && await button.isVisible();
  const enabled = visible && await button.isEnabled();
  const box = visible ? await button.boundingBox() : null;
  const hit = box ? await page.evaluate(({ selector: query, x, y }) => {
    const target = document.querySelector(query);
    const at = document.elementFromPoint(x, y);
    return { button: Boolean(target), hitButton: Boolean(target?.contains(at)),
      hitTag: at instanceof Element ? at.tagName : null,
      hitClass: at instanceof Element ? String(at.className).slice(0, 60) : null };
  }, { selector, x: box.x + box.width / 2, y: box.y + box.height / 2 }) : null;
  const control = { selector, count, visible, enabled, box, hit, input: input(page).kind };
  if (!enabled || !box || !hit?.hitButton) return {
    ok: false, button: control, method: "video button", input: input(page).kind,
    expectedId, diagnostic: await stageDiagnostic(page, rootSelector),
  };
  await input(page).click(box.x + box.width / 2, box.y + box.height / 2);
  const atRelease = await pageReadiness(page, rootSelector);
  try {
    await waitForSettledAsset(page, expectedId, rootSelector);
    return { ok: true, button: control, method: "video button", input: input(page).kind,
      expectedId, atRelease };
  } catch {
    return { ok: false, button: control, method: "video button", input: input(page).kind,
      expectedId, atRelease, diagnostic: await stageDiagnostic(page, rootSelector),
      trace: await page.evaluate(() => (window.__qaStage?.gestures ?? []).slice(-60)) };
  }
}

async function navigateByPresentedInput(page, rootSelector, direction, expectedId) {
  const before = await currentAsset(page, rootSelector);
  return before.kind === "video"
    ? navigateByVideoButton(page, rootSelector, direction, expectedId)
    : navigateByGesture(page, rootSelector, direction, expectedId);
}

/** Every transition frame must have one picture owner; the snapshot alone owns a morph. */
function gradeVideoFullscreenFrames(frames, assetId, { requireClone = true } = {}) {
  const cloneFrames = frames.filter((frame) => frame.videoClone?.painted);
  const wrongClone = cloneFrames.filter((frame) => frame.videoClone.asset !== assetId
    || frame.activeClones !== 1 || frame.clones?.length !== 1);
  const extraOrUnpaintedClone = frames.filter((frame) => (frame.clones?.length ?? 0) > 1
    || ((frame.clones?.length ?? 0) === 1 && frame.activeClones !== 1));
  const badCloneFrame = cloneFrames.filter((frame) => frame.videoClone.frame?.failed !== false);
  const doublePaint = cloneFrames.flatMap((frame) => (frame.surfaces ?? [])
    .flatMap((surface) => ["video", "frame"].filter((kind) => surface.videoVisuals?.[kind]?.painted)
      .map((kind) => ({ at: frame.at, root: surface.root, kind,
        visual: surface.videoVisuals[kind], clone: frame.videoClone }))));
  const stalePaint = frames.flatMap((frame) => (frame.surfaces ?? [])
    .flatMap((surface) => ["video", "frame"].filter((kind) =>
      surface.videoVisuals?.[kind]?.painted && surface.videoVisuals[kind].asset !== assetId)
      .map((kind) => ({ at: frame.at, root: surface.root, kind,
        visual: surface.videoVisuals[kind] }))));
  const concurrentPlayback = frames.filter((frame) => (frame.surfaces ?? [])
    .filter((surface) => surface.videoVisuals?.video?.paused === false).length > 1);
  const uncovered = frames.filter((frame) => !frame.videoClone?.painted
    && !(frame.surfaces ?? []).some((surface) => {
      const visual = surface.videoVisuals;
      return (visual?.video?.painted && visual.video.ready && visual.video.asset === assetId)
        || (visual?.frame?.painted && visual.frame.ready && visual.frame.asset === assetId);
    }));
  return {
    sampledFrames: frames.length, ticks: frames.ticks ?? null,
    unmeasurableFrames: frames.unmeasurable ?? null,
    sourceFrame: frames.source ?? null,
    cloneFrames: cloneFrames.length,
    wrongClone: wrongClone.slice(0, 3).map((frame) => ({ at: frame.at, clone: frame.videoClone })),
    extraOrUnpaintedClone: extraOrUnpaintedClone.slice(0, 3)
      .map((frame) => ({ at: frame.at, clones: frame.clones })),
    badCloneFrame: badCloneFrame.slice(0, 3)
      .map((frame) => ({ at: frame.at, clone: frame.videoClone })),
    doublePaint: doublePaint.slice(0, 3),
    stalePaint: stalePaint.slice(0, 3),
    concurrentPlayback: concurrentPlayback.slice(0, 3).map((frame) => ({ at: frame.at, surfaces: frame.surfaces })),
    uncovered: uncovered.slice(0, 3).map((frame) => ({
      at: frame.at, clone: frame.videoClone, surfaces: frame.surfaces,
    })),
    failed: frames.length === 0 || !(frames.ticks > 0) || (frames.unmeasurable ?? 0) > 0
      || (requireClone && cloneFrames.length === 0)
      || wrongClone.length > 0 || extraOrUnpaintedClone.length > 0 || badCloneFrame.length > 0
      || doublePaint.length > 0 || stalePaint.length > 0
      || concurrentPlayback.length > 0 || uncovered.length > 0,
  };
}

async function videoHandoffState(page, rootSelector) {
  return await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const stage = root?.querySelector("[data-story-media-pages]");
    const video = root?.querySelector(".story-media-pages__video video");
    const current = stage?.querySelector('[data-media-page="current"]');
    const quality = video instanceof HTMLVideoElement ? video.getVideoPlaybackQuality?.() : null;
    const intent = selector.includes("fullscreen")
      ? root?.querySelector('.journey-story-fullscreen__nav [aria-pressed]')
      : document.querySelector('.journey-story__mobile-media-play, .journey-story__media-nav [aria-pressed]');
    return {
      at: performance.now(), visible: Boolean(root && !root.hidden && getComputedStyle(root).display !== "none"),
      id: current?.getAttribute("data-media-page-id") ?? null,
      presentation: stage?.getAttribute("data-media-presentation") ?? null,
      asset: video?.getAttribute("data-shared-media-id") ?? null,
      src: video instanceof HTMLVideoElement ? video.currentSrc : null,
      time: video instanceof HTMLVideoElement ? video.currentTime : null,
      duration: video instanceof HTMLVideoElement ? video.duration : null,
      paused: video instanceof HTMLVideoElement ? video.paused : null,
      muted: video instanceof HTMLVideoElement ? video.muted : null,
      volume: video instanceof HTMLVideoElement ? video.volume : null,
      playbackRate: video instanceof HTMLVideoElement ? video.playbackRate : null,
      readyState: video instanceof HTMLVideoElement ? video.readyState : null,
      dimensions: video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : null,
      presentedFrames: quality?.totalVideoFrames ?? null,
      intentPressed: intent?.getAttribute("aria-pressed") ?? null,
    };
  }, rootSelector);
}

async function videoHandoffFailureDiagnostic(page) {
  return await page.evaluate(() => ({
    inline: document.querySelector('.journey-story__media [data-story-media-pages]')?.outerHTML.slice(0, 900) ?? null,
    fullscreen: document.querySelector('.journey-story-fullscreen [data-story-media-pages]')?.outerHTML.slice(0, 900) ?? null,
    fullscreenVisible: Boolean(document.querySelector('.journey-story-fullscreen:not([hidden])')),
    clones: [...document.querySelectorAll('[data-shared-element-clone]')]
      .map((clone) => clone.getAttribute('data-shared-element-clone')),
    historyStack: window.history.state?.__startripsMobileSurfaceStack ?? null,
  }));
}

async function waitForVideoHandoffState(page, rootSelector, assetId, paused) {
  await page.waitForFunction(({ selector, asset, expectedPaused }) => {
    const root = document.querySelector(selector);
    const stage = root?.querySelector("[data-story-media-pages]");
    const video = root?.querySelector(".story-media-pages__video video");
    return root && !root.hidden && getComputedStyle(root).display !== "none"
      && stage?.getAttribute("data-media-presentation") === "settled"
      && stage?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id") === asset
      && video instanceof HTMLVideoElement && video.getAttribute("data-shared-media-id") === asset
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && video.videoWidth > 0 && video.videoHeight > 0 && video.paused === expectedPaused;
  }, { selector: rootSelector, asset: assetId, expectedPaused: paused }, { polling: "raf", timeout: 8_000 });
  return await videoHandoffState(page, rootSelector);
}

async function waitForPresentedVideoHit(page, rootSelector, assetId) {
  await page.waitForFunction(({ selector, asset }) => {
    const root = document.querySelector(selector);
    const video = root?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement) || video.hidden
      || video.getAttribute("data-shared-media-id") !== asset
      || getComputedStyle(video).visibility !== "visible"
      || document.querySelector(`[data-shared-element-clone="story-fullscreen-${asset}"]`)) return false;
    const box = video.getBoundingClientRect();
    return box.width > 0 && box.height > 0
      && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === video;
  }, { selector: rootSelector, asset: assetId }, { polling: "raf", timeout: 8_000 });
}

function gradeVideoClock(before, after, paused, { requireIntent = true } = {}) {
  const elapsed = (after.at - before.at) / 1000;
  const advance = after.time - before.time;
  // The picture intentionally freezes while the clone flies. Playing resumes
  // at the destination; it may advance after cleanup, but must never jump
  // backward or outrun the elapsed wall time. rVFC and repeated clock samples
  // below independently prove that the transport actually resumed.
  const tolerance = paused ? 0.18 : 0.25;
  return {
    elapsed, advance, tolerance,
    failed: before.id !== V1 || after.id !== V1 || before.asset !== V1 || after.asset !== V1
      || before.src !== after.src || !before.src?.endsWith(CLIP)
      || before.presentation !== "settled" || after.presentation !== "settled"
      || before.paused !== paused || after.paused !== paused
      || before.muted !== after.muted || Math.abs(before.volume - after.volume) > 0.001
      || Math.abs(before.playbackRate - after.playbackRate) > 0.001
      || (requireIntent && (before.intentPressed !== (paused ? "false" : "true")
        || after.intentPressed !== (paused ? "false" : "true")))
      || !Number.isFinite(before.time) || !Number.isFinite(after.time)
      || (paused ? Math.abs(advance) > tolerance
        : advance < -0.18 || advance > elapsed + tolerance),
  };
}

/** Reload only the hidden destination under a held media response. */
async function prepareDelayedFullscreenTarget(page, session, delayMs) {
  const cdp = await cdpFor(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.route(`**${CLIP}`, async (route) => {
    const delayed = { asset: V1, startedAt: Date.now(), releasedAt: null, delayMs,
      range: route.request().headers().range ?? null };
    session.mediaDelays.push(delayed);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayed.releasedAt = Date.now();
    try { await route.continue(); delayed.outcome = "continued"; }
    catch (error) { delayed.outcome = `cancelled:${String(error).slice(0, 100)}`; }
  });
  const initiatedAt = Date.now();
  const target = await page.evaluate(({ inline, fullscreen }) => {
    const source = document.querySelector(inline)?.querySelector(".story-media-pages__video video");
    const destination = document.querySelector(fullscreen)?.querySelector(".story-media-pages__video video");
    if (!(source instanceof HTMLVideoElement) || !(destination instanceof HTMLVideoElement)
      || !source.currentSrc || (destination.currentSrc || destination.src) !== source.currentSrc) {
      return { failed: true, reason: "hidden destination is not bound to the inline source" };
    }
    const before = { readyState: destination.readyState, currentSrc: destination.currentSrc };
    // Fixture operation on the hidden persistent destination only. User input
    // still owns seek, fullscreen and Back; no play/currentTime/state setter.
    destination.load();
    const readProbe = { readyAt: null, events: [] };
    for (const type of ["loadeddata", "canplay", "error"]) {
      destination.addEventListener(type, () => {
        readProbe.events.push({ type, at: Date.now(), readyState: destination.readyState });
        if (destination.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && readProbe.readyAt === null) {
          readProbe.readyAt = Date.now();
        }
      });
    }
    window.__qaTargetReadProbe = readProbe;
    return { before, after: { readyState: destination.readyState, currentSrc: destination.currentSrc },
      failed: destination.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA };
  }, { inline: STAGE, fullscreen: FULLSCREEN });
  const deadline = Date.now() + 2_000;
  let request = session.mediaDelays.find((entry) => entry.startedAt >= initiatedAt) ?? null;
  while (!request && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    request = session.mediaDelays.find((entry) => entry.startedAt >= initiatedAt) ?? null;
  }
  return { initiatedAt, target, requestStartedAt: request?.startedAt ?? null,
    failed: target.failed || !request };
}

/** Native seek can reveal/play a touch video; restore paused intent through its own control. */
async function pauseNativeVideoIfNeeded(page, rootSelector) {
  let state = await videoHandoffState(page, rootSelector);
  if (state.paused) return { before: state, after: state, clicked: false };
  const picture = await presentedVideoPoint(page, rootSelector);
  if (input(page).kind === "mouse") await page.mouse.move(picture.x, picture.y);
  else await input(page).click(picture.x, picture.y);
  state = await videoHandoffState(page, rootSelector);
  if (state.paused) return { before: state, after: state, clicked: false };
  const controls = await nativeControls(page, rootSelector);
  const pause = playEntry(controls);
  if (!pause?.reachable || pause.name.toLowerCase() !== "pause") {
    return { before: state, controls: controls.panel, pause, failed: true };
  }
  await input(page).click(pause.x, pause.y);
  const after = await waitForVideoHandoffState(page, rootSelector, V1, true);
  return { before: state, after, clicked: true, pause };
}

async function startStoryVideoPlayback(page, mobile) {
  const selector = mobile ? ".journey-story__mobile-media-play" : ".journey-story__media-nav [aria-pressed]";
  const button = page.locator(selector);
  const before = await button.getAttribute("aria-pressed");
  await page.evaluate(() => {
    const video = document.querySelector('.journey-story__media .story-media-pages__video video');
    const probe = { events: [] };
    window.__qaPlaybackStart = probe;
    if (!(video instanceof HTMLVideoElement)) return;
    for (const type of ["play", "playing", "pause", "ended", "error", "waiting", "stalled"]) {
      video.addEventListener(type, (event) => {
        if (probe.events.length < 24) probe.events.push({ type, trusted: event.isTrusted,
          at: performance.now(), time: video.currentTime, readyState: video.readyState });
      });
    }
  });
  let activation = null;
  try {
    activation = before !== "true" ? await clickHandoffButton(page, selector) : null;
    const after = await waitForVideoHandoffState(page, STAGE, V1, false);
    return { before, after, activation, pressed: await button.getAttribute("aria-pressed"), failed: false };
  } catch (error) {
    const diagnostic = await page.evaluate((query) => {
      const video = document.querySelector('.journey-story__media .story-media-pages__video video');
      const control = document.querySelector(query);
      return { events: window.__qaPlaybackStart?.events ?? [],
        pressed: control?.getAttribute("aria-pressed") ?? null,
        disabled: control instanceof HTMLButtonElement ? control.disabled : null,
        video: video instanceof HTMLVideoElement ? {
          time: video.currentTime, duration: video.duration, paused: video.paused,
          ended: video.ended, readyState: video.readyState, networkState: video.networkState,
          errorCode: video.error?.code ?? null,
        } : null };
    }, selector);
    return { before, activation, pressed: await button.getAttribute("aria-pressed"), failed: true,
      reason: error instanceof Error ? error.message : String(error), diagnostic };
  }
}

async function clickHandoffButton(page, selector) {
  const button = page.locator(selector);
  const box = await button.boundingBox();
  if (!box || !await button.isEnabled()) throw new Error(`handoff button unavailable: ${selector}`);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const hit = await page.evaluate(({ query, x: atX, y: atY }) => {
    const button = document.querySelector(query);
    const target = document.elementFromPoint(atX, atY);
    return { hitButton: Boolean(button?.contains(target)),
      tag: target instanceof Element ? target.tagName : null,
      className: target instanceof Element ? String(target.className).slice(0, 80) : null };
  }, { query: selector, x, y });
  if (!hit.hitButton) throw new Error(`handoff button covered: ${selector}: ${JSON.stringify(hit)}`);
  await input(page).click(x, y);
  return { selector, input: input(page).kind, hit };
}

/** Reveal the desktop overlay with real pointer activity before Close. */
async function clickFullscreenClose(page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("fullscreen viewport unavailable");
  await page.mouse.move(viewport.width - 40, 40);
  const selector = `${FULLSCREEN} .journey-story-fullscreen__close`;
  await page.locator(selector).waitFor({ state: "visible", timeout: 2_000 });
  return await clickHandoffButton(page, selector);
}

/** Prove that the paused frame in the screenshot is the decoded video frame. */
async function pausedVideoScreenPixels(page, rootSelector, diagnosticName = null) {
  const native = await readNativeControls(page, rootSelector).catch(() => null);
  const nativeChromeTop = native?.controls
    .filter((control) => !control.ignored)
    .reduce((top, control) => Math.min(top, control.box.top), Number.POSITIVE_INFINITY);
  const screenshotBuffer = await page.screenshot();
  const screenshot = screenshotBuffer.toString("base64");
  const result = await page.evaluate(async ({ selector, png, captureFrame, chromeTop }) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement) || !video.paused || video.readyState < 2) {
      return { failed: true, reason: "no paused decoded video" };
    }
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const screen = document.createElement("canvas");
    screen.width = 64; screen.height = 64;
    const screenContext = screen.getContext("2d", { willReadFrequently: true });
    const frame = document.createElement("canvas");
    frame.width = 64; frame.height = 64;
    const frameContext = frame.getContext("2d", { willReadFrequently: true });
    if (!screenContext || !frameContext) return { failed: true, reason: "canvas context unavailable" };
    frameContext.drawImage(video, 0, 0, 64, 64);
    const pixels = frameContext.getImageData(0, 0, 64, 64).data;
    const decodedFramePng = captureFrame ? frame.toDataURL("image/png").split(",")[1] : null;
    const asset = video.getAttribute("data-shared-media-id");
    let reference = window.__qaPausedFrameReference;
    if (!reference) {
      const signal = [];
      const spread = Array(16).fill(null);
      for (let y = 2; y < 62; y += 1) for (let x = 2; x < 62; x += 1) {
        const at = (y * 64 + x) * 4;
        const strength = Math.max(pixels[at], pixels[at + 1], pixels[at + 2]);
        if (strength <= 24) continue;
        const point = { x, y, strength, at };
        signal.push(point);
        const cell = Math.floor(y / 16) * 4 + Math.floor(x / 16);
        if (!spread[cell] || strength > spread[cell].strength) spread[cell] = point;
      }
      signal.sort((left, right) => right.strength - left.strength);
      const points = spread.filter(Boolean).sort((left, right) => right.strength - left.strength).slice(0, 12);
      for (const point of signal) {
        if (points.length >= 12) break;
        if (!points.some((selected) => selected.at === point.at)) points.push(point);
      }
      reference = { asset, pixels: new Uint8ClampedArray(pixels), signal: signal.map((point) => point.at),
        brightPixels: signal.length, cells: spread.flatMap((point, cell) => point ? [cell] : []),
        spreadCells: spread.filter(Boolean).length, points };
      window.__qaPausedFrameReference = reference;
    }
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    const left = box.left + (box.width - width) / 2, top = box.top + (box.height - height) / 2;
    const screenshotScaleX = image.naturalWidth / innerWidth;
    const screenshotScaleY = image.naturalHeight / innerHeight;
    const raster = document.createElement("canvas");
    raster.width = Math.max(1, Math.round(width * screenshotScaleX));
    raster.height = Math.max(1, Math.round(height * screenshotScaleY));
    const rasterContext = raster.getContext("2d");
    if (!rasterContext) return { failed: true, reason: "screen raster unavailable" };
    rasterContext.drawImage(video, 0, 0, raster.width, raster.height);
    frameContext.clearRect(0, 0, 64, 64);
    frameContext.drawImage(raster, 0, 0, 64, 64);
    const screenExpected = frameContext.getImageData(0, 0, 64, 64).data;
    // Compare the same 64x64 spatial footprint. Reading one screenshot pixel
    // against a downsampled decoded frame mistakes compositor scaling for a
    // different picture, especially on sparse star fields.
    screenContext.drawImage(image, left * screenshotScaleX, top * screenshotScaleY,
      width * screenshotScaleX, height * screenshotScaleY, 0, 0, 64, 64);
    const visiblePixels = screenContext.getImageData(0, 0, 64, 64).data;
    const spatialDirect = window.__qaSpatialFrameEvidence(pixels, visiblePixels);
    const spatialRaster = window.__qaSpatialFrameEvidence(screenExpected, visiblePixels);
    // Native controls are browser chrome composited over the decoded picture.
    // Exclude their observed accessibility bounds from both images before
    // asking whether the unobscured picture is the same frame.
    const unobscuredSource = new Uint8ClampedArray(pixels);
    const unobscuredRaster = new Uint8ClampedArray(screenExpected);
    const unobscuredVisible = new Uint8ClampedArray(visiblePixels);
    const maskedRows = [];
    if (Number.isFinite(chromeTop) && chromeTop > top && chromeTop < top + height) {
      for (let y = 0; y < 64; y += 1) {
        if (top + height * (y + 0.5) / 64 < chromeTop) continue;
        maskedRows.push(y);
        for (let x = 0; x < 64; x += 1) {
          const at = (y * 64 + x) * 4;
          for (const image of [unobscuredSource, unobscuredRaster, unobscuredVisible]) {
            image[at] = 0; image[at + 1] = 0; image[at + 2] = 0;
          }
        }
      }
    }
    const unobscuredSpatialDirect = window.__qaSpatialFrameEvidence(unobscuredSource, unobscuredVisible);
    const unobscuredSpatialRaster = window.__qaSpatialFrameEvidence(unobscuredRaster, unobscuredVisible);
    const visibleCells = new Set();
    for (let y = 2; y < 62; y += 1) for (let x = 2; x < 62; x += 1) {
      const at = (y * 64 + x) * 4;
      if (Math.max(visiblePixels[at], visiblePixels[at + 1], visiblePixels[at + 2]) > 24) {
        visibleCells.add(Math.floor(y / 16) * 4 + Math.floor(x / 16));
      }
    }
    const retainedCells = reference.cells.filter((cell) => visibleCells.has(cell)).length;
    const samples = reference.points.map(({ x: px, y: py, at }) => {
      const fx = (px + 0.5) / 64, fy = (py + 0.5) / 64;
      const x = left + width * fx, y = top + height * fy;
      const hit = document.elementFromPoint(x, y);
      const sx = Math.round(x * screenshotScaleX);
      const sy = Math.round(y * screenshotScaleY);
      const offscreen = sx < 0 || sy < 0 || sx >= image.naturalWidth || sy >= image.naturalHeight;
      const decoded = [pixels[at], pixels[at + 1], pixels[at + 2]];
      const expected = [screenExpected[at], screenExpected[at + 1], screenExpected[at + 2]];
      let visible = [0, 0, 0];
      let delta = expected.reduce((sum, channel) => sum + channel, 0) / 3;
      // Filtering can move a source texel by one 64px cell. Keep the nearest
      // matching light there; the bright-count and spread checks reject a
      // blank or covered picture even when a weak texel filters to black.
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= 64 || ny >= 64) continue;
        const near = (ny * 64 + nx) * 4;
        const candidate = [visiblePixels[near], visiblePixels[near + 1], visiblePixels[near + 2]];
        if (Math.max(...candidate) <= 24) continue;
        const candidateDelta = candidate.reduce((sum, channel, index) =>
          sum + Math.abs(channel - expected[index]), 0) / 3;
        if (candidateDelta < delta) { delta = candidateDelta; visible = candidate; }
      }
      return { fx, fy, hitIsVideo: hit === video, offscreen, visible, decoded, expected,
        delta: Number(delta.toFixed(1)) };
    });
    const meanDelta = samples.reduce((sum, sample) => sum + sample.delta, 0) / samples.length;
    let retained = 0, signalDelta = 0;
    for (const at of reference.signal) {
      const expected = reference.pixels;
      if (Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) > 24) retained += 1;
      signalDelta += (Math.abs(pixels[at] - expected[at])
        + Math.abs(pixels[at + 1] - expected[at + 1])
        + Math.abs(pixels[at + 2] - expected[at + 2])) / 3;
    }
    const retainedRatio = reference.signal.length ? retained / reference.signal.length : 0;
    const signalMeanDelta = reference.signal.length ? signalDelta / reference.signal.length : 255;
    const visibleBright = samples.filter((sample) => Math.max(...sample.visible) > 24).length;
    const picture = unobscuredSpatialDirect;
    // A sparse star can move by one raster cell under compositor scaling.
    // Compare the visible spatial pattern with the decoded frame and two wrong
    // arrangements measured from this same frame; also reject a blank or
    // heavily dimmed screen by its occupied cells and total light.
    const visibleFrameWrong = picture.aligned < 0.8 || picture.margin < 0.08
      || picture.visibleCells < Math.ceil(picture.sourceCells * 0.6)
      || picture.energyRatio < 0.5 || picture.energyRatio > 2;
    return { meanDelta: Number(meanDelta.toFixed(1)), samples,
      spatialDirect, spatialRaster,
      unobscuredSpatialDirect, unobscuredSpatialRaster, nativeChromeTop: chromeTop,
      maskedRows: maskedRows.length,
      decodedFramePng,
      brightPixels: reference.brightPixels, spreadCells: reference.spreadCells,
      retainedCells, visibleBright, retainedRatio: Number(retainedRatio.toFixed(2)),
      signalMeanDelta: Number(signalMeanDelta.toFixed(1)),
      visibleFrameWrong,
      failed: asset !== reference.asset || reference.brightPixels < 16 || reference.spreadCells < 3
        || samples.length < 8 || visibleFrameWrong
        || samples.some((sample) => !sample.hitIsVideo || sample.offscreen)
        || retainedRatio < 0.75 || signalMeanDelta > 20 };
  }, { selector: rootSelector, png: screenshot, captureFrame: Boolean(diagnosticName),
    chromeTop: Number.isFinite(nativeChromeTop) ? nativeChromeTop : null });
  if (diagnosticName) {
    await mkdir("artifacts/story-media", { recursive: true });
    await writeFile(`artifacts/story-media/${diagnosticName}-visible.png`, screenshotBuffer);
    if (result.decodedFramePng) {
      await writeFile(`artifacts/story-media/${diagnosticName}-decoded.png`,
        Buffer.from(result.decodedFramePng, "base64"));
    }
  }
  delete result.decodedFramePng;
  return result;
}

function gradePausedFrameIdentity(before, after) {
  if (!before.samples || before.samples.length < 8 || after.samples?.length !== before.samples.length) {
    return { failed: true, reason: "missing signal-bearing decoded frame samples" };
  }
  const pairs = before.samples.map((sample, index) => ({
    at: [sample.fx, sample.fy],
    delta: sample.decoded.reduce((sum, channel, component) =>
      sum + Math.abs(channel - after.samples[index].decoded[component]), 0) / 3,
  }));
  const meanDelta = pairs.length
    ? pairs.reduce((sum, pair) => sum + pair.delta, 0) / pairs.length : null;
  return { meanDelta, pairs, failed: before.failed || after.failed
    || pairs.length < 8 || meanDelta > 12 || after.retainedRatio < 0.75 || after.signalMeanDelta > 20 };
}

/** The retained page canvas must actually be the paused frame on screen. */
async function heldRenewalFramePixels(page, rootSelector, { videoHidden = true } = {}) {
  const screenshot = (await page.screenshot()).toString("base64");
  return await page.evaluate(async ({ selector, png, expectedHidden }) => {
    const stage = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const pageNode = stage?.querySelector('[data-media-page="current"]');
    const canvas = pageNode?.querySelector("canvas");
    const video = stage?.querySelector(".story-media-pages__video video");
    const reference = window.__qaPausedFrameReference;
    const source = expectedHidden ? canvas : video;
    const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source?.width;
    const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source?.height;
    if (!(source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement)
      || !sourceWidth || !sourceHeight || !(video instanceof HTMLVideoElement) || !reference?.pixels) {
      return { failed: true, reason: "renewal has no retained decoded frame" };
    }
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const box = source.getBoundingClientRect();
    const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
    const width = sourceWidth * scale, height = sourceHeight * scale;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;
    const referenceCanvas = document.createElement("canvas");
    referenceCanvas.width = 64; referenceCanvas.height = 64;
    const visible = document.createElement("canvas");
    visible.width = 64; visible.height = 64;
    const sourceContext = referenceCanvas.getContext("2d", { willReadFrequently: true });
    const visibleContext = visible.getContext("2d", { willReadFrequently: true });
    if (!sourceContext || !visibleContext) return { failed: true, reason: "renewal pixel context unavailable" };
    sourceContext.drawImage(source, 0, 0, 64, 64);
    const ratioX = image.naturalWidth / innerWidth, ratioY = image.naturalHeight / innerHeight;
    visibleContext.drawImage(image, left * ratioX, top * ratioY, width * ratioX, height * ratioY,
      0, 0, 64, 64);
    const frame = window.__qaSpatialFrameEvidence(reference.pixels,
      sourceContext.getImageData(0, 0, 64, 64).data);
    const screenReference = new Uint8ClampedArray(reference.pixels);
    const screenPixels = visibleContext.getImageData(0, 0, 64, 64).data;
    const notice = document.querySelector(`${selector} .journey-story__media-state.is-over-media[role="alert"]`);
    const noticeBox = notice?.getBoundingClientRect();
    let maskedRows = 0;
    if (noticeBox) for (let y = 0; y < 64; y += 1) {
      const sampleY = top + height * (y + 0.5) / 64;
      if (sampleY < noticeBox.top || sampleY > noticeBox.bottom) continue;
      maskedRows += 1;
      for (let x = 0; x < 64; x += 1) {
        const at = (y * 64 + x) * 4;
        for (const pixels of [screenReference, screenPixels]) {
          pixels[at] = 0; pixels[at + 1] = 0; pixels[at + 2] = 0;
        }
      }
    }
    const screen = window.__qaSpatialFrameEvidence(screenReference, screenPixels);
    const hit = document.elementFromPoint(left + width / 2, top + height * 0.7);
    const wrong = (quality) => quality.aligned < 0.8 || quality.margin < 0.08
      || quality.visibleCells < Math.ceil(quality.sourceCells * 0.6)
      || quality.energyRatio < 0.5 || quality.energyRatio > 2;
    return {
      frame, screen, maskedRows, currentId: pageNode?.getAttribute("data-media-page-id") ?? null,
      currentReady: pageNode?.getAttribute("data-media-page-ready") ?? null,
      videoHidden: video.hidden, videoSrc: video.getAttribute("src"),
      hitIsSource: hit === source, hitTag: hit instanceof Element ? hit.tagName : null,
      // The canvas bitmap is diagnostic; CSS/compositor treatment determines
      // the frame the viewer actually sees. Keep the screenshot and hit tests
      // as the acceptance signal for a held renewal.
      failed: wrong(screen) || maskedRows > 24 || hit !== source
        || pageNode?.getAttribute("data-media-page-ready") !== (expectedHidden ? "false" : "true")
        || video.hidden !== expectedHidden,
    };
  }, { selector: rootSelector, png: screenshot, expectedHidden: videoHidden });
}

/** Screenshot pixels over the active clone must match its decoded canvas. */
async function activeCloneScreenPixels(page, assetId, { stationary = false } = {}) {
  await page.waitForFunction(({ expected, still }) => {
    const clones = [...document.querySelectorAll('[data-shared-element-clone]')];
    if (clones.length !== 1 || clones[0].getAttribute('data-shared-element-clone') !== `story-fullscreen-${expected}`) return false;
    if (still) return true;
    const animation = clones[0].getAnimations().find((entry) => entry.effect?.target === clones[0]);
    const duration = animation?.effect?.getTiming().duration;
    const progress = typeof duration === 'number' && duration > 0 && typeof animation.currentTime === 'number'
      ? animation.currentTime / duration : 0;
    return progress >= 0.25 && progress <= 0.65;
  }, { expected: assetId, still: stationary }, { polling: "raf", timeout: 9_000 });
  await page.evaluate((expected) => {
    const name = `story-fullscreen-${expected}`;
    const boxes = [];
    const probe = { name, boxes, running: true };
    window.__qaCloneScreen = probe;
    const sample = () => {
      if (!probe.running) return;
      const clone = document.querySelector(`[data-shared-element-clone="${name}"]`);
      if (clone) {
        const box = clone.getBoundingClientRect();
        boxes.push({ at: performance.now(), x: box.x, y: box.y, width: box.width, height: box.height });
      }
      requestAnimationFrame(sample);
    };
    sample();
  }, assetId);
  const png = (await page.screenshot()).toString("base64");
  const capturedAt = Date.now();
  const screenPixels = await page.evaluate(async ({ expected, screenshot }) => {
    const probe = window.__qaCloneScreen;
    probe.running = false;
    const clones = [...document.querySelectorAll('[data-shared-element-clone]')];
    const clone = clones[0];
    if (clones.length !== 1 || clone?.getAttribute('data-shared-element-clone') !== `story-fullscreen-${expected}`
      || !(clone instanceof HTMLCanvasElement)) {
      return { failed: true, reason: "clone disappeared or another clone appeared during screenshot",
        clones: clones.map((node) => node.getAttribute('data-shared-element-clone')), boxes: probe.boxes.length };
    }
    const lastBox = clone.getBoundingClientRect();
    probe.boxes.push({ at: performance.now(), x: lastBox.x, y: lastBox.y,
      width: lastBox.width, height: lastBox.height });
    const image = new Image();
    image.src = `data:image/png;base64,${screenshot}`;
    await image.decode();
    const screen = document.createElement("canvas");
    screen.width = 64; screen.height = 64;
    const screenContext = screen.getContext("2d", { willReadFrequently: true });
    const frame = document.createElement("canvas");
    frame.width = 64; frame.height = 64;
    const frameContext = frame.getContext("2d", { willReadFrequently: true });
    if (!screenContext || !frameContext) return { failed: true, reason: "canvas context unavailable" };
    frameContext.drawImage(clone, 0, 0, 64, 64);
    const pixels = frameContext.getImageData(0, 0, 64, 64).data;
    const bright = [];
    const spread = Array(16).fill(null);
    for (let y = 2; y < 62; y += 1) for (let x = 2; x < 62; x += 1) {
      const at = (y * 64 + x) * 4;
      const strength = Math.max(pixels[at], pixels[at + 1], pixels[at + 2]);
      if (strength <= 24) continue;
      const point = { x, y, strength };
      bright.push(point);
      const cell = Math.floor(y / 16) * 4 + Math.floor(x / 16);
      if (!spread[cell] || strength > spread[cell].strength) spread[cell] = point;
    }
    bright.sort((left, right) => right.strength - left.strength);
    const points = spread.filter(Boolean).sort((left, right) => right.strength - left.strength).slice(0, 12);
    if (points.length < 8) {
      for (const point of bright) {
        if (points.some((selected) => selected.x === point.x && selected.y === point.y)) continue;
        points.push(point);
        if (points.length === 12) break;
      }
    }
    const spreadCells = spread.filter(Boolean).length;
    if (bright.length < 16 || spreadCells < 3 || points.length < 8 || !probe.boxes.length) {
      return { failed: true, reason: "clone has too little visible image signal or no geometry samples",
        brightPixels: bright.length, spreadCells, boxes: probe.boxes.length };
    }
    const screenshotScaleX = image.naturalWidth / innerWidth;
    const screenshotScaleY = image.naturalHeight / innerHeight;
    const raster = document.createElement("canvas");
    const rasterContext = raster.getContext("2d");
    if (!rasterContext) return { failed: true, reason: "clone screen raster unavailable" };
    const candidate = (box) => {
      raster.width = Math.max(1, Math.round(box.width * screenshotScaleX));
      raster.height = Math.max(1, Math.round(box.height * screenshotScaleY));
      rasterContext.drawImage(clone, 0, 0, raster.width, raster.height);
      frameContext.clearRect(0, 0, 64, 64);
      frameContext.drawImage(raster, 0, 0, 64, 64);
      const expectedPixels = frameContext.getImageData(0, 0, 64, 64).data;
      screenContext.clearRect(0, 0, 64, 64);
      screenContext.drawImage(image, box.x * screenshotScaleX, box.y * screenshotScaleY,
        box.width * screenshotScaleX, box.height * screenshotScaleY, 0, 0, 64, 64);
      const visiblePixels = screenContext.getImageData(0, 0, 64, 64).data;
      const spatialDirect = window.__qaSpatialFrameEvidence(pixels, visiblePixels);
      const spatialRaster = window.__qaSpatialFrameEvidence(expectedPixels, visiblePixels);
      const visibleCells = new Set();
      for (let y = 2; y < 62; y += 1) for (let x = 2; x < 62; x += 1) {
        const at = (y * 64 + x) * 4;
        if (Math.max(visiblePixels[at], visiblePixels[at + 1], visiblePixels[at + 2]) > 24) {
          visibleCells.add(Math.floor(y / 16) * 4 + Math.floor(x / 16));
        }
      }
      const samples = points.map(({ x, y, strength }) => {
        const sx = Math.round((box.x + box.width * (x + 0.5) / 64) * screenshotScaleX);
        const sy = Math.round((box.y + box.height * (y + 0.5) / 64) * screenshotScaleY);
        if (sx < 0 || sy < 0 || sx >= image.naturalWidth || sy >= image.naturalHeight) {
          return { x, y, strength, offscreen: true, delta: 255 };
        }
        const offset = (y * 64 + x) * 4;
        const expectedRgb = [expectedPixels[offset], expectedPixels[offset + 1], expectedPixels[offset + 2]];
        let visibleRgb = [0, 0, 0];
        let delta = expectedRgb.reduce((sum, channel) => sum + channel, 0) / 3;
        // The moving clone crosses fractional device pixels. Resample its
        // screenshot footprint before matching local bright texels instead
        // of comparing a raw screen pixel with a downsampled canvas texel.
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= 64 || ny >= 64) continue;
          const near = (ny * 64 + nx) * 4;
          const rgb = [visiblePixels[near], visiblePixels[near + 1], visiblePixels[near + 2]];
          if (Math.max(...rgb) <= 24) continue;
          const nearDelta = expectedRgb.reduce((sum, channel, index) =>
            sum + Math.abs(channel - rgb[index]), 0) / 3;
          if (nearDelta < delta) { delta = nearDelta; visibleRgb = rgb; }
        }
        return { x, y, strength, expectedRgb, visibleRgb,
          delta: Number(delta.toFixed(1)) };
      });
      const retainedCells = spread.reduce((count, entry, cell) =>
        count + Number(Boolean(entry) && visibleCells.has(cell)), 0);
      const visibleBright = samples.filter((sample) =>
        sample.visibleRgb && Math.max(...sample.visibleRgb) > 24).length;
      const meanDelta = samples.reduce((sum, sample) => sum + sample.delta, 0) / samples.length;
      const picture = spatialDirect;
      const visibleFrameWrong = picture.aligned < 0.8 || picture.margin < 0.08
        || picture.visibleCells < Math.ceil(picture.sourceCells * 0.6)
        || picture.energyRatio < 0.25 || picture.energyRatio > 2;
      return { box, samples, retainedCells, visibleBright, meanDelta,
        spatialDirect, spatialRaster, visibleFrameWrong,
        failed: samples.some((sample) => sample.offscreen)
          || retainedCells < Math.ceil(spreadCells * 0.6)
          || visibleBright < Math.ceil(samples.length * 0.6) || visibleFrameWrong };
    };
    // A screenshot can land between rAF samples during a moving morph. Each
    // midpoint remains on the observed path, rather than fitting arbitrary
    // image locations to the source frame.
    const candidateBoxes = probe.boxes.flatMap((box, index) => {
      const next = probe.boxes[index + 1];
      return next ? [box, { x: (box.x + next.x) / 2, y: (box.y + next.y) / 2,
        width: (box.width + next.width) / 2, height: (box.height + next.height) / 2 }] : [box];
    });
    const scored = candidateBoxes.map(candidate).sort((left, right) => left.meanDelta - right.meanDelta);
    const matching = scored.find((entry) => !entry.failed) ?? scored[0];
    const spatialCandidates = [...scored].sort((left, right) =>
      right.spatialDirect.margin - left.spatialDirect.margin);
    return { candidateBoxes: candidateBoxes.length, brightPixels: bright.length,
      spreadCells, retainedCells: matching.retainedCells, visibleBright: matching.visibleBright,
      meanDelta: Number(matching.meanDelta.toFixed(1)), bestBox: matching.box,
      spatialDirect: matching.spatialDirect, spatialRaster: matching.spatialRaster,
      bestSpatial: spatialCandidates[0]
        ? { box: spatialCandidates[0].box, direct: spatialCandidates[0].spatialDirect,
          raster: spatialCandidates[0].spatialRaster } : null,
      samples: matching.samples,
      failed: matching.failed };
  }, { expected: assetId, screenshot: png });
  return { ...screenPixels, capturedAt };
}

/** A compositor callback after handoff proves the playing destination presented a real frame. */
async function awaitPresentedVideoFrame(page, rootSelector) {
  return await page.evaluate((selector) => new Promise((resolve) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement) || !video.requestVideoFrameCallback) {
      resolve({ failed: true, reason: "no video frame callback" }); return;
    }
    const timeout = window.setTimeout(() => resolve({ failed: true, reason: "no presented frame within 2s" }), 2_000);
    video.requestVideoFrameCallback((at, frame) => {
      window.clearTimeout(timeout);
      resolve({ at, mediaTime: frame.mediaTime, presentedFrames: frame.presentedFrames,
        currentTime: video.currentTime, paused: video.paused, readyState: video.readyState,
        failed: video.paused || frame.presentedFrames < 1 || Math.abs(video.currentTime - frame.mediaTime) > 0.25 });
    });
  }), rootSelector);
}

/** The return input must actually reach the video, not a stale fullscreen layer. */
async function clickReturnedVideo(page) {
  const point = await presentedVideoPoint(page, STAGE);
  const expectedPointerType = input(page).kind;
  await page.evaluate(() => {
    window.__qaReturnHit = [];
    document.addEventListener("pointerdown", (event) => {
      window.__qaReturnHit.push({ trusted: event.isTrusted, pointerType: event.pointerType,
        target: event.target instanceof HTMLVideoElement ? "video" : event.target?.tagName ?? null,
        asset: event.target instanceof HTMLVideoElement ? event.target.getAttribute("data-shared-media-id") : null });
    }, { capture: true, once: true });
  });
  await input(page).click(point.x, point.y);
  const events = await page.evaluate(() => window.__qaReturnHit);
  const after = await currentAsset(page, STAGE);
  return { point, events, after, expectedPointerType,
    failed: !point.hitIsVideo || events.length !== 1 || !events[0].trusted
      || events[0].pointerType !== expectedPointerType
      || events[0].target !== "video" || events[0].asset !== V1
      || after.id !== V1 || after.presentation !== "settled" };
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
      await input(page).click(photo.x, photo.y);
      await waitForSettledAsset(page, V1);
      const toVideoFrames = await stopSamplerFrames(page);

      if (surface.enterFullscreen) {
        await page.getByRole("button", { name: "全屏查看媒体", exact: true }).click();
        await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
        await waitForSettledAsset(page, V1, FULLSCREEN);
      }

      const before = await currentAsset(page, surface.root);
      const controls = await nativeControls(page, surface.root);
      const point = await presentedVideoPoint(page, surface.root, { controlsTop: controlChromeTop(controls) });
      const idle = await samplePlayback(page, surface.root, { samples: 2, everyMs: 120 });
      await input(page).click(point.x, point.y);
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

      // Acceptance 2: every control the transport actually provides -- each one
      // resolved from the browser by its own accessible name, not guessed from
      // a bottom inset -- is on screen and hit-tests to the transport, and a
      // real click on its play entry toggles that transport without navigating.
      const entry = playEntry(controls);
      const unreachable = unreachableControls(controls);
      const controlBefore = await samplePlayback(page, surface.root, { samples: 1, everyMs: 0 });
      if (entry) await input(page).click(entry.x, entry.y);
      const controlAfter = await samplePlayback(page, surface.root, { samples: 2, everyMs: 150 });
      const controlState = await currentAsset(page, surface.root);
      const stillPresented = await page.locator(surface.root).isVisible();
      record({
        name: `story-${surface.label}-video-native-controls-reachable`,
        claim: "every native control this transport provides is on screen and hit-tests to the video itself -- intercepted by no navigation surface -- and a real click on its own play entry toggles the transport without navigating or dismissing the surface",
        controls, panel: controls.panel, entry, unreachable,
        controlBefore, controlAfter, controlState, stillPresented,
        failed: !entry || unreachable.length > 0 || !stillPresented
          || controlAfter.paused === controlBefore.paused
          || controlState.id !== V1 || controlState.kind !== "video"
          || controlState.presentation !== "settled" || controlState.hitSurfaces !== 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // A (continued). Video navigation uses the visible step controls; its
  // native picture and controls keep their own pointer input.
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
      const offVideo = await navigateByVideoButton(page, STAGE, 1, V2);
      const buttonFrames = await stopSamplerFrames(page);
      const afterVideoStep = await currentAsset(page);
      const playbackAfterStep = await samplePlayback(page, STAGE, { samples: 2, everyMs: 120 });

      // Back onto the first video, then advertise-driven keyboard navigation.
      const backToVideo = await navigateByVideoButton(page, STAGE, -1, V1);
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
        claim: "the visible video step button reaches the second, differently shaped video exactly once without starting playback, the previous button returns, and the stage's advertised arrow keys still navigate",
        toVideo, offVideo, backToVideo,
        afterFirstSwipe, afterVideoStep, playbackAfterStep, stageRole, keyboardSettled, afterKeyboard,
        handoff: gradeContinuity(buttonFrames, { allowedAssets: [V1, V2] }),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !toVideo.ok || !offVideo.ok || !backToVideo.ok || !keyboardSettled
          || afterFirstSwipe.id !== V1 || afterVideoStep.id !== V2
          || playbackAfterStep.paused !== true
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
      await input(page).click(halves.x, halves.y);
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
  // A (continued). The same input claim on compact mobile, reached by a real
  // browser touch stream in both representative orientations.
  //
  // #489 A asks for a real touch on "the play entry the viewer sees", and under
  // touch that entry is the transport's own play button: Chromium deliberately
  // does not treat a tap on the picture body as an activation the way a mouse
  // click is, and this product ships no play affordance of its own to put there
  // (#244 forbids a second media authority). So the picture-body tap is still
  // driven and graded for what it owns -- it must reach the transport and must
  // not navigate -- while playback is graded from a real touch tap on the play
  // button the browser itself exposes, resolved by its accessible name and
  // required to be on screen first. Every control that transport provides is
  // graded reachable on both orientations, which is acceptance item 2.
  // ---------------------------------------------------------------------
  for (const profile of [
    { label: "phone-portrait", viewport: { width: 390, height: 844 } },
    { label: "phone-landscape", viewport: { width: 844, height: 390 } },
  ]) {
    const session = await createStoryPage({ mobile: true, viewport: profile.viewport });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      await startSampler(page, STAGE);
      // Reach the video by the gesture compact mobile actually offers, so the
      // touch swipe is proved before anything is claimed about the tap.
      const toVideo = await navigateByGesture(page, STAGE, 1, V1);
      const toVideoFrames = await stopSamplerFrames(page);

      const before = await currentAsset(page, STAGE);
      const geometry = await presentedVideoBox(page, STAGE);
      const controls = await nativeControls(page, STAGE);
      let point = { hitIsVideo: false, controls: false };
      let pointError = null;
      try {
        point = await presentedVideoPoint(page, STAGE, { controlsTop: controlChromeTop(controls) });
      } catch (error) {
        pointError = error instanceof Error ? error.message : String(error);
      }
      const idle = await samplePlayback(page, STAGE, { samples: 2, everyMs: 120 });
      if (!pointError) await input(page).click(point.x, point.y);
      const playback = await samplePlayback(page, STAGE);
      const after = await currentAsset(page, STAGE);
      const transports = await liveTransports(page, STAGE);

      // The play entry under touch. It is the transport's own control, so the
      // tap must start the real clock and must still not navigate.
      const entry = playEntry(controls);
      const unreachable = unreachableControls(controls);
      const beforePlayTap = await samplePlayback(page, STAGE, { samples: 2, everyMs: 120 });
      // The picture tap above is the other real touch in this scenario. If a
      // future Chromium ever treats it as an activation, that already satisfies
      // the criterion and tapping play again would only stop the clock, so the
      // graded outcome is the running transport rather than which tap started it.
      const playStartedBy = beforePlayTap.paused ? "native play entry" : "picture tap";
      if (entry?.reachable && beforePlayTap.paused) await input(page).click(entry.x, entry.y);
      const controlPlayback = await samplePlayback(page, STAGE);
      const controlState = await currentAsset(page, STAGE);
      const stillPresented = await page.locator(STAGE).isVisible();
      const pointerTypes = await observedPointerTypes(page);

      record({
        name: `story-mobile-touch-video-tap-${profile.label}`,
        claim: "on a compact-mobile viewport driven by real browser touch, a swipe commits the step onto the video, a tap inside the presented video's contained picture reaches the transport itself without navigating and with no navigation surface over it, every native control that transport provides is on screen and hit-tests to it, and a real touch tap on its own play entry starts the actual clock -- currentTime advancing across repeated samples -- while the stage keeps exactly one live transport and does not navigate",
        viewport: profile.viewport, pointerTypes, toVideo,
        before, geometry, point, pointError, idle, playback, after, transports,
        controls, panel: controls.panel, entry, unreachable,
        beforePlayTap, playStartedBy, controlPlayback, controlState, stillPresented,
        handoffToVideo: gradeContinuity(toVideoFrames, { allowedAssets: [I1, V1] }),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: Boolean(pointError)
          || !pointerTypes.includes("touch") || pointerTypes.includes("mouse")
          || !toVideo.ok || toVideo.gesture.input !== "touch"
          || before.kind !== "video" || before.id !== V1 || before.hitSurfaces !== 0
          || !point.hitIsVideo || !point.controls
          || after.id !== V1 || after.presentation !== "settled" || after.hitSurfaces !== 0
          || transports.presented !== 1 || transports.total !== 1
          || idle.paused !== true
          || !entry || !entry.reachable || unreachable.length > 0
          || controlPlayback.paused !== false || !controlPlayback.advanced || !controlPlayback.monotonic
          || !stillPresented || controlState.id !== V1 || controlState.kind !== "video"
          || controlState.presentation !== "settled" || controlState.hitSurfaces !== 0
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // Chromium's native timeline owns horizontal pointer input on the video.
  // Its seek must move the real playback clock without claiming a Story drag
  // or changing the presented media, in both mouse and touch modalities.
  for (const profile of [
    { label: "desktop-inline", mobile: false, fullscreen: false },
    { label: "desktop-fullscreen", mobile: false, fullscreen: true },
    { label: "phone-portrait-inline", mobile: true, fullscreen: false },
  ]) {
    const session = await createStoryPage({ mobile: profile.mobile });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      const toVideo = await navigateByGesture(page, STAGE, 1, V1);
      if (profile.fullscreen) {
        await page.getByRole("button", { name: "全屏查看媒体", exact: true }).click();
        await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
        await waitForSettledAsset(page, V1, FULLSCREEN);
        // Presentation can be settled while the clone still owns the picture
        // and intentionally locks the destination's native input.
        await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
          .waitFor({ state: "detached", timeout: 5_000 });
        await page.waitForFunction((selector) => {
          const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
          return video instanceof HTMLVideoElement
            && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            && getComputedStyle(video).pointerEvents !== "none";
        }, FULLSCREEN, { polling: "raf", timeout: 5_000 });
      }
      const root = profile.fullscreen ? FULLSCREEN : STAGE;
      const seek = await seekNativeTimeline(page, root);
      record({
        name: `story-native-video-timeline-seek-${profile.label}`,
        claim: "a real browser mouse or touch drag of Chromium's own visible timeline seeks the transport while its asset, stage presentation and request owner stay fixed; no Story media drag claims the pointer",
        toVideo, seek, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !toVideo.ok || seek.failed || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // B. Handoff continuity across the whole mixed sequence, both motion modes
  // and the viewports the report covers. The compact-mobile rows are driven by
  // a real touch stream, the desktop rows by a real mouse -- modality is added
  // to the matrix, not substituted into it.
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
        const step = await navigateByPresentedInput(page, STAGE, direction, target);
        steps.push(step);
        if (!step.ok) break;
        visited.push(target);
      }
      const frames = await stopSamplerFrames(page);
      const continuity = gradeContinuity(frames, { allowedAssets: SEQUENCE });
      const stuck = steps.filter((step) => !step.ok);
      // The modality is graded from the trusted events the page received, so a
      // row can never silently fall back to the weaker mouse configuration.
      const expectedInput = profile.mobile ? "touch" : "mouse";
      const pointerTypes = await observedPointerTypes(page);
      const wrongModality = pointerTypes.some((type) => type !== expectedInput)
        || !pointerTypes.includes(expectedInput)
        || steps.some((step) => step.input !== expectedInput);
      record({
        name: `story-handoff-continuity-${profile.label}`,
        claim: "sampled on every DOM mutation and on every animation frame the chain delivers, image swipes and visible video step buttons keep an owned picture inside the aperture, never an uncovered aperture, never the waiting indicator, and never a second live transport -- with real browser touch on compact mobile and real mouse input on desktop",
        viewport: profile.viewport, reducedMotion: profile.reducedMotion, visited, stuck,
        expectedInput, pointerTypes, wrongModality,
        ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed || stuck.length > 0 || wrongModality
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
      const resisted = [];
      for (const [target, direction] of [[V1, 1], [V2, 1], [I2, 1], [I3, 1]]) {
        let step = await navigateByPresentedInput(page, STAGE, direction, target);
        if (!step.ok && step.method === "image swipe" && step.atRelease?.ready?.[target] === false) {
          // The stack's own contract for direct manipulation: "a cold neighbor
          // resists and returns to rest; its eventual decode never navigates by
          // itself" (StoryMediaPages.settleGesture). Under held-back bytes that
          // resistance is the expected outcome, not a stuck navigation -- so it
          // is graded as such: the page the stack already owned must still be
          // settled and readable, nothing may be left requested, and the SAME
          // gesture must commit once the neighbour is readable. A step that
          // fails while its target WAS readable stays stuck.
          const held = await currentAsset(page, STAGE);
          const requested = await stageDiagnostic(page, STAGE);
          await waitForReadablePage(page, STAGE, target);
          const retry = await navigateByPresentedInput(page, STAGE, direction, target);
          resisted.push({
            target, atRelease: step.atRelease, held, requested: requested.requested,
            keptItsPage: held.id !== target && held.ready && held.presentation === "settled",
            committedOnRetry: retry.ok,
          });
          step = retry;
        }
        steps.push(step);
        if (!step.ok) break;
      }
      const frames = await stopSamplerFrames(page);
      const continuity = gradeContinuity(frames, { allowedAssets: SEQUENCE });
      const stuck = steps.filter((step) => !step.ok);
      const mishandledResistance = resisted.filter((entry) =>
        !entry.keptItsPage || !entry.committedOnRetry || entry.requested !== null);
      record({
        name: "story-handoff-continuity-delayed-readiness",
        claim: "with media bytes and one read URL deliberately held back, image swipes and video step buttons keep a legitimate drawable inside the aperture, never show the waiting indicator while a page owns the stage, and never spawn a second transport; an image swipe toward a cold neighbour resists and commits on retry once readable",
        delays: { bytes: { [I2]: 1_200, [V2]: 900 }, read: { [I3]: 900 } },
        stuck, resisted, mishandledResistance, ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed || stuck.length > 0 || mishandledResistance.length > 0
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // B (continued). The counter-example for acceptance item 3's stage cue.
  // A gesture toward a cold neighbour resists and leaves nothing requested,
  // so it never reaches JourneyStory's cold-request branch. The advertised
  // arrow-key step does: it asks for the neighbour whatever its read state,
  // which is the one input that can hold a pending target while a ready page
  // still owns the stage. That is the exact window in which a stage-level
  // waiting cue would be the forbidden loading flash over the hidden handoff.
  // ---------------------------------------------------------------------
  {
    const session = await createStoryPage({ mobile: false, readDelays: { [V1]: 5_000 } });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      // The presented photograph carries the stage's advertised arrow
      // navigation on its own focusable picture (StoryMediaPages, role=button
      // + aria-keyshortcuts), so the step is driven through the input the
      // product advertises rather than through a navigation setter.
      const focused = await page.evaluate((selector) => {
        const current = document.querySelector(selector)
          ?.querySelector('[data-media-page="current"]')?.querySelector("img");
        current?.focus();
        return {
          keyshortcuts: current?.getAttribute("aria-keyshortcuts") ?? null,
          focused: document.activeElement === current,
        };
      }, STAGE);
      await startSampler(page, STAGE);
      await page.keyboard.press("ArrowRight");
      // The window is only discriminating while the request is actually
      // pending against a ready owner. Observing it is part of the claim: if
      // the neighbour were already readable there would be no cold request to
      // grade, and a silent pass would mean nothing.
      const pending = await page.waitForFunction(({ selector, expected }) => {
        const root = document.querySelector(selector);
        const requested = document.querySelector("[data-media-requested]")
          ?.getAttribute("data-media-requested") ?? null;
        const current = root?.querySelector("[data-story-media-pages]")
          ?.querySelector('[data-media-page="current"]');
        return requested === expected
          && current?.getAttribute("data-media-page-ready") === "true"
          ? { requested, heldBy: current.getAttribute("data-media-page-id") }
          : null;
      }, { selector: STAGE, expected: V1 }, { polling: "raf", timeout: 2_000 })
        .then((handle) => handle.jsonValue(), () => null);
      // The cold request must still commit once its read lands; suppressing a
      // cue may not turn into a navigation that never arrives.
      const committed = await waitForSettledAsset(page, V1, STAGE).then(() => true, () => false);
      const frames = await stopSamplerFrames(page);
      const settled = await currentAsset(page);
      const continuity = gradeContinuity(frames, { allowedAssets: SEQUENCE });
      record({
        name: "story-cold-step-keeps-the-hidden-handoff-hidden",
        claim: "an arrow-key step toward a neighbour whose read is deliberately held back really does hold a pending request while the previous page is still the settled, readable owner, and through that whole window the stage shows no waiting indicator over it -- then commits to the requested asset once the read lands",
        readDelays: { [V1]: 5_000 }, focused, pending, committed, settled, ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed || !focused.focused || !pending || !committed
          || settled.id !== V1
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
      // V2 is prefetched as soon as V1 becomes current, so arm this before
      // entering V1 rather than missing the delayed response in flight.
      let v2ResponseReceived = false;
      const v2ReadResponse = page.waitForResponse((response) =>
        response.url().includes(`/api/uploads/assets/${V2}/read-url`), { timeout: 8_000 })
        .then(async (response) => {
          v2ResponseReceived = true;
          return { status: response.status(), body: await response.json() };
        })
        .catch((error) => ({ error: String(error) }));
      await navigateByGesture(page, STAGE, 1, V1);
      // Root cause of a claim that used to pass without ever being exercised:
      // this window was driven by two swipes, but a gesture toward a neighbour
      // that is not readable at release RESISTS and requests nothing (the
      // `story-handoff-continuity-delayed-readiness` claim above,
      // whose `heldBy`/`requested` record states it outright). So whenever V2 really was
      // still cold there was no abandoned request at all -- the second swipe
      // was an ordinary step back to I1, whose release springs land about a
      // second later, and the check failed; and whenever V2 happened to be warm
      // by then there was no late read to grade either. The claim only ever
      // passed in the case it is not about.
      //
      // The advertised arrow-key step is the one input that holds a pending
      // target while a ready page still owns the stage (JourneyStory
      // `navigateToMedia`, cold disposition), and `navigateMediaStep` anchors
      // the next step on that pending target, so the opposite key is the
      // reverse input whose neighbour IS the visible page -- the
      // `index === assetIndex` cancel-and-stay branch. That is the situation
      // this scenario claims, so it is now the situation it drives.
      const stageRole = await page.evaluate((selector) => {
        const pages = document.querySelector(selector).querySelector("[data-story-media-pages]");
        pages.focus();
        return {
          tabIndex: pages.tabIndex,
          keyshortcuts: pages.getAttribute("aria-keyshortcuts"),
          focused: document.activeElement === pages,
        };
      }, STAGE);
      await startSampler(page, STAGE);
      await page.keyboard.press("ArrowRight");
      // Observing the abandoned request is part of the claim: with nothing
      // pending against a ready owner there is no stale read to grade, and a
      // silent pass would mean nothing.
      const pending = await page.waitForFunction(({ selector, expected, owner }) => {
        const requested = document.querySelector("[data-media-requested]")
          ?.getAttribute("data-media-requested") ?? null;
        const current = document.querySelector(selector)?.querySelector("[data-story-media-pages]")
          ?.querySelector('[data-media-page="current"]');
        const target = [...(document.querySelector(selector)
          ?.querySelectorAll("[data-media-page-id]") ?? [])]
          .find((node) => node.getAttribute("data-media-page-id") === expected);
        return requested === expected
          && current?.getAttribute("data-media-page-id") === owner
          && current?.getAttribute("data-media-page-ready") === "true"
          && target && target.getAttribute("data-media-page-ready") !== "true"
          ? { requested, heldBy: current.getAttribute("data-media-page-id"), targetReady: false }
          : null;
      }, { selector: STAGE, expected: V2, owner: V1 }, { polling: "raf", timeout: 2_000 })
        .then((handle) => handle.jsonValue(), () => null);
      await page.keyboard.press("ArrowLeft");
      const responseBeforeReversal = v2ResponseReceived;
      await waitForSettledAsset(page, V1);
      const afterReversal = await currentAsset(page);
      // The route response, then the neighbour's ready page, prove that the
      // delayed signed read finished and React consumed it. Keep the sampler
      // running through both and for eight subsequent browser frames.
      const readResponse = await v2ReadResponse;
      const readProcessed = readResponse.status === 200 && readResponse.body?.url === VERTICAL_CLIP
        ? await page.waitForFunction(({ selector, assetId }) => {
          const page = [...document.querySelectorAll(`${selector} [data-media-page-id]`)]
            .find((node) => node.getAttribute("data-media-page-id") === assetId);
          return page?.getAttribute("data-media-page-ready") === "true"
            ? { id: assetId, layer: page.getAttribute("data-media-layer") } : null;
        }, { selector: STAGE, assetId: V2 }, { polling: "raf", timeout: 5_000 })
          .then((handle) => handle.jsonValue(), () => null) : null;
      const postReadStart = await page.evaluate(() => window.__qaStage?.ticks ?? null);
      const postReadObserved = await page.waitForFunction((start) =>
        start !== null && window.__qaStage?.running
          && window.__qaStage.ticks - start >= 8,
      postReadStart, { polling: "raf", timeout: 5_000 }).then(() => true, () => false);
      const frames = await stopSamplerFrames(page);
      const afterLateRead = await currentAsset(page);
      const transports = await page.evaluate((selector) =>
        document.querySelector(selector).querySelectorAll("video").length, STAGE);
      const continuity = gradeContinuity(frames, { allowedAssets: [V1] });
      const wrongOwnerFrames = frames.filter((frame) => frame.currentId !== V1);
      record({
        name: "story-late-read-never-takes-the-stage",
        claim: "an arrow-key step really does leave a request for a cold neighbour pending while the readable previous page still owns the stage, the opposite key cancels that request and keeps the visible page, and the read URL that resolves afterwards neither moves the committed owner at any point across the window nor leaves the aperture uncovered",
        abandonedIntent: V2, expectedOwner: V1,
        readDelays: { [V2]: 2_500 }, stageRole, pending,
        readResponse, readProcessed, postReadObserved, responseBeforeReversal,
        postReadTicks: frames.ticks - postReadStart,
        wrongOwnerFrames: wrongOwnerFrames.slice(0, 3),
        afterReversal, afterLateRead, transports, ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed
          || !stageRole.focused || !pending
          || responseBeforeReversal
          || readResponse.status !== 200 || readResponse.body?.url !== VERTICAL_CLIP
          || !readProcessed || !postReadObserved || frames.unmeasurable > 0
          || wrongOwnerFrames.length > 0
          || afterReversal.id !== V1 || afterLateRead.id !== V1
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
      // Start from the middle photograph so both directions address a real,
      // different asset. Video pointer input belongs to native controls.
      await navigateByGesture(page, STAGE, 1, V1);
      await navigateByVideoButton(page, STAGE, 1, V2);
      await navigateByVideoButton(page, STAGE, 1, I2);
      const startedFrom = await currentAsset(page);
      const abandonedIntent = I3;
      const latestIntent = V2;
      await startSampler(page, STAGE);
      // One stream: past the threshold toward I3, then back past it toward V2
      // without lifting, so the reversal really is pre-commit.
      const gesture = await reverseSwipeStage(page, STAGE, 1);
      // Wait on the committed ID, not on `data-media-presentation`. A drag
      // commit never routes through `incomingAssetId`, so the presentation
      // attribute reads "settled" for the whole gesture and that wait returns
      // on its first frame -- while the release springs, seeded with the
      // gesture's own velocity, take most of a second to converge and only
      // then run `landMediaDrag`. Reading the owner in that gap reports the
      // page the gesture started from and calls a late commit a lost one.
      const committed = await waitForSettledAsset(page, latestIntent, STAGE)
        .then(() => null, async () => await stageDiagnostic(page, STAGE));
      // Keep sampling after commit. A one-time owner read misses a transient
      // flash back to the abandoned page or an uncovered video aperture.
      const postCommitStart = await page.evaluate(() => ({
        at: Math.ceil(performance.now()), ticks: window.__qaStage?.ticks ?? null,
        unmeasurable: window.__qaStage?.unmeasurable ?? null,
      }));
      const settled = await currentAsset(page);
      const transports = await page.evaluate((selector) =>
        document.querySelector(selector).querySelectorAll("video").length, STAGE);
      // Thirty delivered browser frames preserve the old post-commit visual
      // observation window without treating elapsed wall time as evidence.
      const postCommitObserved = await page.waitForFunction((start) =>
        start !== null && window.__qaStage?.running
          && window.__qaStage.ticks - start >= 30,
      postCommitStart.ticks, { polling: "raf", timeout: 10_000 }).then(() => true, () => false);
      const stable = { first: settled.id, second: (await currentAsset(page)).id };
      const frames = await stopSamplerFrames(page);
      const postCommitFrames = frames.filter((frame) => frame.at > postCommitStart.at);
      const postCommitContinuity = gradeContinuity(postCommitFrames, { allowedAssets: [latestIntent] });
      const postCommitWrongOwner = postCommitFrames.filter((frame) => frame.currentId !== latestIntent);
      const postCommitUnmeasurable = frames.unmeasurable - postCommitStart.unmeasurable;
      // Read which decoded neighbour the stage ordered above the current
      // page at each end of the same pointer stream. This is page ordering;
      // the frame sampler below separately checks what the viewport shows.
      const orderedNeighbors = gesture.orderedNeighbors.map((entry) => entry?.id);
      const trace = await page.evaluate(() => (window.__qaStage?.gestures ?? []).slice(-80));
      const continuity = gradeContinuity(frames, { allowedAssets: [I2, I3, V2] });
      record({
        name: "story-reversal-commits-latest-intent",
        claim: "a reversal fired before the first navigation settles retargets within the same gesture and commits the reversal's own target, never the abandoned one, and leaves exactly one settled owner, one live transport and no late write-back",
        startedFrom, abandonedIntent, latestIntent, settled, transports, stable,
        gesture, orderedNeighbors, trace, committed, continuity,
        postCommitObserved, postCommitTicks: frames.ticks - postCommitStart.ticks,
        postCommitContinuity, postCommitWrongOwner: postCommitWrongOwner.slice(0, 3),
        postCommitUnmeasurable,
        sampledFrames: frames.length,
        concurrentLiveVideos: frames.filter((frame) => frame.videoCount > 1).slice(0, 2),
        failed: settled.presentation !== "settled" || !settled.ready
          || settled.id !== latestIntent
          || orderedNeighbors[0] !== abandonedIntent || orderedNeighbors[1] !== latestIntent
          || transports !== 1 || stable.first !== stable.second
          || !postCommitObserved || postCommitContinuity.failed || postCommitWrongOwner.length > 0
          || postCommitStart.unmeasurable === null || postCommitUnmeasurable !== 0
          || continuity.failed || frames.some((frame) => frame.videoCount > 1)
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------------
  // B (continued). An abandoned handoff hands the stack's presentation back.
  // A navigation's springs are running when the pointer takes the stack and
  // cancels them mid-flight. The presented identity may remain unchanged, so
  // the canceled target's aperture must be reclaimed explicitly.
  // ---------------------------------------------------------------------
  {
    const session = await createStoryPage({ mobile: false });
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      // Land on the portrait photograph, whose neighbour is a wide one. The
      // residue is only visible when the abandoned target's aperture differs
      // from the presented one's, which is the mixed-aspect-ratio case the
      // recording shows.
      const steps = [];
      for (const expected of [V1, V2, I2]) {
        steps.push(await navigateByPresentedInput(page, STAGE, 1, expected));
      }
      // The abandoned handoff only exists when the request really becomes an
      // in-flight one: a cold target stays a pending request, the stack never
      // starts a spring, and there is nothing to abandon. Wait for the wide
      // neighbour to be readable so the arrow key commits a real handoff.
      await waitForReadablePage(page, STAGE, I3);
      const beforeGrab = await stackRestState(page, STAGE);
      await startSampler(page, STAGE);
      const gesture = await grabDuringNavigation(page, STAGE);
      // The abandoned navigation must not commit, and the drag was far short
      // of its own threshold, so the presented page is still the portrait one.
      const stillPresented = await page.waitForFunction(() => {
        const pages = document.querySelector(".journey-story__media [data-story-media-pages]");
        return pages?.getAttribute("data-media-presentation") === "settled";
      }, undefined, { polling: "raf", timeout: 10_000 }).then(() => true, () => false);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const frames = await stopSamplerFrames(page);
      const afterGrab = await stackRestState(page, STAGE);
      const settled = await currentAsset(page);
      const rest = gradeRestState(afterGrab, I2);
      // The recorded phenomenon itself: the presented page carrying an aperture
      // it was written into for a target that never arrived, while the stack
      // declares nothing in flight. Graded per frame, not read from the end
      // state -- the residue clears itself once something else happens to
      // re-derive the aperture, which is exactly why a screenshot shows
      // nothing wrong.
      const clippedWhileSettled = frames.filter((frame) =>
        frame.presentation === "settled" && frame.currentClip
        && frame.currentClip !== "none" && !/^inset\(0%\)$/.test(frame.currentClip));
      const continuity = gradeContinuity(frames, { allowedAssets: [I2, I3] });
      record({
        name: "story-abandoned-handoff-reclaims-presentation",
        claim: "a navigation abandoned by the finger that grabs the stack leaves the presented page unclipped and painted above every retained page, with the retained pages back inside the presented picture's aperture, and never leaves a residual aperture cutting the presented photograph away",
        presented: I2, steps, gesture,
        // Proof the replay exercised an in-flight handoff rather than a cold
        // pending request: the stack must have declared the target readable
        // before the arrow key, and must have moved the presented page's
        // aperture away from rest at least once during the window.
        targetReadableBeforeRequest: beforeGrab.pages
          .some((slot) => slot.id === I3 && slot.ready === "true"),
        apertureMoved: frames.some((frame) => frame.currentClip
          && frame.currentClip !== "none" && frame.currentClip !== "inset(0%)"),
        beforeGrab, afterGrab, rest, settled, stillPresented,
        sampledFrames: frames.length,
        clippedWhileSettled: { frames: clippedWhileSettled.length, first: clippedWhileSettled.slice(0, 3) },
        continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: steps.some((step) => !step.ok) || !stillPresented
          || !beforeGrab.pages.some((slot) => slot.id === I3 && slot.ready === "true")
          || settled.id !== I2 || rest.failed || continuity.failed
          || clippedWhileSettled.length > 0
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
      await input(page).click(half.x, half.y);
      await waitForSettledAsset(page, V1);
      const toSecondVideo = await navigateByVideoButton(page, STAGE, 1, V2);
      const toLastVisible = await navigateByVideoButton(page, STAGE, 1, I2);
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
      // #489 C/V6: the destination must never draw its own picture while the
      // shared-element clone is still flying. A frame with both is the recorded
      // reveal-then-hide-then-smaller-reopen, and the coverage grade above
      // cannot see it -- a destination painted at full size reads as covered.
      const morphExposure = (frames) => frames.filter((frame) => frame.frontDrawn
        && frame.kind === "image"
        && (frame.morphs ?? []).some((name) => !String(name).startsWith("::view-transition")));
      const entryExposure = morphExposure(entryFrames);
      const exitExposure = morphExposure(exitFrames);
      record({
        name: "story-entry-exit-object-continuity",
        claim: "entering immersive viewing presents only the targeted asset and leaving restores the same last-visible asset, with no other asset owning the foreground, no second transport, no frame in which neither stage draws the picture while no shared-element morph owns it, and no frame in which the destination draws its own picture while that morph is still flying",
        entryFrames: entryFrames.length, exitFrames: exitFrames.length,
        toSecondVideo, toLastVisible, lastVisible, entered, exited, entry, exit,
        entryExposure: { frames: entryExposure.length, first: entryExposure.slice(0, 2) },
        exitExposure: { frames: exitExposure.length, first: exitExposure.slice(0, 2) },
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !toSecondVideo.ok || !toLastVisible.ok || lastVisible.id !== I2 || entered.id !== I2 || exited.id !== I2
          || entry.failed || exit.failed
          || entryExposure.length > 0 || exitExposure.length > 0
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } finally {
      await session.page.close();
    }
  }

  // #489 video fullscreen handoff: the same seeked frame and transport intent
  // survive both directions. Resize interrupts the entry morph while the
  // snapshot owns the paused picture; real Close returns to the inline video.
  {
    const session = await createStoryPage({ mobile: false });
    const progress = {};
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.inlineBefore = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.inlinePixels = await pausedVideoScreenPixels(page, STAGE);

      await startSampler(page, [STAGE, FULLSCREEN]);
      await page.locator(".journey-story__fullscreen-entry").click();
      await page.waitForFunction((asset) => {
        const clone = document.querySelector(`[data-shared-element-clone="story-fullscreen-${asset}"]`);
        const target = document.querySelector('.journey-story-fullscreen .story-media-pages__video video');
        return clone && target?.getAttribute('data-video-handoff-ready') === asset;
      }, V1, { polling: "raf", timeout: 3_000 });
      progress.readyBeforeResize = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight,
        clone: document.querySelector('[data-shared-element-clone]')?.getAttribute('data-shared-element-clone') ?? null,
        targetReady: document.querySelector('.journey-story-fullscreen .story-media-pages__video video')
          ?.getAttribute('data-video-handoff-ready') ?? null,
      }));
      await page.setViewportSize({ width: 800, height: 1280 });
      progress.resizeDuringMorph = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight,
      }));
      await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
      await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
        .waitFor({ state: "detached", timeout: 5_000 });
      progress.entry = gradeVideoFullscreenFrames(await stopSamplerFrames(page), V1);
      progress.fullscreen = await videoHandoffState(page, FULLSCREEN);
      progress.fullscreenPixels = await pausedVideoScreenPixels(page, FULLSCREEN,
        "paused-rotation-fullscreen");

      await startSampler(page, [STAGE, FULLSCREEN]);
      progress.close = await clickFullscreenClose(page);
      progress.exitScreen = await activeCloneScreenPixels(page, V1);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      await waitForVideoHandoffState(page, STAGE, V1, true);
      await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
        .waitFor({ state: "detached", timeout: 5_000 });
      progress.exit = gradeVideoFullscreenFrames(await stopSamplerFrames(page), V1);
      progress.inlineAfter = await videoHandoffState(page, STAGE);
      progress.returnPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.entryFrameIdentity = gradePausedFrameIdentity(progress.inlinePixels, progress.fullscreenPixels);
      progress.exitFrameIdentity = gradePausedFrameIdentity(progress.fullscreenPixels, progress.returnPixels);
      progress.entryClock = gradeVideoClock(progress.inlineBefore, progress.fullscreen, true);
      progress.exitClock = gradeVideoClock(progress.fullscreen, progress.inlineAfter, true);
      progress.returnHit = await clickReturnedVideo(page);
      record({
        name: "story-video-fullscreen-paused-rotation-roundtrip",
        claim: "a real 43% native seek and paused desktop video retain asset, time, intent and visible decoded pixels through fullscreen entry interrupted by resize and real Close; the sampled entry and exit frames keep one picture owner and the returned video receives a real click",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.readyBeforeResize.clone !== `story-fullscreen-${V1}`
          || progress.readyBeforeResize.targetReady !== V1
          || progress.readyBeforeResize.width <= progress.readyBeforeResize.height
          || progress.resizeDuringMorph.width >= progress.resizeDuringMorph.height
          || progress.inlinePixels.failed || progress.fullscreenPixels.failed || progress.returnPixels.failed
          || progress.entryFrameIdentity.failed || progress.exitFrameIdentity.failed
          || progress.exitScreen.failed
          || progress.entry.failed || progress.exit.failed || progress.entryClock.failed || progress.exitClock.failed
          || progress.returnHit.failed || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name: "story-video-fullscreen-paused-rotation-roundtrip", ...progress,
        error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // Reduced motion skips travel, but a slow decoder still needs a visible
  // snapshot until the sought fullscreen frame is genuinely ready.
  {
    const session = await createStoryPage({ mobile: false, reducedMotion: "reduce" });
    const progress = {};
    const name = "story-video-fullscreen-paused-reduced-motion-roundtrip";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.before = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.beforePixels = await pausedVideoScreenPixels(page, STAGE);
      progress.delayedTarget = await prepareDelayedFullscreenTarget(page, session, 3_000);
      await startSampler(page, [STAGE, FULLSCREEN]);
      progress.fullscreenActivation = await clickHandoffButton(page, ".journey-story__fullscreen-entry");
      await page.waitForFunction(() => {
        const clone = document.querySelector('[data-shared-element-clone^="story-fullscreen-"]');
        const target = document.querySelector('.journey-story-fullscreen .story-media-pages__video video');
        return clone && target instanceof HTMLVideoElement
          && target.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
      }, undefined, { polling: "raf", timeout: 3_000 });
      progress.delayedRequest = session.mediaDelays.find((request) =>
        request.startedAt >= progress.delayedTarget.initiatedAt) ?? null;
      progress.waiting = await page.evaluate(() => ({
        clone: document.querySelector('[data-shared-element-clone]')?.getAttribute('data-shared-element-clone') ?? null,
        targetReadyState: document.querySelector('.journey-story-fullscreen .story-media-pages__video video')?.readyState ?? null,
      }));
      progress.waiting.requestReleasedAt = progress.delayedRequest?.releasedAt ?? null;
      progress.entryScreen = await activeCloneScreenPixels(page, V1, { stationary: true });
      await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
        .waitFor({ state: "detached", timeout: 5_000 });
      progress.entry = gradeVideoFullscreenFrames(await stopSamplerFrames(page), V1);
      progress.fullscreen = await videoHandoffState(page, FULLSCREEN);
      progress.fullscreenPixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      progress.entryFrameIdentity = gradePausedFrameIdentity(progress.beforePixels, progress.fullscreenPixels);
      progress.entryClock = gradeVideoClock(progress.before, progress.fullscreen, true);
      progress.fullscreenPoint = await presentedVideoPoint(page, FULLSCREEN);
      await startSampler(page, [STAGE, FULLSCREEN]);
      progress.close = await clickFullscreenClose(page);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      progress.after = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.exit = gradeVideoFullscreenFrames(await stopSamplerFrames(page), V1, { requireClone: false });
      progress.afterPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.exitFrameIdentity = gradePausedFrameIdentity(progress.fullscreenPixels, progress.afterPixels);
      progress.exitClock = gradeVideoClock(progress.fullscreen, progress.after, true);
      progress.returnHit = await clickReturnedVideo(page);
      record({ name,
        claim: "with reduced motion, a real nonzero native seek keeps its paused V1 frame visibly composited by the sole snapshot while fullscreen decoding waits, then preserves that frame, clock and native video hit target through fullscreen and Close",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.beforePixels.failed || progress.delayedTarget.failed
          || progress.waiting.clone !== `story-fullscreen-${V1}`
          || progress.waiting.targetReadyState === null || progress.waiting.targetReadyState >= 2
          || progress.waiting.requestReleasedAt !== null
          || !progress.delayedRequest || progress.delayedRequest.outcome !== "continued"
          || progress.delayedRequest.releasedAt === null
          || progress.entryScreen.capturedAt >= progress.delayedRequest.releasedAt
          || progress.entryScreen.failed || progress.entry.failed
          || progress.fullscreenPixels.failed || progress.entryFrameIdentity.failed
          || progress.entryClock.failed || !progress.fullscreenPoint.hitIsVideo
          || progress.exit.failed || progress.afterPixels.failed || progress.exitFrameIdentity.failed
          || progress.exitClock.failed || progress.returnHit.failed
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // Resize while the hidden fullscreen decoder is genuinely stalled. The
  // snapshot may be discarded by the resize handler, so its already decoded
  // inline source must own the picture before delayed bytes can arrive.
  {
    const session = await createStoryPage({ mobile: false });
    const progress = {};
    const name = "story-video-fullscreen-paused-rotation-slow-decode";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.before = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.beforePixels = await pausedVideoScreenPixels(page, STAGE);
      progress.delayedTarget = await prepareDelayedFullscreenTarget(page, session, 2_500);
      await startSampler(page, [STAGE, FULLSCREEN]);
      progress.fullscreenActivation = await clickHandoffButton(page, ".journey-story__fullscreen-entry");
      await page.waitForFunction(() => {
        const clone = document.querySelector('[data-shared-element-clone^="story-fullscreen-"]');
        const target = document.querySelector('.journey-story-fullscreen .story-media-pages__video video');
        return clone && target instanceof HTMLVideoElement
          && target.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
      }, undefined, { polling: "raf", timeout: 3_000 });
      progress.delayedRequest = session.mediaDelays.find((request) =>
        request.startedAt >= progress.delayedTarget.initiatedAt) ?? null;
      await page.evaluate(() => {
        window.__qaVideoResize = null;
        window.addEventListener("resize", () => {
          window.__qaVideoResize = {
            wallAt: Date.now(),
            clone: document.querySelector('[data-shared-element-clone]')?.getAttribute('data-shared-element-clone') ?? null,
            targetReadyState: document.querySelector('.journey-story-fullscreen .story-media-pages__video video')?.readyState ?? null,
          };
        }, { capture: true, once: true });
      });
      progress.atResize = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight,
        clone: document.querySelector('[data-shared-element-clone]')?.getAttribute('data-shared-element-clone') ?? null,
        targetReadyState: document.querySelector('.journey-story-fullscreen .story-media-pages__video video')?.readyState ?? null,
      }));
      await page.setViewportSize({ width: 800, height: 1280 });
      progress.afterResizeViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await page.waitForFunction(() => window.__qaVideoResize !== null,
        undefined, { polling: "raf", timeout: 3_000 });
      progress.resizeEvent = await page.evaluate(() => window.__qaVideoResize);
      await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
        .waitFor({ state: "detached", timeout: 5_000 });
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 5_000 });
      progress.after = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.coverage = gradeVideoFullscreenFrames(await stopSamplerFrames(page), V1);
      progress.afterPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.frameIdentity = gradePausedFrameIdentity(progress.beforePixels, progress.afterPixels);
      progress.clock = gradeVideoClock(progress.before, progress.after, true);
      progress.returnPoint = await presentedVideoPoint(page, STAGE);
      const deadline = Date.now() + 3_000;
      while (!progress.delayedRequest?.outcome && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      progress.afterLateRelease = await videoHandoffState(page, STAGE);
      progress.afterLatePixels = await pausedVideoScreenPixels(page, STAGE);
      progress.lateFrameIdentity = gradePausedFrameIdentity(progress.beforePixels, progress.afterLatePixels);
      progress.lateClock = gradeVideoClock(progress.before, progress.afterLateRelease, true);
      progress.fullscreenHiddenAfterLateRelease = await page.locator(FULLSCREEN).isHidden();
      progress.returnHit = await clickReturnedVideo(page);
      record({ name,
        claim: "rotating while the fullscreen target is still undecoded returns to the same paused seeked V1 frame with continuous coverage and native hit target; late decoder bytes do not reopen or replace it",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.beforePixels.failed || progress.delayedTarget.failed
          || progress.atResize.width <= progress.atResize.height
          || progress.atResize.clone !== `story-fullscreen-${V1}`
          || progress.atResize.targetReadyState === null || progress.atResize.targetReadyState >= 2
          || progress.resizeEvent?.targetReadyState === null || progress.resizeEvent?.targetReadyState >= 2
          || progress.afterResizeViewport.width >= progress.afterResizeViewport.height
          || progress.coverage.failed || progress.afterPixels.failed || progress.frameIdentity.failed
          || progress.clock.failed || !progress.returnPoint.hitIsVideo || !progress.returnPoint.controls
          || !progress.delayedRequest || progress.delayedRequest.releasedAt === null
          || progress.delayedRequest.startedAt > progress.resizeEvent?.wallAt
          || progress.delayedRequest.releasedAt <= progress.resizeEvent?.wallAt
          || progress.delayedRequest.outcome !== "continued"
          || progress.afterLateRelease.id !== V1 || progress.afterLateRelease.asset !== V1
          || progress.afterLateRelease.src !== progress.before.src
          || progress.afterLatePixels.failed || progress.lateFrameIdentity.failed || progress.lateClock.failed
          || !progress.fullscreenHiddenAfterLateRelease || progress.returnHit.failed
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // Normal playing handoff and a delayed destination reversed while it still
  // lacks a decoded frame. Both use actual mobile touch and Browser Back.
  for (const rapidReverse of [false, true]) {
    const session = await createStoryPage({ mobile: true });
    const progress = { rapidReverse };
    const name = rapidReverse
      ? "story-video-fullscreen-playing-slow-decode-rapid-back"
      : "story-video-fullscreen-playing-roundtrip-back";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.08 });
      progress.remainingAfterSeek = progress.seek.after?.duration - progress.seek.after?.time;
      if (progress.seek.failed || !Number.isFinite(progress.remainingAfterSeek)
        || progress.remainingAfterSeek < 4) {
        throw new Error(`playing handoff needs a real early seek with four seconds left: ${JSON.stringify({
          failed: progress.seek.failed, remaining: progress.remainingAfterSeek,
          time: progress.seek.after?.time, duration: progress.seek.after?.duration,
        })}`);
      }
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.play = await startStoryVideoPlayback(page, true);
      if (progress.play.failed) throw new Error(`source playback did not start: ${progress.play.reason}`);
      progress.inlineBefore = await videoHandoffState(page, STAGE);
      progress.remainingAtHandoff = progress.inlineBefore.duration - progress.inlineBefore.time;
      if (!Number.isFinite(progress.remainingAtHandoff) || progress.remainingAtHandoff < 3.5) {
        throw new Error(`playing source lacks time for fullscreen roundtrip: ${progress.remainingAtHandoff}`);
      }
      if (rapidReverse) progress.delayedTarget = await prepareDelayedFullscreenTarget(page, session, 650);
      await startSampler(page, [STAGE, FULLSCREEN]);
      progress.fullscreenActivation = await clickHandoffButton(page, ".journey-story__mobile-media-fullscreen");
      progress.handoffClickedAt = await page.evaluate(() => window.__qaStage?.handoffSource?.wallAt ?? null);
      await page.waitForFunction(() => {
        const stack = window.history.state?.__startripsMobileSurfaceStack;
        return Array.isArray(stack) && stack.at(-1)?.startsWith("story-media-surface:");
      }, undefined, { polling: "raf", timeout: 3_000 });
      if (rapidReverse) {
        await page.waitForFunction(() => Boolean(document.querySelector(
          '[data-shared-element-clone^="story-fullscreen-"]'))
          && (document.querySelector('.journey-story-fullscreen .story-media-pages__video video')?.readyState ?? 4) < 2,
        undefined, { polling: "raf", timeout: 3_000 });
        progress.entryCloneObserved = true;
      } else {
        progress.entryScreen = await activeCloneScreenPixels(page, V1);
        await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
        await waitForVideoHandoffState(page, FULLSCREEN, V1, false);
        await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
          .waitFor({ state: "detached", timeout: 5_000 });
        const entryFrames = await stopSamplerFrames(page);
        progress.entry = gradeVideoFullscreenFrames(entryFrames, V1);
        progress.fullscreen = await videoHandoffState(page, FULLSCREEN);
        progress.entryClock = gradeVideoClock(progress.inlineBefore, progress.fullscreen, false);
        progress.fullscreenPoint = await presentedVideoPoint(page, FULLSCREEN);
        progress.fullscreenFrame = await awaitPresentedVideoFrame(page, FULLSCREEN);
        progress.fullscreenPlayback = await samplePlayback(page, FULLSCREEN, { samples: 2, everyMs: 180 });
        await startSampler(page, [STAGE, FULLSCREEN]);
      }
      // Same-document browser history traversal exercises the real mobile Back
      // contract; dispatching a popstate event would bypass that ownership.
      progress.back = await page.evaluate((mustStillBeUnready) => {
        const cloneAtBack = Boolean(document.querySelector('[data-shared-element-clone^="story-fullscreen-"]'));
        const targetReadyState = document.querySelector('.journey-story-fullscreen .story-media-pages__video video')?.readyState ?? null;
        const stack = window.history.state?.__startripsMobileSurfaceStack ?? null;
        const at = Date.now();
        if (mustStillBeUnready && (!cloneAtBack || targetReadyState === null || targetReadyState >= 2)) {
          return { triggered: false, cloneAtBack, targetReadyState, stack, at };
        }
        window.history.back();
        return { triggered: true, cloneAtBack, targetReadyState, stack, at };
      }, rapidReverse);
      if (!progress.back.triggered) throw new Error(`Back missed the unready clone: ${JSON.stringify(progress.back)}`);
      if (!rapidReverse) progress.exitScreen = await activeCloneScreenPixels(page, V1);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      await waitForVideoHandoffState(page, STAGE, V1, false);
      await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
        .waitFor({ state: "detached", timeout: 5_000 });
      const exitFrames = await stopSamplerFrames(page);
      progress.exit = gradeVideoFullscreenFrames(exitFrames, V1);
      if (rapidReverse) {
        progress.targetUnreadyWithClone = exitFrames.filter((frame) => frame.videoClone?.painted
          && frame.surfaces?.some((surface) => surface.root === FULLSCREEN
            && !surface.videoVisuals?.video?.ready)).length;
        const deadline = Date.now() + 2_000;
        let delayed = session.mediaDelays.find((request) => request.startedAt >= progress.delayedTarget.initiatedAt);
        while (delayed && delayed.releasedAt === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        progress.delayedRequest = delayed ?? null;
      }
      progress.inlineAfter = await videoHandoffState(page, STAGE);
      progress.exitClock = gradeVideoClock(rapidReverse ? progress.inlineBefore : progress.fullscreen,
        progress.inlineAfter, false);
      progress.inlineFrame = await awaitPresentedVideoFrame(page, STAGE);
      progress.inlinePlayback = await samplePlayback(page, STAGE, { samples: 2, everyMs: 180 });
      progress.returnHit = await clickReturnedVideo(page);
      record({
        name,
        claim: rapidReverse
          ? "a held fullscreen decoder is still unready under the active clone when real Browser Back fires; the original seeked video, native settings and playing clock recover with no stale paint"
          : "a real early native seek with four seconds remaining retains the same playing video, native settings and clock through mobile fullscreen and Browser Back; clone pixels match the composited picture and the returned transport receives a real touch",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.remainingAfterSeek < 4 || progress.remainingAtHandoff < 3.5 || progress.play.failed
          || progress.play.pressed !== "true" || progress.inlineBefore.paused
          || progress.entry?.failed || progress.entryClock?.failed || progress.fullscreenFrame?.failed
          || (rapidReverse && (progress.delayedTarget.failed || progress.handoffClickedAt === null
            || !progress.delayedRequest || progress.delayedRequest.startedAt > progress.back.at
            || progress.delayedRequest.releasedAt <= progress.handoffClickedAt
            || progress.delayedRequest.releasedAt <= progress.back.at
            || progress.targetUnreadyWithClone === 0))
          || progress.entryScreen?.failed || progress.exitScreen?.failed
          || (progress.fullscreenPoint && !progress.fullscreenPoint.hitIsVideo)
          || (rapidReverse && !progress.back.cloneAtBack)
          || (progress.fullscreenPlayback && (!progress.fullscreenPlayback.advanced || !progress.fullscreenPlayback.monotonic))
          || progress.exit.failed || progress.exitClock.failed || progress.inlineFrame.failed
          || !progress.inlinePlayback.advanced || !progress.inlinePlayback.monotonic
          || progress.returnHit.failed || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // A target that remains unready past the handoff deadline must not poison
  // the already readable paused frame. Observe recovery before the held bytes arrive.
  {
    const session = await createStoryPage({ mobile: true });
    const progress = {};
    const name = "story-video-fullscreen-decode-timeout-preserves-source";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.before = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.beforeControls = await readNativeControls(page, STAGE);
      progress.beforePixels = await pausedVideoScreenPixels(page, STAGE, "decode-timeout-before");
      progress.delayedTarget = await prepareDelayedFullscreenTarget(page, session, 9_500);
      await startSampler(page, [STAGE, FULLSCREEN]);
      progress.fullscreenActivation = await clickHandoffButton(page, ".journey-story__mobile-media-fullscreen");
      progress.clickedAt = await page.evaluate(() => window.__qaStage?.handoffSource?.wallAt ?? null);
      await page.waitForFunction((clickedAt) => {
        if (!clickedAt || Date.now() - clickedAt < 8_000) return false;
        return !document.querySelector('[data-shared-element-clone^="story-fullscreen-"]');
      }, progress.clickedAt, { polling: "raf", timeout: 11_000 });
      progress.recoveredAt = Date.now();
      const frames = await stopSamplerFrames(page);
      progress.continuity = gradeVideoFullscreenFrames(frames, V1);
      progress.delayedRequest = session.mediaDelays.find((request) =>
        request.startedAt >= progress.delayedTarget.initiatedAt) ?? null;
      progress.resource = await page.evaluate(({ inline, fullscreen }) => {
        const inlineRoot = document.querySelector(inline);
        const fullRoot = document.querySelector(fullscreen);
        const source = inlineRoot?.querySelector(".story-media-pages__video video");
        const sourcePage = inlineRoot?.querySelector('[data-media-page="current"]');
        const activeRoot = fullRoot && !fullRoot.hidden && getComputedStyle(fullRoot).display !== "none"
          ? fullRoot : inlineRoot;
        const activeVideo = activeRoot?.querySelector(".story-media-pages__video video");
        return {
          inlineVisible: Boolean(inlineRoot && getComputedStyle(inlineRoot).display !== "none"),
          fullscreenVisible: activeRoot === fullRoot,
          sourceSrc: source?.getAttribute("src") ?? null,
          sourceCurrentSrc: source instanceof HTMLVideoElement ? source.currentSrc : null,
          sourceReady: source instanceof HTMLVideoElement && source.readyState >= 2,
          sourcePageReady: sourcePage?.getAttribute("data-media-page-ready") === "true",
          sourceId: sourcePage?.getAttribute("data-media-page-id") ?? null,
          activeReady: activeVideo instanceof HTMLVideoElement && activeVideo.readyState >= 2,
          activeControls: activeVideo instanceof HTMLVideoElement && activeVideo.controls,
          errorText: [...document.querySelectorAll(".journey-story__media-state.is-error")]
            .map((node) => node.textContent?.trim().slice(0, 160)),
          cloneCount: document.querySelectorAll("[data-shared-element-clone]").length,
          targetReadProbe: window.__qaTargetReadProbe ?? null,
        };
      }, { inline: STAGE, fullscreen: FULLSCREEN });
      const activeRoot = progress.resource.fullscreenVisible ? FULLSCREEN : STAGE;
      progress.recovered = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.recoveredControls = await readNativeControls(page, STAGE);
      progress.recoveredPixels = await pausedVideoScreenPixels(page, STAGE, "decode-timeout-recovered");
      progress.recoveredFrame = gradePausedFrameIdentity(progress.beforePixels, progress.recoveredPixels);
      progress.recoveryClock = gradeVideoClock(progress.before, progress.recovered, true);
      progress.activePoint = await presentedVideoPoint(page, activeRoot).catch((error) => ({
        error: error instanceof Error ? error.message : String(error), hitIsVideo: false,
      }));
      if (progress.activePoint.hitIsVideo && progress.resource.activeReady) {
        // The recovery path must offer a usable transport. A first touch may
        // reveal Chromium controls or start playback; otherwise tap Play.
        await input(page).click(progress.activePoint.x, progress.activePoint.y);
        let state = await videoHandoffState(page, activeRoot);
        if (state.paused) {
          const controls = await nativeControls(page, activeRoot);
          const play = playEntry(controls);
          progress.playControl = play ?? { error: "native Play unavailable", panel: controls.panel };
          if (play?.reachable && play.name.toLowerCase() === "play") {
            await input(page).click(play.x, play.y);
            state = await videoHandoffState(page, activeRoot);
          }
        }
        progress.afterActivation = state;
        progress.resumedFromSeek = state.time >= progress.recovered.time - 0.18;
        progress.playback = await samplePlayback(page, activeRoot, { samples: 2, everyMs: 180 });
        progress.assetAfterActivation = await currentAsset(page, activeRoot);
      }
      const deadline = Date.now() + 2_000;
      while (!progress.delayedRequest?.outcome && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      progress.afterLateRelease = await page.evaluate(async ({ inline, fullscreen }) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const sourceRoot = document.querySelector(inline);
        const fullRoot = document.querySelector(fullscreen);
        return {
          sourceSrc: sourceRoot?.querySelector(".story-media-pages__video video")?.getAttribute("src") ?? null,
          sourceAsset: sourceRoot?.querySelector(".story-media-pages__video video")?.getAttribute("data-shared-media-id") ?? null,
          sourceId: sourceRoot?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id") ?? null,
          fullscreenVisible: Boolean(fullRoot && !fullRoot.hidden && getComputedStyle(fullRoot).display !== "none"),
          errorCount: document.querySelectorAll(".journey-story__media-state.is-error").length,
        };
      }, { inline: STAGE, fullscreen: FULLSCREEN });
      record({ name,
        claim: "when the hidden destination remains undecoded past eight seconds, the same paused seeked V1 frame, URL and native controls recover on the inline stage before delayed bytes arrive; Play then advances from that frame without an error state",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.beforePixels.failed || progress.recoveredPixels.failed
          || progress.recoveredFrame.failed || progress.recoveryClock.failed
          || progress.delayedTarget.failed || !progress.clickedAt
          || progress.recoveredAt - progress.clickedAt < 8_000
          || !progress.delayedRequest || progress.delayedRequest.releasedAt <= progress.recoveredAt
          || !progress.resource.targetReadProbe
          || (progress.resource.targetReadProbe.readyAt !== null
            && progress.resource.targetReadProbe?.readyAt <= progress.clickedAt + 8_000)
          || progress.continuity.failed || progress.resource.cloneCount !== 0
          || progress.resource.sourceId !== V1 || !progress.resource.sourcePageReady
          || !progress.resource.sourceSrc?.endsWith(CLIP)
          || progress.resource.errorText.length > 0
          || progress.resource.fullscreenVisible
          || !progress.activePoint.hitIsVideo || !progress.resource.activeReady
          || !progress.resource.activeControls
          || progress.afterActivation?.paused !== false
          || !progress.resumedFromSeek
          || !progress.playback?.advanced || !progress.playback?.monotonic
          || progress.assetAfterActivation?.id !== V1
          || progress.afterLateRelease.sourceId !== V1
          || progress.afterLateRelease.sourceAsset !== V1
          || progress.afterLateRelease.sourceSrc !== progress.resource.sourceSrc
          || progress.delayedRequest.outcome !== "continued"
          || progress.afterLateRelease.fullscreenVisible !== progress.resource.fullscreenVisible
          || progress.afterLateRelease.errorCount !== 0
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // A short signed read expires while the viewer is paused at a real native
  // seek. Hold both the renewal response and its video bytes so the old frame
  // has to remain on screen until the new source reaches the same media time.
  {
    const session = await createStoryPage({ mobile: false, renewPausedVideo: true });
    const progress = {};
    const name = "story-paused-video-signed-read-renewal";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.before = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.beforePixels = await pausedVideoScreenPixels(page, STAGE);
      progress.renewalRead = await waitForFixture(session.renewal.readStarted, 28_000, "signed-read renewal");
      progress.duringRead = await videoHandoffState(page, STAGE);
      await startSampler(page, STAGE);
      session.renewal.releaseRead();
      progress.renewalBytes = await waitForFixture(session.renewal.byteStarted, 5_000, "renewed video bytes");
      await page.waitForFunction(() => {
        const stage = document.querySelector('.journey-story__media [data-story-media-pages]');
        const video = stage?.querySelector('.story-media-pages__video video');
        const frame = stage?.querySelector('[data-media-page="current"] canvas');
        return video instanceof HTMLVideoElement && video.hidden
          && video.getAttribute('src')?.includes('storyRenewal=2')
          && frame instanceof HTMLCanvasElement && frame.width > 0 && frame.height > 0;
      }, undefined, { polling: "raf", timeout: 4_000 });
      progress.held = await heldRenewalFramePixels(page, STAGE);
      progress.fullscreenDisabledWhileHeld = await page.locator('.journey-story__fullscreen-entry').isDisabled();
      session.renewal.releaseBytes();
      progress.after = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.continuity = gradeContinuity(await stopSamplerFrames(page), { allowedAssets: [V1] });
      progress.afterPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.renewedFrame = gradePausedFrameIdentity(progress.beforePixels, progress.afterPixels);
      progress.afterPoint = await presentedVideoPoint(page, STAGE);
      progress.fullscreenActivation = await clickHandoffButton(page, '.journey-story__fullscreen-entry');
      progress.fullscreen = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      await waitForPresentedVideoHit(page, FULLSCREEN, V1);
      progress.fullscreenPixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      progress.fullscreenFrame = gradePausedFrameIdentity(progress.afterPixels, progress.fullscreenPixels);
      progress.close = await clickFullscreenClose(page);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      progress.returned = await waitForVideoHandoffState(page, STAGE, V1, true);
      await waitForPresentedVideoHit(page, STAGE, V1);
      progress.returnedPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.returnedFrame = gradePausedFrameIdentity(progress.fullscreenPixels, progress.returnedPixels);
      progress.returnHit = await clickReturnedVideo(page);
      const near = (left, right) => Number.isFinite(left) && Number.isFinite(right)
        && Math.abs(left - right) <= 0.18;
      record({ name,
        claim: "a short signed read renews after real native seek and pause; a delayed URL and delayed bytes retain the old composited frame, then the single video seeks to the same time before fullscreen and Close return the same hit target",
        ...progress, renewalReads: session.renewal.reads, renewalBytes: session.renewal.bytes,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.beforePixels.failed || progress.held.failed || progress.continuity.failed
          || progress.renewedFrame.failed || progress.fullscreenFrame.failed || progress.returnedFrame.failed
          || progress.renewalRead.count !== 2 || progress.renewalRead.releasedAt === null
          || progress.renewalBytes.releasedAt === null
          || progress.duringRead.src !== progress.before.src
          || !near(progress.duringRead.time, progress.before.time) || !progress.duringRead.paused
          || progress.held.currentId !== V1 || !progress.held.videoSrc?.includes('storyRenewal=2')
          || !progress.fullscreenDisabledWhileHeld
          || progress.after.src === progress.before.src || !progress.after.src?.includes('storyRenewal=2')
          || !near(progress.after.time, progress.before.time) || !progress.after.paused
          || progress.after.muted !== progress.before.muted
          || Math.abs(progress.after.volume - progress.before.volume) > 0.001
          || Math.abs(progress.after.playbackRate - progress.before.playbackRate) > 0.001
          || !progress.afterPoint.hitIsVideo || !progress.afterPoint.controls
          || progress.fullscreen.src !== progress.after.src
          || !near(progress.fullscreen.time, progress.after.time) || !progress.fullscreen.paused
          || progress.returned.src !== progress.after.src
          || !near(progress.returned.time, progress.after.time) || !progress.returned.paused
          || progress.returnHit.failed
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      session.renewal.releaseRead();
      session.renewal.releaseBytes();
      await session.page.close();
    }
  }

  for (const { failure, sameUrl } of [
    { failure: "read", sameUrl: false },
    { failure: "bytes", sameUrl: false },
    { failure: "bytes", sameUrl: true },
  ]) {
    const session = await createStoryPage({ mobile: false, renewPausedVideo: true,
      renewalReadFailure: failure === "read", renewalByteFailure: failure === "bytes",
      renewalSameUrlRetry: sameUrl });
    const progress = { failure, sameUrl };
    const name = `story-paused-video-renewal-${failure}-${sameUrl ? "same-url-" : ""}failure-retry`;
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.before = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.beforePixels = await pausedVideoScreenPixels(page, STAGE);
      progress.renewalRead = await waitForFixture(session.renewal.readStarted, 28_000, "failing signed-read renewal");
      session.renewal.releaseRead();
      if (failure === "bytes") {
        progress.renewalBytes = await waitForFixture(session.renewal.byteStarted, 5_000, "failing video bytes");
        session.renewal.releaseBytes();
      }
      const notice = page.locator(`${STAGE} .journey-story__media-state.is-over-media[role="alert"]`);
      await notice.waitFor({ state: "visible", timeout: 8_000 });
      progress.errorFrame = await heldRenewalFramePixels(page, STAGE,
        { videoHidden: failure === "bytes" });
      progress.noWaitingCoverAtError = await page.locator(`${STAGE} .starlight-media-state.is-waiting`).count() === 0;
      if (sameUrl) await page.evaluate(() => {
        const video = document.querySelector('.journey-story__media .story-media-pages__video video');
        if (!(video instanceof HTMLVideoElement)) throw new Error("no persistent video before same-URL Retry");
        window.__qaSameUrlRetryVideo = video;
        window.__qaSameUrlRetryLoadStarts = 0;
        video.addEventListener("loadstart", () => { window.__qaSameUrlRetryLoadStarts += 1; });
      });
      progress.retryClick = await clickHandoffButton(page,
        `${STAGE} .journey-story__media-state.is-over-media[role="alert"] button`);
      progress.retryRead = await waitForFixture(session.renewal.retryReadStarted, 5_000, "retry signed read");
      progress.retryingLabel = await notice.locator("button").textContent();
      progress.retryReadFrame = await heldRenewalFramePixels(page, STAGE,
        { videoHidden: failure === "bytes" });
      progress.noWaitingCoverDuringRetry = await page.locator(`${STAGE} .starlight-media-state.is-waiting`).count() === 0;
      session.renewal.releaseRetryRead();
      progress.retryBytes = await waitForFixture(session.renewal.retryByteStarted, 5_000, "retry video bytes");
      if (sameUrl) {
        await page.waitForFunction(() => window.__qaSameUrlRetryLoadStarts > 0,
          undefined, { polling: "raf", timeout: 4_000 });
        progress.sameUrlTransport = await page.evaluate(() => ({
          sameNode: document.querySelector('.journey-story__media .story-media-pages__video video')
            === window.__qaSameUrlRetryVideo,
          loadStarts: window.__qaSameUrlRetryLoadStarts,
        }));
      }
      await page.waitForFunction((expectedToken) => {
        const stage = document.querySelector('.journey-story__media [data-story-media-pages]');
        const video = stage?.querySelector('.story-media-pages__video video');
        return video instanceof HTMLVideoElement && video.hidden
          && video.getAttribute('src')?.includes(`storyRenewal=${expectedToken}`);
      }, sameUrl ? 2 : 3, { polling: "raf", timeout: 4_000 });
      progress.retryByteFrame = await heldRenewalFramePixels(page, STAGE);
      session.renewal.releaseRetryBytes();
      progress.after = await waitForVideoHandoffState(page, STAGE, V1, true);
      await notice.waitFor({ state: "hidden", timeout: 4_000 });
      progress.noticeCleared = await notice.count() === 0;
      progress.afterPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.frameIdentity = gradePausedFrameIdentity(progress.beforePixels, progress.afterPixels);
      progress.afterPoint = await presentedVideoPoint(page, STAGE);
      if (sameUrl) progress.returnHit = await clickReturnedVideo(page);
      progress.unexpectedConsoleErrors = session.consoleErrors.filter((message) => !message.includes("503"));
      record({ name,
        claim: sameUrl
          ? "a failed renewed video byte request survives a trusted Retry that receives the same signed URL; the same transport reloads real bytes, holds the old frame and time, clears the notice, and receives a real click"
          : "a real expired paused video survives either a failed signed-read request or failed renewed bytes; a trusted Retry click leaves its original frame visible through the delayed retry request and bytes, then restores the same native time and hit target",
        ...progress, renewalReads: session.renewal.reads, renewalBytes: session.renewal.bytes,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.beforePixels.failed || progress.errorFrame.failed
          || progress.retryReadFrame.failed || progress.retryByteFrame.failed
          || progress.frameIdentity.failed || !progress.noWaitingCoverAtError
          || !progress.noWaitingCoverDuringRetry || !progress.retryClick.hit.hitButton
          || progress.retryingLabel?.trim() !== "正在重试…"
          || progress.renewalRead.outcome !== (failure === "read" ? "failed" : "ready")
          || (failure === "bytes" && progress.renewalBytes?.outcome !== "failed")
          || progress.retryRead.count !== 3 || progress.retryRead.outcome !== "ready"
          || progress.retryBytes.outcome !== "continued"
          || !progress.noticeCleared
          || (sameUrl
            ? progress.retryRead.url !== progress.renewalRead.url
              || progress.retryBytes.url !== progress.renewalBytes.url
              || progress.after.src !== progress.retryBytes.url
              || !progress.sameUrlTransport?.sameNode || progress.sameUrlTransport?.loadStarts < 1
              || progress.returnHit?.failed
            : !progress.after.src?.includes("storyRenewal=3"))
          || !progress.after.paused
          || Math.abs(progress.after.time - progress.before.time) > 0.18
          || !progress.afterPoint.hitIsVideo || !progress.afterPoint.controls
          || progress.unexpectedConsoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      session.renewal.releaseRead();
      session.renewal.releaseBytes();
      session.renewal.releaseRetryRead();
      session.renewal.releaseRetryBytes();
      await session.page.close();
    }
  }

  // The visible fullscreen stage must renew its own paused transport. Holding
  // both the signature and the bytes proves that the old video remains the
  // native target during the request and its decoded frame covers the decode.
  {
    const session = await createStoryPage({ mobile: false, renewPausedVideo: true });
    const progress = {};
    const name = "story-paused-video-fullscreen-live-renewal";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.before = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.beforePixels = await pausedVideoScreenPixels(page, STAGE);
      progress.fullscreenActivation = await clickHandoffButton(page, ".journey-story__fullscreen-entry");
      progress.fullscreen = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      await waitForPresentedVideoHit(page, FULLSCREEN, V1);
      progress.fullscreenPixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      progress.fullscreenFrame = gradePausedFrameIdentity(progress.beforePixels, progress.fullscreenPixels);
      progress.renewalRead = await waitForFixture(session.renewal.readStarted, 28_000,
        "fullscreen signed-read renewal");
      progress.duringRead = await videoHandoffState(page, FULLSCREEN);
      progress.duringReadPoint = await presentedVideoPoint(page, FULLSCREEN);
      await startSampler(page, FULLSCREEN);
      session.renewal.releaseRead();
      progress.renewalBytes = await waitForFixture(session.renewal.byteStarted, 5_000,
        "fullscreen renewed video bytes");
      await page.waitForFunction(() => {
        const stage = document.querySelector('.journey-story-fullscreen [data-story-media-pages]');
        const video = stage?.querySelector('.story-media-pages__video video');
        const frame = stage?.querySelector('[data-media-page="current"] canvas');
        return video instanceof HTMLVideoElement && video.hidden
          && video.getAttribute('src')?.includes('storyRenewal=2')
          && frame instanceof HTMLCanvasElement && frame.width > 0 && frame.height > 0;
      }, undefined, { polling: "raf", timeout: 4_000 });
      progress.held = await heldRenewalFramePixels(page, FULLSCREEN);
      session.renewal.releaseBytes();
      progress.after = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      progress.continuity = gradeContinuity(await stopSamplerFrames(page), { allowedAssets: [V1] });
      progress.afterPixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      progress.renewedFrame = gradePausedFrameIdentity(progress.fullscreenPixels, progress.afterPixels);
      progress.afterPoint = await presentedVideoPoint(page, FULLSCREEN);
      progress.close = await clickFullscreenClose(page);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      progress.returned = await waitForVideoHandoffState(page, STAGE, V1, true);
      await waitForPresentedVideoHit(page, STAGE, V1);
      progress.returnedPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.returnedFrame = gradePausedFrameIdentity(progress.afterPixels, progress.returnedPixels);
      progress.returnHit = await clickReturnedVideo(page);
      const near = (left, right) => Number.isFinite(left) && Number.isFinite(right)
        && Math.abs(left - right) <= 0.18;
      record({ name,
        claim: "an expired paused fullscreen video renews in the visible stage: signed request keeps the old native target, byte decode keeps its frame painted, and completion plus Close retain time, settings and native hit ownership",
        ...progress, renewalReads: session.renewal.reads, renewalBytes: session.renewal.bytes,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.beforePixels.failed || progress.fullscreenFrame.failed
          || progress.returnedFrame.failed || progress.held.failed || progress.renewedFrame.failed
          || progress.continuity.failed || !progress.duringReadPoint.hitIsVideo
          || progress.renewalRead.count !== 2 || progress.renewalRead.releasedAt === null
          || progress.renewalBytes.releasedAt === null
          || progress.duringRead.src !== progress.fullscreen.src
          || !near(progress.duringRead.time, progress.fullscreen.time) || !progress.duringRead.paused
          || !progress.held.videoSrc?.includes("storyRenewal=2")
          || !progress.after.src?.includes("storyRenewal=2")
          || !near(progress.after.time, progress.fullscreen.time) || !progress.after.paused
          || progress.after.muted !== progress.before.muted
          || Math.abs(progress.after.volume - progress.before.volume) > 0.001
          || Math.abs(progress.after.playbackRate - progress.before.playbackRate) > 0.001
          || !progress.afterPoint.hitIsVideo || !progress.afterPoint.controls
          || progress.returned.src !== progress.after.src
          || !near(progress.returned.time, progress.after.time) || !progress.returned.paused
          || progress.returnHit.failed
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      session.renewal.releaseRead();
      session.renewal.releaseBytes();
      await session.page.close();
    }
  }

  // Close while the refreshed fullscreen bytes are still pending. Inline must
  // receive the visible retained bitmap and the intended native time before
  // fullscreen disappears; the delayed bytes may complete afterward.
  {
    const session = await createStoryPage({ mobile: false, renewPausedVideo: true });
    const progress = {};
    const name = "story-fullscreen-close-during-renewal-bytes";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.enter = await clickHandoffButton(page, ".journey-story__fullscreen-entry");
      progress.before = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      progress.beforePixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      progress.renewalRead = await waitForFixture(session.renewal.readStarted, 28_000,
        "fullscreen renewal before Close");
      session.renewal.releaseRead();
      progress.renewalBytes = await waitForFixture(session.renewal.byteStarted, 5_000,
        "fullscreen renewed bytes before Close");
      await page.waitForFunction(() => {
        const stage = document.querySelector('.journey-story-fullscreen [data-story-media-pages]');
        const video = stage?.querySelector('.story-media-pages__video video');
        return video instanceof HTMLVideoElement && video.hidden
          && stage?.querySelector('[data-media-page="current"] canvas:not([hidden])');
      }, undefined, { polling: "raf", timeout: 4_000 });
      progress.fullscreenHeld = await heldRenewalFramePixels(page, FULLSCREEN);
      progress.close = await clickFullscreenClose(page);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 4_000 });
      progress.inlineHeld = await heldRenewalFramePixels(page, STAGE);
      session.renewal.releaseBytes();
      progress.returned = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.returnedPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.returnedFrame = gradePausedFrameIdentity(progress.beforePixels, progress.returnedPixels);
      progress.returnedPoint = await presentedVideoPoint(page, STAGE);
      const near = (left, right) => Number.isFinite(left) && Number.isFinite(right)
        && Math.abs(left - right) <= 0.18;
      record({ name,
        claim: "Close during delayed fullscreen renewal bytes immediately returns the same painted frame to Story, then the single inline video restores its paused time and native click target",
        ...progress, renewalReads: session.renewal.reads, renewalBytes: session.renewal.bytes,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.beforePixels.failed || progress.fullscreenHeld.failed
          || progress.inlineHeld.failed || progress.returnedFrame.failed
          || progress.renewalRead.count !== 2 || progress.renewalBytes.releasedAt === null
          || !progress.returned.src?.includes("storyRenewal=2")
          || !near(progress.returned.time, progress.before.time) || !progress.returned.paused
          || !progress.returnedPoint.hitIsVideo || !progress.returnedPoint.controls
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      session.renewal.releaseRead();
      session.renewal.releaseBytes();
      await session.page.close();
    }
  }

  for (const failure of ["read", "bytes"]) {
    const session = await createStoryPage({ mobile: false, renewPausedVideo: true,
      renewalReadFailure: failure === "read", renewalByteFailure: failure === "bytes",
      renewalSameUrlRetry: failure === "bytes" });
    const progress = { failure };
    const name = `story-fullscreen-renewal-${failure}-failure-retry-close`;
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.before = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.beforePixels = await pausedVideoScreenPixels(page, STAGE);
      if (failure === "bytes") {
        progress.enter = await clickHandoffButton(page, ".journey-story__fullscreen-entry");
        progress.entered = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      }
      progress.renewalRead = await waitForFixture(session.renewal.readStarted, 28_000,
        `fullscreen ${failure} failing signed renewal`);
      session.renewal.releaseRead();
      if (failure === "bytes") {
        progress.renewalBytes = await waitForFixture(session.renewal.byteStarted, 5_000,
          "failing fullscreen renewed bytes");
        session.renewal.releaseBytes();
      }
      const errorRoot = failure === "read" ? STAGE : FULLSCREEN;
      await page.locator(`${errorRoot} .journey-story__media-state.is-over-media[role="alert"]`)
        .waitFor({ state: "visible", timeout: 8_000 });
      if (failure === "read") {
        progress.inlineAlertFrame = await heldRenewalFramePixels(page, STAGE, { videoHidden: false });
        progress.enter = await clickHandoffButton(page, ".journey-story__fullscreen-entry");
        progress.entered = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      }
      const notice = page.locator(`${FULLSCREEN} .journey-story__media-state.is-over-media[role="alert"]`);
      await notice.waitFor({ state: "visible", timeout: 4_000 });
      progress.errorFrame = await heldRenewalFramePixels(page, FULLSCREEN,
        { videoHidden: failure === "bytes" });
      progress.noWaiting = await page.locator(`${FULLSCREEN} .starlight-media-state.is-waiting`).count() === 0;
      if (failure === "bytes") await page.evaluate(() => {
        const video = document.querySelector('.journey-story-fullscreen .story-media-pages__video video');
        window.__qaFullscreenRetryVideo = video;
        window.__qaFullscreenRetryLoads = 0;
        video.addEventListener("loadstart", () => { window.__qaFullscreenRetryLoads += 1; });
      });
      progress.retryClick = await clickHandoffButton(page,
        `${FULLSCREEN} .journey-story__media-state.is-over-media[role="alert"] button`);
      progress.retryRead = await waitForFixture(session.renewal.retryReadStarted, 5_000,
        "fullscreen retry signed read");
      progress.retryReadFrame = await heldRenewalFramePixels(page, FULLSCREEN,
        { videoHidden: failure === "bytes" });
      session.renewal.releaseRetryRead();
      progress.retryBytes = await waitForFixture(session.renewal.retryByteStarted, 5_000,
        "fullscreen retry video bytes");
      if (failure === "bytes") {
        await page.waitForFunction(() => window.__qaFullscreenRetryLoads > 0,
          undefined, { polling: "raf", timeout: 4_000 });
        progress.sameUrlTransport = await page.evaluate(() => ({
          sameNode: document.querySelector('.journey-story-fullscreen .story-media-pages__video video')
            === window.__qaFullscreenRetryVideo,
          loadStarts: window.__qaFullscreenRetryLoads,
        }));
      }
      progress.retryByteFrame = await heldRenewalFramePixels(page, FULLSCREEN);
      session.renewal.releaseRetryBytes();
      progress.after = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      await notice.waitFor({ state: "hidden", timeout: 4_000 });
      progress.noticeCleared = await notice.count() === 0;
      progress.afterPixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      progress.frameIdentity = gradePausedFrameIdentity(progress.beforePixels, progress.afterPixels);
      progress.afterPoint = await presentedVideoPoint(page, FULLSCREEN);
      progress.close = await clickFullscreenClose(page);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      progress.returned = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.returnedPoint = await presentedVideoPoint(page, STAGE);
      progress.unexpectedConsoleErrors = session.consoleErrors.filter((message) => !message.includes("503"));
      const near = (left, right) => Number.isFinite(left) && Number.isFinite(right)
        && Math.abs(left - right) <= 0.18;
      record({ name,
        claim: failure === "read"
          ? "a retained renewal alert does not interrupt Story-to-fullscreen handoff; fullscreen Retry restores the paused frame and Close returns its time"
          : "fullscreen byte failure leaves a visible frame and Retry; even a repeated signed URL reloads real bytes on the same video node before Close",
        ...progress, renewalReads: session.renewal.reads, renewalBytes: session.renewal.bytes,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.inlineAlertFrame?.failed || progress.errorFrame.failed
          || progress.retryReadFrame.failed || progress.retryByteFrame.failed
          || progress.frameIdentity.failed || !progress.noWaiting || !progress.retryClick.hit.hitButton
          || progress.renewalRead.outcome !== (failure === "read" ? "failed" : "ready")
          || (failure === "bytes" && progress.renewalBytes?.outcome !== "failed")
          || progress.retryRead.count !== 3 || progress.retryRead.outcome !== "ready"
          || progress.retryBytes.outcome !== "continued" || !progress.noticeCleared
          || (failure === "bytes" && (progress.retryRead.url !== progress.renewalRead.url
            || progress.retryBytes.url !== progress.renewalBytes.url
            || !progress.sameUrlTransport?.sameNode || progress.sameUrlTransport.loadStarts < 1))
          || !progress.afterPoint.hitIsVideo || !progress.afterPoint.controls
          || !near(progress.after.time, progress.before.time) || !progress.after.paused
          || !near(progress.returned.time, progress.after.time) || !progress.returned.paused
          || !progress.returnedPoint.hitIsVideo || progress.returned.src !== progress.after.src
          || progress.unexpectedConsoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      session.renewal.releaseRead();
      session.renewal.releaseBytes();
      session.renewal.releaseRetryRead();
      session.renewal.releaseRetryBytes();
      await session.page.close();
    }
  }

  // The old capability can be rejected between expiry sweeps when a viewer
  // seeks into bytes the browser has never fetched. A real native timeline
  // gesture must receive Range 403, then Retry obtains new bytes and seeks to
  // that requested time rather than returning to the retained picture's time.
  {
    const session = await createStoryPage({ mobile: false, renewPausedVideo: true,
      expiredRangeFailure: true });
    const progress = {};
    const name = "story-fullscreen-expired-range-seek-retry";
    try {
      const { page } = session;
      await waitForSettledAsset(page, I1);
      progress.toVideo = await navigateByGesture(page, STAGE, 1, V1);
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.enter = await clickHandoffButton(page, ".journey-story__fullscreen-entry");
      progress.before = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      progress.beforePoint = await presentedVideoPoint(page, FULLSCREEN);
      progress.beforePixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      await page.waitForFunction((expiresAt) => Date.now() >= expiresAt + 100,
        session.renewal.initialRead.expiresAt, { polling: "raf", timeout: 9_000 });
      progress.seek = await seekExpiredNativeTimeline(page, FULLSCREEN);
      session.renewal.releaseExpiredRanges(progress.seek.seekStartedAt ?? Number.POSITIVE_INFINITY);
      progress.oldRange = await waitForFixture(session.renewal.expiredRangeDenied, 8_000,
        "expired old URL Range 403 after native seek");
      const notice = page.locator(`${FULLSCREEN} .journey-story__media-state.is-over-media[role="alert"]`);
      await notice.waitFor({ state: "visible", timeout: 8_000 });
      progress.errorFrame = await heldRenewalFramePixels(page, FULLSCREEN);
      progress.noWaiting = await page.locator(`${FULLSCREEN} .starlight-media-state.is-waiting`).count() === 0;
      progress.retryClick = await clickHandoffButton(page,
        `${FULLSCREEN} .journey-story__media-state.is-over-media[role="alert"] button`);
      progress.retryRead = await waitForFixture(session.renewal.readStarted, 5_000,
        "expired range retry signed read");
      progress.retryReadFrame = await heldRenewalFramePixels(page, FULLSCREEN);
      session.renewal.releaseRead();
      progress.retryBytes = await waitForFixture(session.renewal.byteStarted, 5_000,
        "expired range retry video bytes");
      progress.retryByteFrame = await heldRenewalFramePixels(page, FULLSCREEN);
      session.renewal.releaseBytes();
      progress.after = await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      await notice.waitFor({ state: "hidden", timeout: 4_000 });
      progress.afterPixels = await pausedVideoScreenPixels(page, FULLSCREEN);
      progress.afterPoint = await presentedVideoPoint(page, FULLSCREEN);
      progress.close = await clickFullscreenClose(page);
      await page.locator(FULLSCREEN).waitFor({ state: "hidden", timeout: 10_000 });
      progress.returned = await waitForVideoHandoffState(page, STAGE, V1, true);
      progress.returnedPixels = await pausedVideoScreenPixels(page, STAGE);
      progress.returnedFrame = gradePausedFrameIdentity(progress.afterPixels, progress.returnedPixels);
      progress.returnedPoint = await presentedVideoPoint(page, STAGE);
      progress.intendedTime = progress.seek.probe?.events.filter((event) => event.type === "seeking"
        && event.trusted && event.at >= progress.seek.probe.startedAt).at(-1)?.time ?? null;
      progress.unexpectedConsoleErrors = session.consoleErrors.filter((message) => !message.includes("403"));
      const near = (left, right) => Number.isFinite(left) && Number.isFinite(right)
        && Math.abs(left - right) <= 0.3;
      record({ name,
        claim: "a real native seek into uncached bytes receives old-URL Range 403 after TTL; fullscreen keeps its last painted frame and Retry uses a new signed URL to restore the requested time, native target, and Close position",
        ...progress, oldRanges: session.renewal.expiredRanges,
        renewalReads: session.renewal.reads, renewalBytes: session.renewal.bytes,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.pause.failed || progress.seek.failed
          || progress.beforePixels.failed || progress.errorFrame.failed
          || progress.retryReadFrame.failed || progress.retryByteFrame.failed
          || progress.afterPixels.failed || progress.returnedFrame.failed
          || !progress.beforePoint.hitIsVideo || !progress.noWaiting
          || !progress.retryClick.hit.hitButton || progress.oldRange.status !== 403
          || !progress.oldRange.range?.startsWith("bytes=")
          || !progress.oldRange.url.includes("storyRenewal=1")
          || progress.oldRange.requestedAt < progress.seek.seekStartedAt
          || progress.oldRange.at < session.renewal.initialRead.expiresAt
          || progress.retryRead.count !== 2 || progress.retryRead.outcome !== "ready"
          || progress.retryBytes.outcome !== "continued"
          || !progress.retryBytes.url.includes("storyRenewal=2")
          || !progress.after.src?.includes("storyRenewal=2")
          || !near(progress.after.time, progress.intendedTime) || !progress.after.paused
          || !progress.afterPoint.hitIsVideo || !progress.afterPoint.controls
          || !near(progress.returned.time, progress.after.time) || !progress.returned.paused
          || !progress.returnedPoint.hitIsVideo || progress.returned.src !== progress.after.src
          || progress.unexpectedConsoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        diagnostic: await videoHandoffFailureDiagnostic(session.page).catch(() => null),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      session.renewal.releaseExpiredRanges();
      session.renewal.releaseRead();
      session.renewal.releaseBytes();
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
