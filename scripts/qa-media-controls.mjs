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

async function createQaPage(path, mediaUrl, { instrumentMedia = false, mobile = true, viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } } = {}) {
  const page = await browser.newPage({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
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
    body: JSON.stringify({ url: mediaUrl, expiresAt: "2026-08-26T00:00:00.000Z" }),
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

    await story.page.getByRole("button", { name: "下一个媒体" }).click();
    const mobileIconActions = await story.page.evaluate(() => (
      [...document.querySelectorAll(
        ".journey-story__media-order .icon-action-button, .journey-story__media-actions .icon-action-button",
      )].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          ariaLabel: button.getAttribute("aria-label"),
          tooltip: button.getAttribute("data-tooltip"),
          visibleText: button.textContent?.trim() ?? "",
        };
      })
    ));
    const mobileIconActionsFailed = mobileIconActions.length < 4
      || mobileIconActions.some((button) => button.width < 43 || button.height < 43)
      || mobileIconActions.some((button) => !button.ariaLabel || !button.tooltip || button.visibleText !== "");
    checks.push({
      name: "story-mobile-icon-actions",
      actions: mobileIconActions,
      failed: mobileIconActionsFailed,
    });
    if (mobileIconActionsFailed) failed = true;

    await story.page.getByRole("button", { name: "全部照片" }).click();
    record("story-overview", await scanButtons(story.page, ".journey-story"));
    const mobileCoverActions = await story.page.evaluate(() => (
      [...document.querySelectorAll(".journey-story__media-tile-set-cover")].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          ariaLabel: button.getAttribute("aria-label"),
          tooltip: button.getAttribute("data-tooltip"),
          visibleText: button.textContent?.trim() ?? "",
        };
      })
    ));
    const mobileCoverActionsFailed = mobileCoverActions.length < 1
      || mobileCoverActions.some((button) => button.width < 43 || button.height < 43)
      || mobileCoverActions.some((button) => !button.ariaLabel || button.tooltip !== "设为封面" || button.visibleText !== "");
    checks.push({
      name: "story-mobile-cover-actions",
      actions: mobileCoverActions,
      failed: mobileCoverActionsFailed,
    });
    if (mobileCoverActionsFailed) failed = true;

    await story.page.getByRole("button", { name: "返回单张" }).click();
    await story.page.getByRole("button", { name: "删除这段媒体" }).click();
    const deleteScan = await scanButtons(story.page, ".journey-story");
    const otherMediaControlsVisible = await story.page.locator(
      ".journey-story__media-overview, .journey-story__fullscreen-entry, .journey-story__media-nav, .journey-story__media-order",
    ).evaluateAll((elements) => elements.some((element) => (
      Number(getComputedStyle(element).opacity) > 0.05
      && getComputedStyle(element).pointerEvents !== "none"
    )));
    record("story-delete-confirm", deleteScan, { failed: otherMediaControlsVisible });

    await story.page.getByRole("button", { name: "取消" }).click();
    await story.page.getByRole("button", { name: "全屏播放" }).click();
    record("story-fullscreen", await scanButtons(story.page, ".journey-story-fullscreen"));

    if (story.consoleErrors.length || story.pageErrors.length) {
      checks.push({ name: "story-runtime-errors", consoleErrors: story.consoleErrors, pageErrors: story.pageErrors });
      failed = true;
    }
  } finally {
    await story.page.close();
  }

  const storyDesktop = await createQaPage("/?qaState=journey-story", onePixelGif, { mobile: false });
  try {
    await storyDesktop.page.locator(".journey-story").waitFor({ state: "visible" });
    await storyDesktop.page.getByRole("button", { name: "下一个媒体" }).click();
    const coverAction = storyDesktop.page.getByRole("button", { name: "将当前媒体设为封面" });
    await coverAction.hover();
    await storyDesktop.page.waitForFunction(() => {
      const button = document.querySelector(".journey-story__media-set-cover");
      return button && Number(getComputedStyle(button, "::after").opacity) >= 0.9;
    });
    const hoverTooltip = await coverAction.evaluate((button) => ({
      opacity: Number(getComputedStyle(button, "::after").opacity),
      content: getComputedStyle(button, "::after").content,
    }));
    await coverAction.focus();
    await storyDesktop.page.keyboard.press("Shift+Tab");
    await storyDesktop.page.keyboard.press("Tab");
    await storyDesktop.page.waitForFunction(() => {
      const button = document.querySelector(".journey-story__media-set-cover");
      return button === document.activeElement
        && button.matches(":focus-visible")
        && Number(getComputedStyle(button, "::after").opacity) >= 0.9;
    });
    const focusTooltip = await coverAction.evaluate((button) => ({
      focused: document.activeElement === button,
      focusVisible: button.matches(":focus-visible"),
      opacity: Number(getComputedStyle(button, "::after").opacity),
      content: getComputedStyle(button, "::after").content,
    }));
    const desktopTooltipFailed = hoverTooltip.opacity < 0.9
      || !hoverTooltip.content.includes("设为封面")
      || !focusTooltip.focused
      || !focusTooltip.focusVisible
      || focusTooltip.opacity < 0.9
      || !focusTooltip.content.includes("设为封面");
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
