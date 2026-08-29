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
  await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      url: mixedMedia && route.request().url().includes("00000000-0000-4000-8000-000000000152")
        ? tinyVideo
        : mediaUrl,
      expiresAt: "2026-08-26T00:00:00.000Z",
    }),
  }));
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  return { page, consoleErrors, pageErrors };
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
    await mediaStage.dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: swipeStartX,
      clientY: swipeY,
      bubbles: true,
    });
    await mediaStage.dispatchEvent("pointerup", {
      pointerId: 1,
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
      failed: desktopOnlyControls !== 0,
    });
    if (desktopOnlyControls !== 0) failed = true;

    const manageTrigger = story.page.getByRole("button", { name: "管理当前媒体" });
    await manageTrigger.click();
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
    const sheetFocusRestored = await manageTrigger.evaluate((button) => document.activeElement === button);
    checks.push({
      name: "story-mobile-sheet-focus-ownership",
      initialFocusInside,
      tabStayedInside,
      sheetFocusRestored,
      failed: !initialFocusInside || !tabStayedInside || !sheetFocusRestored,
    });
    if (!initialFocusInside || !tabStayedInside || !sheetFocusRestored) failed = true;

    await manageTrigger.click();
    await story.page.getByRole("button", { name: "删除媒体" }).click();
    const deleteSheet = story.page.locator(".journey-story__mobile-media-sheet.is-confirming");
    await deleteSheet.waitFor({ state: "visible" });
    const deleteFocusInside = await deleteSheet.evaluate((root) => root.contains(document.activeElement));
    let deleteTabStayedInside = deleteFocusInside;
    for (let index = 0; index < 4; index += 1) {
      await story.page.keyboard.press("Tab");
      deleteTabStayedInside = deleteTabStayedInside && await deleteSheet.evaluate((root) => root.contains(document.activeElement));
    }
    await story.page.keyboard.press("Escape");
    await deleteSheet.waitFor({ state: "detached" });
    await story.page.waitForFunction(() => (
      document.activeElement?.classList.contains("journey-story__mobile-media-menu-trigger") ?? false
    ));
    const deleteFocusRestored = await manageTrigger.evaluate((button) => document.activeElement === button);
    checks.push({
      name: "story-mobile-delete-focus-ownership",
      deleteFocusInside,
      deleteTabStayedInside,
      deleteFocusRestored,
      failed: !deleteFocusInside || !deleteTabStayedInside || !deleteFocusRestored,
    });
    if (!deleteFocusInside || !deleteTabStayedInside || !deleteFocusRestored) failed = true;

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
    const fullscreenPositionBefore = await fullscreen.locator(".journey-story-fullscreen__nav span").textContent();
    await fullscreen.dispatchEvent("pointerdown", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: fullX, clientY: fullY, bubbles: true });
    await fullscreen.dispatchEvent("pointerup", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: fullX - 110, clientY: fullY, bubbles: true });
    await story.page.waitForFunction((before) => {
      const position = document.querySelector(".journey-story-fullscreen__nav span")?.textContent;
      return Boolean(position && position !== before);
    }, fullscreenPositionBefore, { timeout: 3_000 });
    const fullscreenPosition = await fullscreen.locator(".journey-story-fullscreen__nav span").textContent();
    record("story-fullscreen", await scanButtons(story.page, ".journey-story-fullscreen"), {
      fullscreenInitiallyImmersive,
      fullscreenPositionBefore,
      fullscreenPosition,
      failed: !fullscreenInitiallyImmersive || !fullscreenPositionBefore || !fullscreenPosition || fullscreenPosition === fullscreenPositionBefore,
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
