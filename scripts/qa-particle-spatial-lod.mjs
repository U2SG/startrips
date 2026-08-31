import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const focus = { lat: 22.3193, lon: 114.1694 }; // Hong Kong / Shenzhen regional view.
const qaUrl = new URL(
  `/?qaState=journey-routes&qaQuality=high&qaFocusLat=${focus.lat}&qaFocusLon=${focus.lon}`,
  baseUrl,
).toString();
const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function debug(page) {
  return page.evaluate(() => window.__particleEarthDebug?.() ?? null);
}

async function setZoom(page, targetZoom) {
  const before = await debug(page);
  if (!before) throw new Error("Particle Earth debug state is unavailable");
  if (Math.abs(before.zoom - targetZoom) <= 0.02) return before;
  const canvas = page.locator('canvas[data-three-scene="particle-earth"]');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Particle Earth canvas has no bounds");
  const clientX = bounds.x + bounds.width / 2;
  const clientY = bounds.y + bounds.height / 2;
  const deltaY = -Math.log(targetZoom / before.zoom) / 0.0012;
  await canvas.evaluate((node, init) => node.dispatchEvent(new WheelEvent("wheel", init)), {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    deltaY,
  });
  await page.waitForTimeout(120);
  const after = await debug(page);
  if (!after || Math.abs(after.zoom - targetZoom) > 0.03) {
    throw new Error(`Unable to set particle LOD zoom: ${JSON.stringify({ targetZoom, before, after })}`);
  }
  return after;
}

async function waitForRefinement(page, minimumCount) {
  await page.waitForFunction((minimum) => {
    const state = window.__particleEarthDebug?.();
    return Boolean(
      state
      && state.particleRefinementCount >= minimum
      && ["ready", "cached"].includes(state.particleRefinementBuild),
    );
  }, minimumCount, { timeout: 20_000 });
  return debug(page);
}

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
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

try {
  await page.goto(qaUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => Boolean(window.__particleEarthDebug?.()));
  await page.waitForTimeout(250);

  const one = await setZoom(page, 1);
  const twoZoom = await setZoom(page, 2);
  const twoExpected = Math.max(1, Math.floor(twoZoom.particleRefinementCap * 0.2));
  const two = await waitForRefinement(page, twoExpected);
  const threeZoom = await setZoom(page, 3);
  const threeExpected = Math.max(two.particleRefinementCount + 1, Math.floor(threeZoom.particleRefinementCap * 0.9));
  const three = await waitForRefinement(page, threeExpected);

  const result = {
    baseUrl,
    focus,
    one: {
      zoom: one.zoom,
      semanticLod: one.semanticLod,
      baseCount: one.particleBaseCount,
      refinementCount: one.particleRefinementCount,
    },
    two: {
      zoom: two.zoom,
      semanticLod: two.semanticLod,
      baseCount: two.particleBaseCount,
      refinementCount: two.particleRefinementCount,
      refinementCap: two.particleRefinementCap,
      region: two.particleRefinementRegion,
      build: two.particleRefinementBuild,
    },
    three: {
      zoom: three.zoom,
      semanticLod: three.semanticLod,
      baseCount: three.particleBaseCount,
      refinementCount: three.particleRefinementCount,
      refinementCap: three.particleRefinementCap,
      region: three.particleRefinementRegion,
      build: three.particleRefinementBuild,
    },
    source: three.particleLandSource,
    consoleErrors,
    pageErrors,
  };

  const sameRegion = two.particleRefinementRegion?.key === three.particleRefinementRegion?.key;
  const regionNearFocus = three.particleRefinementRegion
    && Math.abs(three.particleRefinementRegion.center.lat - focus.lat) <= 18
    && Math.abs(three.particleRefinementRegion.center.lon - focus.lon) <= 18;
  const bounded = three.particleRefinementCap <= 9_000
    && three.particleRefinementCap < three.particleBaseCount;
  if (
    one.particleRefinementCount !== 0
    || two.particleRefinementCount <= one.particleRefinementCount
    || three.particleRefinementCount <= two.particleRefinementCount
    || three.particleRefinementCount > three.particleRefinementCap
    || !sameRegion
    || !regionNearFocus
    || !bounded
    || !three.particleLandSource.includes("ne_50m_land.geojson@50m;mask=1440x720")
    || consoleErrors.length > 0
    || pageErrors.length > 0
  ) {
    throw new Error(`Particle spatial LOD QA failed: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
  await browser.close();
}
