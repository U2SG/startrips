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
await page.route("**/api/uploads/qa-upload/complete", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    asset: {
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
await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    url: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
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

  const fileInput = page.locator('.journey-story__media-add input[type="file"]');
  await fileInput.setInputFiles({
    name: "night-route.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await page.getByRole("button", { name: "退出旅程故事" }).click();
  const blockedMessage = page.getByText("正在完成分块上传，完成后即可安全退出。");
  await blockedMessage.waitFor({ state: "visible" });
  if (!await dialog.isVisible()) throw new Error("Dialog closed while upload was in flight");

  await page.getByText("已将 1 个媒体添加到这段旅程。").waitFor({ state: "visible" });
  await page.getByText("1 个媒体片段").waitFor({ state: "visible" });
  const progressRoleCount = await page.getByRole("progressbar").count();
  await page.getByRole("button", { name: "退出旅程故事" }).click();
  await dialog.waitFor({ state: "detached" });

  const result = {
    explicitClose: true,
    escapeClose: true,
    backdropClose: true,
    contentClickPreserved: true,
    escapeRestoredFocus,
    backdropRestoredFocus,
    uploadCloseBlocked: true,
    uploadCompletedAndRefreshed: true,
    progressRemovedAfterCompletion: progressRoleCount === 0,
    consoleErrors,
    pageErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    !escapeRestoredFocus
    || !backdropRestoredFocus
    || progressRoleCount !== 0
    || consoleErrors.length > 0
    || pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await context.close();
  await browser.close();
}
