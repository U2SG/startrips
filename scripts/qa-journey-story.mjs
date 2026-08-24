import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173/?qaState=journey-story";
const storageUrl = new URL("/qa-storage/story-part", baseUrl).toString();

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
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

await page.route("**/api/uploads/start", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ uploadId: "qa-upload", partSize: 8 * 1024 * 1024, partCount: 1 }),
}));
await page.route("**/api/uploads/qa-upload/parts/1", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ url: storageUrl, headers: {} }),
}));
await page.route("**/qa-storage/story-part", async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await route.fulfill({ status: 200, headers: { etag: '"qa-etag"' } });
});
// The soundtrack asset id matches the one the preview stores, so re-uploading
// the same track reproduces the server's content-hash deduplication.
const QA_SOUNDTRACK_ASSET_ID = "00000000-0000-4000-8000-000000000900";
let completeAsSoundtrack = false;
await page.route("**/api/uploads/qa-upload/complete", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    asset: completeAsSoundtrack
      ? {
          id: QA_SOUNDTRACK_ASSET_ID,
          journeyId: "00000000-0000-4000-8000-000000000001",
          storageDriver: "qa",
          storageKey: "qa/story-soundtrack",
          fileName: "night-theme.mp3",
          mimeType: "audio/mpeg",
          bytes: 68,
        }
      : {
          id: "00000000-0000-4000-8000-000000000005",
          journeyId: "00000000-0000-4000-8000-000000000001",
          storageDriver: "qa",
          storageKey: "qa/story-media",
          fileName: "night-route.png",
          mimeType: "image/png",
          bytes: 68,
        },
  }),
}));
const silentWav = "data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    url: route.request().url().includes(QA_SOUNDTRACK_ASSET_ID)
      ? silentWav
      : onePixelGif,
    expiresAt: "2026-08-12T12:00:00.000Z",
  }),
}));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const dialog = page.locator(".journey-story");
  const backdrop = page.locator(".journey-story-backdrop");
  const reopen = page.locator("[data-qa-story-reopen]");
  await dialog.waitFor({ state: "visible" });

  await page.locator(".journey-story__copy").click();
  if (!await dialog.isVisible()) throw new Error("Clicking story content closed the dialog");

  await page.getByRole("button", { name: "退出旅程故事" }).click();
  await dialog.waitFor({ state: "detached" });
  await reopen.click();
  await dialog.waitFor({ state: "visible" });

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  const escapeRestoredFocus = await reopen.evaluate((element) => document.activeElement === element);
  await reopen.click();
  await dialog.waitFor({ state: "visible" });

  await backdrop.click({ position: { x: 6, y: 6 } });
  await dialog.waitFor({ state: "detached" });
  const backdropRestoredFocus = await reopen.evaluate((element) => document.activeElement === element);
  await reopen.click();
  await dialog.waitFor({ state: "visible" });

  // Direct access: reach the last of three seeded photos with one grid click
  // instead of repeated "next" presses.
  const counter = page.locator(".journey-story__media-nav span");
  await counter.filter({ hasText: "1 / 3" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "全部照片" }).click();
  const tiles = page.locator(".journey-story__media-grid > li");
  await tiles.first().waitFor({ state: "visible" });
  const overviewTileCount = await tiles.count();
  await page.locator('[data-media-tile-index="2"]').click();
  await counter.filter({ hasText: "3 / 3" }).waitFor({ state: "visible" });
  const gridClosedAfterSelection = await page
    .locator(".journey-story__media-grid").count() === 0;

  const fileInput = page.locator('.journey-story__media-add input[type="file"]');
  await fileInput.setInputFiles({
    name: "night-route.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  // Pressing exit during an upload must explain the wait rather than be a
  // dead control, so the button stays enabled and the dialog stays open.
  const exitButton = page.getByRole("button", { name: "退出旅程故事" });
  const exitEnabledDuringUpload = await exitButton.isEnabled();
  await exitButton.click();
  const blockedMessage = page.locator(".journey-story__close-blocked");
  await blockedMessage.waitFor({ state: "visible" });
  const blockedByButton = (await blockedMessage.innerText())
    === "正在完成分块上传，完成后即可安全退出。";
  if (!await dialog.isVisible()) throw new Error("Dialog closed while upload was in flight");

  // The notice overlays the media row, so the footer must stay pinned to the
  // dialog's bottom edge instead of being pushed out of the grid.
  const blockedLayout = await page.evaluate(() => {
    const story = document.querySelector(".journey-story");
    const footer = document.querySelector(".journey-story > footer");
    const layout = document.querySelector(".journey-story__layout");
    const notice = document.querySelector(".journey-story__close-blocked");
    if (!story || !footer || !layout || !notice) return null;
    const storyBox = story.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    const layoutBox = layout.getBoundingClientRect();
    const noticeBox = notice.getBoundingClientRect();
    return {
      footerPinned: Math.abs(storyBox.bottom - footerBox.bottom) < 1,
      // The notice shares the media row, so it must stay inside it. Its entrance
      // animation offsets the top by a few pixels, hence the containment check
      // rather than an exact match with the row edge.
      noticeInsideMediaRow: noticeBox.top >= layoutBox.top - 1
        && noticeBox.bottom <= footerBox.top + 1,
      layoutRowHeight: Math.round(layoutBox.height),
      documentOverflow: document.documentElement.scrollWidth
        - document.documentElement.clientWidth,
    };
  });

  // The escape path reports the same wait.
  await page.keyboard.press("Escape");
  await blockedMessage.waitFor({ state: "visible" });
  if (!await dialog.isVisible()) throw new Error("Escape closed the dialog mid-upload");

  await page.getByText("已将 1 个媒体添加到整段旅程。").waitFor({ state: "visible" });
  await page.getByText("4 个媒体片段").waitFor({ state: "visible" });
  const progressRoleCount = await page.getByRole("progressbar").count();

  // The soundtrack is journey-scoped audio: it must appear as an audio player,
  // never as a photo tile or in the visual media count.
  // The harness control sits behind the open dialog's backdrop, so it is
  // dispatched directly instead of hit-tested.
  completeAsSoundtrack = true;
  const soundtrackFile = {
    name: "night-theme.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("fffb90640000000000", "hex"),
  };
  const soundtrackInput = page.locator('.journey-story__soundtrack input[type="file"]');
  await page.locator("[data-qa-story-next-audio]").dispatchEvent("click");
  await soundtrackInput.setInputFiles(soundtrackFile);
  await page.getByText("已把「night-theme.mp3」设为这段旅程的配乐。")
    .waitFor({ state: "visible" });
  // The player appears once its signed read resolves, which is after the
  // success message, so wait for the element instead of racing it.
  const soundtrackAudio = page.locator(".journey-story__soundtrack audio");
  await soundtrackAudio.first().waitFor({ state: "attached" });
  const soundtrackAudioCount = await soundtrackAudio.count();
  const soundtrackNameShown = await page
    .locator(".journey-story__soundtrack strong")
    .innerText() === "night-theme.mp3";
  await page.getByText("4 个媒体片段").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "全部照片" }).click();
  await tiles.first().waitFor({ state: "visible" });
  const tilesAfterSoundtrack = await tiles.count();
  const soundtrackTileCount = await page
    .locator('.journey-story__media-grid [aria-label*="night-theme.mp3"]').count();
  const removeSoundtrackVisible = await page
    .getByRole("button", { name: "移除配乐" }).isVisible();

  // Re-picking the current track is deduplicated to the same asset. The track
  // must survive: the old cleanup path would have deleted the only copy.
  await page.getByRole("button", { name: "返回单张" }).click();
  await page.locator("[data-qa-story-next-audio]").dispatchEvent("click");
  await soundtrackInput.setInputFiles(soundtrackFile);
  await page.getByText("「night-theme.mp3」已经是这段旅程的配乐，没有变化。")
    .waitFor({ state: "visible" });
  await soundtrackAudio.first().waitFor({ state: "attached" });
  const soundtrackSurvivedReupload = await soundtrackAudio.count();
  const soundtrackNameAfterReupload = await page
    .locator(".journey-story__soundtrack strong").innerText();
  const removeStillVisible = await page
    .getByRole("button", { name: "移除配乐" }).isVisible();

  await page.getByRole("button", { name: "退出旅程故事" }).click();
  await dialog.waitFor({ state: "detached" });

  const result = {
    explicitClose: true,
    escapeClose: true,
    backdropClose: true,
    contentClickPreserved: true,
    escapeRestoredFocus,
    backdropRestoredFocus,
    overviewTileCount,
    nonAdjacentSelection: true,
    gridClosedAfterSelection,
    exitEnabledDuringUpload,
    blockedByButton,
    blockedLayout,
    uploadCloseBlocked: true,
    uploadCompletedAndRefreshed: true,
    progressRemovedAfterCompletion: progressRoleCount === 0,
    soundtrackAudioCount,
    soundtrackNameShown,
    tilesAfterSoundtrack,
    soundtrackTileCount,
    removeSoundtrackVisible,
    soundtrackSurvivedReupload,
    soundtrackNameAfterReupload,
    removeStillVisible,
    consoleErrors,
    pageErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    !escapeRestoredFocus
    || !backdropRestoredFocus
    || overviewTileCount !== 3
    || !gridClosedAfterSelection
    || !exitEnabledDuringUpload
    || !blockedByButton
    || !blockedLayout?.footerPinned
    || !blockedLayout?.noticeInsideMediaRow
    || blockedLayout?.layoutRowHeight !== 684
    || blockedLayout?.documentOverflow !== 0
    || progressRoleCount !== 0
    || soundtrackAudioCount !== 1
    || !soundtrackNameShown
    || tilesAfterSoundtrack !== 4
    || soundtrackTileCount !== 0
    || !removeSoundtrackVisible
    || soundtrackSurvivedReupload !== 1
    || soundtrackNameAfterReupload !== "night-theme.mp3"
    || !removeStillVisible
    || consoleErrors.length > 0
    || pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await context.close();
  await browser.close();
}
