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
      // Chromium's zero-duration touchscreen.tap can omit a compatibility
      // click immediately after a pan. Keep the next gesture immediate, but
      // give this real finger press a short hold before release.
      await send("touchStart", finger(x, y));
      await new Promise((resolve) => setTimeout(resolve, 64));
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
  readDelays = {}, byteDelays = {},
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
  return { page, consoleErrors, pageErrors, mediaDelays };
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
  // Capture the source on the trusted entry/Close click, before React's click
  // handler snapshots and pauses it. Back is captured before the registered
  // surface listener performs the reverse handoff. The 64x64 pixels stay in
  // page memory; each sampled clone records only the comparison and signal.
  const pixels64 = (source) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, 64, 64);
    return context.getImageData(0, 0, 64, 64).data;
  };
  const signalOf = (pixels) => {
    if (!pixels) return 0;
    let nonBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > 24) nonBlack += 1;
    }
    return nonBlack;
  };
  const captureSource = (selector, trigger) => {
    if (!state.running) return;
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      state.handoffSource = { trigger, wallAt: Date.now(), error: "source has no decoded frame" };
      return;
    }
    try {
      const pixels = pixels64(video);
      state.handoffSource = { trigger, wallAt: Date.now(), asset: video.getAttribute("data-shared-media-id"),
        time: video.currentTime, pixels, nonBlack: signalOf(pixels) };
    } catch (error) {
      state.handoffSource = { trigger, wallAt: Date.now(), error: String(error) };
    }
  };
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".journey-story__fullscreen-entry, .journey-story__mobile-media-fullscreen")) {
      captureSource(".journey-story__media", "entry-click");
    } else if (target.closest(".journey-story-fullscreen__close")) {
      captureSource(".journey-story-fullscreen", "close-click");
    }
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
    let total = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      total += Math.abs(pixels[index] - source.pixels[index]);
      total += Math.abs(pixels[index + 1] - source.pixels[index + 1]);
      total += Math.abs(pixels[index + 2] - source.pixels[index + 2]);
    }
    const meanDelta = total / (64 * 64 * 3);
    return { trigger: source.trigger, sourceTime: source.time, nonBlack,
      sourceNonBlack: source.nonBlack, meanDelta: Number(meanDelta.toFixed(2)),
      failed: source.nonBlack < 8 || nonBlack < 8 || meanDelta > 8 };
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
    await page.waitForTimeout(120);
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
    await page.waitForTimeout(100);
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
    await page.waitForTimeout(12);
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
      || after.time > before.duration * (targetFraction < 0.6 ? targetFraction + 0.12 : 0.95),
  };
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
  const pointer = input(page);
  await pointer.down(geometry.x, geometry.y);
  for (let step = 1; step <= 10; step += 1) {
    await pointer.move(geometry.x + travel * (step / 10), geometry.y);
    await page.waitForTimeout(12);
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
      await page.waitForTimeout(12);
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
  // Past the 8px axis lock so the grab really fires, far short of the commit
  // threshold and slow enough that release velocity cannot commit either.
  for (let step = 1; step <= 4; step += 1) {
    await pointer.move(geometry.x - step * 5, geometry.y);
    await page.waitForTimeout(40);
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
  const activation = before !== "true" ? await clickHandoffButton(page, selector) : null;
  const after = await waitForVideoHandoffState(page, STAGE, V1, false);
  return { before, after, activation, pressed: await button.getAttribute("aria-pressed") };
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

/** Prove that the paused frame in the screenshot is the decoded video frame. */
async function pausedVideoScreenPixels(page, rootSelector) {
  const screenshot = (await page.screenshot()).toString("base64");
  return await page.evaluate(async ({ selector, png }) => {
    const video = document.querySelector(selector)?.querySelector(".story-media-pages__video video");
    if (!(video instanceof HTMLVideoElement) || !video.paused || video.readyState < 2) {
      return { failed: true, reason: "no paused decoded video" };
    }
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const screen = document.createElement("canvas");
    screen.width = image.naturalWidth; screen.height = image.naturalHeight;
    const screenContext = screen.getContext("2d", { willReadFrequently: true });
    const source = document.createElement("canvas");
    source.width = video.videoWidth; source.height = video.videoHeight;
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    if (!screenContext || !sourceContext) return { failed: true, reason: "canvas context unavailable" };
    screenContext.drawImage(image, 0, 0);
    sourceContext.drawImage(video, 0, 0);
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    const left = box.left + (box.width - width) / 2, top = box.top + (box.height - height) / 2;
    const samples = [];
    for (const fy of [0.3, 0.45, 0.6]) for (const fx of [0.3, 0.5, 0.7]) {
      const x = left + width * fx, y = top + height * fy;
      const hit = document.elementFromPoint(x, y);
      const sx = Math.round(x * image.naturalWidth / innerWidth);
      const sy = Math.round(y * image.naturalHeight / innerHeight);
      const px = Math.round(video.videoWidth * fx), py = Math.round(video.videoHeight * fy);
      const visible = [...screenContext.getImageData(sx, sy, 1, 1).data].slice(0, 3);
      const decoded = [...sourceContext.getImageData(px, py, 1, 1).data].slice(0, 3);
      const delta = visible.reduce((sum, channel, index) => sum + Math.abs(channel - decoded[index]), 0) / 3;
      samples.push({ fx, fy, hitIsVideo: hit === video, visible, decoded, delta: Number(delta.toFixed(1)) });
    }
    const meanDelta = samples.reduce((sum, sample) => sum + sample.delta, 0) / samples.length;
    return { meanDelta: Number(meanDelta.toFixed(1)), samples,
      failed: samples.some((sample) => !sample.hitIsVideo) || meanDelta > 18 };
  }, { selector: rootSelector, png: screenshot });
}

function gradePausedFrameIdentity(before, after) {
  if (before.samples?.length !== 9 || after.samples?.length !== 9) {
    return { failed: true, reason: "missing nine-point decoded frame samples" };
  }
  const pairs = before.samples.map((sample, index) => ({
    at: [sample.fx, sample.fy],
    delta: sample.decoded.reduce((sum, channel, component) =>
      sum + Math.abs(channel - after.samples[index].decoded[component]), 0) / 3,
  }));
  const meanDelta = pairs.length
    ? pairs.reduce((sum, pair) => sum + pair.delta, 0) / pairs.length : null;
  return { meanDelta, pairs, failed: pairs.length !== 9 || meanDelta > 12 };
}

/** Screenshot pixels over the moving clone must match its decoded canvas. */
async function activeCloneScreenPixels(page, assetId) {
  await page.waitForFunction((expected) => {
    const clones = [...document.querySelectorAll('[data-shared-element-clone]')];
    if (clones.length !== 1 || clones[0].getAttribute('data-shared-element-clone') !== `story-fullscreen-${expected}`) return false;
    const animation = clones[0].getAnimations().find((entry) => entry.effect?.target === clones[0]);
    const duration = animation?.effect?.getTiming().duration;
    const progress = typeof duration === 'number' && duration > 0 && typeof animation.currentTime === 'number'
      ? animation.currentTime / duration : 0;
    return progress >= 0.25 && progress <= 0.65;
  }, assetId, { polling: "raf", timeout: 9_000 });
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
  return await page.evaluate(async ({ expected, screenshot }) => {
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
    screen.width = image.naturalWidth; screen.height = image.naturalHeight;
    const screenContext = screen.getContext("2d", { willReadFrequently: true });
    const frame = document.createElement("canvas");
    frame.width = 64; frame.height = 64;
    const frameContext = frame.getContext("2d", { willReadFrequently: true });
    if (!screenContext || !frameContext) return { failed: true, reason: "canvas context unavailable" };
    screenContext.drawImage(image, 0, 0);
    frameContext.drawImage(clone, 0, 0, 64, 64);
    const pixels = frameContext.getImageData(0, 0, 64, 64).data;
    const bright = [];
    for (let y = 4; y < 64; y += 7) for (let x = 4; x < 64; x += 7) {
      const at = (y * 64 + x) * 4;
      const strength = Math.max(pixels[at], pixels[at + 1], pixels[at + 2]);
      if (strength > 24) bright.push({ x, y, strength });
    }
    bright.sort((left, right) => right.strength - left.strength);
    const points = bright.slice(0, 12);
    if (points.length < 4 || !probe.boxes.length) {
      return { failed: true, reason: "clone has too little visible image signal or no geometry samples",
        brightCells: bright.length, boxes: probe.boxes.length };
    }
    const candidate = (box) => {
      const samples = points.map(({ x, y, strength }) => {
        const sx = Math.round((box.x + box.width * (x + 0.5) / 64) * image.naturalWidth / innerWidth);
        const sy = Math.round((box.y + box.height * (y + 0.5) / 64) * image.naturalHeight / innerHeight);
        if (sx < 0 || sy < 0 || sx >= image.naturalWidth || sy >= image.naturalHeight) {
          return { x, y, strength, offscreen: true, delta: 255 };
        }
        const visible = screenContext.getImageData(sx, sy, 1, 1).data;
        const offset = (y * 64 + x) * 4;
        const expectedRgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
        const delta = expectedRgb.reduce((sum, channel, index) => sum + Math.abs(channel - visible[index]), 0) / 3;
        return { x, y, strength, expectedRgb, visibleRgb: [...visible].slice(0, 3),
          delta: Number(delta.toFixed(1)) };
      });
      return { box, samples, meanDelta: samples.reduce((sum, sample) => sum + sample.delta, 0) / samples.length };
    };
    const matching = probe.boxes.map(candidate).sort((left, right) => left.meanDelta - right.meanDelta)[0];
    return { candidateBoxes: probe.boxes.length, brightCells: bright.length,
      meanDelta: Number(matching.meanDelta.toFixed(1)), bestBox: matching.box,
      samples: matching.samples,
      failed: matching.samples.some((sample) => sample.offscreen) || matching.meanDelta > 22 };
  }, { expected: assetId, screenshot: png });
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
        return requested === expected
          && current?.getAttribute("data-media-page-id") === owner
          && current?.getAttribute("data-media-page-ready") === "true"
          ? { requested, heldBy: current.getAttribute("data-media-page-id") }
          : null;
      }, { selector: STAGE, expected: V2, owner: V1 }, { polling: "raf", timeout: 2_000 })
        .then((handle) => handle.jsonValue(), () => null);
      await page.keyboard.press("ArrowLeft");
      await waitForSettledAsset(page, V1);
      const afterReversal = await currentAsset(page);
      // Outlive the held read, then look again: this window exists to catch a
      // late completion, so it has to still be recording when the read lands.
      const lateWindow = [];
      for (let tick = 0; tick < 6; tick += 1) {
        await page.waitForTimeout(500);
        lateWindow.push({ at: (tick + 1) * 500, ...await currentAsset(page) });
      }
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
        claim: "an arrow-key step really does leave a request for a cold neighbour pending while the readable previous page still owns the stage, the opposite key cancels that request and keeps the visible page, and the read URL that resolves afterwards neither moves the committed owner at any point across the window nor leaves the aperture uncovered",
        abandonedIntent: V2, expectedOwner: V1,
        readDelays: { [V2]: 2_500 }, stageRole, pending, lateWindow,
        afterReversal, afterLateRead, transports, ...continuity,
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: continuity.failed
          || !stageRole.focused || !pending
          || lateWindow.some((sample) => sample.id !== V1)
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
        sampledFrames: frames.length,
        concurrentLiveVideos: frames.filter((frame) => frame.videoCount > 1).slice(0, 2),
        failed: settled.presentation !== "settled" || !settled.ready
          || settled.id !== latestIntent
          || orderedNeighbors[0] !== abandonedIntent || orderedNeighbors[1] !== latestIntent
          || transports !== 1 || stable.first !== stable.second
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
      await page.waitForTimeout(700);
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
      await page.waitForFunction(() => Boolean(document.querySelector(
        '[data-shared-element-clone^="story-fullscreen-"]')),
      undefined, { polling: "raf", timeout: 3_000 });
      progress.entryCloneObserved = true;
      await page.evaluate(() => {
        window.addEventListener("resize", () => {
          window.__qaResizeDuringVideoMorph = Boolean(document.querySelector(
            '[data-shared-element-clone^="story-fullscreen-"]'));
        }, { once: true });
      });
      await page.setViewportSize({ width: 800, height: 1280 });
      progress.resizeDuringMorph = await page.evaluate(() => ({
        cloneAtResize: window.__qaResizeDuringVideoMorph === true,
        width: innerWidth, height: innerHeight,
      }));
      await page.locator(FULLSCREEN).waitFor({ state: "visible", timeout: 10_000 });
      await waitForVideoHandoffState(page, FULLSCREEN, V1, true);
      await page.locator('[data-shared-element-clone^="story-fullscreen-"]')
        .waitFor({ state: "detached", timeout: 5_000 });
      progress.entry = gradeVideoFullscreenFrames(await stopSamplerFrames(page), V1);
      progress.fullscreen = await videoHandoffState(page, FULLSCREEN);
      progress.fullscreenPixels = await pausedVideoScreenPixels(page, FULLSCREEN);

      await startSampler(page, [STAGE, FULLSCREEN]);
      await page.locator(`${FULLSCREEN} .journey-story-fullscreen__close`).click();
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
        claim: "a real 43% native seek and paused desktop video retain asset, time, intent and visible decoded pixels through fullscreen entry interrupted by resize and real Close; the canvas clone alone paints during either morph and the returned video receives a real click",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || !progress.resizeDuringMorph.cloneAtResize
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
      progress.seek = await seekNativeTimeline(page, STAGE, { targetFraction: 0.43 });
      progress.pause = await pauseNativeVideoIfNeeded(page, STAGE);
      progress.play = await startStoryVideoPlayback(page, true);
      progress.inlineBefore = await videoHandoffState(page, STAGE);
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
          : "a real 43% native seek retains the same playing video, native settings and clock through mobile fullscreen and Browser Back; clone pixels match the composited picture and the returned transport receives a real touch",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
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
  // the already readable asset. Observe recovery before the held bytes arrive.
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
      progress.play = await startStoryVideoPlayback(page, true);
      progress.before = await videoHandoffState(page, STAGE);
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
        progress.timeoutClock = gradeVideoClock(progress.before, state, false, { requireIntent: false });
        progress.playback = await samplePlayback(page, activeRoot, { samples: 2, everyMs: 180 });
        progress.assetAfterActivation = await currentAsset(page, activeRoot);
      }
      const deadline = Date.now() + 2_000;
      while (progress.delayedRequest?.releasedAt === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      progress.afterLateRelease = await page.evaluate(async ({ inline, fullscreen }) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const sourceRoot = document.querySelector(inline);
        const fullRoot = document.querySelector(fullscreen);
        return {
          sourceSrc: sourceRoot?.querySelector(".story-media-pages__video video")?.getAttribute("src") ?? null,
          sourceId: sourceRoot?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id") ?? null,
          fullscreenVisible: Boolean(fullRoot && !fullRoot.hidden && getComputedStyle(fullRoot).display !== "none"),
          errorCount: document.querySelectorAll(".journey-story__media-state.is-error").length,
        };
      }, { inline: STAGE, fullscreen: FULLSCREEN });
      record({ name,
        claim: "when the hidden destination remains undecoded past eight seconds, the original V1 read URL and current page survive without an error state; the viewer returns to the source or gets a genuinely usable Play target before delayed bytes are released",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !progress.toVideo.ok || progress.seek.failed || progress.pause.failed
          || progress.play.pressed !== "true" || progress.delayedTarget.failed || !progress.clickedAt
          || progress.recoveredAt - progress.clickedAt < 8_000
          || !progress.delayedRequest || progress.delayedRequest.releasedAt <= progress.recoveredAt
          || !progress.resource.targetReadProbe
          || (progress.resource.targetReadProbe.readyAt !== null
            && progress.resource.targetReadProbe?.readyAt <= progress.clickedAt + 8_000)
          || progress.continuity.failed || progress.resource.cloneCount !== 0
          || progress.resource.sourceId !== V1 || !progress.resource.sourcePageReady
          || !progress.resource.sourceSrc?.endsWith(CLIP)
          || progress.resource.errorText.length > 0
          || !progress.activePoint.hitIsVideo || !progress.resource.activeReady
          || !progress.resource.activeControls
          || progress.afterActivation?.paused !== false
          || progress.timeoutClock?.failed !== false
          || !progress.playback?.advanced || !progress.playback?.monotonic
          || progress.assetAfterActivation?.id !== V1
          || progress.afterLateRelease.sourceId !== V1
          || progress.afterLateRelease.sourceSrc !== progress.resource.sourceSrc
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
