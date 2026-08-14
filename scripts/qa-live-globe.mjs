import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.QA_BASE_URL;
const email = process.env.QA_EMAIL;
const password = process.env.QA_PASSWORD;
const screenshotPath = process.env.QA_SCREENSHOT_PATH;

if (!baseUrl || !email || !password) {
  throw new Error("QA_BASE_URL, QA_EMAIL, and QA_PASSWORD are required");
}

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

async function globeState() {
  return page.evaluate(() => window.__particleEarthDebug?.() ?? null);
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const emailInput = page.locator('input[type="email"]').first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator("button.auth-primary").click();
  }

  const scene = page.locator('[data-scene-ready="true"]');
  const organizationChoices = page.locator(".auth-choice-list button");
  await Promise.race([
    scene.waitFor({ timeout: 20_000 }),
    organizationChoices.first().waitFor({ timeout: 20_000 }),
  ]);
  if (await organizationChoices.first().isVisible().catch(() => false)) {
    await organizationChoices.first().click();
  }
  await scene.waitFor({ timeout: 20_000 });

  const locationSearch = await page.evaluate(async () => {
    const response = await fetch(
      "/api/locations/search?q=National%20Gallery%20Singapore",
      { credentials: "include" },
    );
    const payload = await response.json();
    return { status: response.status, payload };
  });

  const canvas = page.locator('canvas[data-three-scene="particle-earth"]');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Globe canvas has no layout bounds");
  const centerX = bounds.x + bounds.width * 0.52;
  const centerY = bounds.y + bounds.height * 0.55;

  const before = await globeState();
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 180, centerY - 46, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(220);
  const afterDrag = await globeState();

  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(220);
  const afterWheel = await globeState();

  const cdp = await context.newCDPSession(page);
  const pinchBefore = await globeState();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: centerX - 50, y: centerY, radiusX: 2, radiusY: 2, force: 1, id: 1 },
      { x: centerX + 50, y: centerY, radiusX: 2, radiusY: 2, force: 1, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: centerX - 85, y: centerY, radiusX: 2, radiusY: 2, force: 1, id: 1 },
      { x: centerX + 85, y: centerY, radiusX: 2, radiusY: 2, force: 1, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(220);
  const afterPinch = await globeState();

  const canvasMetrics = await canvas.evaluate((element) => ({
    pixelRatioX: element.width / element.clientWidth,
    pixelRatioY: element.height / element.clientHeight,
    dragging: element.parentElement?.getAttribute("data-dragging") ?? null,
  }));
  const result = {
    before,
    afterDrag,
    afterWheel,
    pinchBefore,
    afterPinch,
    locationSearch,
    canvasMetrics,
    consoleErrors,
    pageErrors,
  };
  console.log(JSON.stringify(result, null, 2));

  if (
    !before
    || !afterDrag
    || !afterWheel
    || !pinchBefore
    || !afterPinch
    || Math.abs(afterDrag.rotationY - before.rotationY) < 0.08
    || before.coastlineVertices < 10_000
    || afterWheel.zoom <= afterDrag.zoom + 0.03
    || afterPinch.zoom <= pinchBefore.zoom + 0.03
    || locationSearch.status !== 200
    || !Array.isArray(locationSearch.payload?.results)
    || locationSearch.payload.results.length === 0
    || locationSearch.payload?.attribution?.url !== "https://www.openstreetmap.org/copyright"
    || canvasMetrics.pixelRatioX < 1.95
    || canvasMetrics.pixelRatioY < 1.95
    || canvasMetrics.dragging !== null
    || consoleErrors.length > 0
    || pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await context.close();
  await browser.close();
}
