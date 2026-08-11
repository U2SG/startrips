import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173/";
const outputDir = new URL("../docs/qa/current/", import.meta.url);
const viewport = {
  width: Number(process.env.QA_VIEWPORT_WIDTH ?? 1280),
  height: Number(process.env.QA_VIEWPORT_HEIGHT ?? 720),
};
const outputSuffix = process.env.QA_OUTPUT_SUFFIX ?? "";
const allStates = [
  "earth-intro",
  "archive-burst",
  "brand-transition",
  "earth-surface",
  "archive-index",
  "artwork-browser",
  "artwork-detail",
  "upload-empty",
  "upload-filled",
  "upload-ready",
  "generation-progress",
  "point-generated",
  "earth-return",
  "personal-gallery",
  "moment-detail",
];
const requestedStates = process.argv.slice(2);
const states = requestedStates.length
  ? allStates.filter((state) => requestedStates.includes(state))
  : allStates;

if (states.length === 0) {
  throw new Error(`No valid QA states requested. Valid states: ${allStates.join(", ")}`);
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const results = [];

try {
  for (const state of states) {
    const consoleErrors = [];
    const pageErrors = [];
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const url = new URL(baseUrl);
    url.searchParams.set("qaState", state);
    url.searchParams.set("quality", "low");
    await page.goto(url.href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.waitForTimeout(120);
    if (state === "personal-gallery") {
      await page.locator('[data-gallery-ready="true"]').waitFor({ timeout: 15_000 });
    } else {
      const scene = page.locator('[data-scene-ready="true"]');
      if ((await scene.count()) > 0) await scene.waitFor({ timeout: 15_000 });
    }
    await page.screenshot({
      path: fileURLToPath(new URL(`${state}${outputSuffix}.png`, outputDir)),
    });

    const metrics = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));

    results.push({ state, ...metrics, consoleErrors, pageErrors });
    await page.close();
  }
} finally {
  await browser.close();
}

await writeFile(
  new URL(`capture-report${outputSuffix}.json`, outputDir),
  `${JSON.stringify(results, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(results, null, 2));

if (
  results.some(
    ({ innerWidth, scrollWidth, innerHeight, scrollHeight, consoleErrors, pageErrors }) =>
      scrollWidth > innerWidth ||
      scrollHeight > innerHeight ||
      consoleErrors.length > 0 ||
      pageErrors.length > 0,
  )
) {
  process.exitCode = 1;
}
