import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const captureMotion = process.env.CI === "true" && process.env.QA_CAPTURE_MEDIA_MOTION === "1";
const motionArtifactDir = "artifacts/media-motion";
const motionPhotos = ["/artworks/hokusai-wave.jpg", "/artworks/monet-water-lilies.jpg", "/artworks/stieglitz-hand-of-man.jpg"];
// Use a checked-in, decodable clip so StoryMediaPages and PlaybackMediaStage
// exercise their real metadata/first-frame gates. `instrumentMedia` below
// only makes play/pause deterministic; it does not fake readyState or frames.
const tinyVideo = "/demo-media/east-star-orbit.webm";

// Story media is rendered as three physical page slots. Images live inside a
// page slot; the single persistent video root lives beside those slots and
// carries data-shared-media-id only while it is the current asset. Keep these
// selectors descendant-based because the page rail may be nested in the
// presentation stage, and never use the old incoming/fade implementation as
// a readiness signal.
const storyMediaPagesSelector = "[data-story-media-pages]";
const storyPageSelector = (page) => `${storyMediaPagesSelector} [data-media-page="${page}"]`;
const storyReadyPageSelector = (page) => `${storyPageSelector(page)}[data-media-page-ready="true"]`;
const storyCurrentPageSelector = storyReadyPageSelector("current");
const storyCurrentImageSelector = `${storyCurrentPageSelector} [data-shared-media-id]`;
const storyCurrentVideoSelector = `${storyMediaPagesSelector} video[data-shared-media-id]`;
const storyPersistentVideoSelector = `${storyMediaPagesSelector} .story-media-pages__video video`;
const storyCurrentMediaSelector = `${storyCurrentImageSelector}, ${storyCurrentVideoSelector}`;
const storyFixedPageNames = ["previous", "current", "next"];

const browser = await launchQaBrowser();

// Desktop navigation uses the stationary hit surface, even while the painted
// photo is moving. Its contained picture halves exclude letterboxes and native
// video controls. Real mouse input also exercises Story's gesture ownership.
function storyPicture(page, surfaceSelector = ".journey-story__media") {
  return page.locator(`${surfaceSelector}:visible`)
    .locator('img[data-shared-media-id]:visible, video[data-shared-media-id]:visible');
}

async function storyPicturePoint(page, direction, surfaceSelector = ".journey-story__media") {
  const picture = storyPicture(page, surfaceSelector);
  await picture.waitFor({ state: "visible" });
  // A stable photo target is still carried by the Story's entrance/layout
  // animation. Wait for that outer motion only; photo children keep moving
  // during rapid-click checks and must remain immediately interruptible.
  await page.waitForFunction((selector) => {
    let node = document.querySelector(selector)?.querySelector("[data-story-hit-surface]");
    if (!node) return false;
    while (node) {
      if (node.getAnimations().some((animation) => animation.pending || animation.playState === "running")) return false;
      node = node.parentElement;
    }
    return true;
  }, surfaceSelector, { polling: "raf", timeout: 3_000 });
  return picture.evaluate((media, step) => {
    const root = media.closest("[data-story-media-pages]");
    const surface = root?.querySelector("[data-story-hit-surface]");
    if (root?.getAttribute("data-click-navigation") === "true" && !surface) {
      throw new Error("Desktop Story has no stable click surface");
    }
    const bounds = (surface ?? media).getBoundingClientRect();
    const naturalWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const naturalHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!naturalWidth || !naturalHeight || !bounds.width || !bounds.height) {
      throw new Error("Story navigation requires a decoded picture with non-zero bounds");
    }
    const scale = Math.min(bounds.width / naturalWidth, bounds.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    const x = bounds.left + (bounds.width - width) / 2 + width * (step < 0 ? .25 : .75);
    const y = bounds.top + (bounds.height - height) / 2 + height * (media instanceof HTMLVideoElement ? .3 : .5);
    if (media instanceof HTMLVideoElement && media.controls
      && y >= bounds.bottom - Math.min(72, bounds.height * .25)) {
      throw new Error("Story video navigation point overlaps native controls");
    }
    const hit = document.elementFromPoint(x, y);
    if (surface && (hit !== surface || getComputedStyle(surface).transform !== "none")) {
      throw new Error(`Stable Story hit surface is blocked or transformed: ${JSON.stringify({
        hit: hit?.className, surface: surface.className, transform: getComputedStyle(surface).transform, x, y,
      })}`);
    }
    const describe = (node) => node instanceof Element ? {
      tag: node.tagName, asset: node.getAttribute("data-shared-media-id"),
      pageId: node.closest("[data-media-page]")?.getAttribute("data-media-page-id"),
      pageRole: node.closest("[data-media-page]")?.getAttribute("data-media-page"),
      transform: getComputedStyle(node.closest("[data-media-page]") ?? node).transform,
      zIndex: getComputedStyle(node.closest("[data-media-page]") ?? node).zIndex,
      bounds: node.getBoundingClientRect().toJSON(),
    } : null;
    return { x, y, expected: describe(media), hit: describe(hit),
      stableBounds: surface ? bounds.toJSON() : null };
  }, direction);
}

async function clickStoryPicture(page, direction, surfaceSelector = ".journey-story__media", fixedPoint = null) {
  const point = fixedPoint ?? await storyPicturePoint(page, direction, surfaceSelector);
  await page.evaluate(({ point, direction, surfaceSelector }) => {
    if (point.stableBounds) {
      const surface = document.querySelector(surfaceSelector)?.querySelector("[data-story-hit-surface]");
      const bounds = surface?.getBoundingClientRect();
      if (!bounds || document.elementFromPoint(point.x, point.y) !== surface
        || ["x", "y", "width", "height"].some((key) => Math.abs(bounds[key] - point.stableBounds[key]) > .5)) {
        throw new Error(`Story click geometry moved or lost its actual hit target: ${JSON.stringify({
          before: point.stableBounds, now: bounds?.toJSON(), x: point.x, y: point.y,
        })}`);
      }
    }
    window.__qaStoryLastPictureClick = { point, direction, events: [] };
    if (window.__qaStoryPictureTraceInstalled) return;
    window.__qaStoryPictureTraceInstalled = true;
    for (const type of ["pointerdown", "pointerup", "click"]) {
      document.addEventListener(type, (event) => {
        const trace = window.__qaStoryLastPictureClick;
        const target = event.target;
        if (!trace || !(target instanceof Element)) return;
        trace.events.push({ type, tag: target.tagName, class: target.className,
          asset: target.getAttribute("data-shared-media-id"),
          pageId: target.closest("[data-media-page]")?.getAttribute("data-media-page-id"),
          x: event.clientX, y: event.clientY });
      }, true);
    }
  }, { point, direction, surfaceSelector });
  await page.mouse.click(point.x, point.y);
}

async function clickStoryNativeControlStrip(page, surfaceSelector) {
  const video = page.locator(surfaceSelector).locator("video[data-shared-media-id]");
  const before = await video.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    // Chromium's lower-left native play/pause region, outside the clipped
    // navigation surface. Do not activate a React handler or DOM .click().
    const point = { x: bounds.left + 28, y: bounds.bottom - 24 };
    window.__qaNativeControlVideo = element;
    window.__qaNativeControlEvents = [];
    element.addEventListener("pointerdown", (event) => {
      window.__qaNativeControlEvents.push({ type: event.type, trusted: event.isTrusted });
    }, { once: true });
    return { point, id: element.getAttribute("data-shared-media-id"), controls: element.controls,
      fullscreen: Boolean(element.closest(".journey-story-fullscreen")),
      actualHitIsVideo: document.elementFromPoint(point.x, point.y) === element };
  });
  if (!before.controls || !before.actualHitIsVideo) {
    throw new Error(`Native video control strip is covered: ${JSON.stringify(before)}`);
  }
  await page.mouse.click(before.point.x, before.point.y);
  const after = await page.evaluate(async (selector) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const root = document.querySelector(selector);
    const pages = root?.querySelector("[data-story-media-pages]");
    const video = root?.querySelector("video[data-shared-media-id]");
    const fullscreen = document.querySelector(".journey-story-fullscreen");
    return { id: video?.getAttribute("data-shared-media-id"), sameNode: video === window.__qaNativeControlVideo,
      presentation: pages?.getAttribute("data-media-presentation"), connected: Boolean(root?.isConnected),
      fullscreen: Boolean(fullscreen && !fullscreen.hidden && fullscreen.getBoundingClientRect().width),
      events: window.__qaNativeControlEvents };
  }, surfaceSelector);
  // Native shadow controls may intentionally contain their pointer events;
  // actual hit-testing plus Playwright mouse input establishes the input path.
  return { before, after, failed: !after.connected || !after.sameNode || after.id !== before.id
    || after.presentation !== "settled" || after.fullscreen !== before.fullscreen };
}

async function exerciseStoryEdgeRegrab(page) {
  const point = await storyPicturePoint(page, -1);
  const current = page.locator(`.journey-story__media ${storyCurrentPageSelector}`);
  const rest = await current.evaluate((element) => element.getBoundingClientRect().toJSON());
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  let pulled;
  try {
    await page.mouse.move(point.x + 120, point.y, { steps: 6 });
    pulled = await current.evaluate((element) => element.getBoundingClientRect().toJSON());
  } finally {
    await page.mouse.up();
  }
  // Start with real mouse input. Re-grab in the same rendering task as both
  // geometry reads, so a RAF between RPC calls cannot conceal a reset to rest.
  const regrab = await page.evaluate(({ point, rest, pulled }) => new Promise((resolve, reject) => {
    const started = performance.now();
    const root = document.querySelector(".journey-story__media [data-story-media-pages]");
    const surface = root?.querySelector("[data-story-hit-surface]");
    const current = root?.querySelector('[data-media-page="current"]');
    if (!surface || !current || pulled.x - rest.x <= 3) {
      reject(new Error(`Boundary mouse drag did not visibly displace its photo: ${JSON.stringify({ rest, pulled })}`));
      return;
    }
    const inspect = () => {
      const before = current.getBoundingClientRect().toJSON();
      const displacement = before.x - rest.x;
      if (displacement > 3 && displacement < (pulled.x - rest.x) * .85) {
        const pointer = { pointerId: 991, pointerType: "mouse", isPrimary: true,
          clientX: point.x, clientY: point.y, button: 0, buttons: 1,
          bubbles: true, cancelable: true, composed: true };
        surface.dispatchEvent(new PointerEvent("pointerdown", pointer));
        const after = current.getBoundingClientRect().toJSON();
        resolve({ pointer, before, after, displacement,
          jump: Math.max(...["x", "y", "width", "height"].map((key) => Math.abs(after[key] - before[key]))) });
        return;
      }
      if (performance.now() - started >= 3_000) {
        reject(new Error(`No intermediate boundary spring pixels to re-grab: ${JSON.stringify({ rest, pulled, before })}`));
        return;
      }
      requestAnimationFrame(inspect);
    };
    requestAnimationFrame(inspect);
  }), { point, rest, pulled });
  let continuation;
  try {
    if (captureMotion) await page.screenshot({ path: `${motionArtifactDir}/story-stack-regrab-held.png`, animations: "allow" });
    continuation = await page.evaluate((pointer) => {
      const root = document.querySelector(".journey-story__media [data-story-media-pages]");
      const surface = root.querySelector("[data-story-hit-surface]");
      const current = root.querySelector('[data-media-page="current"]');
      const before = current.getBoundingClientRect().toJSON();
      surface.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX: pointer.clientX + 48 }));
      const after = current.getBoundingClientRect().toJSON();
      return { before, after, followedPointer: after.x - before.x > 2 };
    }, regrab.pointer);
  } finally {
    await page.evaluate((pointer) => document.querySelector(".journey-story__media [data-story-hit-surface]")
      ?.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: pointer.clientX + 48, buttons: 0 })), regrab.pointer);
  }
  await page.waitForFunction((rest) => {
    const root = document.querySelector(".journey-story__media [data-story-media-pages]");
    const current = root?.querySelector('[data-media-page="current"]');
    if (!current || current.getAttribute("data-media-page-id") !== "00000000-0000-4000-8000-000000000100") return false;
    const bounds = current.getBoundingClientRect();
    const atRest = ["x", "y", "width", "height"].every((key) => Math.abs(bounds[key] - rest[key]) <= .5);
    window.__qaEdgeRegrabRestFrames = atRest ? (window.__qaEdgeRegrabRestFrames ?? 0) + 1 : 0;
    return window.__qaEdgeRegrabRestFrames >= 3 && root.getAttribute("data-media-presentation") === "settled";
  }, rest, { polling: "raf", timeout: 3_000 });
  await waitForStoryPicture(page, "00000000-0000-4000-8000-000000000100");
  const nodes = await page.evaluate(() => {
    const root = document.querySelector(".journey-story__media [data-story-media-pages]");
    const pages = [...root.querySelectorAll("[data-media-page]")];
    return { count: pages.length, sameNodes: pages.every((node, index) => node === window.__qaStoryMediaPageNodes[index]),
      asset: root.querySelector("[data-shared-media-id]")?.getAttribute("data-shared-media-id") };
  });
  const heldDrift = Math.max(...["x", "y", "width", "height"].map((key) => Math.abs(continuation.before[key] - regrab.after[key])));
  return { rest, pulled, regrab, continuation, heldDrift, nodes, failed: regrab.jump > .5 || heldDrift > .5 || !continuation.followedPointer
    || nodes.count !== 3 || !nodes.sameNodes || nodes.asset !== "00000000-0000-4000-8000-000000000100" };
}

async function waitForStoryPicture(page, assetId, surfaceSelector = ".journey-story__media") {
  await page.waitForFunction(({ surfaceSelector, assetId }) => {
    const root = document.querySelector(surfaceSelector)?.querySelector("[data-story-media-pages]");
    const current = root?.querySelector('[data-media-page="current"]');
    const media = root?.querySelector("[data-shared-media-id]");
    return root?.getAttribute("data-media-presentation") === "settled"
      && current?.getAttribute("data-media-page-id") === assetId
      && current?.getAttribute("data-media-page-ready") === "true"
      && media?.getAttribute("data-shared-media-id") === assetId
      && (media instanceof HTMLImageElement ? media.complete && media.naturalWidth > 0
        : media instanceof HTMLVideoElement && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
  }, { surfaceSelector, assetId }, { polling: "raf", timeout: 3_000 }).catch(async (error) => {
    const state = await page.evaluate((selector) => {
      const root = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
      return { presentation: root?.getAttribute("data-media-presentation"),
        pages: [...root?.querySelectorAll("[data-media-page]") ?? []].map((node) => ({
          id: node.getAttribute("data-media-page-id"), role: node.getAttribute("data-media-page"),
          ready: node.getAttribute("data-media-page-ready"), incoming: node.getAttribute("data-media-incoming"),
        })), lastClick: window.__qaStoryLastPictureClick };
    }, surfaceSelector);
    throw new Error(`Story picture ${assetId} did not settle: ${JSON.stringify(state)}`, { cause: error });
  });
}

function overlapPairs(items) {
  const pairs = [];
  for (let index = 0; index < items.length; index += 1) {
    for (let other = index + 1; other < items.length; other += 1) {
      const a = items[index];
      const b = items[other];
      const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      if (overlapX > 2 && overlapY > 2) {
        pairs.push({ a: a.name, b: b.name, area: Math.round(overlapX * overlapY) });
      }
    }
  }
  return pairs;
}

async function scanButtons(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return { items: [], viewport: [innerWidth, innerHeight], overflowX: 0 };
    const items = [...root.querySelectorAll("button")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0.05
          && style.pointerEvents !== "none"
          && bounds.width > 1
          && bounds.height > 1;
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          name: (element.getAttribute("aria-label") || element.textContent || "button")
            .trim().replace(/\s+/g, " ").slice(0, 80),
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
        };
      });
    return {
      items,
      viewport: [innerWidth, innerHeight],
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, rootSelector);
}

async function createQaPage(path, mediaUrl, {
  instrumentMedia = false,
  mixedMedia = false,
  mobile = true,
  readDelayMs = 0,
  blockedReadAssetId = null,
  videoTimeline = null,
  videoMediaUrl = null,
  videoAssetId = null,
  reducedMotion = "reduce",
  recordMotion = false,
  rotateReadUrls = false,
  viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
} = {}) {
  const page = await browser.newPage({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    reducedMotion,
    ...(captureMotion && recordMotion ? { recordVideo: { dir: `${motionArtifactDir}/raw`, size: viewport } } : {}),
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // #195 Phase 2. The trim transport is ~245 lines of event handling on a real
  // <video>, and no assertion executed it: the trim needs deterministic timing
  // while still loading a real, decodable source for the first-frame gate. This
  // keeps native metadata/frame readiness, React handlers and the director,
  // while making duration/currentTime/play/pause deterministic. It deliberately
  // never dispatches `ended`, so a beat can only finish at the out-point.
  if (videoTimeline) {
    await page.addInitScript(({ sourceDurationSeconds, tickMs, tickSeconds }) => {
      const media = new WeakMap();
      const trace = { samples: [], seeks: [], endedEvents: 0, playCalls: 0 };
      window.__qaVideoTimeline = trace;
      const overlayState = () => {
        const overlay = document.querySelector(".journey-playback");
        return {
          step: overlay ? Number(overlay.getAttribute("data-playback-step")) : null,
          trim: overlay ? overlay.getAttribute("data-video-trim") : null,
        };
      };
      const sample = (element, reason) => {
        const entry = media.get(element);
        if (!entry) return;
        trace.samples.push({
          reason,
          at: Math.round(performance.now()),
          time: Number(entry.time.toFixed(3)),
          playing: entry.playing,
          ...overlayState(),
        });
      };
      const stop = (element) => {
        const entry = media.get(element);
        if (!entry || entry.timer === null) return;
        clearInterval(entry.timer);
        entry.timer = null;
      };
      const ensureEntry = (element) => {
        const entry = media.get(element)
          ?? { time: 0, playing: false, metadata: false, timer: null, src: null };
        entry.src = element.currentSrc || element.getAttribute("src") || null;
        media.set(element, entry);
        return entry;
      };
      const define = (name, descriptor) => {
        Object.defineProperty(HTMLMediaElement.prototype, name, {
          configurable: true,
          ...descriptor,
        });
      };
      define("duration", {
        get() {
          return media.get(this)?.metadata ? sourceDurationSeconds : Number.NaN;
        },
      });
      define("paused", {
        get() {
          return media.get(this)?.playing !== true;
        },
      });
      define("currentTime", {
        get() {
          return media.get(this)?.time ?? 0;
        },
        set(value) {
          const entry = ensureEntry(this);
          entry.time = Math.max(0, Math.min(sourceDurationSeconds, Number(value)));
          trace.seeks.push({ to: Number(entry.time.toFixed(3)), ...overlayState() });
          sample(this, "seek");
          // A real seek settles asynchronously.
          setTimeout(() => {
            this.dispatchEvent(new Event("seeked"));
            sample(this, "seeked");
          }, 0);
        },
      });
      document.addEventListener("loadedmetadata", (event) => {
        const element = event.target;
        if (!(element instanceof HTMLMediaElement)) return;
        const entry = ensureEntry(element);
        entry.metadata = true;
        sample(element, "loadedmetadata");
      }, true);
      HTMLMediaElement.prototype.play = function qaPlay() {
        const entry = ensureEntry(this);
        trace.playCalls += 1;
        if (entry.playing) return Promise.resolve();
        entry.playing = true;
        sample(this, "play");
        this.dispatchEvent(new Event("playing"));
        entry.timer = setInterval(() => {
          if (!this.isConnected) {
            stop(this);
            return;
          }
          if (!entry.playing) return;
          entry.time = Math.min(sourceDurationSeconds, entry.time + tickSeconds);
          this.dispatchEvent(new Event("timeupdate"));
          sample(this, "timeupdate");
        }, tickMs);
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function qaPause() {
        const entry = media.get(this);
        if (!entry || !entry.playing) return;
        entry.playing = false;
        stop(this);
        sample(this, "pause");
      };
      document.addEventListener("ended", () => { trace.endedEvents += 1; }, true);
    }, videoTimeline);
  }
  if (instrumentMedia) {
    await page.addInitScript(() => {
      const state = new WeakMap();
      Object.defineProperty(HTMLMediaElement.prototype, "paused", {
        configurable: true,
        get() {
          return state.get(this) !== "playing";
        },
      });
      window.__qaMediaPlayEvents = [];
      const mediaElementIds = new WeakMap();
      let nextMediaElementId = 1;
      HTMLMediaElement.prototype.play = function play() {
        state.set(this, "playing");
        if (!mediaElementIds.has(this)) mediaElementIds.set(this, nextMediaElementId++);
        window.__qaMediaPlayEvents.push({
          tagName: this.tagName,
          elementId: mediaElementIds.get(this),
          userActivation: navigator.userActivation?.isActive ?? null,
        });
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function pause() {
        state.set(this, "paused");
      };
    });
  }
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  let releaseBlockedRead = () => undefined;
  const blockedRead = blockedReadAssetId
    ? new Promise((resolve) => { releaseBlockedRead = resolve; })
    : null;
  const readRequests = new Map();
  await page.route("**/api/uploads/assets/*/read-url", async (route) => {
    const assetId = route.request().url().match(/assets\/([^/]+)\/read-url/)?.[1];
    const readCount = (readRequests.get(assetId) ?? 0) + 1;
    readRequests.set(assetId, readCount);
    const photoUrl = typeof mediaUrl === "function" ? mediaUrl(route.request().url()) : mediaUrl;
    if (blockedRead && route.request().url().includes(blockedReadAssetId)) await blockedRead;
    if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: mixedMedia && route.request().url().includes("00000000-0000-4000-8000-000000000152")
          ? tinyVideo
          : videoMediaUrl && videoAssetId && route.request().url().includes(videoAssetId)
            ? videoMediaUrl
            : rotateReadUrls ? `${photoUrl}?qaRead=${readCount}` : photoUrl,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
    });
  });
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  return { page, consoleErrors, pageErrors, releaseBlockedRead, readRequests };
}

const checks = [];
let failed = false;

function record(name, scan, extra = {}) {
  const pairs = overlapPairs(scan.items);
  const result = { name, overlaps: pairs, overflowX: scan.overflowX, ...extra };
  checks.push(result);
  if (pairs.length > 0 || scan.overflowX > 0 || extra.failed) failed = true;
}

try {
  const story = await createQaPage("/?qaState=journey-story", onePixelGif);
  try {
    await story.page.locator(".journey-story").waitFor({ state: "visible" });
    record("story-media", await scanButtons(story.page, ".journey-story"));

    const mediaStage = story.page.locator(".journey-story__media");
    const touch = await story.page.context().newCDPSession(story.page);
    const settledMedia = story.page.locator(storyCurrentMediaSelector).first();
    const firstMediaLabel = await settledMedia.getAttribute("alt");
    const desktopOnlyControls = await story.page.locator(
      ".journey-story__media-overview, .journey-story__fullscreen-entry, .journey-story__media-controls, .journey-story__media-actions",
    ).count();
    const stageBox = await mediaStage.boundingBox();
    if (!stageBox) throw new Error("mobile story media stage has no bounds");
    const swipeStartX = stageBox.x + stageBox.width * 0.72;
    const swipeY = stageBox.y + stageBox.height * 0.5;
    await mediaStage.evaluate((stage) => {
      stage.addEventListener("gotpointercapture", (event) => { stage.dataset.qaCapturedPointer = String(event.pointerId); });
      stage.addEventListener("lostpointercapture", (event) => { if (event.target === stage && String(event.pointerId) === stage.dataset.qaCapturedPointer) stage.dataset.qaReleasedPointer = String(event.pointerId); });
    });
    // At the first asset, a large outward drag has no neighbor. It must spring
    // back as overscroll, not be reinterpreted as the image tap that opens
    // fullscreen merely because `commit` is false.
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: swipeStartX, y: swipeY }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: swipeStartX + 80, y: swipeY }],
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await story.page.waitForTimeout(300);
    const inlineEdgeOverscrollOpenedFullscreen = await story.page.locator(".journey-story-fullscreen").isVisible();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: swipeStartX, y: swipeY }],
    });
    // The live-drag gesture computes distance/direction from pointermove,
    // not just down/up coordinates, so a swipe simulation needs an
    // intervening move — a real finger can't teleport between the two.
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: swipeStartX - 30, y: swipeY }],
    });
    const inlineCapturedDuringDrag = await mediaStage.evaluate((stage) => {
      const pointerId = Number(stage.dataset.qaCapturedPointer);
      return Number.isFinite(pointerId) && stage.hasPointerCapture(pointerId);
    });
    // Once horizontal intent owns the pointer, move outside the inline
    // media stage and release there. Capture must keep routing the terminal
    // event back to the stage so the gesture cannot strand its transform.
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: swipeStartX - 30, y: 10 }],
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const inlineReleasedAfterDrag = await mediaStage.evaluate((stage) => Boolean(stage.dataset.qaReleasedPointer));
    // The 30px horizontal move above intentionally crosses the 8px intent
    // lock but stays below the 48px navigation threshold. Because pointer
    // capture retargets the eventual click to the stage, the component must
    // explicitly preserve the image tap and still enter fullscreen.
    let inlineJitterOpenedFullscreen = false;
    const jitterFullscreen = story.page.locator(".journey-story-fullscreen");
    try {
      await jitterFullscreen.waitFor({ state: "visible", timeout: 1_500 });
      inlineJitterOpenedFullscreen = true;
      await story.page.keyboard.press("Escape");
      await jitterFullscreen.waitFor({ state: "hidden", timeout: 1_500 });
    } catch {
      inlineJitterOpenedFullscreen = false;
    }

    // #239: a sub-threshold image drag schedules fullscreen only after the
    // settle window. A newer Route Point scope owns the Story before that
    // deadline and must cancel the deferred entry rather than reopening stale
    // fullscreen over the new scope.
    const scopeTarget = story.page.locator(
      ".journey-story__route-points button[data-route-point-id]",
    ).first();
    let deferredFullscreenCancelledByScopeChange = false;
    if (await scopeTarget.count()) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: swipeStartX, y: swipeY }],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: swipeStartX - 30, y: swipeY }],
      });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await scopeTarget.evaluate((button) => button.click());
      await story.page.waitForTimeout(320);
      deferredFullscreenCancelledByScopeChange = !(await jitterFullscreen.isVisible());
      const wholeJourneyScope = story.page.locator(
        ".journey-story__route-points > button:not([data-route-point-id])",
      ).first();
      await wholeJourneyScope.evaluate((button) => button.click());
      await story.page.waitForFunction(({ selector, expected }) => {
        const media = document.querySelector(selector);
        return media && (media.getAttribute("alt") ?? media.getAttribute("src")) === expected;
      }, { selector: storyCurrentMediaSelector, expected: firstMediaLabel }, { timeout: 3_000 });
    }
    checks.push({
      name: "story-mobile-deferred-fullscreen-cancelled-by-scope-change",
      deferredFullscreenCancelledByScopeChange,
      failed: !deferredFullscreenCancelledByScopeChange,
    });
    if (!deferredFullscreenCancelledByScopeChange) failed = true;

    // Issue #65: a short but fast flick should commit even below the 48px
    // distance threshold, while the 30px jitter above remains a tap. Use real
    // CDP touch timing so velocity comes from browser event timestamps.
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: swipeStartX, y: swipeY }],
    });
    await story.page.waitForTimeout(20);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: swipeStartX - 40, y: swipeY }],
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await story.page.waitForFunction(({ selector, before }) => {
      const media = document.querySelector(selector);
      return media && (media.getAttribute("alt") ?? media.getAttribute("src")) !== before;
    }, { selector: storyCurrentMediaSelector, before: firstMediaLabel }, { timeout: 3_000 });
    const flickedMedia = story.page.locator(storyCurrentMediaSelector).first();
    const flickedMediaLabel = (await flickedMedia.getAttribute("alt")) ?? (await flickedMedia.getAttribute("src"));
    const inlineVelocityFlickNavigated = Boolean(flickedMediaLabel && flickedMediaLabel !== firstMediaLabel);

    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: swipeStartX, y: swipeY }],
    });
    await story.page.waitForTimeout(20);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: swipeStartX + 40, y: swipeY }],
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await story.page.waitForFunction(({ selector, expected }) => {
      const media = document.querySelector(selector);
      return media && (media.getAttribute("alt") ?? media.getAttribute("src")) === expected;
    }, { selector: storyCurrentMediaSelector, expected: firstMediaLabel }, { timeout: 3_000 });
    const inlineVelocityReverseReturned = true;

    await mediaStage.dispatchEvent("pointerdown", {
      pointerId: 11,
      pointerType: "touch",
      isPrimary: true,
      clientX: swipeStartX,
      clientY: swipeY,
      bubbles: true,
    });
    await mediaStage.dispatchEvent("pointermove", {
      pointerId: 11,
      pointerType: "touch",
      isPrimary: true,
      clientX: swipeStartX - 110,
      clientY: swipeY,
      bubbles: true,
    });
    await mediaStage.dispatchEvent("pointerup", {
      pointerId: 11,
      pointerType: "touch",
      isPrimary: true,
      clientX: swipeStartX - 110,
      clientY: swipeY,
      bubbles: true,
    });
    await story.page.waitForFunction(({ selector, before }) => {
      const media = document.querySelector(selector);
      return media && (media.getAttribute("alt") ?? media.getAttribute("src")) !== before;
    }, { selector: storyCurrentMediaSelector, before: firstMediaLabel }, { timeout: 3_000 });
    checks.push({
      name: "story-mobile-swipe-navigation",
      desktopOnlyControls,
      inlineCapturedDuringDrag,
      inlineReleasedAfterDrag,
      inlineEdgeOverscrollOpenedFullscreen,
      inlineJitterOpenedFullscreen,
      inlineVelocityFlickNavigated,
      inlineVelocityReverseReturned,
      failed: desktopOnlyControls !== 0
        || !inlineCapturedDuringDrag
        || !inlineReleasedAfterDrag
        || inlineEdgeOverscrollOpenedFullscreen
        || !inlineJitterOpenedFullscreen
        || !inlineVelocityFlickNavigated
        || !inlineVelocityReverseReturned,
    });
    if (
      desktopOnlyControls !== 0
      || !inlineCapturedDuringDrag
      || !inlineReleasedAfterDrag
      || inlineEdgeOverscrollOpenedFullscreen
      || !inlineJitterOpenedFullscreen
      || !inlineVelocityFlickNavigated
      || !inlineVelocityReverseReturned
    ) failed = true;

    const storyRoot = story.page.locator(".journey-story");
    const storyClose = story.page.getByRole("button", { name: "退出旅程故事" });
    const closeBox = await storyClose.boundingBox();
    const closeVisibleText = (await storyClose.innerText()).trim();
    const closeUsesControlGrid = closeBox !== null
      && Math.min(closeBox.width, closeBox.height) >= 44
      && Math.abs(closeBox.width - closeBox.height) <= 1;
    checks.push({
      name: "story-mobile-close-control-grammar",
      closeVisibleText,
      closeUsesControlGrid,
      failed: closeVisibleText !== "" || !closeUsesControlGrid,
    });
    if (closeVisibleText !== "" || !closeUsesControlGrid) failed = true;

    const manageTrigger = story.page.getByRole("button", { name: "管理旅程" });
    const manageTriggerButton = story.page.locator(".journey-story__mobile-media-menu-trigger");
    const viewerMode = await storyRoot.getAttribute("data-mobile-mode");
    const viewerMutationButtons = await story.page.getByRole("button", {
      name: /添加照片或视频|编辑旅程|删除旅程/,
    }).count();
    const manageTriggerBox = await manageTrigger.boundingBox();
    const manageTouchTarget = manageTriggerBox ? Math.min(manageTriggerBox.width, manageTriggerBox.height) : 0;
    checks.push({
      name: "story-mobile-viewer-manage-separation",
      viewerMode,
      viewerMutationButtons,
      manageTouchTarget,
      failed: viewerMode !== "viewer" || viewerMutationButtons !== 0 || manageTouchTarget < 44,
    });
    if (viewerMode !== "viewer" || viewerMutationButtons !== 0 || manageTouchTarget < 44) failed = true;

    await manageTrigger.click();
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage");
    const manageMutationButtons = await story.page.getByRole("button", { name: /编辑旅程|删除旅程/ }).count();
    const manageDone = story.page.getByRole("button", { name: "完成" });
    await story.page.waitForFunction(() => document.activeElement?.textContent?.includes("完成"));
    const manageFocusTransferred = await manageDone.evaluate((button) => document.activeElement === button);
    const manageDoneVisible = await manageDone.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return rect.top >= 0
        && rect.left >= 0
        && rect.bottom <= window.innerHeight
        && rect.right <= window.innerWidth;
    });
    checks.push({
      name: "story-mobile-manage-mode-reveals-mutations",
      manageMutationButtons,
      hasDone: await manageDone.count() === 1,
      manageFocusTransferred,
      manageDoneVisible,
      failed: manageMutationButtons < 2 || await manageDone.count() !== 1 || !manageFocusTransferred || !manageDoneVisible,
    });
    if (manageMutationButtons < 2 || await manageDone.count() !== 1 || !manageFocusTransferred || !manageDoneVisible) failed = true;

    const journeyDeleteButton = story.page.locator(".journey-story__manage .is-destructive");
    await journeyDeleteButton.click();
    const journeyDeleteConfirmation = story.page.locator(".journey-story__delete-confirmation");
    await journeyDeleteConfirmation.waitFor({ state: "visible" });
    await story.page.evaluate(() => window.history.back());
    await journeyDeleteConfirmation.waitFor({ state: "detached" });
    await story.page.waitForFunction(() => document.activeElement?.textContent?.includes("删除旅程"));
    const journeyDeleteBackFocusRestored = await journeyDeleteButton.evaluate((button) => document.activeElement === button);
    checks.push({
      name: "story-mobile-journey-delete-back-focus",
      journeyDeleteBackFocusRestored,
      failed: !journeyDeleteBackFocusRestored,
    });
    if (!journeyDeleteBackFocusRestored) failed = true;

    await journeyDeleteButton.click();
    await journeyDeleteConfirmation.waitFor({ state: "visible" });
    await manageDone.click();
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer");
    await story.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理旅程");
    const manageDoneFocusRestored = await story.page.getByRole("button", { name: "管理旅程" }).evaluate((button) => document.activeElement === button);
    const deleteConfirmationLeakedToViewer = await journeyDeleteConfirmation.count() !== 0;
    checks.push({
      name: "story-mobile-delete-confirmation-owned-by-manage",
      deleteConfirmationLeakedToViewer,
      manageDoneFocusRestored,
      failed: deleteConfirmationLeakedToViewer || !manageDoneFocusRestored,
    });
    if (deleteConfirmationLeakedToViewer || !manageDoneFocusRestored) failed = true;

    await story.page.getByRole("button", { name: "管理旅程" }).click();
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage");
    await story.page.evaluate(() => window.history.back());
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer");
    await story.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理旅程");
    const manageExitedOnBack = await storyRoot.getAttribute("data-mobile-mode") === "viewer";
    const manageBackFocusRestored = await story.page.getByRole("button", { name: "管理旅程" }).evaluate((button) => document.activeElement === button);
    checks.push({
      name: "story-mobile-manage-back-contract",
      manageExitedOnBack,
      manageBackFocusRestored,
      failed: !manageExitedOnBack || !manageBackFocusRestored,
    });
    if (!manageExitedOnBack || !manageBackFocusRestored) failed = true;

    await story.page.getByRole("button", { name: "管理旅程" }).click();
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage");
    const mediaManageTrigger = story.page.getByRole("button", { name: "管理当前媒体" });
    await mediaManageTrigger.click();
    const mobileSheet = story.page.locator(".journey-story__mobile-media-sheet");
    await mobileSheet.waitFor({ state: "visible" });
    const initialFocusInside = await mobileSheet.evaluate((root) => root.contains(document.activeElement));
    let tabStayedInside = initialFocusInside;
    for (let index = 0; index < 6; index += 1) {
      await story.page.keyboard.press("Tab");
      tabStayedInside = tabStayedInside && await mobileSheet.evaluate((root) => root.contains(document.activeElement));
    }
    await story.page.keyboard.press("Escape");
    await mobileSheet.waitFor({ state: "detached" });
    const sheetFocusRestored = await manageTriggerButton.evaluate((button) => document.activeElement === button);
    checks.push({
      name: "story-mobile-sheet-focus-ownership",
      initialFocusInside,
      tabStayedInside,
      sheetFocusRestored,
      failed: !initialFocusInside || !tabStayedInside || !sheetFocusRestored,
    });
    if (!initialFocusInside || !tabStayedInside || !sheetFocusRestored) failed = true;

    await mediaManageTrigger.click();
    const reclassifyMedia = story.page.getByRole("button", { name: "移动媒体 / 重新归类" });
    const organizeMedia = mobileSheet.getByRole("button", { name: "整理媒体", exact: true });
    const reclassifyBox = await reclassifyMedia.boundingBox();
    const organizeBox = await organizeMedia.boundingBox();
    const bothSheetActionsAvailable = await reclassifyMedia.count() === 1 && await organizeMedia.count() === 1;
    // #199 follow-up: Manage owns cover, ordering, reclassification and
    // deletion. No playback or immersive-viewing action may live here, and the
    // check reads the sheet's real buttons rather than one known label.
    const sheetActionLabels = (await scanButtons(story.page, ".journey-story__mobile-media-sheet")).items
      .map((item) => item.name);
    const sheetOffersPlayback = sheetActionLabels.some((label) => /沉浸|播放/.test(label));
    checks.push({
      name: "story-mobile-manage-sheet-has-no-playback",
      sheetActionLabels,
      sheetOffersPlayback,
      failed: sheetOffersPlayback || sheetActionLabels.length === 0,
    });
    if (sheetOffersPlayback || sheetActionLabels.length === 0) failed = true;
    await reclassifyMedia.click();
    await mobileSheet.waitFor({ state: "detached" });
    const moveSelectToggle = story.page.locator(".journey-story__media-select-toggle");
    await moveSelectToggle.waitFor({ state: "visible" });
    await story.page.waitForFunction(() => (
      document.querySelector(".journey-story__media-select-toggle")?.getAttribute("aria-pressed") === "true"
      && document.querySelector(".story-media-organizer") !== null
    ));
    const directMoveModeActive = await moveSelectToggle.getAttribute("aria-pressed") === "true";
    const directMoveFocusTransferred = await moveSelectToggle.evaluate((button) => document.activeElement === button);
    const directMoveTouchTarget = reclassifyBox ? Math.min(reclassifyBox.width, reclassifyBox.height) : 0;
    const organizeTouchTarget = organizeBox ? Math.min(organizeBox.width, organizeBox.height) : 0;
    checks.push({
      name: "story-mobile-media-reclassification-direct-entry",
      directMoveModeActive,
      directMoveFocusTransferred,
      bothSheetActionsAvailable,
      directMoveTouchTarget,
      organizeTouchTarget,
      failed: !directMoveModeActive
        || !directMoveFocusTransferred
        || !bothSheetActionsAvailable
        || directMoveTouchTarget < 44
        || organizeTouchTarget < 44,
    });
    if (!directMoveModeActive
      || !directMoveFocusTransferred
      || !bothSheetActionsAvailable
      || directMoveTouchTarget < 44
      || organizeTouchTarget < 44) failed = true;

    await story.page.keyboard.press("Escape");
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer");
    await story.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理旅程");
    const directMoveEscapeRestoredViewer = await storyRoot.getAttribute("data-mobile-mode") === "viewer";
    const directMoveEscapeFocusRestored = await manageTrigger.evaluate((button) => document.activeElement === button);

    await manageTrigger.click();
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage");
    await mediaManageTrigger.click();
    await reclassifyMedia.click();
    await moveSelectToggle.waitFor({ state: "visible" });
    await story.page.evaluate(() => window.history.back());
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer");
    await story.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理旅程");
    const directMoveBackRestoredViewer = await storyRoot.getAttribute("data-mobile-mode") === "viewer";
    const directMoveBackFocusRestored = await manageTrigger.evaluate((button) => document.activeElement === button);
    checks.push({
      name: "story-mobile-media-reclassification-exit-contract",
      directMoveEscapeRestoredViewer,
      directMoveEscapeFocusRestored,
      directMoveBackRestoredViewer,
      directMoveBackFocusRestored,
      failed: !directMoveEscapeRestoredViewer
        || !directMoveEscapeFocusRestored
        || !directMoveBackRestoredViewer
        || !directMoveBackFocusRestored,
    });
    if (!directMoveEscapeRestoredViewer
      || !directMoveEscapeFocusRestored
      || !directMoveBackRestoredViewer
      || !directMoveBackFocusRestored) failed = true;

    await manageTrigger.click();
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage");
    await mediaManageTrigger.click();
    await story.page.getByRole("button", { name: "删除媒体" }).click();
    const deleteSheet = story.page.locator(".journey-story__mobile-media-sheet.is-confirming");
    await deleteSheet.waitFor({ state: "visible" });
    const deleteFocusInside = await deleteSheet.evaluate((root) => root.contains(document.activeElement));
    let deleteTabStayedInside = deleteFocusInside;
    for (let index = 0; index < 4; index += 1) {
      await story.page.keyboard.press("Tab");
      deleteTabStayedInside = deleteTabStayedInside && await deleteSheet.evaluate((root) => root.contains(document.activeElement));
    }
    // Menu -> delete is a replacement, not a nested history layer. One Back
    // closes delete directly to Manage; a second Back must leave Manage without
    // exposing or traversing a stale media-menu history entry.
    await story.page.evaluate(() => window.history.back());
    await deleteSheet.waitFor({ state: "detached" });
    await story.page.waitForFunction(() => (
      document.activeElement?.classList.contains("journey-story__mobile-media-menu-trigger") ?? false
    ));
    const deleteFocusRestored = await manageTriggerButton.evaluate((button) => document.activeElement === button);
    const replacementMenuStayedClosed = await mobileSheet.count() === 0;
    const replacementStayedInManage = await storyRoot.getAttribute("data-mobile-mode") === "manage";
    await story.page.evaluate(() => window.history.back());
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer");
    const replacementSecondBackExitedManage = await storyRoot.getAttribute("data-mobile-mode") === "viewer";
    checks.push({
      name: "story-mobile-delete-focus-ownership",
      deleteFocusInside,
      deleteTabStayedInside,
      deleteFocusRestored,
      replacementMenuStayedClosed,
      replacementStayedInManage,
      replacementSecondBackExitedManage,
      failed: !deleteFocusInside
        || !deleteTabStayedInside
        || !deleteFocusRestored
        || !replacementMenuStayedClosed
        || !replacementStayedInManage
        || !replacementSecondBackExitedManage,
    });
    if (!deleteFocusInside
      || !deleteTabStayedInside
      || !deleteFocusRestored
      || !replacementMenuStayedClosed
      || !replacementStayedInManage
      || !replacementSecondBackExitedManage) failed = true;
    await story.page.getByRole("button", { name: "管理旅程" }).click();
    await story.page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage");

    await settledMedia.click();
    const fullscreen = story.page.locator(".journey-story-fullscreen");
    await fullscreen.waitFor({ state: "visible" });
    const fullscreenInitiallyImmersive = await fullscreen.evaluate((root) => root.classList.contains("is-controls-hidden"));
    const fullscreenBox = await fullscreen.boundingBox();
    if (!fullscreenBox) throw new Error("mobile fullscreen has no bounds");
    const fullX = fullscreenBox.x + fullscreenBox.width * 0.5;
    const fullY = fullscreenBox.y + fullscreenBox.height * 0.45;
    await fullscreen.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: fullX, clientY: fullY, bubbles: true });
    await fullscreen.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: fullX, clientY: fullY, bubbles: true });
    const fullscreenCloseBox = await fullscreen.locator(".journey-story-fullscreen__close").boundingBox();
    const fullscreenCloseTouchTarget = fullscreenCloseBox ? Math.min(fullscreenCloseBox.width, fullscreenCloseBox.height) : 0;
    const fullscreenPositionBefore = await fullscreen.locator(".journey-story-fullscreen__nav span").textContent();
    await fullscreen.evaluate((stage) => {
      stage.addEventListener("gotpointercapture", (event) => { stage.dataset.qaCapturedPointer = String(event.pointerId); });
      stage.addEventListener("lostpointercapture", (event) => { if (event.target === stage && String(event.pointerId) === stage.dataset.qaCapturedPointer) stage.dataset.qaReleasedPointer = String(event.pointerId); });
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: fullX, y: fullY }],
    });
    // See the inline-stage comment above: the live-drag gesture needs a
    // pointermove to know the swipe distance/direction.
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: fullX - 30, y: fullY }],
    });
    const fullscreenCapturedDuringDrag = await fullscreen.evaluate((stage) => {
      const pointerId = Number(stage.dataset.qaCapturedPointer);
      return Number.isFinite(pointerId) && stage.hasPointerCapture(pointerId);
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const fullscreenReleasedAfterDrag = await fullscreen.evaluate((stage) => Boolean(stage.dataset.qaReleasedPointer));
    await fullscreen.dispatchEvent("pointerdown", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: fullX, clientY: fullY, bubbles: true });
    await fullscreen.dispatchEvent("pointermove", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: fullX - 110, clientY: fullY, bubbles: true });
    await fullscreen.dispatchEvent("pointerup", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: fullX - 110, clientY: fullY, bubbles: true });
    await story.page.waitForFunction((before) => {
      const position = document.querySelector(".journey-story-fullscreen__nav span")?.textContent;
      return Boolean(position && position !== before);
    }, fullscreenPositionBefore, { timeout: 3_000 });
    const fullscreenPosition = await fullscreen.locator(".journey-story-fullscreen__nav span").textContent();
    record("story-fullscreen", await scanButtons(story.page, ".journey-story-fullscreen"), {
      fullscreenInitiallyImmersive,
      fullscreenCloseTouchTarget,
      fullscreenPositionBefore,
      fullscreenPosition,
      fullscreenCapturedDuringDrag,
      fullscreenReleasedAfterDrag,
      failed: !fullscreenInitiallyImmersive
        || fullscreenCloseTouchTarget < 44
        || !fullscreenPositionBefore
        || !fullscreenPosition
        || fullscreenPosition === fullscreenPositionBefore
        || !fullscreenCapturedDuringDrag
        || !fullscreenReleasedAfterDrag,
    });
    await fullscreen.dispatchEvent("pointerdown", { pointerId: 4, pointerType: "touch", isPrimary: true, clientX: fullX, clientY: fullY, bubbles: true });
    await fullscreen.dispatchEvent("pointerup", { pointerId: 4, pointerType: "touch", isPrimary: true, clientX: fullX, clientY: fullY + 130, bubbles: true });
    await fullscreen.waitFor({ state: "hidden" });

    await settledMedia.click();
    await story.page.locator(".journey-story-fullscreen").waitFor({ state: "visible" });
    await story.page.evaluate(() => window.history.back());
    await story.page.locator(".journey-story-fullscreen").waitFor({ state: "hidden" });
    const storyStillVisibleAfterBack = await story.page.locator(".journey-story").isVisible();
    checks.push({
      name: "story-mobile-fullscreen-exit-contract",
      storyStillVisibleAfterBack,
      failed: !storyStillVisibleAfterBack,
    });
    if (!storyStillVisibleAfterBack) failed = true;

    if (story.consoleErrors.length || story.pageErrors.length) {
      checks.push({ name: "story-runtime-errors", consoleErrors: story.consoleErrors, pageErrors: story.pageErrors });
      failed = true;
    }
  } finally {
    await story.page.close();
  }

  const storyDesktop = await createQaPage("/?qaState=journey-story", onePixelGif, { mobile: false });
  try {
    const desktopStory = storyDesktop.page.locator(".journey-story");
    await desktopStory.waitFor({ state: "visible" });
    const readingView = await desktopStory.evaluate((root) => ({
      layout: root.getAttribute("data-story-layout"),
      editing: root.getAttribute("data-story-editing"),
      editingControls: root.querySelectorAll(".journey-story__media-add, .journey-story__media-order, .journey-story__media-actions, .journey-story__media-overview").length,
      sidebarStats: root.querySelectorAll(".journey-story__copy > dl").length,
      thumbnailRail: root.querySelectorAll(".story-media-rail").length,
      fullscreenEntry: root.querySelectorAll(".journey-story__fullscreen-entry").length,
      navigationButtons: [...root.querySelectorAll(".journey-story__media-nav button")]
        .map((button) => button.getAttribute("aria-label")),
    }));
    const readingViewFailed = readingView.layout !== "desktop" || readingView.editing !== null
      || readingView.editingControls !== 0 || readingView.sidebarStats !== 0
      || readingView.thumbnailRail !== 0 || readingView.fullscreenEntry !== 1
      || JSON.stringify(readingView.navigationButtons) !== JSON.stringify(["全屏查看媒体", "自动播放媒体"]);
    checks.push({ name: "story-desktop-reading-view", ...readingView, failed: readingViewFailed });
    if (readingViewFailed) failed = true;
    const currentPhoto = storyPicture(storyDesktop.page);
    const firstPhotoId = "00000000-0000-4000-8000-000000000100";
    const secondPhotoId = "00000000-0000-4000-8000-000000000101";
    const lastPhotoId = "00000000-0000-4000-8000-000000000102";
    await waitForStoryPicture(storyDesktop.page, firstPhotoId);
    const photoButtonRole = await currentPhoto.getAttribute("role");
    const photoKeyShortcuts = await currentPhoto.getAttribute("aria-keyshortcuts");
    await clickStoryPicture(storyDesktop.page, 1);
    await waitForStoryPicture(storyDesktop.page, secondPhotoId);
    const photoFullscreen = storyDesktop.page.locator(".journey-story-fullscreen");
    const clickStayedInline = !await photoFullscreen.isVisible();
    await clickStoryPicture(storyDesktop.page, -1);
    await waitForStoryPicture(storyDesktop.page, firstPhotoId);
    const keyboardNavigation = [];
    await currentPhoto.focus();
    for (const [key, assetId] of [
      ["ArrowRight", secondPhotoId],
      ["ArrowLeft", firstPhotoId],
      ["Enter", secondPhotoId],
      ["ArrowRight", lastPhotoId],
      ["Space", secondPhotoId], // At the last photo, activation chooses the available previous direction.
    ]) {
      await storyDesktop.page.keyboard.press(key);
      await waitForStoryPicture(storyDesktop.page, assetId);
      keyboardNavigation.push({ key, assetId: await currentPhoto.getAttribute("data-shared-media-id") });
    }
    const keyboardStayedInline = !await photoFullscreen.isVisible();
    const pictureNavigationFailed = photoButtonRole !== "button"
      || photoKeyShortcuts !== "ArrowLeft ArrowRight" || !clickStayedInline || !keyboardStayedInline;
    checks.push({ name: "story-desktop-picture-click-keyboard-navigation", photoButtonRole, photoKeyShortcuts,
      clickStayedInline, keyboardStayedInline, keyboardNavigation, failed: pictureNavigationFailed });
    if (pictureNavigationFailed) failed = true;

    await desktopStory.getByRole("button", { name: "全屏查看媒体", exact: true }).click();
    await photoFullscreen.waitFor({ state: "visible" });
    await waitForStoryPicture(storyDesktop.page, secondPhotoId, ".journey-story-fullscreen");
    const fullscreenNavigationButtons = await photoFullscreen.locator(".journey-story-fullscreen__nav button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    await clickStoryPicture(storyDesktop.page, 1, ".journey-story-fullscreen");
    await waitForStoryPicture(storyDesktop.page, lastPhotoId, ".journey-story-fullscreen");
    await clickStoryPicture(storyDesktop.page, -1, ".journey-story-fullscreen");
    await waitForStoryPicture(storyDesktop.page, secondPhotoId, ".journey-story-fullscreen");
    const fullscreenPictureNavigation = await photoFullscreen.isVisible();
    // A captured horizontal movement below the flip threshold must spring
    // back without its release click being treated as backdrop dismissal.
    const jitterStart = await storyPicturePoint(storyDesktop.page, 1, ".journey-story-fullscreen");
    await storyDesktop.page.mouse.move(jitterStart.x, jitterStart.y);
    await storyDesktop.page.mouse.down();
    await storyDesktop.page.mouse.move(jitterStart.x + 12, jitterStart.y, { steps: 3 });
    await storyDesktop.page.mouse.up();
    await waitForStoryPicture(storyDesktop.page, secondPhotoId, ".journey-story-fullscreen");
    const shortDragKeptFullscreen = await photoFullscreen.isVisible();
    const fullscreenNavigationFailed = !fullscreenPictureNavigation || !shortDragKeptFullscreen
      || JSON.stringify(fullscreenNavigationButtons) !== JSON.stringify(["自动播放媒体"]);
    checks.push({ name: "story-desktop-fullscreen-picture-navigation", fullscreenNavigationButtons,
      fullscreenPictureNavigation, shortDragKeptFullscreen, failed: fullscreenNavigationFailed });
    if (fullscreenNavigationFailed) failed = true;
    await photoFullscreen.getByRole("button", { name: "退出沉浸媒体" }).click();
    await photoFullscreen.waitFor({ state: "hidden" });
    await desktopStory.getByRole("button", { name: "编辑故事", exact: true }).click();
    await desktopStory.locator(".story-media-organizer").waitFor({ state: "visible" });
    const editingView = {
      editing: await desktopStory.getAttribute("data-story-editing"),
      uploadInput: await desktopStory.locator('.journey-story__media-add input[type="file"]').count(),
      selectionControl: await desktopStory.locator(".journey-story__media-select-toggle").count(),
    };
    const editingViewFailed = editingView.editing !== "true" || editingView.uploadInput !== 1 || editingView.selectionControl !== 1;
    checks.push({ name: "story-desktop-explicit-edit-entry", ...editingView, failed: editingViewFailed });
    if (editingViewFailed) failed = true;
    await desktopStory.getByRole("button", { name: "返回单张", exact: true }).click();
    const coverAction = storyDesktop.page.getByRole("button", { name: "将当前媒体设为封面" });
    await coverAction.hover();
    await storyDesktop.page.waitForFunction(() => {
      const button = document.querySelector(".journey-story__media-set-cover");
      return button && Number(getComputedStyle(button, "::after").opacity) >= 0.9;
    });
    const hoverTooltip = await coverAction.evaluate((button) => {
      const stage = button.closest(".journey-story__media");
      const buttonRect = button.getBoundingClientRect();
      const stageRect = stage?.getBoundingClientRect();
      const tooltipStyle = getComputedStyle(button, "::after");
      const tooltipHeight = Number.parseFloat(tooltipStyle.height)
        + Number.parseFloat(tooltipStyle.paddingTop)
        + Number.parseFloat(tooltipStyle.paddingBottom)
        + Number.parseFloat(tooltipStyle.borderTopWidth)
        + Number.parseFloat(tooltipStyle.borderBottomWidth);
      const tooltipTop = tooltipStyle.top !== "auto"
        ? buttonRect.top + Number.parseFloat(tooltipStyle.top)
        : buttonRect.bottom - Number.parseFloat(tooltipStyle.bottom) - tooltipHeight;
      const tooltipBottom = tooltipTop + tooltipHeight;
      return {
        opacity: Number(tooltipStyle.opacity),
        content: tooltipStyle.content,
        placement: tooltipStyle.top !== "auto" ? "below" : "above",
        stageTop: stageRect ? Math.round(stageRect.top) : null,
        stageBottom: stageRect ? Math.round(stageRect.bottom) : null,
        tooltipTop: Math.round(tooltipTop),
        tooltipBottom: Math.round(tooltipBottom),
        fullyInsideStage: Boolean(stageRect)
          && tooltipTop >= stageRect.top
          && tooltipBottom <= stageRect.bottom,
        insideViewport: tooltipTop >= 0 && tooltipBottom <= innerHeight,
      };
    });
    await coverAction.focus();
    await storyDesktop.page.keyboard.press("Shift+Tab");
    await storyDesktop.page.keyboard.press("Tab");
    await storyDesktop.page.waitForFunction(() => {
      const button = document.querySelector(".journey-story__media-set-cover");
      return button === document.activeElement
        && button.matches(":focus-visible")
        && Number(getComputedStyle(button, "::after").opacity) >= 0.9;
    });
    const focusTooltip = await coverAction.evaluate((button) => {
      const stage = button.closest(".journey-story__media");
      const buttonRect = button.getBoundingClientRect();
      const stageRect = stage?.getBoundingClientRect();
      const tooltipStyle = getComputedStyle(button, "::after");
      const tooltipHeight = Number.parseFloat(tooltipStyle.height)
        + Number.parseFloat(tooltipStyle.paddingTop)
        + Number.parseFloat(tooltipStyle.paddingBottom)
        + Number.parseFloat(tooltipStyle.borderTopWidth)
        + Number.parseFloat(tooltipStyle.borderBottomWidth);
      const tooltipTop = tooltipStyle.top !== "auto"
        ? buttonRect.top + Number.parseFloat(tooltipStyle.top)
        : buttonRect.bottom - Number.parseFloat(tooltipStyle.bottom) - tooltipHeight;
      const tooltipBottom = tooltipTop + tooltipHeight;
      return {
        focused: document.activeElement === button,
        focusVisible: button.matches(":focus-visible"),
        opacity: Number(tooltipStyle.opacity),
        content: tooltipStyle.content,
        placement: tooltipStyle.top !== "auto" ? "below" : "above",
        fullyInsideStage: Boolean(stageRect)
          && tooltipTop >= stageRect.top
          && tooltipBottom <= stageRect.bottom,
        insideViewport: tooltipTop >= 0 && tooltipBottom <= innerHeight,
      };
    });
    const desktopTooltipFailed = hoverTooltip.opacity < 0.9
      || !hoverTooltip.content.includes("设为封面")
      || !hoverTooltip.insideViewport
      || !focusTooltip.focused
      || !focusTooltip.focusVisible
      || focusTooltip.opacity < 0.9
      || !focusTooltip.content.includes("设为封面")
      || !focusTooltip.insideViewport;
    checks.push({
      name: "story-icon-action-tooltip-hover-focus",
      hoverTooltip,
      focusTooltip,
      failed: desktopTooltipFailed,
    });
    if (desktopTooltipFailed) failed = true;
    await desktopStory.getByRole("button", { name: "完成编辑故事", exact: true }).click();
    await desktopStory.getByRole("button", { name: "编辑故事", exact: true }).waitFor({ state: "visible" });
    const returnedToReading = await desktopStory.evaluate((root) => root.getAttribute("data-story-editing") === null
      && root.querySelectorAll(".story-media-organizer, .journey-story__media-add, .journey-story__media-actions, .journey-story__media-order").length === 0);
    checks.push({ name: "story-desktop-finish-editing-restores-reading", returnedToReading, failed: !returnedToReading });
    if (!returnedToReading) failed = true;
  } finally {
    await storyDesktop.page.close();
  }

  const mixedMediaMobile = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif, {
    instrumentMedia: true,
    mixedMedia: true,
    mobile: true,
    reducedMotion: "reduce",
  });
  const nativeTouchPoints = [];
  async function nativeVideoTouchPoint(video, phase) {
    const point = await video.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const scale = Math.min(bounds.width / element.videoWidth, bounds.height / element.videoHeight);
      const width = element.videoWidth * scale;
      const height = element.videoHeight * scale;
      const controlsTop = bounds.bottom - Math.min(72, bounds.height * .25);
      const pictureLeft = bounds.left + (bounds.width - width) / 2;
      const pictureTop = bounds.top + (bounds.height - height) / 2;
      const left = Math.max(0, pictureLeft);
      const right = Math.min(innerWidth, pictureLeft + width);
      const top = Math.max(0, pictureTop);
      const bottom = Math.min(innerHeight, pictureTop + height, controlsTop);
      // The sticky Story header can cover the upper picture after scrolling.
      // Choose an exposed row that fits both the 30px jitter and 110px swipe.
      const pathFits = right - left > 142 && bottom > top;
      const x = Math.min(right - 31, Math.max(left + 111, bounds.left + bounds.width / 2));
      const candidates = pathFits ? [.35, .5, .65, .8, .9].map((fraction) => {
        const y = top + (bottom - top) * fraction;
        const hits = [-110, -55, 0, 30].map((offset) => document.elementFromPoint(x + offset, y));
        return { y, exposed: hits.every((hit) => hit === element),
          hits: hits.map((hit) => hit instanceof Element ? `${hit.tagName}.${hit.className}` : null) };
      }) : [];
      const selected = candidates.find((candidate) => candidate.exposed);
      const y = selected?.y ?? top;
      const hit = selected ? document.elementFromPoint(x, y) : null;
      return { x, y, bounds: bounds.toJSON(), picture: [width, height],
        asset: element.getAttribute("data-shared-media-id"), readyState: element.readyState,
        hitIsVideo: hit === element, hit: hit instanceof Element ? `${hit.tagName}.${hit.className}` : null,
        controlsTop, pathFits, candidates,
        viewport: [innerWidth, innerHeight] };
    });
    nativeTouchPoints.push({ phase, ...point });
    if (!point.hitIsVideo || point.y >= point.controlsTop || !point.picture.every((value) => value > 0)) {
      throw new Error(`Mobile video touch does not reach its picture: ${JSON.stringify(nativeTouchPoints.at(-1))}`);
    }
    return point;
  }
  try {
    await mixedMediaMobile.page.evaluate(() => {
      window.__qaNativeVideoTouches = [];
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"]) {
        document.addEventListener(type, (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const stage = target.closest(".journey-story__media, .journey-story-fullscreen");
          window.__qaNativeVideoTouches.push({ type, time: event.timeStamp, pointerId: event.pointerId,
            target: `${target.tagName}.${target.className}`, x: event.clientX, y: event.clientY,
            stage: stage?.className ?? null,
            asset: stage?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id") });
          if (window.__qaNativeVideoTouches.length > 60) window.__qaNativeVideoTouches.shift();
        }, true);
      }
    });
    await mixedMediaMobile.page.locator(".journey-story").waitFor({ state: "visible" });
    const inlineStage = mixedMediaMobile.page.locator(".journey-story__media");
    const initialImage = inlineStage.locator(storyCurrentImageSelector).first();
    await initialImage.waitFor({ state: "visible" });
    await initialImage.click();

    const fullscreenStage = mixedMediaMobile.page.locator(".journey-story-fullscreen");
    await fullscreenStage.waitFor({ state: "visible" });
    const fullscreenBox = await fullscreenStage.boundingBox();
    if (!fullscreenBox) throw new Error("mobile mixed-media fullscreen has no bounds");
    const fullStartX = fullscreenBox.x + fullscreenBox.width * 0.72;
    const fullSwipeY = fullscreenBox.y + fullscreenBox.height * 0.42;
    // Land on the video deterministically before exercising real touch. This
    // setup gesture targets the stage directly; the assertions below use CDP
    // touch so the browser gives the <video> its normal implicit capture.
    await fullscreenStage.dispatchEvent("pointerdown", { pointerId: 51, pointerType: "touch", isPrimary: true, clientX: fullStartX, clientY: fullSwipeY, bubbles: true });
    await fullscreenStage.dispatchEvent("pointermove", { pointerId: 51, pointerType: "touch", isPrimary: true, clientX: fullStartX - 110, clientY: fullSwipeY, bubbles: true });
    await fullscreenStage.dispatchEvent("pointerup", { pointerId: 51, pointerType: "touch", isPrimary: true, clientX: fullStartX - 110, clientY: fullSwipeY, bubbles: true });

    const fullscreenVideo = fullscreenStage.locator("video[data-shared-media-id]");
    await fullscreenVideo.waitFor({ state: "visible", timeout: 3_000 });
    const touch = await mixedMediaMobile.page.context().newCDPSession(mixedMediaMobile.page);
    await fullscreenStage.evaluate((stage) => {
      stage.dataset.qaVideoStageCapture = "";
      stage.addEventListener("gotpointercapture", (event) => {
        if (event.target === stage) stage.dataset.qaVideoStageCapture = String(event.pointerId);
      });
    });
    await fullscreenVideo.evaluate((video) => {
      video.dataset.qaPointerUps = "0";
      video.addEventListener("pointerup", (event) => {
        if (event.target === video) {
          video.dataset.qaPointerUps = String(Number(video.dataset.qaPointerUps ?? "0") + 1);
        }
      });
    });
    const fullscreenVideoPoint = await nativeVideoTouchPoint(fullscreenVideo, "fullscreen-jitter");
    const fullscreenVideoX = fullscreenVideoPoint.x;
    const fullscreenVideoY = fullscreenVideoPoint.y;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fullscreenVideoX, y: fullscreenVideoY }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fullscreenVideoX + 30, y: fullscreenVideoY }] });
    const fullscreenVideoStageCapturedOnJitter = await fullscreenStage.evaluate((stage) => Boolean(stage.dataset.qaVideoStageCapture));
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const fullscreenVideoPointerUps = Number(await fullscreenVideo.getAttribute("data-qa-pointer-ups") ?? "0");

    const fullscreenPositionBeforeVideoSwipe = await fullscreenStage.locator(".journey-story-fullscreen__nav span").textContent();
    const fullscreenSwipePoint = await nativeVideoTouchPoint(fullscreenVideo, "fullscreen-swipe");
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fullscreenSwipePoint.x, y: fullscreenSwipePoint.y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fullscreenSwipePoint.x - 110, y: fullscreenSwipePoint.y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await mixedMediaMobile.page.waitForFunction((before) => {
      const position = document.querySelector(".journey-story-fullscreen__nav span")?.textContent;
      return Boolean(position && position !== before);
    }, fullscreenPositionBeforeVideoSwipe, { timeout: 3_000 });
    const fullscreenVideoSwipeNavigated = true;

    // Return to the video, then exit fullscreen so the inline stage can run
    // the same native-capture contract.
    await fullscreenStage.dispatchEvent("pointerdown", { pointerId: 52, pointerType: "touch", isPrimary: true, clientX: fullStartX, clientY: fullSwipeY, bubbles: true });
    await fullscreenStage.dispatchEvent("pointermove", { pointerId: 52, pointerType: "touch", isPrimary: true, clientX: fullStartX + 110, clientY: fullSwipeY, bubbles: true });
    await fullscreenStage.dispatchEvent("pointerup", { pointerId: 52, pointerType: "touch", isPrimary: true, clientX: fullStartX + 110, clientY: fullSwipeY, bubbles: true });
    await fullscreenVideo.waitFor({ state: "visible", timeout: 3_000 });
    await mixedMediaMobile.page.keyboard.press("Escape");
    // The fullscreen stage stays mounted but hidden so its exact <video> node
    // keeps playback authorization; dismissal is semantic, not DOM detachment.
    await fullscreenStage.waitFor({ state: "hidden" });

    const inlineVideo = inlineStage.locator(storyCurrentVideoSelector);
    await inlineVideo.waitFor({ state: "visible", timeout: 3_000 });
    await inlineStage.evaluate((stage) => {
      stage.dataset.qaVideoStageCapture = "";
      stage.addEventListener("gotpointercapture", (event) => {
        if (event.target === stage) stage.dataset.qaVideoStageCapture = String(event.pointerId);
      });
    });
    await inlineVideo.evaluate((video) => {
      video.dataset.qaPointerUps = "0";
      video.addEventListener("pointerup", (event) => {
        if (event.target === video) {
          video.dataset.qaPointerUps = String(Number(video.dataset.qaPointerUps ?? "0") + 1);
        }
      });
    });
    const inlineVideoPoint = await nativeVideoTouchPoint(inlineVideo, "inline-jitter");
    const inlineVideoX = inlineVideoPoint.x;
    const inlineVideoY = inlineVideoPoint.y;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: inlineVideoX, y: inlineVideoY }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: inlineVideoX + 30, y: inlineVideoY }] });
    const inlineVideoStageCapturedOnJitter = await inlineStage.evaluate((stage) => Boolean(stage.dataset.qaVideoStageCapture));
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const inlineVideoPointerUps = Number(await inlineVideo.getAttribute("data-qa-pointer-ups") ?? "0");

    const inlineVideoSrcBeforeSwipe = await inlineVideo.getAttribute("src");
    // This assertion exercises a warm video-to-photo swipe. Returning from
    // fullscreen may leave the inline neighbor waiting for its own decode.
    await inlineStage.locator(storyReadyPageSelector("next")).waitFor({ state: "attached", timeout: 3_000 });
    const inlineSwipePoint = await nativeVideoTouchPoint(inlineVideo, "inline-swipe");
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: inlineSwipePoint.x, y: inlineSwipePoint.y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: inlineSwipePoint.x - 110, y: inlineSwipePoint.y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await mixedMediaMobile.page.waitForFunction(({ selector, before }) => {
      const media = document.querySelector(".journey-story__media")?.querySelector(selector);
      return Boolean(media && media.getAttribute("src") !== before);
    }, { selector: storyCurrentMediaSelector, before: inlineVideoSrcBeforeSwipe }, { timeout: 3_000 });
    const inlineVideoSwipeNavigated = true;

    const videoNativeTapFailed = fullscreenVideoStageCapturedOnJitter
      || inlineVideoStageCapturedOnJitter
      || fullscreenVideoPointerUps < 1
      || inlineVideoPointerUps < 1
      || !fullscreenVideoSwipeNavigated
      || !inlineVideoSwipeNavigated
      || mixedMediaMobile.consoleErrors.length > 0
      || mixedMediaMobile.pageErrors.length > 0;
    checks.push({
      name: "story-mobile-video-native-capture-preserved",
      fullscreenVideoStageCapturedOnJitter,
      fullscreenVideoPointerUps,
      fullscreenVideoSwipeNavigated,
      inlineVideoStageCapturedOnJitter,
      inlineVideoPointerUps,
      inlineVideoSwipeNavigated,
      nativeTouchPoints,
      consoleErrors: mixedMediaMobile.consoleErrors,
      pageErrors: mixedMediaMobile.pageErrors,
      failed: videoNativeTapFailed,
    });
    if (videoNativeTapFailed) failed = true;
  } catch (error) {
    const state = await mixedMediaMobile.page.evaluate(() => ({
      events: window.__qaNativeVideoTouches,
      storyScrollTop: document.querySelector(".journey-story")?.scrollTop,
      stages: [...document.querySelectorAll(".journey-story__media, .journey-story-fullscreen")].map((stage) => ({
        className: stage.className, hidden: stage.hidden, bounds: stage.getBoundingClientRect().toJSON(),
        presentation: stage.querySelector("[data-story-media-pages]")?.getAttribute("data-media-presentation"),
        pages: [...stage.querySelectorAll("[data-media-page]")].map((page) => ({
          id: page.getAttribute("data-media-page-id"), role: page.getAttribute("data-media-page"),
          ready: page.getAttribute("data-media-page-ready"), transform: page.style.transform,
        })),
      })),
    }));
    throw new Error(`Mobile native video gesture failed: ${JSON.stringify({ nativeTouchPoints, ...state })}`, { cause: error });
  } finally {
    await mixedMediaMobile.page.close();
  }

  // #204 final review P1: starting autoplay on an image must authorize the
  // persistent future-video element in that same user gesture. When the timer
  // later reaches the video, the synchronization play() must target the exact
  // same DOM element rather than a newly keyed, untrusted <video>.
  const futureVideoAuthorization = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif, {
    instrumentMedia: true,
    mixedMedia: true,
    mobile: true,
  });
  try {
    await futureVideoAuthorization.page.locator(".journey-story").waitFor({ state: "visible" });
    const stage = futureVideoAuthorization.page.locator(".journey-story__media");
    await stage.locator(storyCurrentImageSelector).first().waitFor({ state: "visible" });
    const primedVideo = stage.locator(storyPersistentVideoSelector);
    await primedVideo.waitFor({ state: "attached", timeout: 5_000 });
    await futureVideoAuthorization.page.waitForFunction((selector) => {
      const video = document.querySelector(selector);
      return Boolean(video?.getAttribute("src"));
    }, storyPersistentVideoSelector, { timeout: 5_000 });

    const playControl = futureVideoAuthorization.page.locator(".journey-story__mobile-media-play");
    await futureVideoAuthorization.page.evaluate(() => { window.__qaMediaPlayEvents.length = 0; });
    await playControl.click();
    const primingEvents = await futureVideoAuthorization.page.evaluate(() => [...window.__qaMediaPlayEvents]);
    const primingVideoEvent = primingEvents.find((event) => (
      event.tagName === "VIDEO" && event.userActivation === true
    ));
    // Events cross the bridge as fresh objects on every evaluate(), so identity
    // comparison against the priming event can never exclude it. Everything
    // recorded after the gesture is identified by this index instead, and the
    // wait below observes the same window as the assertion.
    const primingEventCount = primingEvents.length;

    // The play() recorded after the gesture is the only observable step
    // boundary here: the stage video is mounted from the start, so element
    // visibility says nothing about which step the sequence is on. The budget
    // must therefore cover a full image step (STORY_AUTOPLAY_STEP_MS = 5.2s)
    // plus the settle that follows it.
    await futureVideoAuthorization.page.waitForFunction((recorded) => (
      window.__qaMediaPlayEvents.slice(recorded).some((event) => event.tagName === "VIDEO")
    ), primingEventCount, { timeout: 10_000 });
    const laterEvents = await futureVideoAuthorization.page.evaluate(() => [...window.__qaMediaPlayEvents]);
    const playsAfterGesture = laterEvents.slice(primingEventCount);
    const reusedAuthorizedVideo = Boolean(
      primingVideoEvent
      && playsAfterGesture.some((event) => (
        event.tagName === "VIDEO"
        && event.elementId === primingVideoEvent.elementId
      )),
    );
    const videoOwnerElementIds = [...new Set(
      laterEvents.filter((event) => event.tagName === "VIDEO").map((event) => event.elementId),
    )];
    const singleVideoPlaybackOwner = videoOwnerElementIds.length === 1
      && videoOwnerElementIds[0] === primingVideoEvent?.elementId;
    const futureVideoAuthorizationFailed = !primingVideoEvent
      || !reusedAuthorizedVideo
      || !singleVideoPlaybackOwner
      || futureVideoAuthorization.consoleErrors.length > 0
      || futureVideoAuthorization.pageErrors.length > 0;
    checks.push({
      name: "story-autoplay-future-video-authorization",
      primingVideoEvent,
      playsAfterGesture,
      reusedAuthorizedVideo,
      videoOwnerElementIds,
      singleVideoPlaybackOwner,
      consoleErrors: futureVideoAuthorization.consoleErrors,
      pageErrors: futureVideoAuthorization.pageErrors,
      failed: futureVideoAuthorizationFailed,
    });
    if (futureVideoAuthorizationFailed) failed = true;
  } finally {
    await futureVideoAuthorization.page.close();
  }

  for (const [label, viewport] of [
    ["844x390", { width: 844, height: 390 }],
    ["932x430", { width: 932, height: 430 }],
  ]) {
    const landscapeStory = await createQaPage("/?qaState=journey-story", onePixelGif, {
      mobile: true,
      viewport,
    });
    try {
      await landscapeStory.page.locator(".journey-story").waitFor({ state: "visible" });
      const storyMobileLayout = await landscapeStory.page.locator(".journey-story__media").getAttribute("data-mobile-layout");
      const storyDesktopOnlyControls = await landscapeStory.page.locator(
        ".journey-story__media-overview, .journey-story__fullscreen-entry, .journey-story__media-controls, .journey-story__media-actions",
      ).count();
      checks.push({
        name: `story-phone-landscape-${label}`,
        storyMobileLayout,
        storyDesktopOnlyControls,
        failed: storyMobileLayout !== "true" || storyDesktopOnlyControls !== 0,
      });
      if (storyMobileLayout !== "true" || storyDesktopOnlyControls !== 0) failed = true;
    } finally {
      await landscapeStory.page.close();
    }

    const landscapeComposer = await createQaPage("/?qaState=journey-composer&qaMode=edit", onePixelGif, {
      mobile: true,
      viewport,
    });
    try {
      const composer = landscapeComposer.page.locator(".journey-composer");
      await composer.waitFor({ state: "visible" });
      const composerMobileLayout = await composer.getAttribute("data-mobile-layout");
      checks.push({
        name: `composer-phone-landscape-${label}`,
        composerMobileLayout,
        failed: composerMobileLayout !== "true",
      });
      if (composerMobileLayout !== "true") failed = true;
    } finally {
      await landscapeComposer.page.close();
    }
  }

  // Issue #199: mobile Viewer must offer Story media sequence playback without
  // entering Manage mode. The control belongs to the viewer action cluster, is
  // never inside the management sheet, keeps a 44px target from the narrowest
  // portrait phone to phone landscape, and toggles `aria-pressed` on tap.
  for (const [label, viewport] of [
    ["320x700", { width: 320, height: 700 }],
    ["390x844", { width: 390, height: 844 }],
    ["844x390", { width: 844, height: 390 }],
    ["932x430", { width: 932, height: 430 }],
  ]) {
    const viewerPlayback = await createQaPage("/?qaState=journey-story", onePixelGif, {
      mobile: true,
      viewport,
    });
    try {
      await viewerPlayback.page.locator(".journey-story").waitFor({ state: "visible" });
      const playControl = viewerPlayback.page.locator(".journey-story__mobile-media-play");
      await playControl.waitFor({ state: "visible", timeout: 5_000 });
      const playBox = await playControl.boundingBox();
      const placement = await playControl.evaluate((element) => ({
        idleLabel: element.getAttribute("aria-label"),
        idlePressed: element.getAttribute("aria-pressed"),
        inViewerCluster: Boolean(element.closest(".journey-story__mobile-media-actions")),
        insideManageSheet: Boolean(element.closest(".journey-story__mobile-media-sheet")),
        manageSheetsMounted: document.querySelectorAll(".journey-story__mobile-media-sheet").length,
        mobileMode: element.closest(".journey-story")?.dataset.mobileMode ?? null,
      }));
      // The cluster shares one absolute anchor with the management entry, so
      // an overlap here would mean the pair collided at this width.
      const clusterScan = await scanButtons(viewerPlayback.page, ".journey-story__mobile-media-actions");
      const clusterOverlap = overlapPairs(clusterScan.items);
      // #199 follow-up: immersive viewing is a viewing action, so its entry
      // shares the Viewer cluster with playback instead of living in the
      // management sheet. It must clear the same 44px target at every phone
      // width the playback control is graded at.
      const fullscreenControl = viewerPlayback.page.locator(".journey-story__mobile-media-fullscreen");
      await fullscreenControl.waitFor({ state: "visible", timeout: 5_000 });
      const fullscreenBox = await fullscreenControl.boundingBox();
      const fullscreenPlacement = await fullscreenControl.evaluate((element) => ({
        label: element.getAttribute("aria-label"),
        inViewerCluster: Boolean(element.closest(".journey-story__mobile-media-actions")),
        insideManageSheet: Boolean(element.closest(".journey-story__mobile-media-sheet")),
        mobileMode: element.closest(".journey-story")?.dataset.mobileMode ?? null,
      }));
      await playControl.click();
      await viewerPlayback.page.waitForFunction(
        () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "true",
        undefined,
        { timeout: 3_000 },
      );
      const playingLabel = await playControl.getAttribute("aria-label");
      await playControl.click();
      await viewerPlayback.page.waitForFunction(
        () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "false",
        undefined,
        { timeout: 3_000 },
      );
      const restoredPressed = await playControl.getAttribute("aria-pressed");
      const playbackFailed = !playBox
        || playBox.width < 44
        || playBox.height < 44
        || !fullscreenBox
        || fullscreenBox.width < 44
        || fullscreenBox.height < 44
        || fullscreenPlacement.label !== "沉浸查看媒体"
        || !fullscreenPlacement.inViewerCluster
        || fullscreenPlacement.insideManageSheet
        || fullscreenPlacement.mobileMode !== "viewer"
        || placement.idlePressed !== "false"
        || placement.idleLabel !== "自动播放媒体"
        || playingLabel !== "暂停自动播放"
        || restoredPressed !== "false"
        || !placement.inViewerCluster
        || placement.insideManageSheet
        || placement.manageSheetsMounted !== 0
        || placement.mobileMode !== "viewer"
        || clusterOverlap.length > 0
        || viewerPlayback.consoleErrors.length > 0
        || viewerPlayback.pageErrors.length > 0;
      checks.push({
        name: `story-mobile-viewer-playback-${label}`,
        playBox: playBox ? { width: Math.round(playBox.width), height: Math.round(playBox.height) } : null,
        fullscreenBox: fullscreenBox ? { width: Math.round(fullscreenBox.width), height: Math.round(fullscreenBox.height) } : null,
        fullscreenPlacement,
        ...placement,
        playingLabel,
        restoredPressed,
        clusterOverlap,
        consoleErrors: viewerPlayback.consoleErrors,
        pageErrors: viewerPlayback.pageErrors,
        failed: playbackFailed,
      });
      if (playbackFailed) failed = true;
    } finally {
      await viewerPlayback.page.close();
    }
  }

  // Issue #199 review: a video step must be ended by the video, not by the
  // fixed slide timer. `instrumentMedia` makes play() resolve, so a synthetic
  // `ended` is the only thing that can finish the step here; a timer-only
  // implementation would need STORY_AUTOPLAY_STEP_MS (5.2s) to advance.
  const videoAutoplay = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif, {
    instrumentMedia: true,
    mixedMedia: true,
    mobile: true,
  });
  try {
    await videoAutoplay.page.locator(".journey-story").waitFor({ state: "visible" });
    const videoStage = videoAutoplay.page.locator(".journey-story__media");
    const firstImage = videoStage.locator(storyCurrentImageSelector).first();
    await firstImage.waitFor({ state: "visible" });
    const videoStageBox = await videoStage.boundingBox();
    if (!videoStageBox) throw new Error("mixed-media story stage has no bounds");
    const videoSwipeX = videoStageBox.x + videoStageBox.width * 0.72;
    const videoSwipeY = videoStageBox.y + videoStageBox.height * 0.5;
    // One committed swipe lands on the video asset at index 1.
    await videoStage.dispatchEvent("pointerdown", { pointerId: 71, pointerType: "touch", isPrimary: true, clientX: videoSwipeX, clientY: videoSwipeY, bubbles: true });
    await videoStage.dispatchEvent("pointermove", { pointerId: 71, pointerType: "touch", isPrimary: true, clientX: videoSwipeX - 110, clientY: videoSwipeY, bubbles: true });
    await videoStage.dispatchEvent("pointerup", { pointerId: 71, pointerType: "touch", isPrimary: true, clientX: videoSwipeX - 110, clientY: videoSwipeY, bubbles: true });
    const settledVideo = videoStage.locator(storyCurrentVideoSelector);
    await settledVideo.waitFor({ state: "visible", timeout: 5_000 });

    const videoPlayControl = videoAutoplay.page.locator(".journey-story__mobile-media-play");
    await videoPlayControl.waitFor({ state: "visible" });
    await videoAutoplay.page.evaluate(() => { window.__qaMediaPlayEvents.length = 0; });
    await videoPlayControl.click();
    await videoAutoplay.page.waitForFunction(
      () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "true",
      undefined,
      { timeout: 3_000 },
    );
    const videoPlayEvents = await videoAutoplay.page.evaluate(() => window.__qaMediaPlayEvents);
    const gestureStartedVideo = videoPlayEvents.some((event) => (
      event.tagName === "VIDEO" && event.userActivation === true
    ));
    // The sequence, not the markup, starts this element: the inline stage
    // never sets `autoPlay`, so an unplayed video would stay paused.
    const videoDrivenBySequence = await videoAutoplay.page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        return element ? !element.paused : false;
      },
      storyCurrentVideoSelector,
      { timeout: 3_000 },
    ).then(() => true).catch(() => false);

    // Native controls own the element too: pausing the settled video must
    // immediately stop Story autoplay rather than leaving `playing=true`.
    await settledVideo.evaluate((element) => element.dispatchEvent(new Event("pause")));
    const nativePauseStoppedSequence = await videoAutoplay.page.waitForFunction(
      () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "false",
      undefined,
      { timeout: 3_000 },
    ).then(() => true).catch(() => false);

    // Restart from a fresh user gesture so the existing ended contract remains
    // covered after the native-pause ownership assertion.
    await videoPlayControl.click();
    await videoAutoplay.page.waitForFunction(
      () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "true",
      undefined,
      { timeout: 3_000 },
    );
    const endedAt = Date.now();
    await settledVideo.evaluate((element) => element.dispatchEvent(new Event("ended")));
    let videoEndAdvancedMs = null;
    try {
      await videoAutoplay.page.waitForFunction((selector) => {
        const element = document.querySelector(selector);
        return element?.tagName === "IMG" && element.getAttribute("alt") === "seed-2.png";
      }, storyCurrentMediaSelector, { timeout: 4_000 });
      videoEndAdvancedMs = Date.now() - endedAt;
    } catch {
      videoEndAdvancedMs = null;
    }
    const videoAutoplayFailed = !gestureStartedVideo
      || !videoDrivenBySequence
      || !nativePauseStoppedSequence
      || videoEndAdvancedMs === null
      || videoEndAdvancedMs >= 5_000
      || videoAutoplay.consoleErrors.length > 0
      || videoAutoplay.pageErrors.length > 0;
    checks.push({
      name: "story-mobile-viewer-playback-video-completion",
      gestureStartedVideo,
      videoPlayEvents,
      videoDrivenBySequence,
      nativePauseStoppedSequence,
      videoEndAdvancedMs,
      consoleErrors: videoAutoplay.consoleErrors,
      pageErrors: videoAutoplay.pageErrors,
      failed: videoAutoplayFailed,
    });
    if (videoAutoplayFailed) failed = true;
  } finally {
    await videoAutoplay.page.close();
  }

  // A renewal can start while paused and finish after a user starts playback.
  // Exercise the real expiry sweep and async read boundary, including failure;
  // the current transport must survive, and refresh must resume after pause.
  for (const outcome of ["success", "error"]) {
    const refreshRace = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif,
      { instrumentMedia: true, mixedMedia: true, mobile: false });
    let releaseRefresh = () => undefined;
    try {
      const page = refreshRace.page;
      const videoId = "00000000-0000-4000-8000-000000000152";
      await waitForStoryPicture(page, "00000000-0000-4000-8000-000000000100");
      await clickStoryPicture(page, 1);
      await waitForStoryPicture(page, videoId);
      const video = page.locator(".journey-story__media video[data-shared-media-id]");
      await video.evaluate((element) => {
        window.__qaRefreshVideo = element;
        window.__qaRefreshSource = element.getAttribute("src");
        window.__qaRefreshSourceChanges = 0;
        window.__qaRefreshEmptied = 0;
        new MutationObserver((records) => { window.__qaRefreshSourceChanges += records.length; })
          .observe(element, { attributes: true, attributeFilter: ["src"] });
        element.addEventListener("emptied", () => { window.__qaRefreshEmptied += 1; });
      });
      const held = new Promise((resolve) => { releaseRefresh = resolve; });
      let requestCount = 0;
      let startedRefresh;
      const started = new Promise((resolve) => { startedRefresh = resolve; });
      const expiredNow = Date.now() + 901_000;
      await page.route(`**/api/uploads/assets/${videoId}/read-url`, async (route) => {
        const attempt = ++requestCount;
        if (attempt === 1) { startedRefresh(); await held; }
        await route.fulfill({
          status: attempt === 1 && outcome === "error" ? 500 : 200,
          contentType: "application/json",
          body: JSON.stringify(attempt === 1 && outcome === "error" ? { message: "QA refresh unavailable" } : {
            url: `${tinyVideo}?renewal=${attempt}`,
            expiresAt: new Date(expiredNow + 900_000).toISOString(),
          }),
        });
      });
      // Only Date changes. Real timers, media readiness and user input continue.
      await page.clock.setFixedTime(expiredNow);
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("Story refresh did not start")), 25_000))]);
      await page.locator(".journey-story").getByRole("button", { name: "自动播放媒体", exact: true }).click();
      await page.waitForFunction(() => !window.__qaRefreshVideo.paused);
      const completion = page.waitForResponse((response) => response.url().includes(`/assets/${videoId}/read-url`));
      releaseRefresh();
      await (await completion).finished();
      const retained = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const element = document.querySelector(".journey-story__media video[data-shared-media-id]");
        return { sameNode: element === window.__qaRefreshVideo,
          sameSource: element?.getAttribute("src") === window.__qaRefreshSource,
          sourceChanges: window.__qaRefreshSourceChanges, emptied: window.__qaRefreshEmptied,
          playing: Boolean(element && !element.paused),
          storyPlaying: Boolean(document.querySelector('.journey-story button[aria-label="暂停自动播放"]')) };
      });
      await page.locator(".journey-story").getByRole("button", { name: "暂停自动播放", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".journey-story__media video[data-shared-media-id]")
        ?.getAttribute("src")?.includes("renewal=2"), undefined, { timeout: 25_000 });
      const unexpectedErrors = refreshRace.consoleErrors.filter((message) => outcome !== "error" || !message.includes("500"));
      const raceFailed = !retained.sameNode || !retained.sameSource || retained.sourceChanges !== 0
        || retained.emptied !== 0 || !retained.playing || !retained.storyPlaying || requestCount !== 2
        || unexpectedErrors.length > 0 || refreshRace.pageErrors.length > 0;
      checks.push({ name: `story-slow-refresh-then-play-${outcome}`, ...retained,
        refreshedAfterPause: true, requestCount, unexpectedErrors, pageErrors: refreshRace.pageErrors, failed: raceFailed });
      if (raceFailed) failed = true;
    } finally {
      releaseRefresh();
      await refreshRace.page.close();
    }
  }

  // #199 follow-up: the immersive entry the management sheet used to own now
  // belongs to Viewer, must work when the current asset is a VIDEO (the sheet
  // button was the only entry there, because the tap-to-open path is bound to
  // the image element), and must be playback-transparent: entering and leaving
  // fullscreen hands the sequence over instead of starting or stopping it.
  const videoImmersive = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif, {
    instrumentMedia: true,
    mixedMedia: true,
    mobile: true,
  });
  try {
    await videoImmersive.page.locator(".journey-story").waitFor({ state: "visible" });
    const stage = videoImmersive.page.locator(".journey-story__media");
    await stage.locator(storyCurrentImageSelector).first().waitFor({ state: "visible" });
    const stageBox = await stage.boundingBox();
    if (!stageBox) throw new Error("mixed-media story stage has no bounds");
    const swipeX = stageBox.x + stageBox.width * 0.72;
    const swipeY = stageBox.y + stageBox.height * 0.5;
    await stage.dispatchEvent("pointerdown", { pointerId: 81, pointerType: "touch", isPrimary: true, clientX: swipeX, clientY: swipeY, bubbles: true });
    await stage.dispatchEvent("pointermove", { pointerId: 81, pointerType: "touch", isPrimary: true, clientX: swipeX - 110, clientY: swipeY, bubbles: true });
    await stage.dispatchEvent("pointerup", { pointerId: 81, pointerType: "touch", isPrimary: true, clientX: swipeX - 110, clientY: swipeY, bubbles: true });
    await stage.locator(storyCurrentVideoSelector).waitFor({ state: "visible", timeout: 5_000 });
    const currentIsVideo = await videoImmersive.page.evaluate((selector) => (
      document.querySelector(selector)?.tagName === "VIDEO"
    ), storyCurrentMediaSelector);

    const immersiveEntry = videoImmersive.page.locator(".journey-story__mobile-media-fullscreen");
    const playControl = videoImmersive.page.locator(".journey-story__mobile-media-play");
    const overlay = videoImmersive.page.locator(".journey-story-fullscreen");
    await immersiveEntry.waitFor({ state: "visible", timeout: 5_000 });
    const entryReachableInViewer = await videoImmersive.page.evaluate(() => (
      document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer"
    ));
    await immersiveEntry.click();
    const videoOpenedFullscreen = await overlay
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    // The entry keeps the mobile immersive contract: the overlay opens with its
    // chrome hidden, which is also why this lane leaves through Browser Back
    // rather than through a close button that is deliberately not visible yet.
    const enteredImmersive = await overlay.evaluate((root) => root.classList.contains("is-controls-hidden"));
    // Idle: the entry did not invent playback for a viewer that was not playing.
    const stayedPausedOnEntry = await overlay.evaluate((root) => !root.classList.contains("is-playing"));
    await videoImmersive.page.evaluate(() => window.history.back());
    await overlay.waitFor({ state: "hidden", timeout: 5_000 });

    // Playing: the sequence survives the round trip, and both controls agree.
    await playControl.click();
    await videoImmersive.page.waitForFunction(
      () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "true",
      undefined,
      { timeout: 3_000 },
    );
    await immersiveEntry.click();
    await overlay.waitFor({ state: "visible", timeout: 5_000 });
    const keptPlayingInFullscreen = await videoImmersive.page.waitForFunction(
      () => {
        const root = document.querySelector(".journey-story-fullscreen");
        const navPlay = document.querySelector(".journey-story-fullscreen__nav button[aria-pressed]");
        return Boolean(root?.classList.contains("is-playing") && navPlay?.getAttribute("aria-pressed") === "true");
      },
      undefined,
      { timeout: 3_000 },
    ).then(() => true).catch(() => false);
    await videoImmersive.page.evaluate(() => window.history.back());
    await overlay.waitFor({ state: "hidden", timeout: 5_000 });
    const keptPlayingAfterExit = await videoImmersive.page.waitForFunction(
      () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "true",
      undefined,
      { timeout: 3_000 },
    ).then(() => true).catch(() => false);

    const videoImmersiveFailed = !currentIsVideo
      || !entryReachableInViewer
      || !videoOpenedFullscreen
      || !enteredImmersive
      || !stayedPausedOnEntry
      || !keptPlayingInFullscreen
      || !keptPlayingAfterExit
      || videoImmersive.consoleErrors.length > 0
      || videoImmersive.pageErrors.length > 0;
    checks.push({
      name: "story-mobile-viewer-immersive-entry-video",
      currentIsVideo,
      entryReachableInViewer,
      videoOpenedFullscreen,
      enteredImmersive,
      stayedPausedOnEntry,
      keptPlayingInFullscreen,
      keptPlayingAfterExit,
      consoleErrors: videoImmersive.consoleErrors,
      pageErrors: videoImmersive.pageErrors,
      failed: videoImmersiveFailed,
    });
    if (videoImmersiveFailed) failed = true;
  } finally {
    await videoImmersive.page.close();
  }

  for (const [label, viewport] of [
    ["320", { width: 320, height: 700 }],
    ["360", { width: 360, height: 780 }],
    ["390", { width: 390, height: 844 }],
    ["430", { width: 430, height: 900 }],
  ]) {
    const mobileContinuity = await createQaPage("/?qaState=journey-story", onePixelGif, {
      mobile: true,
      blockedReadAssetId: "00000000-0000-4000-8000-000000000101",
      reducedMotion: "no-preference",
      viewport,
    });
    try {
      const stage = mobileContinuity.page.locator(".journey-story__media");
      await stage.waitFor({ state: "visible" });
      const base = stage.locator(storyCurrentMediaSelector).first();
      await base.waitFor({ state: "visible", timeout: 3_000 });
      const beforeLabel = (await base.getAttribute("alt")) ?? (await base.getAttribute("src"));
      const initialRailState = await mobileContinuity.page.evaluate(({ pagesSelector, currentMediaSelector, pageNames }) => {
        const root = document.querySelector(pagesSelector);
        if (!root) return null;
        const wrappers = [...root.querySelectorAll("[data-media-page]")];
        const current = root.querySelector('[data-media-page="current"]');
        const next = root.querySelector('[data-media-page="next"]');
        const nextImage = next?.querySelector("img") ?? null;
        window.__qaStoryMediaPageNodes = wrappers;
        window.__qaStoryNextImageNode = nextImage;
        return {
          wrapperCount: wrappers.length,
          roles: wrappers.map((element) => element.getAttribute("data-media-page")),
          ids: wrappers.map((element) => element.getAttribute("data-media-page-id")),
          pageOffsets: wrappers.map((element) => getComputedStyle(element).getPropertyValue("--page-offset").trim()),
          currentId: current?.getAttribute("data-media-page-id") ?? null,
          currentReady: current?.getAttribute("data-media-page-ready") === "true",
          nextImageId: nextImage?.getAttribute("data-shared-media-id") ?? null,
          pageNames,
          legacyIncomingCount: root.querySelectorAll(".journey-story__media-incoming").length,
        };
      }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector, pageNames: storyFixedPageNames });
      const box = await stage.boundingBox();
      if (!box) throw new Error(`mobile continuity ${label}: stage has no bounds`);
      const startX = box.x + box.width * 0.72;
      const y = box.y + box.height * 0.5;
      await stage.dispatchEvent("pointerdown", {
        pointerId: 41,
        pointerType: "touch",
        isPrimary: true,
        clientX: startX,
        clientY: y,
        bubbles: true,
      });
      // See the earlier comment: the live-drag gesture needs a pointermove
      // to resolve a neighbor and commit at all.
      await stage.dispatchEvent("pointermove", {
        pointerId: 41,
        pointerType: "touch",
        isPrimary: true,
        clientX: startX - 110,
        clientY: y,
        bubbles: true,
      });
      const dragState = await mobileContinuity.page.evaluate(({ pagesSelector }) => {
        const root = document.querySelector(pagesSelector);
        if (!root) return null;
        const wrappers = [...root.querySelectorAll("[data-media-page]")];
        const current = root.querySelector('[data-media-page="current"]');
        const next = root.querySelector('[data-media-page="next"]');
        const readTransform = (element) => element ? getComputedStyle(element).transform : null;
        const currentTransform = readTransform(current);
        const nextTransform = readTransform(next);
        const nextImage = next?.querySelector("img") ?? null;
        return {
          fixedWrapperIdentity: wrappers.length === 3
            && wrappers.every((element, index) => window.__qaStoryMediaPageNodes?.[index] === element),
          currentId: current?.getAttribute("data-media-page-id") ?? null,
          nextId: next?.getAttribute("data-media-page-id") ?? null,
          pageOffsets: wrappers.map((element) => getComputedStyle(element).getPropertyValue("--page-offset").trim()),
          currentTransform,
          nextTransform,
          currentTransformActive: Boolean(currentTransform && currentTransform !== "none"),
          nextTransformActive: Boolean(nextTransform && nextTransform !== "none"),
          dragOffset: getComputedStyle(root).getPropertyValue("--story-drag-x").trim(),
          dragOffsetActive: getComputedStyle(root).getPropertyValue("--story-drag-x").trim() !== ""
            && getComputedStyle(root).getPropertyValue("--story-drag-x").trim() !== "0px",
          nextImageSameNode: !window.__qaStoryNextImageNode || window.__qaStoryNextImageNode === nextImage,
          nextImageMounted: Boolean(nextImage),
          animationCount: typeof root.getAnimations === "function" ? root.getAnimations({ subtree: true }).length : null,
          animationNames: typeof root.getAnimations === "function"
            ? root.getAnimations({ subtree: true }).map((animation) => animation.animationName ?? null)
            : [],
          legacyIncomingCount: root.querySelectorAll(".journey-story__media-incoming").length,
        };
      }, { pagesSelector: storyMediaPagesSelector });
      await stage.dispatchEvent("pointerup", {
        pointerId: 41,
        pointerType: "touch",
        isPrimary: true,
        clientX: startX - 110,
        clientY: y,
        bubbles: true,
      });
      await mobileContinuity.page.waitForTimeout(60);
      const blockedState = await mobileContinuity.page.evaluate(({ pagesSelector, currentMediaSelector }) => {
        const root = document.querySelector(pagesSelector);
        const current = root?.querySelector('[data-media-page="current"]');
        const media = document.querySelector(currentMediaSelector);
        return {
          currentId: current?.getAttribute("data-media-page-id") ?? null,
          currentReady: current?.getAttribute("data-media-page-ready") === "true",
          mediaLabel: media?.getAttribute("alt") ?? media?.getAttribute("src") ?? null,
          targetReadyCount: root?.querySelectorAll('[data-media-page][data-media-page-ready="true"]').length ?? 0,
          legacyIncomingCount: root?.querySelectorAll(".journey-story__media-incoming").length ?? 0,
        };
      }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector });
      const oldFrameHeldDuringRead = blockedState?.mediaLabel === beforeLabel;
      const currentNotPromotedWhileReadBlocked = blockedState?.currentId === initialRailState?.currentId;
      mobileContinuity.releaseBlockedRead();
      const settledState = await mobileContinuity.page.waitForFunction(({ pagesSelector, currentMediaSelector, currentId, targetId }) => {
        const root = document.querySelector(pagesSelector);
        const current = root?.querySelector('[data-media-page="current"]');
        const media = document.querySelector(currentMediaSelector);
        const target = [...(root?.querySelectorAll("[data-media-page]") ?? [])]
          .find((page) => page.getAttribute("data-media-page-id") === targetId);
        const stillOld = current?.getAttribute("data-media-page-id") === currentId
          && media?.getAttribute("data-shared-media-id") === currentId
          && root?.getAttribute("data-media-presentation") === "settled";
        if (stillOld && target?.getAttribute("data-media-page-ready") === "true") {
          window.__qaColdNeighbourStableFrames = (window.__qaColdNeighbourStableFrames ?? 0) + 1;
        } else {
          window.__qaColdNeighbourStableFrames = 0;
        }
        return (window.__qaColdNeighbourStableFrames ?? 0) >= 3;
      }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector, currentId: "00000000-0000-4000-8000-000000000100", targetId: "00000000-0000-4000-8000-000000000101" }, { polling: "raf", timeout: 3_000 })
        .then(() => mobileContinuity.page.evaluate(({ pagesSelector, currentMediaSelector }) => {
          const root = document.querySelector(pagesSelector);
          const wrappers = [...(root?.querySelectorAll("[data-media-page]") ?? [])];
          const current = root?.querySelector('[data-media-page="current"]');
          const next = root?.querySelector('[data-media-page="next"]');
          const media = document.querySelector(currentMediaSelector);
          const readTransform = (element) => element ? getComputedStyle(element).transform : null;
          const animationList = typeof root?.getAnimations === "function"
            ? root.getAnimations({ subtree: true })
            : [];
          const nextImage = next?.querySelector("img") ?? null;
          return {
            fixedWrapperIdentity: wrappers.length === 3
              && wrappers.every((element, index) => window.__qaStoryMediaPageNodes?.[index] === element),
            currentId: current?.getAttribute("data-media-page-id") ?? null,
            currentReady: current?.getAttribute("data-media-page-ready") === "true",
            mediaId: media?.getAttribute("data-shared-media-id") ?? null,
            mediaLabel: media?.getAttribute("alt") ?? media?.getAttribute("src") ?? null,
            targetReady: [...(root?.querySelectorAll("[data-media-page]") ?? [])]
              .some((page) => page.getAttribute("data-media-page-id") === "00000000-0000-4000-8000-000000000101"
                && page.getAttribute("data-media-page-ready") === "true"),
            presentation: root?.getAttribute("data-media-presentation") ?? null,
            currentTransform: readTransform(current),
            nextTransform: readTransform(next),
            pageOffsets: wrappers.map((element) => getComputedStyle(element).getPropertyValue("--page-offset").trim()),
            nextImageSameNode: !window.__qaStoryNextImageNode || window.__qaStoryNextImageNode === nextImage,
            animationCount: animationList.length,
            animationNames: animationList.map((animation) => animation.animationName ?? null),
            legacyIncomingCount: root?.querySelectorAll(".journey-story__media-incoming").length ?? 0,
          };
        }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector }))
        .catch(() => null);
      const dragOffsetActive = Boolean(dragState?.dragOffsetActive);
      const transformFollowedPointer = Boolean(
        dragState?.currentTransformActive || dragState?.nextTransformActive || dragOffsetActive,
      );
      const initialRailShapeValid = Boolean(
        initialRailState
        && initialRailState.wrapperCount === 3
        && initialRailState.roles.filter((role) => role === "current").length === 1
        && initialRailState.roles.every((role) => storyFixedPageNames.includes(role))
        && initialRailState.currentId === "00000000-0000-4000-8000-000000000100"
        && initialRailState.ids.some((id, index) => (
          id === "00000000-0000-4000-8000-000000000101"
          && Number(initialRailState.pageOffsets?.[index]) === 1
        )),
      );
      const continuityFailed = !oldFrameHeldDuringRead
        || !currentNotPromotedWhileReadBlocked
        || !initialRailShapeValid
        || !initialRailState.pageOffsets?.some((offset) => Number(offset) === 0)
        || !dragState?.fixedWrapperIdentity
        || !dragState?.nextImageSameNode
        || !dragState?.pageOffsets?.every((offset) => offset !== "")
        || !transformFollowedPointer
        || !settledState?.fixedWrapperIdentity
        || settledState.currentId !== "00000000-0000-4000-8000-000000000100"
        || settledState.mediaId !== "00000000-0000-4000-8000-000000000100"
        || settledState.currentReady !== true
        || settledState.targetReady !== true
        || settledState.presentation !== "settled"
        || !settledState.nextImageSameNode
        || settledState.legacyIncomingCount !== 0
        || mobileContinuity.consoleErrors.length > 0
        || mobileContinuity.pageErrors.length > 0;
      checks.push({
        name: `story-mobile-swipe-compositor-continuity-${label}`,
        oldFrameHeldDuringRead,
        currentNotPromotedWhileReadBlocked,
        initialRail: initialRailState,
        blocked: blockedState,
        drag: dragState,
        dragOffsetActive,
        transformFollowedPointer,
        settled: settledState,
        consoleErrors: mobileContinuity.consoleErrors,
        pageErrors: mobileContinuity.pageErrors,
        failed: continuityFailed,
      });
      if (continuityFailed) failed = true;
    } finally {
      await mobileContinuity.page.close();
    }
  }

  // Real deployments re-sign the same asset. A fixed URL plus three photos
  // concealed reloads at every handoff and focus loss when slots are recycled.
  const manyPhotoPaths = ["hokusai-wave", "greek-amphora", "monet-water-lilies",
    "woman-power-poster", "stieglitz-hand-of-man", "han-dancer", "mughal-akbarnama", "egypt-coffin"];
  const manyPhotos = await createQaPage("/?qaState=journey-story&qaMode=many-media",
    (url) => `/artworks/${manyPhotoPaths[Number(url.match(/assets\/[^/]*(\d{3})\/read-url/)?.[1]) - 100]}.jpg`,
    { mobile: false, reducedMotion: "no-preference", rotateReadUrls: true, recordMotion: true });
  try {
    const idFor = (index) => `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
    await waitForStoryPicture(manyPhotos.page, idFor(0));
    await manyPhotos.page.evaluate(() => {
      const root = document.querySelector(".journey-story__media [data-story-media-pages]");
      window.__qaManyPhotoNodes = [...root.querySelectorAll("[data-media-page]")];
      window.__qaManyPhotoReloads = [];
      const aperture = { boundaries: 0, jumps: [], samples: 0, maxBoundaryDelta: 0 };
      let previous = new Map();
      let lastTime = performance.now();
      const sample = (now) => {
        const next = new Map();
        for (const node of root.querySelectorAll("[data-media-page-id]")) {
          const clip = getComputedStyle(node).clipPath.match(/[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [0, 0];
          const state = { clip: [clip[0], clip[1] ?? clip[0]],
            role: `${node.dataset.mediaPage}:${node.dataset.mediaIncoming ?? "false"}` };
          const before = previous.get(node.dataset.mediaPageId);
          if (before && before.role !== state.role && now - lastTime < 80) {
            aperture.boundaries += 1;
            const delta = Math.max(...state.clip.map((value, index) => Math.abs(value - before.clip[index])));
            aperture.maxBoundaryDelta = Math.max(aperture.maxBoundaryDelta, delta);
            // At role handoff a retained photograph must not abruptly open or
            // recrop. Allow actual spring travel during the sampled interval.
            if (delta > Math.max(2, (now - lastTime) * .16)) aperture.jumps.push({ delta, elapsed: now - lastTime });
          }
          next.set(node.dataset.mediaPageId, state);
        }
        aperture.samples += 1;
        previous = next;
        lastTime = now;
        window.__qaApertureFrame = requestAnimationFrame(sample);
      };
      window.__qaAperture = aperture;
      sample(performance.now());
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const image = record.target;
          const before = record.oldValue;
          const after = image.getAttribute("src");
          if (before && after && before !== after
            && new URL(before, location.href).pathname === new URL(after, location.href).pathname) {
            window.__qaManyPhotoReloads.push(image.parentElement.dataset.mediaPageId);
          }
        }
      });
      observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["src"], attributeOldValue: true });
    });
    await storyPicture(manyPhotos.page).focus();
    for (const index of [1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0]) {
      const current = Number((await storyPicture(manyPhotos.page).getAttribute("data-shared-media-id")).slice(-3)) - 100;
      // Do not refocus the new slot: subsequent keys must work as typed by a user.
      await manyPhotos.page.keyboard.press(index > current ? "ArrowRight" : "ArrowLeft");
      await waitForStoryPicture(manyPhotos.page, idFor(index));
    }
    await clickStoryPicture(manyPhotos.page, 1);
    await waitForStoryPicture(manyPhotos.page, idFor(1));
    await manyPhotos.page.keyboard.press("ArrowRight");
    await waitForStoryPicture(manyPhotos.page, idFor(2));
    const stable = await manyPhotos.page.evaluate(() => {
      cancelAnimationFrame(window.__qaApertureFrame);
      const root = document.querySelector(".journey-story__media [data-story-media-pages]");
      return { reloads: window.__qaManyPhotoReloads,
        aperture: window.__qaAperture,
        sameSlots: [...root.querySelectorAll("[data-media-page]")].every((node, index) => node === window.__qaManyPhotoNodes[index]),
        focusOnCurrent: document.activeElement === root.querySelector('[data-media-page="current"] img') };
    });
    const requests = Object.fromEntries(manyPhotos.readRequests);
    const regressionFailed = stable.reloads.length > 0 || !stable.sameSlots || !stable.focusOnCurrent
      || Object.keys(requests).length !== 8 || Object.values(requests).some((count) => count !== 1)
      || manyPhotos.consoleErrors.length > 0 || manyPhotos.pageErrors.length > 0;
    checks.push({ name: "story-eight-photos-signed-read-cache-and-continuous-focus", ...stable, requests, failed: regressionFailed });
    if (regressionFailed) failed = true;
    const apertureFailed = stable.aperture.boundaries < 12 || stable.aperture.jumps.length > 0;
    checks.push({ name: "story-mixed-aspect-aperture-continuity", ...stable.aperture, failed: apertureFailed });
    if (apertureFailed) failed = true;
  } finally {
    const video = manyPhotos.page.video();
    await manyPhotos.page.close();
    if (video) { await video.saveAs(`${motionArtifactDir}/story-mixed-aspect.webm`); await video.delete(); }
  }

  // Only this existing desktop motion scenario records; the many transport and
  // reduced-motion checks retain their tiny deterministic fixtures.
  const mediaContinuity = await createQaPage("/?qaState=journey-story", captureMotion
    ? (url) => motionPhotos[Number(url.match(/assets\/[^/]*(\d{3})\/read-url/)?.[1] ?? 100) % motionPhotos.length]
    : onePixelGif, {
    mobile: false,
    reducedMotion: "no-preference",
    recordMotion: true,
  });
  try {
    await mediaContinuity.page.locator(".journey-story").waitFor({ state: "visible" });
    if (captureMotion) {
      await waitForStoryPicture(mediaContinuity.page, "00000000-0000-4000-8000-000000000100");
      await mediaContinuity.page.screenshot({ path: `${motionArtifactDir}/story-stack-before.png`, animations: "allow" });
    }
    const initialRailState = await mediaContinuity.page.evaluate(({ pagesSelector }) => {
      const root = document.querySelector(pagesSelector);
      const wrappers = [...(root?.querySelectorAll("[data-media-page]") ?? [])];
      window.__qaStoryMediaPageNodes = wrappers;
      return {
        wrapperCount: wrappers.length,
        roles: wrappers.map((element) => element.getAttribute("data-media-page")),
        currentId: root?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id") ?? null,
      };
    }, { pagesSelector: storyMediaPagesSelector });
    await clickStoryPicture(mediaContinuity.page, 1);
    const settledState = await mediaContinuity.page.waitForFunction(({ pagesSelector, currentMediaSelector, targetId }) => {
      const root = document.querySelector(pagesSelector);
      const current = root?.querySelector('[data-media-page="current"]');
      const media = document.querySelector(currentMediaSelector);
      return current?.getAttribute("data-media-page-id") === targetId
        && current?.getAttribute("data-media-page-ready") === "true"
        && media?.getAttribute("data-shared-media-id") === targetId;
    }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector, targetId: "00000000-0000-4000-8000-000000000101" }, { polling: "raf", timeout: 3_000 })
      .then(() => mediaContinuity.page.evaluate(({ pagesSelector, currentMediaSelector }) => {
        const root = document.querySelector(pagesSelector);
        const wrappers = [...(root?.querySelectorAll("[data-media-page]") ?? [])];
        const current = root?.querySelector('[data-media-page="current"]');
        const media = document.querySelector(currentMediaSelector);
        const animations = typeof root?.getAnimations === "function"
          ? root.getAnimations({ subtree: true })
          : [];
        return {
          fixedWrapperIdentity: wrappers.length === 3
            && wrappers.every((element, index) => window.__qaStoryMediaPageNodes?.[index] === element),
          currentId: current?.getAttribute("data-media-page-id") ?? null,
          currentReady: current?.getAttribute("data-media-page-ready") === "true",
          mediaId: media?.getAttribute("data-shared-media-id") ?? null,
          presentation: root?.getAttribute("data-media-presentation") ?? null,
          tagName: media?.tagName ?? null,
          transform: current ? getComputedStyle(current).transform : null,
          transition: current ? getComputedStyle(current).transition : null,
          animationCount: animations.length,
          animationNames: animations.map((animation) => animation.animationName ?? null),
          complete: media instanceof HTMLImageElement ? media.complete : true,
          legacyIncomingCount: root?.querySelectorAll(".journey-story__media-incoming").length ?? 0,
        };
      }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector }))
      .catch(() => null);
    const uniqueStoryVideoCount = await mediaContinuity.page.locator(`${storyMediaPagesSelector} video`).count();
    const continuityFailed = !initialRailState
      || initialRailState.wrapperCount !== 3
      || !settledState?.fixedWrapperIdentity
      || settledState.currentId !== "00000000-0000-4000-8000-000000000101"
      || settledState.currentReady !== true
      || settledState.mediaId !== "00000000-0000-4000-8000-000000000101"
      || settledState.presentation !== "settled"
      || settledState.legacyIncomingCount !== 0
      || uniqueStoryVideoCount > 1
      || !settledState.complete
      || mediaContinuity.consoleErrors.length > 0
      || mediaContinuity.pageErrors.length > 0;
    checks.push({
      name: "story-media-switch-dom-continuity",
      initialRail: initialRailState,
      settled: settledState,
      uniqueStoryVideoCount,
      consoleErrors: mediaContinuity.consoleErrors,
      pageErrors: mediaContinuity.pageErrors,
      failed: continuityFailed,
    });
    if (continuityFailed) failed = true;
    if (captureMotion) await mediaContinuity.page.screenshot({ path: `${motionArtifactDir}/story-stack-next.png`, animations: "allow" });
    {
      await clickStoryPicture(mediaContinuity.page, -1);
      await waitForStoryPicture(mediaContinuity.page, "00000000-0000-4000-8000-000000000100");
      if (captureMotion) await mediaContinuity.page.screenshot({ path: `${motionArtifactDir}/story-stack-return.png`, animations: "allow" });
      await mediaContinuity.page.evaluate((selector) => {
        const root = document.querySelector(selector);
        const trace = { maxPages: 0, maxVideos: 0 };
        const sample = () => {
          trace.maxPages = Math.max(trace.maxPages, root.querySelectorAll("[data-media-page]").length);
          trace.maxVideos = Math.max(trace.maxVideos, root.querySelectorAll("video").length);
        };
        sample();
        const observer = new MutationObserver(sample);
        observer.observe(root, { childList: true, subtree: true });
        window.__qaMotionNodeTrace = { trace, observer };
      }, storyMediaPagesSelector);
      const edgeRegrab = await exerciseStoryEdgeRegrab(mediaContinuity.page);
      checks.push({ name: "story-boundary-spring-regrab-keeps-visible-pixels", ...edgeRegrab });
      if (edgeRegrab.failed) failed = true;
      // Reverse through actual picture clicks while motion is still running;
      // the recording preserves those frames without pausing any animation.
      const forwardPoint = await storyPicturePoint(mediaContinuity.page, 1);
      const reversePoint = await storyPicturePoint(mediaContinuity.page, -1);
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await clickStoryPicture(mediaContinuity.page, 1, ".journey-story__media", forwardPoint);
        await mediaContinuity.page.waitForFunction((selector) => document.querySelector(selector)
          ?.getAttribute("data-media-presentation") === "moving", storyMediaPagesSelector, { polling: "raf", timeout: 3_000 });
        await clickStoryPicture(mediaContinuity.page, -1, ".journey-story__media", reversePoint);
        await waitForStoryPicture(mediaContinuity.page, "00000000-0000-4000-8000-000000000100");
      }
      // At the boundary the second click has no further semantic target. It
      // must still leave the in-flight last-page spring free to finish.
      await clickStoryPicture(mediaContinuity.page, 1, ".journey-story__media", forwardPoint);
      await waitForStoryPicture(mediaContinuity.page, "00000000-0000-4000-8000-000000000101");
      const boundaryPoint = await storyPicturePoint(mediaContinuity.page, 1);
      await clickStoryPicture(mediaContinuity.page, 1, ".journey-story__media", boundaryPoint);
      await mediaContinuity.page.waitForFunction((selector) => document.querySelector(selector)
        ?.getAttribute("data-media-presentation") === "moving", storyMediaPagesSelector, { polling: "raf", timeout: 3_000 });
      await clickStoryPicture(mediaContinuity.page, 1, ".journey-story__media", boundaryPoint);
      await waitForStoryPicture(mediaContinuity.page, "00000000-0000-4000-8000-000000000102");
      checks.push({ name: "story-stable-hit-surface-repeated-boundary-click", settledAsset: "00000000-0000-4000-8000-000000000102", failed: false });
      const nodeTrace = await mediaContinuity.page.evaluate((selector) => {
        const { trace, observer } = window.__qaMotionNodeTrace;
        observer.disconnect();
        const pages = [...document.querySelector(selector).querySelectorAll("[data-media-page]")];
        return { ...trace, samePhysicalPages: pages.length === 3
          && pages.every((node, index) => node === window.__qaStoryMediaPageNodes[index]) };
      }, storyMediaPagesSelector);
      const traceFailed = nodeTrace.maxPages !== 3 || nodeTrace.maxVideos > 1 || !nodeTrace.samePhysicalPages;
      checks.push({ name: "story-stable-hit-surface-rapid-reverse-node-stability", ...nodeTrace, failed: traceFailed });
      if (traceFailed) failed = true;
      if (captureMotion) await mediaContinuity.page.screenshot({ path: `${motionArtifactDir}/story-stack-boundary-settled.png`, animations: "allow" });
    }
  } finally {
    const video = mediaContinuity.page.video();
    await mediaContinuity.page.close();
    if (video) {
      await video.saveAs(`${motionArtifactDir}/story-stack-switch.webm`);
      await video.delete();
    }
  }

  const reducedMotionStory = await createQaPage("/?qaState=journey-story", onePixelGif, {
    mobile: true,
    reducedMotion: "reduce",
  });
  try {
    await reducedMotionStory.page.locator(".journey-story").waitFor({ state: "visible" });
    const reducedInitial = await reducedMotionStory.page.evaluate(({ pagesSelector }) => {
      const root = document.querySelector(pagesSelector);
      const pages = [...(root?.querySelectorAll("[data-media-page]") ?? [])];
      window.__qaStoryReducedPageNodes = pages;
      return { count: pages.length, currentId: root?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id") ?? null };
    }, { pagesSelector: storyMediaPagesSelector });
    await reducedMotionStory.page.getByRole("button", { name: "查看第 2 个照片：seed-1.png", exact: true }).click();
    const reducedState = await reducedMotionStory.page.waitForFunction(({ pagesSelector, currentMediaSelector, targetId }) => {
      const root = document.querySelector(pagesSelector);
      const current = root?.querySelector('[data-media-page="current"]');
      const media = document.querySelector(currentMediaSelector);
      return current?.getAttribute("data-media-page-id") === targetId
        && current?.getAttribute("data-media-page-ready") === "true"
        && media?.getAttribute("data-shared-media-id") === targetId;
    }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector, targetId: "00000000-0000-4000-8000-000000000101" }, { polling: "raf", timeout: 3_000 })
      .then(() => reducedMotionStory.page.evaluate(({ pagesSelector }) => {
        const root = document.querySelector(pagesSelector);
        const current = root?.querySelector('[data-media-page="current"]');
        const pages = [...(root?.querySelectorAll("[data-media-page]") ?? [])];
        const transform = current ? getComputedStyle(current).transform : "none";
        const transformX = transform !== "none" ? new DOMMatrixReadOnly(transform).e : 0;
        const animations = typeof root?.getAnimations === "function" ? root.getAnimations({ subtree: true }) : [];
        return {
          currentId: current?.getAttribute("data-media-page-id") ?? null,
          currentReady: current?.getAttribute("data-media-page-ready") === "true",
          fixedWrapperIdentity: pages.length === 3
            && pages.every((page, index) => window.__qaStoryReducedPageNodes?.[index] === page),
          animationCount: animations.length,
          transform,
          transformX,
          legacyIncomingCount: root?.querySelectorAll(".journey-story__media-incoming").length ?? 0,
        };
      }, { pagesSelector: storyMediaPagesSelector }))
      .catch(() => null);
    const reducedMotionFailed = reducedInitial?.count !== 3
      || reducedState?.currentId !== "00000000-0000-4000-8000-000000000101"
      || reducedState?.currentReady !== true
      || !reducedState?.fixedWrapperIdentity
      || reducedState?.animationCount !== 0
      || Math.abs(reducedState?.transformX ?? Number.POSITIVE_INFINITY) > 1
      || reducedState?.legacyIncomingCount !== 0
      || reducedMotionStory.consoleErrors.length > 0
      || reducedMotionStory.pageErrors.length > 0;
    checks.push({
      name: "story-media-pages-reduced-motion",
      initial: reducedInitial,
      settled: reducedState,
      failed: reducedMotionFailed,
      consoleErrors: reducedMotionStory.consoleErrors,
      pageErrors: reducedMotionStory.pageErrors,
    });
    if (reducedMotionFailed) failed = true;
  } finally {
    await reducedMotionStory.page.close();
  }

  // Cold-media race: the fixture's middle asset is held at the signed-read
  // boundary while the user reverses the navigation. The late read may settle
  // in the cache, but it must not promote the stale next target over the
  // user's reverse input.
  const coldMediaRaceTargetId = "00000000-0000-4000-8000-000000000101";
  const coldMediaRaceReadDelayMs = 80;
  const coldMediaRace = await createQaPage("/?qaState=journey-story", onePixelGif, {
    mobile: false,
    blockedReadAssetId: coldMediaRaceTargetId,
    readDelayMs: coldMediaRaceReadDelayMs,
    reducedMotion: "reduce",
  });
  try {
    // The target read is blocked until after the reverse click, so this probe
    // can observe the target image's actual browser decode completion. Waiting
    // on the API response alone would let the assertion pass before the
    // decode-settle effect has had a chance to process the late target.
    const coldDecodeProbeInstalled = await coldMediaRace.page.evaluate(() => {
      const originalDecode = HTMLImageElement.prototype.decode;
      if (typeof originalDecode !== "function") return false;
      window.__qaImageDecodeCompletions = 0;
      window.__qaImageDecodeFailures = 0;
      HTMLImageElement.prototype.decode = function qaDecodeProbe() {
        return Promise.resolve(originalDecode.call(this)).then(
          (value) => {
            window.__qaImageDecodeCompletions += 1;
            return value;
          },
          (error) => {
            window.__qaImageDecodeFailures += 1;
            throw error;
          },
        );
      };
      return true;
    });
    const coldStage = coldMediaRace.page.locator(".journey-story__media");
    const coldSettled = coldStage.locator(storyCurrentMediaSelector).first();
    await coldMediaRace.page.locator(".journey-story").waitFor({ state: "visible" });
    const initialSettledAtFirstAsset = await coldMediaRace.page.waitForFunction(({ pagesSelector, currentMediaSelector, expectedId, expectedLabel }) => {
      const root = document.querySelector(pagesSelector);
      const current = root?.querySelector('[data-media-page="current"]');
      const settled = document.querySelector(currentMediaSelector);
      return current?.getAttribute("data-media-page-id") === expectedId
        && current?.getAttribute("data-media-page-ready") === "true"
        && settled?.getAttribute("data-shared-media-id") === expectedId
        && settled?.getAttribute("alt") === expectedLabel;
    }, {
      pagesSelector: storyMediaPagesSelector,
      currentMediaSelector: storyCurrentMediaSelector,
      expectedId: "00000000-0000-4000-8000-000000000100",
      expectedLabel: "seed-0.png",
    }, { timeout: 3_000 }).then(() => true).catch(() => false);
    const initialDecodeSettled = coldDecodeProbeInstalled
      ? await coldMediaRace.page.evaluate(async () => {
        const root = document.querySelector("[data-story-media-pages]");
        const settled = root?.querySelector('[data-media-page="current"] [data-shared-media-id]');
        if (!(settled instanceof HTMLImageElement)) return false;
        await settled.decode();
        return true;
      }).catch(() => false)
      : false;

    await clickStoryPicture(coldMediaRace.page, 1);

    // The reverse action must become available while the next signed read is
    // still blocked. This is the user input that makes the response stale.
    const reversePoint = await storyPicturePoint(coldMediaRace.page, -1);
    await coldMediaRace.page.mouse.move(reversePoint.x, reversePoint.y);
    const reverseEnabledDuringBlockedRead = await coldMediaRace.page.waitForFunction(() => {
      const root = document.querySelector(".journey-story__media [data-story-media-pages]");
      return root?.getAttribute("data-click-direction") === "previous";
    }, undefined, { timeout: 1_500 }).then(() => true).catch(() => false);
    let reverseClickIssued = false;
    if (reverseEnabledDuringBlockedRead) {
      await coldMediaRace.page.mouse.click(reversePoint.x, reversePoint.y);
      reverseClickIssued = true;
    }

    // Start observing before release so the assertion covers the delayed
    // response itself rather than only a fixed wall-clock pause.
    const lateReadResponse = coldMediaRace.page.waitForResponse(
      (response) => response.url().includes(`/assets/${coldMediaRaceTargetId}/read-url`),
      { timeout: 3_000 },
    ).then(() => true).catch(() => false);
    const coldDecodeCompletionsBeforeRelease = coldDecodeProbeInstalled
      ? await coldMediaRace.page.evaluate(() => window.__qaImageDecodeCompletions ?? 0)
      : null;
    coldMediaRace.releaseBlockedRead();
    const coldReadResponseObserved = await lateReadResponse;
    const coldDecodeCompletedAfterLateRead = coldDecodeProbeInstalled
      ? await coldMediaRace.page.waitForFunction((before) => (
        (window.__qaImageDecodeCompletions ?? 0) > before
      ), coldDecodeCompletionsBeforeRelease, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false)
      : false;
    const finalSettledAtOriginal = coldDecodeCompletedAfterLateRead
      ? await coldMediaRace.page.waitForFunction(({ pagesSelector, currentMediaSelector, expectedId, expectedLabel }) => {
        const root = document.querySelector(pagesSelector);
        const current = root?.querySelector('[data-media-page="current"]');
        const settled = document.querySelector(currentMediaSelector);
        return current?.getAttribute("data-media-page-id") === expectedId
          && current?.getAttribute("data-media-page-ready") === "true"
          && settled?.getAttribute("data-shared-media-id") === expectedId
          && settled?.getAttribute("alt") === expectedLabel;
      }, {
        pagesSelector: storyMediaPagesSelector,
        currentMediaSelector: storyCurrentMediaSelector,
        expectedId: "00000000-0000-4000-8000-000000000100",
        expectedLabel: "seed-0.png",
      }, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false)
      : false;
    const coldFinalState = await coldSettled.count() > 0
      ? await coldMediaRace.page.evaluate(({ pagesSelector, currentMediaSelector }) => {
        const root = document.querySelector(pagesSelector);
        const current = root?.querySelector('[data-media-page="current"]');
        const element = document.querySelector(currentMediaSelector);
        return {
          id: current?.getAttribute("data-media-page-id") ?? null,
          ready: current?.getAttribute("data-media-page-ready") === "true",
          mediaId: element?.getAttribute("data-shared-media-id") ?? null,
          alt: element?.getAttribute("alt") ?? null,
          pageIds: [...(root?.querySelectorAll("[data-media-page]") ?? [])]
            .map((page) => ({ role: page.getAttribute("data-media-page"), id: page.getAttribute("data-media-page-id") })),
          legacyIncomingCount: root?.querySelectorAll(".journey-story__media-incoming").length ?? 0,
        };
      }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector })
      : null;
    const coldMediaRaceFailed = !initialSettledAtFirstAsset
      || !initialDecodeSettled
      || !reverseEnabledDuringBlockedRead
      || !reverseClickIssued
      || !coldReadResponseObserved
      || !coldDecodeProbeInstalled
      || !coldDecodeCompletedAfterLateRead
      || !finalSettledAtOriginal
      || coldFinalState?.id !== "00000000-0000-4000-8000-000000000100"
      || coldFinalState?.mediaId !== "00000000-0000-4000-8000-000000000100"
      || coldFinalState?.alt !== "seed-0.png"
      || coldFinalState?.ready !== true
      || coldFinalState?.legacyIncomingCount !== 0
      || coldMediaRace.consoleErrors.length > 0
      || coldMediaRace.pageErrors.length > 0;
    checks.push({
      name: "story-cold-media-next-reverse-no-stale-return",
      fixture: {
        initialAssetId: "00000000-0000-4000-8000-000000000100",
        blockedReadAssetId: coldMediaRaceTargetId,
        expectedFinalAssetId: "00000000-0000-4000-8000-000000000100",
        readDelayMs: coldMediaRaceReadDelayMs,
      },
      initialSettledAtFirstAsset,
      initialDecodeSettled,
      reverseEnabledDuringBlockedRead,
      reverseClickIssued,
      coldReadResponseObserved,
      coldDecodeProbeInstalled,
      coldDecodeCompletionsBeforeRelease,
      coldDecodeCompletedAfterLateRead,
      finalSettledAtOriginal,
      final: coldFinalState,
      consoleErrors: coldMediaRace.consoleErrors,
      pageErrors: coldMediaRace.pageErrors,
      failed: coldMediaRaceFailed,
    });
    if (coldMediaRaceFailed) failed = true;
  } finally {
    // Always release the intercepted read before closing the page, including
    // assertion failures, so the route cannot retain an in-flight promise.
    coldMediaRace.releaseBlockedRead();
    await coldMediaRace.page.close();
  }

  // Read/decode completion must not take the current page away from a held
  // pointer. Releasing a small vertical movement consumes the resulting click
  // without changing the latest horizontal navigation intent.
  const heldColdTarget = "00000000-0000-4000-8000-000000000101";
  const heldColdMedia = await createQaPage("/?qaState=journey-story", onePixelGif, {
    mobile: false,
    blockedReadAssetId: heldColdTarget,
    reducedMotion: "no-preference",
  });
  let heldColdPointerDown = false;
  try {
    await waitForStoryPicture(heldColdMedia.page, "00000000-0000-4000-8000-000000000100");
    // Keyboard navigation avoids starting an earlier pointer settle; this
    // pointer-down is the one whose ownership the delayed response challenges.
    await storyPicture(heldColdMedia.page).press("ArrowRight");
    const holdPoint = await storyPicturePoint(heldColdMedia.page, -1);
    await heldColdMedia.page.mouse.move(holdPoint.x, holdPoint.y);
    await heldColdMedia.page.mouse.down();
    heldColdPointerDown = true;
    const heldResponse = heldColdMedia.page.waitForResponse(
      (response) => response.url().includes(`/assets/${heldColdTarget}/read-url`),
      { timeout: 3_000 },
    );
    heldColdMedia.releaseBlockedRead();
    await heldResponse;
    // This is the physical neighbor's real image decode gate, not merely a
    // fulfilled read-url response or a fixed timer.
    await heldColdMedia.page.waitForFunction((targetId) => {
      const root = document.querySelector(".journey-story__media [data-story-media-pages]");
      return [...(root?.querySelectorAll("[data-media-page]") ?? [])].some((page) => (
        page.getAttribute("data-media-page-id") === targetId && page.getAttribute("data-media-page-ready") === "true"
      ));
    }, heldColdTarget, { polling: "raf", timeout: 3_000 });
    const stateWhileHeld = await heldColdMedia.page.evaluate(async () => {
      // Give decode-triggered React effects two rendering opportunities while
      // the real pointer remains down, so an early snapshot cannot hide a race.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const root = document.querySelector(".journey-story__media [data-story-media-pages]");
      return {
        currentId: root?.querySelector('[data-media-page="current"]')?.getAttribute("data-media-page-id"),
        presentation: root?.getAttribute("data-media-presentation"),
        incomingCount: root?.querySelectorAll('[data-media-incoming="true"]').length,
      };
    });
    await heldColdMedia.page.mouse.move(holdPoint.x, holdPoint.y + 12, { steps: 3 });
    await heldColdMedia.page.mouse.up();
    heldColdPointerDown = false;
    const latestTargetAfterRelease = await waitForStoryPicture(heldColdMedia.page, heldColdTarget)
      .then(() => true).catch(() => false);
    const heldColdFailed = stateWhileHeld.currentId !== "00000000-0000-4000-8000-000000000100"
      || stateWhileHeld.presentation !== "settled" || stateWhileHeld.incomingCount !== 0
      || !latestTargetAfterRelease || heldColdMedia.consoleErrors.length > 0 || heldColdMedia.pageErrors.length > 0;
    checks.push({ name: "story-cold-media-ready-during-pointer-hold", stateWhileHeld, latestTargetAfterRelease,
      consoleErrors: heldColdMedia.consoleErrors, pageErrors: heldColdMedia.pageErrors, failed: heldColdFailed });
    if (heldColdFailed) failed = true;
  } finally {
    heldColdMedia.releaseBlockedRead();
    if (heldColdPointerDown) await heldColdMedia.page.mouse.up();
    await heldColdMedia.page.close();
  }

  // Cached normal-motion race: the fixture prefetches the middle asset while A
  // is shown, then the test reverses B after observing actual intermediate
  // pixels. Springs keep running; this contract has no WAAPI object or timer.
  const cachedRapidReverse = await createQaPage("/?qaState=journey-story", onePixelGif, {
    mobile: false,
    readDelayMs: 0,
    reducedMotion: "no-preference",
  });
  try {
    const settledAsset = async (expectedId, expectedLabel) => cachedRapidReverse.page.waitForFunction(({ pagesSelector, currentMediaSelector, assetId, fileName }) => {
      const root = document.querySelector(pagesSelector);
      const current = root?.querySelector('[data-media-page="current"]');
      const settled = document.querySelector(currentMediaSelector);
      return root?.getAttribute("data-media-presentation") === "settled"
        && current?.getAttribute("data-media-page-id") === assetId
        && current?.getAttribute("data-media-page-ready") === "true"
        && settled?.getAttribute("data-shared-media-id") === assetId
        && settled?.getAttribute("alt") === fileName;
    }, {
      pagesSelector: storyMediaPagesSelector,
      currentMediaSelector: storyCurrentMediaSelector,
      assetId: expectedId,
      fileName: expectedLabel,
    }, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
    await cachedRapidReverse.page.locator(".journey-story").waitFor({ state: "visible" });
    const initialShownA = await settledAsset("00000000-0000-4000-8000-000000000100", "seed-0.png");

    let interruptedTransitionState = null;
    let returnedToAAfterReverse = false;
    let returnedState = null;
    let mobileModeEntered = false;
    let mobileDragTransform = null;
    let mobileDragSettled = false;
    let desktopModeRestored = false;
    let nextAfterReverseTargetReady = false;
    let nextAfterReverseSettled = false;
    if (initialShownA) {
      const forward = await storyPicturePoint(cachedRapidReverse.page, 1);
      const reverse = await storyPicturePoint(cachedRapidReverse.page, -1);
      const initialBounds = await cachedRapidReverse.page.locator(`.journey-story__media ${storyCurrentPageSelector}`)
        .evaluate((element) => element.getBoundingClientRect().toJSON());
      await clickStoryPicture(cachedRapidReverse.page, 1, ".journey-story__media", forward);
      try {
        const movingHandle = await cachedRapidReverse.page.waitForFunction(({ pagesSelector, initialBounds }) => {
          const root = document.querySelector(pagesSelector);
          if (root?.getAttribute("data-media-presentation") !== "moving") return false;
          const target = [...(root?.querySelectorAll("[data-media-page]") ?? [])]
            .find((page) => page.getAttribute("data-media-page-id") === "00000000-0000-4000-8000-000000000101");
          if (!target || target.getAttribute("data-media-page-ready") !== "true") return false;
          const current = root.querySelector('[data-media-page="current"]');
          if (!current) return false;
          const bounds = current.getBoundingClientRect();
          const movement = Math.max(...["x", "y", "width", "height"].map((key) => Math.abs(bounds[key] - initialBounds[key])));
          if (movement <= 1) return false;
          return {
            targetId: target.getAttribute("data-media-page-id"),
            targetReady: target.getAttribute("data-media-page-ready") === "true",
            currentId: current.getAttribute("data-media-page-id"),
            presentation: root.getAttribute("data-media-presentation"),
            movement,
            transform: getComputedStyle(target).transform,
            currentBounds: bounds.toJSON(),
          };
        }, { pagesSelector: storyMediaPagesSelector, initialBounds }, { polling: "raf", timeout: 3_000 });
        interruptedTransitionState = await movingHandle.jsonValue();
      } catch {
        interruptedTransitionState = null;
      }

      if (interruptedTransitionState) {
        await clickStoryPicture(cachedRapidReverse.page, -1, ".journey-story__media", reverse);
        returnedToAAfterReverse = await settledAsset("00000000-0000-4000-8000-000000000100", "seed-0.png");
        returnedState = await cachedRapidReverse.page.evaluate(({ pagesSelector, currentMediaSelector }) => {
          const root = document.querySelector(pagesSelector);
          const current = root?.querySelector('[data-media-page="current"]');
          const settled = document.querySelector(currentMediaSelector);
          return {
            id: current?.getAttribute("data-media-page-id") ?? null,
            ready: current?.getAttribute("data-media-page-ready") === "true",
            mediaId: settled?.getAttribute("data-shared-media-id") ?? null,
            alt: settled?.getAttribute("alt") ?? null,
            pageIds: [...(root?.querySelectorAll("[data-media-page]") ?? [])]
              .map((page) => ({ role: page.getAttribute("data-media-page"), id: page.getAttribute("data-media-page-id") })),
            legacyIncomingCount: root?.querySelectorAll(".journey-story__media-incoming").length ?? 0,
          };
        }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector });
      }
    }

    if (returnedToAAfterReverse) {
      await cachedRapidReverse.page.setViewportSize({ width: 390, height: 844 });
      mobileModeEntered = await cachedRapidReverse.page.waitForFunction(() => (
        document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer"
      ), undefined, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
      if (mobileModeEntered) {
        const mobileStage = cachedRapidReverse.page.locator(".journey-story__media");
        const box = await mobileStage.boundingBox();
        if (box) {
          const startX = box.x + box.width * 0.5;
          const startY = box.y + box.height * 0.5;
          let mouseDown = false;
          try {
            await cachedRapidReverse.page.mouse.move(startX, startY);
            await cachedRapidReverse.page.mouse.down();
            mouseDown = true;
            // At the first asset, moving right has no neighbor: the gesture
            // must track the visible base, then spring back to A on release.
            await cachedRapidReverse.page.mouse.move(startX + 80, startY);
            try {
              const transformHandle = await cachedRapidReverse.page.waitForFunction(({ pagesSelector, currentMediaSelector }) => {
                const root = document.querySelector(pagesSelector);
                const current = root?.querySelector('[data-media-page="current"]');
                const base = document.querySelector(currentMediaSelector);
                const transform = current ? getComputedStyle(current).transform : "";
                const transformX = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).e : 0;
                const dragOffset = getComputedStyle(root).getPropertyValue("--story-drag-x").trim();
                const dragOffsetX = Number.parseFloat(dragOffset) || 0;
                return base && current && (Math.abs(transformX) > 1 || Math.abs(dragOffsetX) > 1)
                  ? {
                    alt: base.getAttribute("alt"),
                    id: current.getAttribute("data-media-page-id"),
                    transform,
                    transformX,
                    dragOffset,
                    dragOffsetX,
                  }
                  : false;
              }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector }, { polling: "raf", timeout: 1_500 });
              mobileDragTransform = await transformHandle.jsonValue();
            } catch {
              mobileDragTransform = null;
            }
          } finally {
            if (mouseDown) await cachedRapidReverse.page.mouse.up();
          }
          mobileDragSettled = await cachedRapidReverse.page.waitForFunction(({ pagesSelector, currentMediaSelector }) => {
            const root = document.querySelector(pagesSelector);
            const current = root?.querySelector('[data-media-page="current"]');
            const base = document.querySelector(currentMediaSelector);
            const transform = current ? getComputedStyle(current).transform : "";
            const transformX = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).e : 0;
            const dragOffset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--story-drag-x")) || 0;
            return current?.getAttribute("data-media-page-id") === "00000000-0000-4000-8000-000000000100"
              && base?.getAttribute("data-shared-media-id") === "00000000-0000-4000-8000-000000000100"
              && base?.getAttribute("alt") === "seed-0.png"
              && Math.abs(transformX) < 1
              && Math.abs(dragOffset) < 1
              && (root?.querySelectorAll(".journey-story__media-incoming").length ?? 0) === 0;
          }, { pagesSelector: storyMediaPagesSelector, currentMediaSelector: storyCurrentMediaSelector }, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
        }
      }
      await cachedRapidReverse.page.setViewportSize({ width: 1280, height: 800 });
      desktopModeRestored = await cachedRapidReverse.page.waitForFunction(() => (
        document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === null
      ), undefined, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
    }

    if (returnedToAAfterReverse && mobileDragSettled && desktopModeRestored) {
      await clickStoryPicture(cachedRapidReverse.page, 1);
      nextAfterReverseTargetReady = await cachedRapidReverse.page.waitForFunction(({ pagesSelector, targetId }) => {
        const root = document.querySelector(pagesSelector);
        const target = [...(root?.querySelectorAll("[data-media-page]") ?? [])]
          .find((page) => page.getAttribute("data-media-page-id") === targetId);
        return target?.getAttribute("data-media-page-ready") === "true";
      }, { pagesSelector: storyMediaPagesSelector, targetId: "00000000-0000-4000-8000-000000000101" }, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
      nextAfterReverseSettled = await settledAsset("00000000-0000-4000-8000-000000000101", "seed-1.png");
    }

    const cachedRapidReverseFailed = !initialShownA
      || interruptedTransitionState?.targetId !== "00000000-0000-4000-8000-000000000101"
      || interruptedTransitionState?.targetReady !== true
      || interruptedTransitionState?.currentId !== "00000000-0000-4000-8000-000000000100"
      || interruptedTransitionState?.presentation !== "moving"
      || !(interruptedTransitionState?.movement > 1)
      || !returnedToAAfterReverse
      || returnedState?.id !== "00000000-0000-4000-8000-000000000100"
      || returnedState?.mediaId !== "00000000-0000-4000-8000-000000000100"
      || returnedState?.ready !== true
      || returnedState?.alt !== "seed-0.png"
      || returnedState?.legacyIncomingCount !== 0
      || !mobileModeEntered
      || !mobileDragTransform
      || mobileDragTransform.alt !== "seed-0.png"
      || mobileDragTransform.id !== "00000000-0000-4000-8000-000000000100"
      || !mobileDragSettled
      || !desktopModeRestored
      || !nextAfterReverseTargetReady
      || !nextAfterReverseSettled
      || cachedRapidReverse.consoleErrors.length > 0
      || cachedRapidReverse.pageErrors.length > 0;
    checks.push({
      name: "story-cached-normal-motion-rapid-reverse",
      fixture: {
        initialAssetId: "00000000-0000-4000-8000-000000000100",
        cachedTargetAssetId: "00000000-0000-4000-8000-000000000101",
        expectedReturnedAssetId: "00000000-0000-4000-8000-000000000100",
        expectedNextAssetId: "00000000-0000-4000-8000-000000000101",
      },
      initialShownA,
      interruptedTransition: interruptedTransitionState,
      returnedToAAfterReverse,
      returned: returnedState,
      mobileModeEntered,
      mobileDragTransform,
      mobileDragSettled,
      desktopModeRestored,
      nextAfterReverseTargetReady,
      nextAfterReverseSettled,
      consoleErrors: cachedRapidReverse.consoleErrors,
      pageErrors: cachedRapidReverse.pageErrors,
      failed: cachedRapidReverseFailed,
    });
    if (cachedRapidReverseFailed) failed = true;
  } finally {
    await cachedRapidReverse.page.close();
  }

  const mixedMedia = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif, {
    instrumentMedia: true,
    mixedMedia: true,
    mobile: false,
    reducedMotion: "no-preference",
  });
  try {
    await mixedMedia.page.locator(".journey-story").waitFor({ state: "visible" });
    await clickStoryPicture(mixedMedia.page, 1);
    const stageVideoSettled = await mixedMedia.page.waitForFunction(({ pagesSelector, currentMediaSelector, expectedId }) => {
      const root = document.querySelector(pagesSelector);
      const current = root?.querySelector('[data-media-page="current"]');
      const video = document.querySelector(currentMediaSelector);
      return current?.getAttribute("data-media-page-id") === expectedId
        && current?.getAttribute("data-media-page-ready") === "true"
        && video instanceof HTMLVideoElement
        && video.getAttribute("data-shared-media-id") === expectedId;
    }, {
      pagesSelector: storyMediaPagesSelector,
      currentMediaSelector: storyCurrentMediaSelector,
      expectedId: "00000000-0000-4000-8000-000000000152",
    }, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
    const stageVideoNodeCount = await mixedMedia.page.locator(`.journey-story__media ${storyPersistentVideoSelector}`).count();
    await mixedMedia.page.locator(".journey-story__media").locator(storyCurrentVideoSelector).evaluate((video) => {
      window.__qaStoryInlineVideoNode = video;
    });
    await waitForStoryPicture(mixedMedia.page, "00000000-0000-4000-8000-000000000152");
    const inlineNativeControls = await clickStoryNativeControlStrip(mixedMedia.page, ".journey-story__media");
    checks.push({ name: "story-desktop-native-video-control-strip", ...inlineNativeControls });
    if (inlineNativeControls.failed) failed = true;

    // Fullscreen has its own explicit control; upper video halves navigate.
    await mixedMedia.page.getByRole("button", { name: "全屏查看媒体", exact: true }).click();
    const mixedFullscreen = mixedMedia.page.locator(".journey-story-fullscreen");
    await mixedFullscreen.waitFor({ state: "visible" });
    await waitForStoryPicture(mixedMedia.page, "00000000-0000-4000-8000-000000000152", ".journey-story-fullscreen");
    const fullscreenVideo = mixedFullscreen.locator("video[data-shared-media-id]").first();
    const fullscreenVideoControls = await fullscreenVideo.evaluate((video) => {
      window.__qaStoryFullscreenVideoNode = video;
      return video.controls;
    });
    const fullscreenNativeControls = await clickStoryNativeControlStrip(mixedMedia.page, ".journey-story-fullscreen");
    checks.push({ name: "story-fullscreen-native-video-control-strip", ...fullscreenNativeControls });
    if (fullscreenNativeControls.failed) failed = true;

    await clickStoryPicture(mixedMedia.page, 1, ".journey-story-fullscreen");
    const fullscreenImageSettled = await mixedMedia.page.waitForFunction(({ fullscreenSelector, expectedId }) => {
      const root = document.querySelector(fullscreenSelector);
      const media = root?.querySelector("[data-shared-media-id]");
      const pages = root?.querySelector("[data-story-media-pages]");
      const current = pages?.querySelector('[data-media-page="current"]');
      return media?.getAttribute("data-shared-media-id") === expectedId
        && (!pages || (
          current?.getAttribute("data-media-page-id") === expectedId
          && current?.getAttribute("data-media-page-ready") === "true"
        ));
    }, { fullscreenSelector: ".journey-story-fullscreen", expectedId: "00000000-0000-4000-8000-000000000102" }, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
    const outgoingVideoState = await mixedFullscreen.evaluate((root) => {
      const video = root.querySelector(".story-media-pages__video video");
      return {
        nodeRetained: video === window.__qaStoryFullscreenVideoNode,
        paused: video instanceof HTMLVideoElement && video.paused,
        hidden: video instanceof HTMLVideoElement && video.hidden,
        noCurrentAsset: video?.getAttribute("data-shared-media-id") === null,
      };
    });
    await clickStoryPicture(mixedMedia.page, -1, ".journey-story-fullscreen");
    const fullscreenVideoSettled = await mixedMedia.page.waitForFunction(({ fullscreenSelector, expectedId }) => {
      const root = document.querySelector(fullscreenSelector);
      const media = root?.querySelector("[data-shared-media-id]");
      const pages = root?.querySelector("[data-story-media-pages]");
      const current = pages?.querySelector('[data-media-page="current"]');
      return media?.getAttribute("data-shared-media-id") === expectedId
        && (!pages || (
          current?.getAttribute("data-media-page-id") === expectedId
          && current?.getAttribute("data-media-page-ready") === "true"
        ))
        && media instanceof HTMLVideoElement;
    }, { fullscreenSelector: ".journey-story-fullscreen", expectedId: "00000000-0000-4000-8000-000000000152" }, { polling: "raf", timeout: 3_000 }).then(() => true).catch(() => false);
    const settledFullscreenVideo = mixedFullscreen.locator("video[data-shared-media-id]").first();
    const fullscreenControlsAfterReturn = fullscreenVideoSettled
      ? await settledFullscreenVideo.evaluate((video) => video.controls)
      : false;
    const videoIdentityAfterReturn = await mixedFullscreen.evaluate((root) => ({
      count: root.querySelectorAll("video").length,
      sameNode: root.querySelector("video[data-shared-media-id]") === window.__qaStoryFullscreenVideoNode,
      inlineNodeRetained: document.querySelector(".journey-story__media .story-media-pages__video video")
        === window.__qaStoryInlineVideoNode,
      inactiveInlinePaused: window.__qaStoryInlineVideoNode?.paused === true,
    }));
    const mixedMediaFailed = !stageVideoSettled
      || stageVideoNodeCount !== 1
      || !fullscreenVideoControls
      || !fullscreenImageSettled
      || !outgoingVideoState.nodeRetained || !outgoingVideoState.paused
      || !outgoingVideoState.hidden || !outgoingVideoState.noCurrentAsset
      || !fullscreenVideoSettled
      || !fullscreenControlsAfterReturn
      || videoIdentityAfterReturn.count !== 1 || !videoIdentityAfterReturn.sameNode
      || !videoIdentityAfterReturn.inlineNodeRetained || !videoIdentityAfterReturn.inactiveInlinePaused
      || mixedMedia.consoleErrors.length > 0
      || mixedMedia.pageErrors.length > 0;
    checks.push({
      name: "story-fullscreen-mixed-media-settle",
      stageVideoSettled,
      stageVideoNodeCount,
      fullscreenVideoControls,
      fullscreenImageSettled,
      outgoingVideoState,
      fullscreenVideoSettled,
      fullscreenControlsAfterReturn,
      videoIdentityAfterReturn,
      consoleErrors: mixedMedia.consoleErrors,
      pageErrors: mixedMedia.pageErrors,
      failed: mixedMediaFailed,
    });
    if (mixedMediaFailed) failed = true;
  } finally {
    await mixedMedia.page.close();
  }

  const playback = await createQaPage("/?qaState=journey-playback", tinyVideo, { instrumentMedia: true });
  try {
    await playback.page.locator(".journey-playback").waitFor({ state: "visible" });
    const next = playback.page.getByRole("button", { name: "下一个章节" });
    await next.click();
    await next.click();
    const playbackPresentation = playback.page.locator(".playback-media-presentation");
    await playbackPresentation.waitFor({ state: "visible", timeout: 5_000 });
    await playback.page.locator('.playback-media-presentation[data-media-presentation="settled"]')
      .waitFor({ state: "attached", timeout: 5_000 });
    const phase = await playback.page.locator(".journey-playback").getAttribute("data-playback-phase");
    const presentedAsset = await playbackPresentation.getAttribute("data-presented-asset");
    const requestedAsset = await playbackPresentation.getAttribute("data-requested-asset");
    const video = playbackPresentation.locator("[data-media-slot][aria-hidden=\"false\"] video");
    const videoVisible = await video.count() === 1;
    const liveVideoCount = await playbackPresentation.locator("video").count();
    const nativeControls = videoVisible ? await video.evaluate((element) => element.controls) : null;
    const initiallyPaused = videoVisible ? await video.evaluate((element) => element.paused) : null;
    const pauseButton = playback.page.getByRole("button", { name: "暂停播放" });
    await pauseButton.click();
    await playback.page.waitForTimeout(20);
    const pausedAfterStartripsPause = videoVisible ? await video.evaluate((element) => element.paused) : null;
    await playback.page.getByRole("button", { name: "继续播放" }).click();
    await playback.page.waitForTimeout(20);
    const pausedAfterStartripsResume = videoVisible ? await video.evaluate((element) => element.paused) : null;
    const bottomGap = await playback.page.locator(".journey-playback__controls").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.round(innerHeight - bounds.bottom);
    });
    record("playback-video", await scanButtons(playback.page, ".journey-playback"), {
      phase,
      presentedAsset,
      requestedAsset,
      videoVisible,
      liveVideoCount,
      nativeControls,
      initiallyPaused,
      pausedAfterStartripsPause,
      pausedAfterStartripsResume,
      bottomGap,
      failed: phase !== "media"
        || presentedAsset !== "00000000-0000-4000-8000-000000000111"
        || requestedAsset !== presentedAsset
        || !videoVisible
        || liveVideoCount !== 1
        || nativeControls !== false
        || initiallyPaused !== false
        || pausedAfterStartripsPause !== true
        || pausedAfterStartripsResume !== false
        || bottomGap < 12,
    });
    if (playback.consoleErrors.length || playback.pageErrors.length) {
      checks.push({ name: "playback-runtime-errors", consoleErrors: playback.consoleErrors, pageErrors: playback.pageErrors });
      failed = true;
    }
  } finally {
    await playback.page.close();
  }

  // Playback presentation contract: a cold image request keeps the already
  // presented frame visible until read + browser decode settle, then commits
  // the requested asset into one of the two fixed slots. This fixture's first
  // point has deterministic image ids generated by the prefetch QA preview.
  const playbackColdInitialAssetId = "00000000-0000-4000-8000-100000000000";
  const playbackColdTargetAssetId = "00000000-0000-4000-8000-100001000000";
  const playbackCold = await createQaPage(
    "/?qaState=journey-playback&qaMode=prefetch&qaFixture=single",
    onePixelGif,
    {
      blockedReadAssetId: playbackColdTargetAssetId,
      reducedMotion: "no-preference",
    },
  );
  try {
    const playbackSurface = playbackCold.page.locator(".journey-playback");
    const presentation = playbackCold.page.locator(".playback-media-presentation");
    await playbackSurface.waitFor({ state: "visible" });
    await presentation.waitFor({ state: "visible", timeout: 8_000 });
    const initialSettled = await playbackCold.page.waitForFunction(({ presentationSelector, assetId }) => {
      const stage = document.querySelector(presentationSelector);
      return stage?.getAttribute("data-media-presentation") === "settled"
        && stage.getAttribute("data-presented-asset") === assetId;
    }, { presentationSelector: ".playback-media-presentation", assetId: playbackColdInitialAssetId }, { polling: "raf", timeout: 8_000 }).then(() => true).catch(() => false);
    const initialSlots = await presentation.evaluate((stage) => {
      const slots = [...stage.querySelectorAll("[data-media-slot]")];
      const visibleImage = stage.querySelector('[data-media-slot][aria-hidden="false"] img');
      window.__qaPlaybackSlotNodes = slots;
      window.__qaPlaybackPresentedImage = visibleImage;
      return {
        slotCount: slots.length,
        presentedAsset: stage.getAttribute("data-presented-asset"),
        requestedAsset: stage.getAttribute("data-requested-asset"),
        presentation: stage.getAttribute("data-media-presentation"),
        visibleImageAlt: visibleImage?.getAttribute("alt") ?? null,
      };
    });
    const nextChapter = playbackCold.page.getByRole("button", { name: "下一个章节" });
    await nextChapter.click();
    const waitingForColdRead = await playbackCold.page.waitForFunction(({ presentationSelector, overlaySelector, initialAssetId, targetAssetId }) => {
      const stage = document.querySelector(presentationSelector);
      const overlay = document.querySelector(overlaySelector);
      const visibleImage = stage?.querySelector('[data-media-slot][aria-hidden="false"] img');
      return stage?.getAttribute("data-requested-asset") === targetAssetId
        && stage.getAttribute("data-presented-asset") === initialAssetId
        && stage.getAttribute("data-media-presentation") === "waiting"
        && overlay?.getAttribute("data-playback-presentation-hold") === "waiting"
        && visibleImage === window.__qaPlaybackPresentedImage
        && visibleImage?.getAttribute("alt") === "prefetch-0-0.png";
    }, {
      presentationSelector: ".playback-media-presentation",
      overlaySelector: ".journey-playback",
      initialAssetId: playbackColdInitialAssetId,
      targetAssetId: playbackColdTargetAssetId,
    }, { polling: "raf", timeout: 5_000 }).then(() => true).catch(() => false);
    playbackCold.releaseBlockedRead();
    const committed = await playbackCold.page.waitForFunction(({ presentationSelector, targetAssetId }) => {
      const stage = document.querySelector(presentationSelector);
      const visibleImage = stage?.querySelector('[data-media-slot][aria-hidden="false"] img');
      return stage?.getAttribute("data-media-presentation") === "settled"
        && stage.getAttribute("data-presented-asset") === targetAssetId
        && stage.getAttribute("data-requested-asset") === targetAssetId
        && visibleImage?.getAttribute("alt") === "prefetch-0-1.png"
        && visibleImage.complete
        && visibleImage.naturalWidth > 0;
    }, { presentationSelector: ".playback-media-presentation", targetAssetId: playbackColdTargetAssetId }, { polling: "raf", timeout: 8_000 }).then(() => true).catch(() => false);
    const committedState = await presentation.evaluate((stage) => {
      const slots = [...stage.querySelectorAll("[data-media-slot]")];
      const visibleImage = stage.querySelector('[data-media-slot][aria-hidden="false"] img');
      return {
        slotCount: slots.length,
        fixedSlotIdentity: slots.length === 2
          && slots.every((slot, index) => window.__qaPlaybackSlotNodes?.[index] === slot),
        presentation: stage.getAttribute("data-media-presentation"),
        presentedAsset: stage.getAttribute("data-presented-asset"),
        requestedAsset: stage.getAttribute("data-requested-asset"),
        visibleImageAlt: visibleImage?.getAttribute("alt") ?? null,
        visibleImageComplete: visibleImage instanceof HTMLImageElement && visibleImage.complete,
        visibleImageNaturalWidth: visibleImage instanceof HTMLImageElement ? visibleImage.naturalWidth : 0,
        visibleImageIsOldNode: visibleImage === window.__qaPlaybackPresentedImage,
        videoCount: stage.querySelectorAll("video").length,
      };
    });
    const playbackColdFailed = !initialSettled
      || initialSlots.slotCount !== 2
      || initialSlots.presentedAsset !== playbackColdInitialAssetId
      || initialSlots.requestedAsset !== playbackColdInitialAssetId
      || initialSlots.presentation !== "settled"
      || initialSlots.visibleImageAlt !== "prefetch-0-0.png"
      || !waitingForColdRead
      || !committed
      || committedState.slotCount !== 2
      || !committedState.fixedSlotIdentity
      || committedState.presentation !== "settled"
      || committedState.presentedAsset !== playbackColdTargetAssetId
      || committedState.requestedAsset !== playbackColdTargetAssetId
      || committedState.visibleImageAlt !== "prefetch-0-1.png"
      || !committedState.visibleImageComplete
      || committedState.visibleImageNaturalWidth <= 0
      || committedState.visibleImageIsOldNode
      || committedState.videoCount !== 0
      || playbackCold.consoleErrors.length > 0
      || playbackCold.pageErrors.length > 0;
    checks.push({
      name: "playback-cold-image-presentation-contract",
      fixture: {
        initialAssetId: playbackColdInitialAssetId,
        targetAssetId: playbackColdTargetAssetId,
      },
      initialSettled,
      initial: initialSlots,
      waitingForColdRead,
      committed,
      committedState,
      consoleErrors: playbackCold.consoleErrors,
      pageErrors: playbackCold.pageErrors,
      failed: playbackColdFailed,
    });
    if (playbackColdFailed) failed = true;
  } finally {
    playbackCold.releaseBlockedRead();
    await playbackCold.page.close();
  }

  // ── #195 Phase 2: the trim transport, executed ──────────────────────────
  // Acceptance 1, 2 and 6 are behaviour of a real element under a real
  // director, so they are graded here rather than by a pure-function assertion:
  // the element must reach the in-point before the beat's budget starts, the
  // beat must end at the out-point instead of on `ended`, and a pause must
  // leave it inside its segment.
  const TRIM_SOURCE_SECONDS = 12;
  const trimVideoAssetId = "00000000-0000-4000-8000-000000000111";
  const trimTimeline = { sourceDurationSeconds: TRIM_SOURCE_SECONDS, tickMs: 40, tickSeconds: 0.1 };

  async function openTrimmedBeat(inMs, outMs) {
    const opened = await createQaPage(
      `/?qaState=journey-playback&qaMode=trim&qaTrimIn=${inMs}&qaTrimOut=${outMs}`,
      // The video asset gets the real WebM source; the following image keeps
      // the valid GIF fallback URL through the per-asset read route.
      onePixelGif,
      { videoTimeline: trimTimeline, videoMediaUrl: tinyVideo, videoAssetId: trimVideoAssetId },
    );
    await opened.page.locator(".journey-playback").waitFor({ state: "visible" });
    const presentation = opened.page.locator(".playback-media-presentation");
    const next = opened.page.getByRole("button", { name: "下一个章节" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await presentation.count() === 1 && await presentation.locator("video").count() === 1) break;
      await next.click();
      await opened.page.waitForTimeout(80);
    }
    await opened.page.locator('.journey-playback[data-video-trim="playing"]')
      .waitFor({ timeout: 15_000 });
    await opened.page.locator('.playback-media-presentation[data-media-presentation="settled"]')
      .waitFor({ state: "attached", timeout: 8_000 });
    const presentedAsset = await presentation.getAttribute("data-presented-asset");
    const presentedMediaCount = await presentation.locator('[data-media-slot][aria-hidden="false"] :is(img, video)').count();
    const videoStep = Number(
      await opened.page.locator(".journey-playback").getAttribute("data-playback-step"),
    );
    return { ...opened, videoStep, presentedAsset, presentedMediaCount };
  }

  async function readTimeline(page) {
    return page.evaluate(() => window.__qaVideoTimeline);
  }

  async function waitForStepAfter(page, videoStep) {
    await page.waitForFunction((step) => {
      const overlay = document.querySelector(".journey-playback");
      return !!overlay && Number(overlay.getAttribute("data-playback-step")) > step;
    }, videoStep, { timeout: 20_000 });
  }

  // Acceptance 1 + 2: entry lands on the in-point while the budget is still
  // held, and the beat ends at the out-point.
  const trimIn = 1_200;
  const trimOut = 4_700;
  const segment = await openTrimmedBeat(trimIn, trimOut);
  try {
    const entered = await readTimeline(segment.page);
    await waitForStepAfter(segment.page, segment.videoStep);
    const finished = await readTimeline(segment.page);
    const inSeconds = trimIn / 1_000;
    const outSeconds = trimOut / 1_000;
    const seekedToInPoint = entered.seeks.some((seek) => Math.abs(seek.to - inSeconds) < 0.01);
    // The budget is held while the element is being positioned: every seek onto
    // the in-point is issued from a holding state, never from `playing`.
    const seekedWhileHolding = entered.seeks.every(
      (seek) => seek.trim === "positioning" || seek.trim === "buffering",
    );
    const firstPlaying = entered.samples.find((entry) => entry.trim === "playing");
    const sawPositioning = entered.samples.some((entry) => entry.trim === "positioning");
    const onSegment = finished.samples
      .filter((entry) => entry.trim === "playing" && entry.step === segment.videoStep)
      .map((entry) => entry.time);
    const lastSegmentTime = onSegment.length ? Math.max(...onSegment) : null;
    const firstSegmentTime = onSegment.length ? Math.min(...onSegment) : null;
    const failedTrimSegment = !seekedToInPoint
      || !seekedWhileHolding
      || !sawPositioning
      || !firstPlaying
      || segment.presentedAsset !== "00000000-0000-4000-8000-000000000111"
      || segment.presentedMediaCount !== 1
      || firstPlaying.time < inSeconds - 0.15
      || firstSegmentTime === null
      || firstSegmentTime < inSeconds - 0.15
      || lastSegmentTime === null
      // Ended at the out-point, not at the end of a 12 s source and not on the
      // wall-clock budget, which would have stopped a tick short of it.
      || lastSegmentTime > outSeconds + 0.15
      || lastSegmentTime < outSeconds - 0.35
      || finished.endedEvents !== 0
      || finished.playCalls < 1;
    checks.push({
      name: "playback-video-trim-segment",
      trim: { inSeconds, outSeconds, sourceDurationSeconds: TRIM_SOURCE_SECONDS },
      seeks: entered.seeks,
      sawPositioning,
      firstPlayingTime: firstPlaying?.time ?? null,
      presentedAsset: segment.presentedAsset,
      presentedMediaCount: segment.presentedMediaCount,
      firstSegmentTime,
      lastSegmentTime,
      endedEvents: finished.endedEvents,
      failed: failedTrimSegment,
    });
    if (failedTrimSegment) failed = true;
    if (segment.consoleErrors.length || segment.pageErrors.length) {
      checks.push({
        name: "playback-video-trim-runtime-errors",
        consoleErrors: segment.consoleErrors,
        pageErrors: segment.pageErrors,
      });
      failed = true;
    }
  } finally {
    await segment.page.close();
  }

  // Acceptance 6: a pause inside a trimmed segment is transparent — the media
  // time freezes, the trim keeps owning the beat rather than degrading, and the
  // resumed beat still ends at its own out-point.
  const pauseIn = 1_200;
  const pauseOut = 9_200;
  const paused = await openTrimmedBeat(pauseIn, pauseOut);
  try {
    await paused.page.waitForTimeout(400);
    await paused.page.getByRole("button", { name: "暂停播放" }).click();
    await paused.page.waitForTimeout(120);
    const atPause = await readTimeline(paused.page);
    const pausedTime = atPause.samples[atPause.samples.length - 1].time;
    const trimDuringPause = await paused.page.locator(".journey-playback")
      .getAttribute("data-video-trim");
    await paused.page.waitForTimeout(700);
    const afterHold = await readTimeline(paused.page);
    const heldTime = afterHold.samples[afterHold.samples.length - 1].time;
    await paused.page.getByRole("button", { name: "继续播放" }).click();
    await waitForStepAfter(paused.page, paused.videoStep);
    const finished = await readTimeline(paused.page);
    const inSeconds = pauseIn / 1_000;
    const outSeconds = pauseOut / 1_000;
    const onSegment = finished.samples
      .filter((entry) => entry.trim === "playing" && entry.step === paused.videoStep)
      .map((entry) => entry.time);
    const escapedSegment = onSegment.some(
      (time) => time < inSeconds - 0.15 || time > outSeconds + 0.15,
    );
    const lastSegmentTime = onSegment.length ? Math.max(...onSegment) : null;
    const failedTrimPause = pausedTime !== heldTime
      || pausedTime < inSeconds
      || trimDuringPause !== "playing"
      || paused.presentedAsset !== "00000000-0000-4000-8000-000000000111"
      || paused.presentedMediaCount !== 1
      || escapedSegment
      || lastSegmentTime === null
      || lastSegmentTime > outSeconds + 0.15
      || lastSegmentTime < outSeconds - 0.35
      || finished.endedEvents !== 0;
    checks.push({
      name: "playback-video-trim-pause",
      trim: { inSeconds, outSeconds },
      pausedTime,
      heldTime,
      trimDuringPause,
      presentedAsset: paused.presentedAsset,
      presentedMediaCount: paused.presentedMediaCount,
      escapedSegment,
      lastSegmentTime,
      endedEvents: finished.endedEvents,
      failed: failedTrimPause,
    });
    if (failedTrimPause) failed = true;
    if (paused.consoleErrors.length || paused.pageErrors.length) {
      checks.push({
        name: "playback-video-trim-pause-runtime-errors",
        consoleErrors: paused.consoleErrors,
        pageErrors: paused.pageErrors,
      });
      failed = true;
    }
  } finally {
    await paused.page.close();
  }
} finally {
  console.log("Media checks completed before exit:", JSON.stringify(checks));
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
