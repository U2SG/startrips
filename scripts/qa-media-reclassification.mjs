import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const browser = await launchQaBrowser();
const checks = [];
let failed = false;

function record(name, details) {
  const result = { name, ...details };
  checks.push(result);
  if (details.failed) failed = true;
}

try {
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
    body: JSON.stringify({
      url: onePixelGif,
      expiresAt: "2026-08-26T00:00:00.000Z",
    }),
  }));

  try {
    await page.goto(`${origin}/?qaState=journey-story`, { waitUntil: "domcontentloaded" });
    const storyRoot = page.locator(".journey-story");
    await storyRoot.waitFor({ state: "visible" });

    const manageTrigger = page.locator(".journey-story__mobile-media-menu-trigger:visible").first();
    await manageTrigger.waitFor({ state: "visible" });
    const viewerManageLabel = await manageTrigger.getAttribute("aria-label");
    record("story-mobile-media-reclassification-viewer-trigger", {
      viewerManageLabel,
      failed: viewerManageLabel !== "管理旅程",
    });
    const enterManage = async () => {
      await manageTrigger.click();
      await page.waitForFunction(() => (
        document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage"
      ));
    };
    const openMediaSheet = async () => {
      await page.waitForFunction(() => (
        document.querySelector(".journey-story__mobile-media-menu-trigger")?.getAttribute("aria-label") === "管理当前媒体"
      ));
      const trigger = page.locator(".journey-story__mobile-media-menu-trigger:visible").first();
      const manageMediaLabel = await trigger.getAttribute("aria-label");
      if (manageMediaLabel !== "管理当前媒体") {
        throw new Error(`unexpected media-management label: ${manageMediaLabel}`);
      }
      await trigger.click();
      const sheet = page.locator(".journey-story__mobile-media-sheet");
      await sheet.waitFor({ state: "visible" });
      return sheet;
    };

    await enterManage();
    let mobileSheet = await openMediaSheet();
    const reclassifyMedia = page.getByRole("button", { name: "移动媒体 / 重新归类" });
    const organizeMedia = page.getByRole("button", { name: "整理媒体" });
    const reclassifyBox = await reclassifyMedia.boundingBox();
    const organizeBox = await organizeMedia.boundingBox();
    const bothSheetActionsAvailable = await reclassifyMedia.count() === 1
      && await organizeMedia.count() === 1;
    const directMoveTouchTarget = reclassifyBox
      ? Math.min(reclassifyBox.width, reclassifyBox.height)
      : 0;
    const organizeTouchTarget = organizeBox
      ? Math.min(organizeBox.width, organizeBox.height)
      : 0;

    await reclassifyMedia.click();
    await mobileSheet.waitFor({ state: "detached" });
    const moveSelectToggle = page.locator(".journey-story__media-select-toggle");
    await moveSelectToggle.waitFor({ state: "visible" });
    await page.waitForFunction(() => (
      document.querySelector(".journey-story__media-grid")?.classList.contains("is-selecting") ?? false
    ));
    const directMoveModeActive = await moveSelectToggle.getAttribute("aria-pressed") === "true";
    const directMoveFocusTransferred = await moveSelectToggle.evaluate(
      (button) => document.activeElement === button,
    );
    record("story-mobile-media-reclassification-direct-entry", {
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

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (
      document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer"
    ));
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理旅程");
    const directMoveEscapeRestoredViewer = await storyRoot.getAttribute("data-mobile-mode") === "viewer";
    const directMoveEscapeFocusRestored = await manageTrigger.evaluate(
      (button) => document.activeElement === button,
    );

    await enterManage();
    mobileSheet = await openMediaSheet();
    await page.getByRole("button", { name: "移动媒体 / 重新归类" }).click();
    await mobileSheet.waitFor({ state: "detached" });
    await moveSelectToggle.waitFor({ state: "visible" });
    await page.waitForFunction(() => (
      document.querySelector(".journey-story__media-grid")?.classList.contains("is-selecting") ?? false
    ));
    await page.evaluate(() => window.history.back());
    await page.waitForFunction(() => (
      document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer"
    ));
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理旅程");
    const directMoveBackRestoredViewer = await storyRoot.getAttribute("data-mobile-mode") === "viewer";
    const directMoveBackFocusRestored = await manageTrigger.evaluate(
      (button) => document.activeElement === button,
    );
    record("story-mobile-media-reclassification-exit-contract", {
      directMoveEscapeRestoredViewer,
      directMoveEscapeFocusRestored,
      directMoveBackRestoredViewer,
      directMoveBackFocusRestored,
      failed: !directMoveEscapeRestoredViewer
        || !directMoveEscapeFocusRestored
        || !directMoveBackRestoredViewer
        || !directMoveBackFocusRestored,
    });

    record("story-mobile-media-reclassification-runtime-errors", {
      consoleErrors,
      pageErrors,
      failed: consoleErrors.length > 0 || pageErrors.length > 0,
    });
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
