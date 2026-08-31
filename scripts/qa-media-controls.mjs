import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const tinyVideo = "data:video/mp4;base64,AAAA";

const browser = await launchQaBrowser();

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
  reducedMotion = "reduce",
  viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
} = {}) {
  const page = await browser.newPage({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    reducedMotion,
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  if (instrumentMedia) {
    await page.addInitScript(() => {
      const state = new WeakMap();
      Object.defineProperty(HTMLMediaElement.prototype, "paused", {
        configurable: true,
        get() {
          return state.get(this) !== "playing";
        },
      });
      HTMLMediaElement.prototype.play = function play() {
        state.set(this, "playing");
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
  await page.route("**/api/uploads/assets/*/read-url", async (route) => {
    if (blockedRead && route.request().url().includes(blockedReadAssetId)) await blockedRead;
    if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: mixedMedia && route.request().url().includes("00000000-0000-4000-8000-000000000152")
          ? tinyVideo
          : mediaUrl,
        expiresAt: "2026-08-26T00:00:00.000Z",
      }),
    });
  });
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  return { page, consoleErrors, pageErrors, releaseBlockedRead };
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
    const settledMedia = story.page.locator(
      ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)",
    ).first();
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
    await story.page.waitForFunction((before) => {
      const media = document.querySelector(
        ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)",
      );
      return media && (media.getAttribute("alt") ?? media.getAttribute("src")) !== before;
    }, firstMediaLabel, { timeout: 3_000 });
    const flickedMedia = story.page.locator(
      ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)",
    ).first();
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
    await story.page.waitForFunction((expected) => {
      const media = document.querySelector(
        ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)",
      );
      return media && (media.getAttribute("alt") ?? media.getAttribute("src")) === expected;
    }, firstMediaLabel, { timeout: 3_000 });
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
    await story.page.waitForFunction((before) => {
      const media = document.querySelector(
        ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)",
      );
      return media && (media.getAttribute("alt") ?? media.getAttribute("src")) !== before;
    }, firstMediaLabel, { timeout: 3_000 });
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
    const organizeMedia = story.page.getByRole("button", { name: "整理媒体" });
    const reclassifyBox = await reclassifyMedia.boundingBox();
    const organizeBox = await organizeMedia.boundingBox();
    const bothSheetActionsAvailable = await reclassifyMedia.count() === 1 && await organizeMedia.count() === 1;
    await reclassifyMedia.click();
    await mobileSheet.waitFor({ state: "detached" });
    const moveSelectToggle = story.page.locator(".journey-story__media-select-toggle");
    await moveSelectToggle.waitFor({ state: "visible" });
    await story.page.waitForFunction(() => (
      document.querySelector(".journey-story__media-grid")?.classList.contains("is-selecting") ?? false
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
    await fullscreen.waitFor({ state: "detached" });

    await settledMedia.click();
    await story.page.locator(".journey-story-fullscreen").waitFor({ state: "visible" });
    await story.page.evaluate(() => window.history.back());
    await story.page.locator(".journey-story-fullscreen").waitFor({ state: "detached" });
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

  const mixedMediaMobile = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif, {
    instrumentMedia: true,
    mixedMedia: true,
    mobile: true,
    reducedMotion: "reduce",
  });
  try {
    await mixedMediaMobile.page.locator(".journey-story").waitFor({ state: "visible" });
    const inlineStage = mixedMediaMobile.page.locator(".journey-story__media");
    const initialImage = inlineStage.locator(":scope > img:not(.journey-story__media-incoming)").first();
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

    const fullscreenVideo = fullscreenStage.locator(":scope > video:not(.journey-story__media-incoming)");
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
    const fullscreenVideoBox = await fullscreenVideo.boundingBox();
    if (!fullscreenVideoBox) throw new Error("mobile fullscreen video has no bounds");
    const fullscreenVideoX = fullscreenVideoBox.x + fullscreenVideoBox.width * 0.5;
    const fullscreenVideoY = fullscreenVideoBox.y + fullscreenVideoBox.height * 0.35;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fullscreenVideoX, y: fullscreenVideoY }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fullscreenVideoX + 30, y: fullscreenVideoY }] });
    const fullscreenVideoStageCapturedOnJitter = await fullscreenStage.evaluate((stage) => Boolean(stage.dataset.qaVideoStageCapture));
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const fullscreenVideoPointerUps = Number(await fullscreenVideo.getAttribute("data-qa-pointer-ups") ?? "0");

    const fullscreenPositionBeforeVideoSwipe = await fullscreenStage.locator(".journey-story-fullscreen__nav span").textContent();
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fullscreenVideoX, y: fullscreenVideoY }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fullscreenVideoX - 110, y: fullscreenVideoY }] });
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
    await fullscreenStage.waitFor({ state: "detached" });

    const inlineVideo = inlineStage.locator(":scope > video:not(.journey-story__media-incoming)");
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
    const inlineVideoBox = await inlineVideo.boundingBox();
    if (!inlineVideoBox) throw new Error("mobile inline video has no bounds");
    const inlineVideoX = inlineVideoBox.x + inlineVideoBox.width * 0.5;
    const inlineVideoY = inlineVideoBox.y + inlineVideoBox.height * 0.35;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: inlineVideoX, y: inlineVideoY }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: inlineVideoX + 30, y: inlineVideoY }] });
    const inlineVideoStageCapturedOnJitter = await inlineStage.evaluate((stage) => Boolean(stage.dataset.qaVideoStageCapture));
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const inlineVideoPointerUps = Number(await inlineVideo.getAttribute("data-qa-pointer-ups") ?? "0");

    const inlineVideoSrcBeforeSwipe = await inlineVideo.getAttribute("src");
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: inlineVideoX, y: inlineVideoY }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: inlineVideoX - 110, y: inlineVideoY }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await mixedMediaMobile.page.waitForFunction((before) => {
      const media = document.querySelector(
        ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)",
      );
      return Boolean(media && media.getAttribute("src") !== before);
    }, inlineVideoSrcBeforeSwipe, { timeout: 3_000 });
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
      consoleErrors: mixedMediaMobile.consoleErrors,
      pageErrors: mixedMediaMobile.pageErrors,
      failed: videoNativeTapFailed,
    });
    if (videoNativeTapFailed) failed = true;
  } finally {
    await mixedMediaMobile.page.close();
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
      const base = stage.locator(
        ":scope > img:not(.journey-story__media-incoming), :scope > video:not(.journey-story__media-incoming)",
      ).first();
      await base.waitFor({ state: "visible", timeout: 3_000 });
      const beforeLabel = (await base.getAttribute("alt")) ?? (await base.getAttribute("src"));
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
      await stage.dispatchEvent("pointerup", {
        pointerId: 41,
        pointerType: "touch",
        isPrimary: true,
        clientX: startX - 110,
        clientY: y,
        bubbles: true,
      });
      await mobileContinuity.page.waitForTimeout(60);
      const incoming = stage.locator(":scope > .journey-story__media-incoming");
      const incomingWhileReadBlocked = await incoming.count();
      const oldFrameHeldDuringRead = await stage.locator(
        ":scope > img:not(.journey-story__media-incoming), :scope > video:not(.journey-story__media-incoming)",
      ).first().evaluate((element, expected) => (
        (element.getAttribute("alt") ?? element.getAttribute("src")) === expected
      ), beforeLabel);
      mobileContinuity.releaseBlockedRead();
      await incoming.waitFor({ state: "attached", timeout: 3_000 });
      const incomingState = await incoming.evaluate((element) => {
        window.__qaMobileIncomingMediaNode = element;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          position: style.position,
          animationName: style.animationName,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          layout: { x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight },
        };
      });
      await mobileContinuity.page.waitForFunction(() => (
        !document.querySelector(".journey-story__media > .journey-story__media-incoming")
      ), null, { timeout: 3_000 });
      const settledState = await mobileContinuity.page.evaluate(() => {
        const settled = document.querySelector(
          ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)",
        );
        if (!settled) return null;
        const style = getComputedStyle(settled);
        const rect = settled.getBoundingClientRect();
        return {
          sameNode: window.__qaMobileIncomingMediaNode === settled,
          position: style.position,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          layout: { x: settled.offsetLeft, y: settled.offsetTop, width: settled.offsetWidth, height: settled.offsetHeight },
        };
      });
      const layoutDelta = settledState
        ? Math.max(
          Math.abs(settledState.layout.x - incomingState.layout.x),
          Math.abs(settledState.layout.y - incomingState.layout.y),
          Math.abs(settledState.layout.width - incomingState.layout.width),
          Math.abs(settledState.layout.height - incomingState.layout.height),
        )
        : Number.POSITIVE_INFINITY;
      const continuityFailed = !oldFrameHeldDuringRead
        || incomingWhileReadBlocked !== 0
        || incomingState.position !== "absolute"
        || incomingState.animationName !== "motionMediaIn"
        || !settledState?.sameNode
        || settledState.position !== "absolute"
        || layoutDelta > 0
        || mobileContinuity.consoleErrors.length > 0
        || mobileContinuity.pageErrors.length > 0;
      checks.push({
        name: `story-mobile-swipe-compositor-continuity-${label}`,
        oldFrameHeldDuringRead,
        incomingWhileReadBlocked,
        incoming: incomingState,
        settled: settledState,
        layoutDelta,
        consoleErrors: mobileContinuity.consoleErrors,
        pageErrors: mobileContinuity.pageErrors,
        failed: continuityFailed,
      });
      if (continuityFailed) failed = true;
    } finally {
      await mobileContinuity.page.close();
    }
  }

  const mediaContinuity = await createQaPage("/?qaState=journey-story", onePixelGif, {
    mobile: false,
    reducedMotion: "no-preference",
  });
  try {
    await mediaContinuity.page.locator(".journey-story").waitFor({ state: "visible" });
    await mediaContinuity.page.getByRole("button", { name: "下一个媒体" }).click();
    const incoming = mediaContinuity.page.locator(
      ".journey-story__media > .journey-story__media-incoming",
    );
    await incoming.waitFor({ state: "attached", timeout: 3_000 });
    const incomingState = await incoming.evaluate((element) => {
      window.__qaIncomingMediaNode = element;
      const style = getComputedStyle(element);
      return {
        tagName: element.tagName,
        animationName: style.animationName,
        opacity: Number(style.opacity),
      };
    });
    await mediaContinuity.page.waitForFunction(() => (
      !document.querySelector(".journey-story__media > .journey-story__media-incoming")
    ), null, { timeout: 3_000 });
    const settledState = await mediaContinuity.page.evaluate(() => {
      const settled = document.querySelector(
        ".journey-story__media > img, .journey-story__media > video",
      );
      return {
        sameNode: Boolean(settled && window.__qaIncomingMediaNode === settled),
        opacity: settled ? Number(getComputedStyle(settled).opacity) : 0,
        complete: settled instanceof HTMLImageElement ? settled.complete : true,
      };
    });
    const continuityFailed = incomingState.animationName !== "motionMediaIn"
      || !settledState.sameNode
      || settledState.opacity < 0.99
      || !settledState.complete
      || mediaContinuity.consoleErrors.length > 0
      || mediaContinuity.pageErrors.length > 0;
    checks.push({
      name: "story-media-switch-dom-continuity",
      incoming: incomingState,
      settled: settledState,
      consoleErrors: mediaContinuity.consoleErrors,
      pageErrors: mediaContinuity.pageErrors,
      failed: continuityFailed,
    });
    if (continuityFailed) failed = true;
  } finally {
    await mediaContinuity.page.close();
  }

  const mixedMedia = await createQaPage("/?qaState=journey-story&qaMode=mixed-media", onePixelGif, {
    instrumentMedia: true,
    mixedMedia: true,
    mobile: false,
    reducedMotion: "no-preference",
  });
  try {
    await mixedMedia.page.locator(".journey-story").waitFor({ state: "visible" });
    const stageNext = mixedMedia.page.locator(".journey-story__media-nav button").last();
    await stageNext.click();
    const stageIncomingVideo = mixedMedia.page.locator(".journey-story__media > video.journey-story__media-incoming");
    await stageIncomingVideo.waitFor({ state: "attached", timeout: 3_000 });
    await stageIncomingVideo.waitFor({ state: "detached", timeout: 3_000 });
    const settledStageVideo = mixedMedia.page.locator(".journey-story__media > video:not(.journey-story__media-incoming)");
    const stageVideoSettled = await settledStageVideo.count() === 1;

    await mixedMedia.page.locator(".journey-story__fullscreen-entry").click();
    const mixedFullscreen = mixedMedia.page.locator(".journey-story-fullscreen");
    await mixedFullscreen.waitFor({ state: "visible" });
    const fullscreenVideoControls = await mixedFullscreen.locator(":scope > video:not(.journey-story__media-incoming)").evaluate((video) => video.controls);

    const fullscreenNext = mixedFullscreen.locator(".journey-story-fullscreen__nav button").last();
    const fullscreenPrevious = mixedFullscreen.locator(".journey-story-fullscreen__nav button").first();
    await fullscreenNext.click();
    await mixedFullscreen.locator(":scope > .journey-story__media-incoming").waitFor({ state: "attached", timeout: 3_000 });
    await mixedFullscreen.locator(":scope > .journey-story__media-incoming").waitFor({ state: "detached", timeout: 3_000 });
    await fullscreenPrevious.click();
    const fullscreenIncomingVideo = mixedFullscreen.locator(":scope > video.journey-story__media-incoming");
    await fullscreenIncomingVideo.waitFor({ state: "attached", timeout: 3_000 });
    await fullscreenIncomingVideo.waitFor({ state: "detached", timeout: 3_000 });
    const settledFullscreenVideo = mixedFullscreen.locator(":scope > video:not(.journey-story__media-incoming)");
    const fullscreenVideoSettled = await settledFullscreenVideo.count() === 1;
    const fullscreenControlsAfterReturn = fullscreenVideoSettled
      ? await settledFullscreenVideo.evaluate((video) => video.controls)
      : false;
    const mixedMediaFailed = !stageVideoSettled
      || !fullscreenVideoControls
      || !fullscreenVideoSettled
      || !fullscreenControlsAfterReturn
      || mixedMedia.consoleErrors.length > 0
      || mixedMedia.pageErrors.length > 0;
    checks.push({
      name: "story-fullscreen-mixed-media-settle",
      stageVideoSettled,
      fullscreenVideoControls,
      fullscreenVideoSettled,
      fullscreenControlsAfterReturn,
      consoleErrors: mixedMedia.consoleErrors,
      pageErrors: mixedMedia.pageErrors,
      failed: mixedMediaFailed,
    });
    if (mixedMediaFailed) failed = true;
  } finally {
    await mixedMedia.page.close();
  }

  const storyDesktop = await createQaPage("/?qaState=journey-story", onePixelGif, { mobile: false });
  try {
    await storyDesktop.page.locator(".journey-story").waitFor({ state: "visible" });
    const desktopPrevious = storyDesktop.page.getByRole("button", { name: "上一个媒体" });
    const desktopNext = storyDesktop.page.getByRole("button", { name: "下一个媒体" });
    const desktopButtonsVisible = await desktopPrevious.isVisible() && await desktopNext.isVisible();
    await desktopNext.click();
    await desktopPrevious.click();
    await desktopNext.click();
    checks.push({ name: "story-desktop-explicit-navigation", desktopButtonsVisible, failed: !desktopButtonsVisible });
    if (!desktopButtonsVisible) failed = true;
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
      const tooltipHeight = Number.parseFloat(tooltipStyle.height);
      const tooltipTop = buttonRect.bottom + 8;
      const tooltipBottom = tooltipTop + tooltipHeight
        + Number.parseFloat(tooltipStyle.paddingTop)
        + Number.parseFloat(tooltipStyle.paddingBottom)
        + Number.parseFloat(tooltipStyle.borderTopWidth)
        + Number.parseFloat(tooltipStyle.borderBottomWidth);
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
      const tooltipHeight = Number.parseFloat(tooltipStyle.height);
      const tooltipTop = buttonRect.bottom + 8;
      const tooltipBottom = tooltipTop + tooltipHeight
        + Number.parseFloat(tooltipStyle.paddingTop)
        + Number.parseFloat(tooltipStyle.paddingBottom)
        + Number.parseFloat(tooltipStyle.borderTopWidth)
        + Number.parseFloat(tooltipStyle.borderBottomWidth);
      return {
        focused: document.activeElement === button,
        focusVisible: button.matches(":focus-visible"),
        opacity: Number(tooltipStyle.opacity),
        content: tooltipStyle.content,
        placement: tooltipStyle.top !== "auto" ? "below" : "above",
        fullyInsideStage: Boolean(stageRect)
          && tooltipTop >= stageRect.top
          && tooltipBottom <= stageRect.bottom,
      };
    });
    const desktopTooltipFailed = hoverTooltip.opacity < 0.9
      || !hoverTooltip.content.includes("设为封面")
      || hoverTooltip.placement !== "below"
      || !hoverTooltip.fullyInsideStage
      || !focusTooltip.focused
      || !focusTooltip.focusVisible
      || focusTooltip.opacity < 0.9
      || !focusTooltip.content.includes("设为封面")
      || focusTooltip.placement !== "below"
      || !focusTooltip.fullyInsideStage;
    checks.push({
      name: "story-icon-action-tooltip-hover-focus",
      hoverTooltip,
      focusTooltip,
      failed: desktopTooltipFailed,
    });
    if (desktopTooltipFailed) failed = true;
  } finally {
    await storyDesktop.page.close();
  }

  const playback = await createQaPage("/?qaState=journey-playback", tinyVideo, { instrumentMedia: true });
  try {
    await playback.page.locator(".journey-playback").waitFor({ state: "visible" });
    const next = playback.page.getByRole("button", { name: "下一个章节" });
    await next.click();
    await next.click();
    await playback.page.waitForTimeout(80);
    const phase = await playback.page.locator(".journey-playback").getAttribute("data-playback-phase");
    const video = playback.page.locator(".journey-playback__media video");
    const videoVisible = await video.count() === 1;
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
      videoVisible,
      nativeControls,
      initiallyPaused,
      pausedAfterStartripsPause,
      pausedAfterStartripsResume,
      bottomGap,
      failed: phase !== "media"
        || !videoVisible
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
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
