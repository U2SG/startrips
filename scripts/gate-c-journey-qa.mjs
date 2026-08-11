import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const fixturePath = fileURLToPath(
  new URL("../public/qa/upload-filled-artwork.jpg", import.meta.url),
);
const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
});
const consoleErrors = [];
const pageErrors = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto("http://127.0.0.1:4173/?quality=low", {
    waitUntil: "networkidle",
  });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "进入世界艺术档案" }).click();
  await page.getByRole("button", { name: /打开西汉女舞俑/ }).click();
  await page.locator(".artwork-browser-card.is-selected").click();
  await page.getByRole("button", { name: /ADD YOUR VIEW/ }).click();

  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await page.locator(".personal-image-frame.has-image").waitFor();
  await page.locator(".editor-field--title input").fill("kobe with gianna.");
  await page.locator(".editor-field textarea").fill("我记忆深刻的瞬间");
  await page.locator(".location-row input").fill("洛杉矶");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.locator(".editor-field--year input").fill("2020");
  await page.locator(".create-point").click();

  await page.locator(".generation-progress").waitFor();
  await page.locator(".point-confirmation").waitFor({ timeout: 5_000 });
  const storedMoments = await page.evaluate(() => {
    const serialized = sessionStorage.getItem("art-history-twin:personal-moments");
    return serialized ? JSON.parse(serialized).length : 0;
  });
  await page.getByRole("button", { name: /回到艺术地球/ }).click();
  await page.locator(".phase-earthReturn").waitFor();
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });

  const metrics = await page.evaluate(() => ({
    phase: document.querySelector("main")?.className,
    canvasCount: document.querySelectorAll("canvas").length,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  const result = {
    storedMoments,
    ...metrics,
    consoleErrors,
    pageErrors,
  };
  console.log(JSON.stringify(result, null, 2));

  if (
    storedMoments !== 1
    || metrics.canvasCount !== 1
    || metrics.scrollWidth > metrics.innerWidth
    || metrics.scrollHeight > metrics.innerHeight
    || consoleErrors.length > 0
    || pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
