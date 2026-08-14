import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.QA_BASE_URL;
const email = process.env.QA_EMAIL;
const password = process.env.QA_PASSWORD;
const outputPath = process.env.QA_SCREENSHOT_PATH;
const viewport = {
  width: Number(process.env.QA_VIEWPORT_WIDTH ?? 1440),
  height: Number(process.env.QA_VIEWPORT_HEIGHT ?? 900),
};
const isComposerQaPreview = new URL(baseUrl ?? "http://invalid").searchParams.get("qaState")
  === "journey-composer";

if (!baseUrl || !email || !password || !outputPath) {
  throw new Error(
    "QA_BASE_URL, QA_EMAIL, QA_PASSWORD, and QA_SCREENSHOT_PATH are required",
  );
}

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});

if (isComposerQaPreview) {
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
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
  const dialog = page.locator(".journey-composer");
  if (!await dialog.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /记录.*旅程/ }).first().click();
  }
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(400);
  const metrics = await dialog.evaluate((element) => {
    const labels = [...element.querySelectorAll(".journey-story-fields label > span, .journey-location-search label > span")];
    const buttons = [...element.querySelectorAll("button")];
    const rect = element.getBoundingClientRect();
    const backdropRect = element.parentElement?.getBoundingClientRect();
    const atlasRect = element.closest(".living-atlas")?.getBoundingClientRect();
    const dialogStyle = getComputedStyle(element);
    const backdropStyle = element.parentElement ? getComputedStyle(element.parentElement) : null;
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScroll: { x: window.scrollX, y: window.scrollY },
      backdrop: backdropRect ? {
        x: Math.round(backdropRect.x),
        y: Math.round(backdropRect.y),
        width: Math.round(backdropRect.width),
        height: Math.round(backdropRect.height),
      } : null,
      atlas: atlasRect ? {
        x: Math.round(atlasRect.x),
        y: Math.round(atlasRect.y),
        width: Math.round(atlasRect.width),
        height: Math.round(atlasRect.height),
      } : null,
      layout: {
        dialogAlignSelf: dialogStyle.alignSelf,
        dialogMargin: dialogStyle.margin,
        backdropAlignItems: backdropStyle?.alignItems ?? null,
        backdropJustifyItems: backdropStyle?.justifyItems ?? null,
        backdropGridRows: backdropStyle?.gridTemplateRows ?? null,
      },
      labelFontSizes: [...new Set(labels.map((label) => getComputedStyle(label).fontSize))],
      buttonFontSizes: [...new Set(buttons.map((button) => getComputedStyle(button).fontSize))],
      hasStepNavigation: Boolean(element.querySelector(".journey-composer__steps")),
      preciseLocationOpen: element.querySelector(".journey-precise-location")?.hasAttribute("open") ?? null,
    };
  });
  await page.screenshot({ path: outputPath, fullPage: false });
  const focusFlow = {};
  focusFlow.initial = await page.evaluate(() => document.activeElement?.className ?? null);
  await page.keyboard.press("Shift+Tab");
  focusFlow.afterShiftTab = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
  await page.keyboard.press("Tab");
  focusFlow.afterWrap = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
  await page.keyboard.press("Tab");
  focusFlow.pickerVisible = await page.locator(".journey-media-picker").evaluate((element) => ({
    focusWithin: element.matches(":focus-within"),
    outlineStyle: getComputedStyle(element).outlineStyle,
  }));

  const preciseLocation = page.locator(".journey-precise-location");
  await preciseLocation.locator("summary").click();
  const preciseLocationToggled = await preciseLocation.evaluate((element) => element.hasAttribute("open"));

  let locationFlow = null;
  if (!isComposerQaPreview) {
    const searchInput = page.locator(".journey-location-search input");
    await searchInput.fill("National Gallery Singapore");
    await page.locator('.journey-location-search button[type="submit"]').click();
    const firstResult = page.locator(".journey-location-results button").first();
    await firstResult.waitFor({ state: "visible", timeout: 20_000 });
    const resultLabel = await firstResult.locator("strong").textContent();
    await firstResult.click();
    const routePoints = page.locator(".journey-route-draft > li:not(.is-empty)");
    locationFlow = {
      resultLabel,
      pointCount: await routePoints.count(),
      coordinateText: await routePoints.first().locator("small").textContent(),
    };
  }

  console.log(JSON.stringify({
    metrics,
    focusFlow,
    preciseLocationToggled,
    locationFlow,
    consoleErrors,
    pageErrors,
    failedResponses,
    outputPath,
  }, null, 2));

  if (
    !String(focusFlow.initial).includes("journey-composer")
    || !String(focusFlow.afterShiftTab).includes("保存")
    || focusFlow.afterWrap !== "关闭创建器"
    || focusFlow.pickerVisible.focusWithin !== true
    || focusFlow.pickerVisible.outlineStyle === "none"
    || preciseLocationToggled !== true
    || (!isComposerQaPreview && locationFlow?.pointCount !== 1)
    || consoleErrors.length > 0
    || pageErrors.length > 0
    || failedResponses.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await context.close();
  await browser.close();
}
