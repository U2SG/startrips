/**
 * #595 browser QA: grouped Route Point notes stay narrative beats.
 *
 * Grouping a Route Point under a Stop changes its chapter, never who owns its
 * note. This lane drives the production Story and Journey Playback previews
 * over the grouped-notes fixture (ProductQaPreview `qaMode=grouped-notes`):
 *
 *   S  Stop, own note + photo          A  grouped, short note + photo
 *   B  grouped, note only              C  grouped, long note + photo + video
 *   T  Stop, photo                     V  ungrouped via, note only
 *   U  Stop, photo
 *
 * Story order: s1, a1, note:B, c1, c2, t1, note:V, u1.
 *
 * Everything is real browser input (keyboard on the stage, mouse and touch
 * drags, button clicks and taps) read back from the product's own DOM state.
 * No state setters, no forced clicks, no patched media elements.
 */
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const STORY_PATH = "/?qaState=journey-story&qaMode=grouped-notes";
const PLAYBACK_PATH = "/?qaState=journey-playback&qaMode=grouped-notes";
const STAGE = ".journey-story__media";

const S1 = "nb-media-s1";
const A1 = "nb-media-a1";
const C1 = "nb-media-c1";
const C2 = "nb-media-c2";
const T1 = "nb-media-t1";
const U1 = "nb-media-u1";
const NOTE_B = "note:nb-point-b";
const NOTE_V = "note:nb-point-v";
const ASSET_URLS = {
  [S1]: "/artworks/china-handscroll.jpg",
  [A1]: "/artworks/mughal-akbarnama.jpg",
  [C1]: "/artworks/egypt-coffin.jpg",
  [C2]: "/demo-media/east-star-orbit.webm",
  [T1]: "/artworks/hokusai-wave.jpg",
  [U1]: "/artworks/monet-water-lilies.jpg",
};
const S_NOTE = "停靠点 S 自己的感想";
const A_NOTE = "A 的感想";
const B_NOTE = "B 只留下了一句话";
const C_NOTE_START = "第 1 段：雨停以后";
const V_NOTE = "路过 V 时想到的";

const browser = await launchQaBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });
const checks = [];
let failed = false;

function record(entry) {
  checks.push(entry);
  if (entry.failed) failed = true;
}

async function touchDriver(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  const finger = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  return {
    kind: "touch",
    down: async (x, y) => { await send("touchStart", finger(x, y)); },
    move: async (x, y) => { await send("touchMove", finger(x, y)); },
    up: async () => { await send("touchEnd", []); },
    tap: async (x, y) => { await send("touchStart", finger(x, y)); await send("touchEnd", []); },
  };
}

function mouseDriver(page) {
  return {
    kind: "mouse",
    down: async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); },
    move: async (x, y) => { await page.mouse.move(x, y); },
    up: async () => { await page.mouse.up(); },
    tap: async (x, y) => { await page.mouse.click(x, y); },
  };
}

async function openPage({ path, viewport, mobile = false }) {
  const page = await browser.newPage({
    viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, reducedMotion: "reduce",
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  }));
  const reads = [];
  await page.route("**/api/uploads/assets/*/read-url", (route) => {
    const id = /\/assets\/([^/]+)\/read-url/.exec(new URL(route.request().url()).pathname)?.[1] ?? "";
    reads.push(id);
    const asset = ASSET_URLS[id];
    if (!asset) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: `${origin}${asset}`, expiresAt: "2099-01-01T00:00:00.000Z" }),
    });
  });
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  const pointer = mobile ? await touchDriver(page) : mouseDriver(page);
  return { page, pointer, consoleErrors, pageErrors, reads };
}

/** The product's own published state of the Story stage and its note owners. */
async function storyState(page) {
  return await page.evaluate((selector) => {
    const section = document.querySelector(selector);
    const pages = section?.querySelector("[data-story-media-pages]");
    const current = pages?.querySelector('[data-media-page="current"]');
    const block = section?.querySelector(".story-point-note");
    const blockText = block?.querySelector(".story-point-note__text");
    const sheet = section?.querySelector(".story-point-note-sheet");
    const video = pages?.parentElement?.querySelector("video[data-shared-media-id]")
      ?? document.querySelector(".journey-story__media video");
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { top: box.top, left: box.left, width: box.width, height: box.height, bottom: box.bottom, right: box.right };
    };
    return {
      currentId: current?.getAttribute("data-media-page-id") ?? null,
      ready: current?.getAttribute("data-media-page-ready") === "true",
      presentation: pages?.getAttribute("data-media-presentation") ?? null,
      kind: pages?.getAttribute("data-current-media-kind") ?? null,
      noteText: current?.querySelector(".story-media-pages__note-text")?.textContent ?? null,
      noteLabel: current?.querySelector(".story-media-pages__note-label")?.textContent ?? null,
      blockOwner: block?.getAttribute("data-story-point-note") ?? null,
      blockText: blockText?.textContent ?? null,
      blockClamped: block?.getAttribute("data-story-point-note-clamped") === "true",
      blockOverflow: blockText ? blockText.scrollHeight > blockText.clientHeight + 1 : null,
      blockRect: rect(block),
      expandVisible: Boolean(block?.querySelector(".story-point-note__expand")),
      sheetOpen: Boolean(sheet),
      sheetText: sheet?.querySelector(".story-point-note-sheet__text")?.textContent ?? null,
      sheetRect: rect(sheet),
      sheetOverscroll: sheet ? getComputedStyle(sheet.querySelector(".story-point-note-sheet__body")).overscrollBehaviorY : null,
      copyNote: Boolean(document.querySelector(".journey-story__copy .journey-story__point-note")),
      overlayNote: Boolean(section?.querySelector(".revealed-note")),
      currentPointLabel: document.querySelector(".journey-story__current-point")?.textContent ?? null,
      sectionRect: rect(section),
      pagesRect: rect(pages),
      requested: section?.getAttribute("data-media-requested") ?? null,
      videoTime: video ? video.currentTime : null,
      videoPaused: video ? video.paused : null,
      storyOpen: Boolean(document.querySelector(".journey-story")),
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, STAGE);
}

async function markBlock(page) {
  await page.evaluate(() => {
    const block = document.querySelector(".story-point-note");
    if (block) block.dataset.qaKept = "true";
  });
}

async function blockKept(page) {
  return await page.evaluate(() => document.querySelector(".story-point-note")?.dataset.qaKept === "true");
}

async function waitForCurrent(page, id, timeout = 10_000) {
  await page.waitForFunction(({ selector, expected }) => {
    const pages = document.querySelector(selector)?.querySelector("[data-story-media-pages]");
    const current = pages?.querySelector('[data-media-page="current"]');
    return current?.getAttribute("data-media-page-id") === expected
      && current?.getAttribute("data-media-page-ready") === "true"
      && pages?.getAttribute("data-media-presentation") === "settled";
  }, { selector: STAGE, expected: id }, { polling: "raf", timeout });
}

async function pressOnStage(page, key) {
  await page.evaluate((selector) => (
    document.querySelector(selector)?.querySelector("[data-story-media-pages]")?.focus()
  ), STAGE);
  await page.keyboard.press(key);
}

async function swipe(session, direction, startOn = "[data-story-media-pages]") {
  const { page, pointer } = session;
  const geometry = await page.evaluate(({ selector, target }) => {
    const element = document.querySelector(selector)?.querySelector(target) ?? document.querySelector(target);
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * 0.4, width: bounds.width };
  }, { selector: STAGE, target: startOn });
  const travel = Math.min(320, geometry.width * 0.45) * (direction > 0 ? -1 : 1);
  await pointer.down(geometry.x, geometry.y);
  for (let step = 1; step <= 10; step += 1) {
    await pointer.move(geometry.x + travel * (step / 10), geometry.y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await pointer.up();
}

async function tapSelector(session, selector) {
  const box = await session.page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no hit box`);
  const hit = await session.page.evaluate(({ query, x, y }) => {
    const target = document.querySelector(query);
    return Boolean(target?.contains(document.elementFromPoint(x, y)));
  }, { query: selector, x: box.x + box.width / 2, y: box.y + box.height / 2 });
  if (session.pointer.kind === "touch") await session.page.locator(selector).tap();
  else await session.pointer.tap(box.x + box.width / 2, box.y + box.height / 2);
  return { hit, width: box.width, height: box.height };
}

const sameRect = (left, right) => Boolean(left && right
  && ["top", "left", "width", "height"].every((key) => Math.abs(left[key] - right[key]) <= 0.5));

/** Expanding and collapsing the long note must not touch the stage at all. */
async function toggleLongNote(session) {
  const { page } = session;
  const before = await storyState(page);
  const expand = await tapSelector(session, ".story-point-note__expand");
  await page.locator(".story-point-note-sheet").waitFor({ state: "visible", timeout: 5_000 });
  const expanded = await storyState(page);
  // A drag on the sheet scrolls the sheet; it must never page the stage.
  await swipe(session, 1, ".story-point-note-sheet__body");
  await page.waitForTimeout(400);
  const afterSheetDrag = await storyState(page);
  const collapse = await tapSelector(session, ".story-point-note-sheet__close");
  await page.locator(".story-point-note-sheet").waitFor({ state: "detached", timeout: 5_000 });
  const collapsed = await storyState(page);
  const stable = (state) => sameRect(state.pagesRect, before.pagesRect)
    && state.currentId === before.currentId && state.requested === before.requested
    && (before.videoTime === null || (state.videoTime !== null && (before.videoPaused
      ? Math.abs(state.videoTime - before.videoTime) < 0.05 : state.videoTime >= before.videoTime - 0.05)));
  return {
    before, expanded, afterSheetDrag, collapsed, expand, collapse,
    failed: !before.blockClamped || !before.blockOverflow || !before.expandVisible
      || !before.blockText?.startsWith(C_NOTE_START)
      || !expanded.sheetOpen || expanded.sheetText !== before.blockText
      || expanded.blockText !== before.blockText
      || !stable(expanded) || !stable(afterSheetDrag) || !stable(collapsed)
      || !expanded.storyOpen || !collapsed.storyOpen || collapsed.sheetOpen
      || collapsed.blockText !== before.blockText
      || expanded.sheetOverscroll !== "contain"
      || !expand.hit || !collapse.hit || expand.height < 44 || collapse.height < 44,
  };
}

try {
  // ---------------------------------------------------------------- Story desktop
  {
    const name = "story-grouped-notes-desktop";
    const session = await openPage({ path: STORY_PATH, viewport: { width: 1280, height: 800 } });
    const progress = {};
    try {
      const { page } = session;
      await waitForCurrent(page, S1);
      progress.s1 = await storyState(page);
      await pressOnStage(page, "ArrowRight");
      await waitForCurrent(page, A1);
      progress.a1 = await storyState(page);
      // Keyboard onto the note-only Route Point, between its media neighbours.
      await pressOnStage(page, "ArrowRight");
      await waitForCurrent(page, NOTE_B);
      progress.noteB = await storyState(page);
      progress.noteBReads = session.reads.filter((id) => decodeURIComponent(id).startsWith("note:"));
      // Its explicit Next button leaves it.
      await page.locator('.journey-story__media-nav [data-video-step="next"]').click();
      await waitForCurrent(page, C1);
      progress.c1 = await storyState(page);
      progress.toggle = await toggleLongNote(session);
      // A swipe after the toggle still pages the stage, and the block stays
      // mounted (not replayed) while the cursor stays on C.
      await markBlock(page);
      await swipe(session, 1);
      await waitForCurrent(page, C2);
      progress.c2 = await storyState(page);
      progress.blockKeptAcrossC = await blockKept(page);
      // On the video the toggle must not seek or restart the transport.
      progress.videoToggle = await toggleLongNote(session);
      await page.locator('.journey-story__media-nav [data-video-step="next"]').click();
      await waitForCurrent(page, T1);
      progress.afterToggle = await storyState(page);
      await pressOnStage(page, "ArrowRight");
      await waitForCurrent(page, NOTE_V);
      progress.noteV = await storyState(page);
      // Back across the note pages by swipe and keyboard.
      await swipe(session, -1);
      await waitForCurrent(page, T1);
      await pressOnStage(page, "ArrowLeft");
      await waitForCurrent(page, C2);
      await pressOnStage(page, "ArrowLeft");
      await waitForCurrent(page, C1);
      await pressOnStage(page, "ArrowLeft");
      await waitForCurrent(page, NOTE_B);
      await swipe(session, -1);
      await waitForCurrent(page, A1);
      progress.back = await storyState(page);
      record({ name,
        claim: "desktop Story steps onto and off the note-only Route Point by keyboard, button and swipe; each media shows its own Route Point's note above the stage (parent and child notes are separate owners); the long note clamps and expands over the stage without moving or reloading it; the transit via is its own note page",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: progress.s1.blockOwner !== "nb-point-s" || !progress.s1.blockText?.includes(S_NOTE)
          || progress.s1.copyNote || progress.s1.blockRect === null
          || progress.s1.blockRect.bottom > progress.s1.pagesRect.top + 1
          || progress.a1.blockOwner !== "nb-point-a" || !progress.a1.blockText?.includes(A_NOTE)
          || progress.a1.blockText?.includes(S_NOTE) || progress.a1.copyNote
          || !progress.a1.currentPointLabel?.includes("STOP S 港湾 · A 石阶")
          || !sameRect(progress.a1.pagesRect, progress.s1.pagesRect)
          || progress.noteB.kind !== "note" || !progress.noteB.noteText?.includes(B_NOTE)
          || !progress.noteB.noteLabel?.includes("STOP S 港湾 · B 茶摊")
          || progress.noteB.blockOwner !== null || progress.noteB.copyNote
          || !sameRect(progress.noteB.pagesRect, progress.s1.pagesRect)
          || progress.noteBReads.length > 0
          || progress.c1.blockOwner !== "nb-point-c"
          || progress.toggle.failed
          || progress.c2.blockOwner !== "nb-point-c" || !progress.blockKeptAcrossC
          || progress.c2.kind !== "video" || progress.videoToggle.failed
          || progress.noteV.kind !== "note" || !progress.noteV.noteText?.includes(V_NOTE)
          || progress.back.currentId !== A1
          || session.consoleErrors.length > 0 || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------- Story autoplay
  {
    const name = "story-grouped-notes-autoplay";
    const session = await openPage({ path: STORY_PATH, viewport: { width: 1280, height: 800 } });
    const progress = {};
    try {
      const { page } = session;
      await waitForCurrent(page, S1);
      await pressOnStage(page, "ArrowRight");
      await waitForCurrent(page, A1);
      const startedAt = Date.now();
      await page.locator(".journey-story__media-autobrowse").click();
      await waitForCurrent(page, NOTE_B, 12_000);
      progress.reachedNoteMs = Date.now() - startedAt;
      const onNoteAt = Date.now();
      // The note page is ready the moment it is shown, so autoplay never stalls
      // on it: it leaves after the shared note dwell (3.5 s + 18 ms per char).
      await waitForCurrent(page, C1, 12_000);
      progress.noteDwellMs = Date.now() - onNoteAt;
      progress.c1 = await storyState(page);
      await page.locator(".journey-story__media-autobrowse").click();
      record({ name,
        claim: "Story autoplay walks A -> note-only B -> C and holds the note page for the shared note dwell instead of skipping it or stalling",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: progress.noteDwellMs < 3_000 || progress.noteDwellMs > 9_500
          || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------- Story mobile touch
  for (const viewport of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) {
    const name = `story-grouped-notes-touch-${viewport.width}`;
    const session = await openPage({ path: STORY_PATH, viewport, mobile: true });
    const progress = {};
    try {
      const { page } = session;
      await waitForCurrent(page, S1);
      progress.s1 = await storyState(page);
      await swipe(session, 1);
      await waitForCurrent(page, A1);
      // A touch swipe lands on the note page and another leaves it.
      await swipe(session, 1);
      await waitForCurrent(page, NOTE_B);
      progress.noteB = await storyState(page);
      await swipe(session, -1);
      await waitForCurrent(page, A1);
      await swipe(session, 1);
      await waitForCurrent(page, NOTE_B);
      await swipe(session, 1);
      await waitForCurrent(page, C1);
      progress.c1 = await storyState(page);
      progress.toggle = await toggleLongNote(session);
      await markBlock(page);
      await swipe(session, 1);
      await waitForCurrent(page, C2);
      progress.afterToggleSwipe = await storyState(page);
      progress.blockKeptAcrossC = await blockKept(page);
      const firstScreen = (state) => Boolean(state.pagesRect && state.blockRect
        && state.blockRect.top >= 0 && state.blockRect.bottom <= state.pagesRect.top + 1
        && state.pagesRect.bottom <= state.viewport.height + 0.5 && state.pagesRect.height >= 120);
      record({ name,
        claim: "on a touch phone the note block sits above the stage with the stage still inside the first screen, touch swipes page onto and off the note-only Route Point, and tapping expand/collapse on the long note leaves the stage untouched and swipeable",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: !firstScreen(progress.s1) || !firstScreen(progress.c1)
          || progress.noteB.kind !== "note" || !progress.noteB.noteText?.includes(B_NOTE)
          || progress.toggle.failed
          || progress.toggle.expanded.sheetRect === null
          || progress.toggle.expanded.sheetRect.bottom > viewport.height + 0.5
          || progress.afterToggleSwipe.currentId !== C2 || !progress.blockKeptAcrossC
          || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------- Story direct open
  {
    const name = "story-grouped-notes-direct-open";
    const session = await openPage({
      path: `${STORY_PATH}&qaRoutePoint=nb-point-b`, viewport: { width: 1280, height: 800 },
    });
    const progress = {};
    try {
      await waitForCurrent(session.page, NOTE_B);
      progress.opened = await storyState(session.page);
      progress.observation = await session.page.evaluate(() => ({
        routePoint: document.querySelector("main.living-atlas")?.getAttribute("data-qa-story-observation-route-point") ?? null,
        asset: document.querySelector("main.living-atlas")?.getAttribute("data-qa-story-observation-asset") ?? null,
      }));
      record({ name,
        claim: "opening Story on a note-only Route Point (a deep link or a Playback return) lands on its note page and publishes that Route Point with no asset",
        ...progress, pageErrors: session.pageErrors,
        failed: progress.opened.kind !== "note" || !progress.opened.noteText?.includes(B_NOTE)
          || progress.observation.routePoint !== "nb-point-b" || progress.observation.asset !== null
          || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }

  // ---------------------------------------------------------------- Journey Playback
  for (const mobile of [false, true]) {
    const name = mobile ? "playback-grouped-notes-touch-390" : "playback-grouped-notes-desktop";
    const session = await openPage({
      path: PLAYBACK_PATH,
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      mobile,
    });
    const progress = {};
    try {
      const { page } = session;
      await page.locator(".journey-playback").waitFor({ state: "visible", timeout: 10_000 });
      const readBeat = () => page.evaluate(() => {
        const root = document.querySelector(".journey-playback");
        const beat = root?.querySelector(".journey-playback__note-beat");
        const caption = root?.querySelector(".journey-playback__stop");
        const box = beat?.getBoundingClientRect();
        return {
          step: root?.getAttribute("data-playback-step") ?? null,
          phase: root?.getAttribute("data-playback-phase") ?? null,
          beatOwner: beat?.getAttribute("data-playback-note-beat") ?? null,
          beatTransit: beat?.getAttribute("data-playback-transit-note") === "true",
          beatText: beat?.textContent ?? null,
          beatInViewport: Boolean(box && box.top >= 0 && box.bottom <= innerHeight + 0.5),
          captionPoint: caption?.querySelector("[data-playback-caption-point]")?.getAttribute("data-playback-caption-point") ?? null,
          captionHeading: caption?.querySelector("h3")?.textContent ?? null,
          captionNote: caption?.querySelector("blockquote")?.textContent ?? null,
          stopCaption: Boolean(caption),
        };
      });
      const stepTo = async (step) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const current = Number(await page.locator(".journey-playback").getAttribute("data-playback-step"));
          if (current === step) return;
          await page.locator(".journey-playback").focus();
          await page.keyboard.press(current < step ? "ArrowRight" : "ArrowLeft");
          await page.waitForFunction((previous) => (
            document.querySelector(".journey-playback")?.getAttribute("data-playback-step") !== String(previous)
          ), current, { timeout: 5_000 }).catch(() => undefined);
        }
        throw new Error(`Playback did not reach step ${step}`);
      };
      // Steps: 0 intro, 1 stop S, 2 s1, 3 a1, 4 note B, 5 note C, 6 c1, 7 c2,
      // 8 travel, 9 stop T, 10 t1, 11 note V, 12 travel, 13 stop U, 14 u1, 15 outro.
      await page.locator('.journey-playback__controls button[aria-label="暂停播放"]').click({ timeout: 3_000 }).catch(() => undefined);
      await stepTo(2);
      progress.s1 = await readBeat();
      await stepTo(3);
      progress.a1 = await readBeat();
      await stepTo(4);
      progress.noteB = await readBeat();
      await stepTo(5);
      progress.noteC = await readBeat();
      await stepTo(11);
      progress.noteV = await readBeat();
      await stepTo(4);
      await page.locator(".journey-playback__close").click();
      await page.waitForFunction(() => document.querySelector("main[data-qa-grouped-notes]")
        ?.getAttribute("data-qa-return-reason") !== null, null, { timeout: 5_000 });
      progress.returned = await page.evaluate(() => {
        const main = document.querySelector("main[data-qa-grouped-notes]");
        return {
          routePoint: main?.getAttribute("data-qa-return-route-point") ?? null,
          asset: main?.getAttribute("data-qa-return-asset") ?? null,
        };
      });
      record({ name,
        claim: "Playback captions a grouped child's media with the child's own note and provenance label, plays the note-only child and the long note as their own beats in canonical order inside the Stop chapter, plays the ungrouped via as a transit note beat with no STOP caption, and returns from a note beat to the Route Point that owns it",
        ...progress, consoleErrors: session.consoleErrors, pageErrors: session.pageErrors,
        failed: progress.s1.captionPoint !== "nb-point-s" || !progress.s1.captionNote?.includes(S_NOTE)
          || progress.a1.captionPoint !== "nb-point-a" || !progress.a1.captionHeading?.includes("STOP S 港湾 · A 石阶")
          || !progress.a1.captionNote?.includes(A_NOTE) || progress.a1.captionNote?.includes(S_NOTE)
          || progress.noteB.phase !== "note" || progress.noteB.beatOwner !== "nb-point-b"
          || progress.noteB.beatTransit || !progress.noteB.beatText?.includes(B_NOTE)
          || !progress.noteB.beatText?.includes("STOP 1") || progress.noteB.stopCaption
          || !progress.noteB.beatInViewport
          || progress.noteC.phase !== "note" || progress.noteC.beatOwner !== "nb-point-c"
          || !progress.noteC.beatText?.includes(C_NOTE_START)
          || progress.noteV.phase !== "note" || progress.noteV.beatOwner !== "nb-point-v"
          || !progress.noteV.beatTransit || progress.noteV.beatText?.includes("STOP")
          || !progress.noteV.beatText?.includes(V_NOTE) || progress.noteV.stopCaption
          || progress.returned.routePoint !== "nb-point-b" || progress.returned.asset !== null
          || session.pageErrors.length > 0,
      });
    } catch (error) {
      record({ name, ...progress, error: error instanceof Error ? error.message : String(error),
        consoleErrors: session.consoleErrors, pageErrors: session.pageErrors, failed: true });
    } finally {
      await session.page.close();
    }
  }
} catch (error) {
  console.log(JSON.stringify(checks, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
