import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173/";
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

async function snapshot(label) {
  return page.evaluate((snapshotLabel) => {
    const memory = performance.memory;
    return {
      label: snapshotLabel,
      debug: window.__particleEarthDebug?.() ?? null,
      canvasCount: document.querySelectorAll("canvas").length,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      usedJSHeapSize: memory?.usedJSHeapSize ?? null,
    };
  }, label);
}

const snapshots = [];

try {
  const url = new URL(baseUrl);
  url.searchParams.set("quality", "low");
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });
  snapshots.push(await snapshot("initial"));

  for (let index = 0; index < 5; index += 1) {
    await page.getByRole("button", { name: "SIGNAL" }).click();
    await page.waitForTimeout(80);
    await page.getByRole("button", { name: "OCEAN" }).click();
    await page.waitForTimeout(80);
  }

  snapshots.push(await snapshot("after-five-round-trips"));
} finally {
  await browser.close();
}

const [before, after] = snapshots;
const heapGrowthMb =
  before?.usedJSHeapSize !== null && after?.usedJSHeapSize !== null
    ? (after.usedJSHeapSize - before.usedJSHeapSize) / 1024 / 1024
    : null;
const result = { snapshots, heapGrowthMb, consoleErrors, pageErrors };
console.log(JSON.stringify(result, null, 2));

const memoryStable =
  before?.debug &&
  after?.debug &&
  before.debug.geometries === after.debug.geometries &&
  before.debug.textures === after.debug.textures;
const failed =
  !memoryStable ||
  before?.canvasCount !== 1 ||
  after?.canvasCount !== 1 ||
  before?.devicePixelRatio !== 1 ||
  after?.devicePixelRatio !== 1 ||
  (heapGrowthMb !== null && heapGrowthMb >= 25) ||
  consoleErrors.length > 0 ||
  pageErrors.length > 0;

if (failed) process.exitCode = 1;
