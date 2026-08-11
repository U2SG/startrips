import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173/";
const outputDir = new URL("../docs/qa/current/", import.meta.url);
const fixturePath = fileURLToPath(
  new URL("../public/qa/upload-filled-artwork.jpg", import.meta.url),
);
const onlyJourney = process.env.QA_ONLY;
const results = [];

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForTimeout(120);
}

async function capturePhase(page, viewportName, phase, expected) {
  await settle(page);
  await page.screenshot({
    path: fileURLToPath(new URL(`${viewportName}-${phase}.png`, outputDir)),
  });

  const metrics = await page.evaluate(() => {
    const visibleControls = [...document.querySelectorAll("button, input, textarea")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && bounds.width > 0
          && bounds.height > 0;
      });

    return {
      mainClass: document.querySelector("main")?.className ?? "",
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      canvasCount: document.querySelectorAll("canvas").length,
      earthCanvasCount: document.querySelectorAll(
        'canvas[data-three-scene="particle-earth"]',
      ).length,
      galleryCanvasCount: document.querySelectorAll(
        'canvas[data-three-scene="hanging-gallery"]',
      ).length,
      galleryFullResolutionTextures: Number(
        document.querySelector(".hanging-gallery-canvas")
          ?.getAttribute("data-full-resolution-textures") ?? 0,
      ),
      overflowingControls: visibleControls
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left < -0.5
            || bounds.right > window.innerWidth + 0.5
            || bounds.top < -0.5
            || bounds.bottom > window.innerHeight + 0.5;
        })
        .map((element) => element.getAttribute("data-action")
          ?? element.getAttribute("aria-label")
          ?? element.textContent?.trim()
          ?? element.tagName),
    };
  });

  results.push({ viewportName, phase, expected, ...metrics });
}

async function createTrackedPage(viewport, isMobile = false) {
  const page = await browser.newPage({
    viewport,
    isMobile,
    hasTouch: isMobile,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, consoleErrors, pageErrors };
}

async function verifyLiveDesktopJourney() {
  const viewportName = "desktop";
  const { page, consoleErrors, pageErrors } = await createTrackedPage({
    width: 1280,
    height: 720,
  });

  try {
    const url = new URL(baseUrl);
    url.searchParams.set("quality", "low");
    await page.goto(url.href, { waitUntil: "networkidle" });
    await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "earth-intro-live", {
      canvasCount: 1,
      earthCanvasCount: 1,
      galleryCanvasCount: 0,
    });

    await page.locator(".primary-cta").click();
    await page.locator(".archive-shell").waitFor();
    await page.locator(".archive-controls button").nth(1).click();
    await page.locator(".artwork-browser-card.is-selected").click();
    await page.locator(".artwork-detail-actions button").first().click();

    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.locator(".personal-image-frame.has-image").waitFor();
    await page.locator(".editor-field--title input").fill("kobe with gianna.");
    await page.locator(".editor-field textarea").fill("我记忆深刻的瞬间");
    await page.locator(".location-row input").fill("洛杉矶");
    await page.locator(".location-row button").click();
    await page.locator(".editor-field--year input").fill("2020");
    await page.getByRole("button", { name: "选择星云紫" }).click();
    await page.evaluate(() => {
      const main = document.querySelector("main");
      window.__qaPhaseHistory = main ? [main.className] : [];
      const observer = new MutationObserver(() => {
        if (main) window.__qaPhaseHistory.push(main.className);
      });
      if (main) observer.observe(main, { attributes: true, attributeFilter: ["class"] });
      window.__qaPhaseObserver = observer;
    });
    await page.locator(".create-point").click();

    await page.locator(".point-confirmation").waitFor({ timeout: 5_000 });
    const phaseHistory = await page.evaluate(() => {
      window.__qaPhaseObserver?.disconnect();
      return window.__qaPhaseHistory ?? [];
    });
    const storedMoments = await page.evaluate(() => {
      const serialized = sessionStorage.getItem("art-history-twin:personal-moments");
      const moments = serialized ? JSON.parse(serialized) : [];
      return {
        count: moments.length,
        lightColor: moments[0]?.lightColor ?? null,
      };
    });

    await page.locator(".point-confirmation__actions button").last().click();
    await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "earth-return-live", {
      canvasCount: 1,
      earthCanvasCount: 1,
      galleryCanvasCount: 0,
    });

    const personalPoint = await page.locator(".particle-earth-scene").evaluate((element) => ({
      x: Number(element.getAttribute("data-personal-point-x")),
      y: Number(element.getAttribute("data-personal-point-y")),
      focusColor: element.getAttribute("data-focus-color"),
    }));
    await page.locator('canvas[data-three-scene="particle-earth"]').click({
      position: { x: personalPoint.x, y: personalPoint.y },
    });
    await page.locator('[data-gallery-ready="true"]').waitFor({ timeout: 15_000 });
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    await capturePhase(page, viewportName, "personal-gallery-live", {
      canvasCount: 1,
      earthCanvasCount: 0,
      galleryCanvasCount: 1,
    });

    await page.locator('[data-action="open-moment"]').click();
    await page.locator(".personal-moment-detail").waitFor();
    await capturePhase(page, viewportName, "moment-detail-live", {
      canvasCount: 0,
      earthCanvasCount: 0,
      galleryCanvasCount: 0,
    });

    await page.locator('[data-action="back-gallery"]').click();
    await page.locator('[data-gallery-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "gallery-return-live", {
      canvasCount: 1,
      earthCanvasCount: 0,
      galleryCanvasCount: 1,
    });

    await page.locator('[data-action="back-earth"]').click();
    await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "earth-final-live", {
      canvasCount: 1,
      earthCanvasCount: 1,
      galleryCanvasCount: 0,
    });

    results.push({
      viewportName,
      runtime: true,
      storedMoments: storedMoments.count,
      storedLightColor: storedMoments.lightColor,
      renderedLightColor: personalPoint.focusColor,
      phaseHistory,
      consoleErrors,
      pageErrors,
    });
  } finally {
    await page.close();
  }
}

async function verifyMobileJourney() {
  const viewportName = "mobile";
  const { page, consoleErrors, pageErrors } = await createTrackedPage(
    { width: 390, height: 844 },
    true,
  );

  try {
    const url = new URL(baseUrl);
    url.searchParams.set("qaState", "earth-return");
    url.searchParams.set("quality", "low");
    await page.goto(url.href, { waitUntil: "networkidle" });
    await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "earth-return", {
      canvasCount: 1,
      earthCanvasCount: 1,
      galleryCanvasCount: 0,
    });

    await page.locator(".personal-point-entry").click();
    await page.locator('[data-gallery-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "personal-gallery", {
      canvasCount: 1,
      earthCanvasCount: 0,
      galleryCanvasCount: 1,
    });

    await page.locator('[data-action="open-moment"]').click();
    await page.locator(".personal-moment-detail").waitFor();
    await capturePhase(page, viewportName, "moment-detail", {
      canvasCount: 0,
      earthCanvasCount: 0,
      galleryCanvasCount: 0,
    });

    await page.locator('[data-action="back-gallery"]').click();
    await page.locator('[data-gallery-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "gallery-return", {
      canvasCount: 1,
      earthCanvasCount: 0,
      galleryCanvasCount: 1,
    });

    await page.locator('[data-action="back-earth"]').click();
    await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 15_000 });
    await capturePhase(page, viewportName, "earth-final", {
      canvasCount: 1,
      earthCanvasCount: 1,
      galleryCanvasCount: 0,
    });

    results.push({ viewportName, runtime: true, consoleErrors, pageErrors });
  } finally {
    await page.close();
  }
}

try {
  if (onlyJourney !== "mobile") await verifyLiveDesktopJourney();
  if (onlyJourney !== "desktop") await verifyMobileJourney();
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));

const failed = results.some((result) => {
  if (result.runtime) {
    return result.consoleErrors.length > 0
      || result.pageErrors.length > 0
      || (result.storedMoments !== undefined && result.storedMoments !== 1)
      || (
        result.storedLightColor !== undefined
        && result.storedLightColor !== "#9e8cff"
      )
      || (
        result.renderedLightColor !== undefined
        && result.renderedLightColor !== "#9e8cff"
      )
      || (
        result.phaseHistory !== undefined
        && !result.phaseHistory.some((phase) => phase.includes("phase-generating"))
      );
  }

  return result.documentWidth > result.innerWidth
    || result.documentHeight > result.innerHeight
    || result.canvasCount !== result.expected.canvasCount
    || result.earthCanvasCount !== result.expected.earthCanvasCount
    || result.galleryCanvasCount !== result.expected.galleryCanvasCount
    || result.galleryFullResolutionTextures > 3
    || result.overflowingControls.length > 0;
});

if (failed) process.exitCode = 1;
