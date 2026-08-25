import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const tinyVideo = "data:video/mp4;base64,AAAA";

const browser = await chromium.launch({ executablePath: edgePath, headless: true });

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

async function createMobilePage(path, mediaUrl) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  const story = await createMobilePage("/?qaState=journey-story", onePixelGif);
  try {
    await story.page.locator(".journey-story").waitFor({ state: "visible" });
    record("story-media", await scanButtons(story.page, ".journey-story"));

    await story.page.getByRole("button", { name: "全部照片" }).click();
    record("story-overview", await scanButtons(story.page, ".journey-story"));

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

  const playback = await createMobilePage("/?qaState=journey-playback", tinyVideo);
  try {
    await playback.page.locator(".journey-playback").waitFor({ state: "visible" });
    const next = playback.page.getByRole("button", { name: "下一个章节" });
    await next.click();
    await next.click();
    await playback.page.waitForTimeout(80);
    const phase = await playback.page.locator(".journey-playback").getAttribute("data-playback-phase");
    const videoVisible = await playback.page.locator(".journey-playback__media video").count() === 1;
    const bottomGap = await playback.page.locator(".journey-playback__controls").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.round(innerHeight - bounds.bottom);
    });
    record("playback-video", await scanButtons(playback.page, ".journey-playback"), {
      phase,
      videoVisible,
      bottomGap,
      failed: phase !== "media" || !videoVisible || bottomGap < 70,
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
