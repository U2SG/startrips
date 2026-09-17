import { launchQaBrowser } from "./qa-browser.mjs";
import { setParticleZoom } from "./qa-particle-zoom.mjs";

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

function setZoom(page, targetZoom) {
  return setParticleZoom(page, targetZoom);
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
