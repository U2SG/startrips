// #233 / ST-065 — owner-private Home Base activation/context QA.
// The existing projected Home anchor is the sole entry point. This lane proves
// pointer + keyboard activation, compact-mobile layout, historical period truth,
// and that Story/Playback/timeline intent wins without inventing another camera
// or semantic focus owner.
import { mkdirSync } from "node:fs";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const captureDir = "artifacts/home-base-context";
mkdirSync(captureDir, { recursive: true });

const CURRENT_HOME = {
  id: "11111111-aaaa-4111-8111-111111111111",
  label: "北京",
  latitude: 39.9075,
  longitude: 116.39723,
  startedOn: "2025-01-01",
  endedOn: null,
  source: "manual",
};
const CITY_FIXTURE = {
  cities: [{
    n: "Beijing", z: "北京", la: 39.9075, lo: 116.39723, p: 18_960_744, r: 0, c: "CN",
  }],
};

const HISTORICAL_HOME = {
  id: "22222222-bbbb-4222-8222-222222222222",
  label: "成都",
  latitude: 30.5728,
  longitude: 104.0668,
  startedOn: "2022-01-01",
  endedOn: "2024-12-31",
  source: "manual",
};

function journey(id, title, startedOn, latitude, longitude) {
  return {
    id,
    atlasId: "qa-atlas",
    title,
    startedOn,
    endedOn: startedOn,
    note: "",
    lightColor: "#77c8c2",
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 1,
    createdByUserId: "qa-user",
    createdAt: `${startedOn}T00:00:00.000Z`,
    updatedAt: `${startedOn}T00:00:00.000Z`,
    routePoints: [
      {
        id: `${id}-point`, journeyId: id, sortOrder: 0,
        latitude, longitude, label: title, isStop: true,
        occurredAt: `${startedOn}T12:00:00.000Z`, note: null,
        createdAt: `${startedOn}T12:00:00.000Z`,
      },
    ],
    media: [],
  };
}

const journeys = [
  journey("aaaaaaaa-1111-4111-8111-111111111111", "成都旧日", "2023-06-01", 30.5728, 104.0668),
  // Keep desktop arbitration comfortably beyond the renderer's 0.18-unit Route
  // Point threshold while Beijing remains the exact Home/city overlap fixture.
  journey("bbbbbbbb-2222-4222-8222-222222222222", "赣南今夏", "2026-06-01", 25.0, 116.4),
];
const mobileJourneys = [
  journeys[0],
  // Compact mobile separately proves Home's keyboard/accessibility target and
  // context placement. Put the selected Journey on Home so projection is stable;
  // pointer precedence for overlapping Route Points is already exercised above.
  journey(
    "bbbbbbbb-2222-4222-8222-222222222222",
    "北京今夏",
    "2026-06-01",
    CURRENT_HOME.latitude,
    CURRENT_HOME.longitude,
  ),
];

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
let failed = false;

function record(name, data, condition) {
  checks.push({ name, ...data, failed: !condition });
  if (!condition) failed = true;
}

async function installOwnerApi(page, journeyRows = journeys) {
  // Exercise the real city-label projection/arbitration with one deterministic
  // GeoNames-shaped city at Home. The production dataset/collision budget is
  // covered elsewhere; this lane owns the interaction boundary itself.
  await page.route("**/earth/cities.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(CITY_FIXTURE),
  }));
  const session = {
    session: {
      id: "qa-home-session", userId: "qa-user", token: "qa-token",
      expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z", activeOrganizationId: "qa-org",
    },
    user: {
      id: "qa-user", name: "QA Traveler", email: "qa@example.com", emailVerified: true,
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  await page.route("**/api/auth/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/get-session")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) });
    }
    if (pathname.endsWith("/organization/list")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify([{ id: "qa-org", name: "QA Atlas", slug: "qa-atlas" }]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/atlases/current", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "同行记忆" }, role: "owner" }),
  }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ journeys: journeyRows }),
  }));
  await page.route("**/api/home-bases/dismissal", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ dismissals: [] }),
  }));
  await page.route("**/api/home-bases", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ periods: [HISTORICAL_HOME, CURRENT_HOME] }),
  }));
}

async function openOwner(viewport, { journeyRows = journeys } = {}) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installOwnerApi(page, journeyRows);
  // This contract starts from the EXISTING projected Home anchor, so the lane
  // must mount the real LivingAtlasGlobe rather than LivingAtlasQaGlobe (which
  // intentionally has no geographic Home projection surface).
  await page.goto(`${origin}/?qaState=atlas-gateway&qaMode=globe-chrome`, { waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 30_000 });
  try {
    await page.waitForFunction(
      (periodId) => {
        const node = document.querySelector(`[data-home-base-period-id="${periodId}"]`);
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return !node.hidden && style.display !== "none" && rect.width >= 44 && rect.height >= 44;
      },
      CURRENT_HOME.id,
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate((periodId) => {
      const marker = document.querySelector(`[data-home-base-period-id="${periodId}"]`);
      const markerRect = marker instanceof HTMLElement ? marker.getBoundingClientRect() : null;
      const markerStyle = marker instanceof HTMLElement ? getComputedStyle(marker) : null;
      const scene = document.querySelector(".particle-earth-scene");
      const globe = document.querySelector(".living-atlas-globe");
      const atlas = document.querySelector(".living-atlas");
      return {
        mobileV2: atlas?.getAttribute("data-mobile-v2") ?? null,
        atlasClass: atlas?.getAttribute("class") ?? null,
        markerCount: document.querySelectorAll("[data-home-base-period-id]").length,
        marker: marker instanceof HTMLElement ? {
          hidden: marker.hidden,
          display: markerStyle?.display ?? null,
          visibility: markerStyle?.visibility ?? null,
          rect: markerRect ? { x: markerRect.x, y: markerRect.y, width: markerRect.width, height: markerRect.height } : null,
          presence: marker.getAttribute("data-home-base-presence"),
        } : null,
        earthDive: globe?.getAttribute("data-earth-dive") ?? null,
        earthDiveOwner: globe?.getAttribute("data-earth-dive-owner") ?? null,
        sceneReady: scene?.getAttribute("data-scene-ready") ?? null,
        focusRevision: scene?.getAttribute("data-focus-revision") ?? null,
        focusTargetLat: scene?.getAttribute("data-focus-target-lat") ?? null,
        focusTargetLon: scene?.getAttribute("data-focus-target-lon") ?? null,
        routeFocusLat: scene?.getAttribute("data-route-focus-lat") ?? null,
        routeFocusLon: scene?.getAttribute("data-route-focus-lon") ?? null,
      };
    }, CURRENT_HOME.id);
    throw new Error(`Home marker did not become actionable: ${JSON.stringify(diagnostics)}; ${error instanceof Error ? error.message : String(error)}`);
  }
  return { page, pageErrors };
}

async function currentHomeMarker(page) {
  return page.locator(`[data-home-base-period-id="${CURRENT_HOME.id}"]`);
}

async function clickProjectedHome(page, marker) {
  const box = await marker.boundingBox();
  if (!box) throw new Error("Projected Home marker has no pointer geometry");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const owner = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return {
      tag: hit?.tagName ?? null,
      className: hit instanceof Element ? hit.getAttribute("class") : null,
      homeOwnsHit: Boolean(hit?.closest?.(".living-atlas-globe__home-base")),
      sceneOwnsHit: Boolean(hit?.closest?.(".particle-earth-scene") || hit?.matches?.('canvas[data-three-scene="particle-earth"]')),
    };
  }, { x, y });
  if (owner.homeOwnsHit || !owner.sceneOwnsHit) {
    throw new Error(`Projected Home pointer is not renderer-owned: ${JSON.stringify(owner)}`);
  }
  await page.mouse.click(x, y);
  return owner;
}

async function closeContext(page) {
  const context = page.locator("[data-home-base-context]");
  if (await context.count()) {
    await context.getByRole("button", { name: "关闭常住地信息" }).click();
    await context.waitFor({ state: "detached", timeout: 5_000 });
  }
}

async function homeMarkerCenter(marker) {
  const box = await marker.boundingBox();
  if (!box) throw new Error("Projected Home marker has no pointer geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function revealHomeCityLabel(page, marker) {
  await homeMarkerCenter(marker);
  await page.waitForFunction(() => [...document.querySelectorAll(".particle-earth-city")].some((node) => (
    node.textContent?.includes("北京") && getComputedStyle(node).display !== "none"
  )), null, { timeout: 5_000 });
  return page.evaluate(() => {
    const markerNode = document.querySelector('[data-home-base-presence="current"]');
    const city = [...document.querySelectorAll(".particle-earth-city")].find((node) => (
      node.textContent?.includes("北京") && getComputedStyle(node).display !== "none"
    ));
    if (!(markerNode instanceof HTMLElement) || !(city instanceof SVGTextElement)) return null;
    const home = markerNode.getBoundingClientRect();
    const label = city.getBoundingClientRect();
    const left = Math.max(home.left, label.left);
    const right = Math.min(home.right, label.right);
    const top = Math.max(home.top, label.top);
    const bottom = Math.min(home.bottom, label.bottom);
    if (right <= left || bottom <= top) return null;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y,
      hitCity: Boolean(hit?.closest?.(".particle-earth-city")),
      cityLat: city.getAttribute("data-city-lat"),
      cityLon: city.getAttribute("data-city-lon"),
    };
  });
}

try {
  // Desktop pointer + keyboard activation and semantic non-ownership.
  const desktop = await openOwner({ width: 1280, height: 860 });
  const page = desktop.page;
  const marker = await currentHomeMarker(page);
  const markerMetrics = await marker.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      label: element.getAttribute("aria-label"),
      tabIndex: element.tabIndex,
    };
  });
  // Pointer ownership is measured on the unobscured geographic surface. The
  // ordinary desktop active card legitimately sits above part of the globe;
  // globe-focus removes that competing UI without changing the projected Home
  // anchor or inventing a second interaction path.
  await page.locator(".living-atlas__globe-focus").click();
  await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  const desktopPointerOwner = await clickProjectedHome(page, marker);
  const context = page.locator("[data-home-base-context]");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  const currentContext = await context.evaluate((element) => ({
    periodId: element.getAttribute("data-home-base-period-id"),
    presence: element.getAttribute("data-home-base-presence"),
    text: element.textContent ?? "",
    role: element.getAttribute("role"),
    modal: element.getAttribute("aria-modal"),
    coordinates: /\b-?\d{1,3}\.\d{3,}\b/.test(element.textContent ?? ""),
  }));
  await page.screenshot({ path: `${captureDir}/01-desktop-current-context.png`, fullPage: false });
  record("desktop pointer opens exact current Home context without a modal or coordinates", {
    markerMetrics, currentContext, desktopPointerOwner,
  }, Boolean(
    markerMetrics.width >= 44
    && markerMetrics.height >= 44
    && markerMetrics.tabIndex === 0
    && desktopPointerOwner.sceneOwnsHit
    && !desktopPointerOwner.homeOwnsHit
    && markerMetrics.label?.includes("当前常住地")
    && currentContext.periodId === CURRENT_HOME.id
    && currentContext.presence === "current"
    && currentContext.text.includes("常住地 · 北京")
    && currentContext.text.includes("2025-01-01 起")
    && !currentContext.coordinates
    && currentContext.role === null
    && currentContext.modal === null
  ));

  await closeContext(page);
  await page.locator(".living-atlas__globe-focus-exit").click();
  await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "off");
  await marker.focus();
  await page.keyboard.press("Enter");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  record("desktop keyboard activation opens the same current Home context", {
    periodId: await context.getAttribute("data-home-base-period-id"),
  }, (await context.getAttribute("data-home-base-period-id")) === CURRENT_HOME.id);

  // Story is a newer narrative owner. It closes Home context and closing Story
  // does not resurrect an old Home intent.
  await page.locator(".living-atlas__active-actions button", { hasText: "打开故事" }).click();
  await page.locator(".journey-story").waitFor({ state: "visible", timeout: 15_000 });
  const duringStory = await page.locator("[data-home-base-context]").count();
  const homeTargetsDuringStory = await page.locator("[data-home-base-period-id]").count();
  await page.locator(".journey-story__close").click();
  await page.locator(".journey-story").waitFor({ state: "detached", timeout: 10_000 });
  const afterStory = await page.locator("[data-home-base-context]").count();
  record("Story disables Home activation and old Home context does not auto-return", {
    duringStory, homeTargetsDuringStory, afterStory,
  }, duringStory === 0 && homeTargetsDuringStory === 0 && afterStory === 0);

  // Playback is the same ownership boundary. Pointer Home activation was
  // already proven on an unobscured globe above; the active Journey card is a
  // legitimate higher visual layer here, so use Home's keyboard target to open
  // context before Playback takes ownership rather than clicking through UI.
  const playbackHomeMarker = await currentHomeMarker(page);
  await playbackHomeMarker.focus();
  await page.keyboard.press("Enter");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  await page.locator(".living-atlas__active-play").click();
  await page.locator(".living-atlas__playback-mode-menu button", { hasText: "完整播放" }).first().click();
  await page.locator(".journey-playback").waitFor({ state: "visible", timeout: 20_000 });
  const duringPlayback = await page.locator("[data-home-base-context]").count();
  // ST-065 only proves Playback ownership. Escape dismissal is a separate
  // release-candidate regression family (#356), so close through Playback's
  // explicit product control rather than coupling this lane to that contract.
  await page.locator('.journey-playback button[aria-label="退出播放"]').click();
  await page.locator(".journey-playback").waitFor({ state: "detached", timeout: 20_000 });
  const returnedStory = page.locator(".journey-story");
  if (await returnedStory.isVisible()) {
    await returnedStory.locator(".journey-story__close").click();
    await returnedStory.waitFor({ state: "detached", timeout: 10_000 });
  }
  const afterPlayback = await page.locator("[data-home-base-context]").count();
  record("Playback immediately wins context ownership and Home does not auto-return", {
    duringPlayback, afterPlayback,
  }, duringPlayback === 0 && afterPlayback === 0);

  // Rewind to the earliest dated Journey while globe focus owns the composition.
  // That date falls inside the historical Guangzhou Home period. The same marker
  // activation must now resolve the historical period rather than today's Home.
  await page.locator(".living-atlas__globe-focus").click();
  const scrubber = page.locator(".globe-time-scrubber__track");
  await scrubber.waitFor({ state: "visible", timeout: 10_000 });
  await scrubber.focus();
  await page.keyboard.press("Home");
  const historicalMarker = page.locator(`[data-home-base-period-id="${HISTORICAL_HOME.id}"]`);
  await historicalMarker.waitFor({ state: "visible", timeout: 15_000 });
  // The historical Journey point intentionally shares this Home coordinate; the
  // fixture is geographically separated from current Beijing so the opening
  // Home-pointer check is not accidentally owned by this historical Route Point.
  // Pointer activation must keep the existing Route Point owner; keyboard Home
  // activation remains available and clears that subordinate point context.
  await clickProjectedHome(page, historicalMarker);
  const overlappingRoutePointContext = page.locator("[data-route-point-context]");
  await overlappingRoutePointContext.waitFor({ state: "visible", timeout: 5_000 });
  record("overlapping Home pointer preserves Route Point ownership", {
    routePointId: await overlappingRoutePointContext.getAttribute("data-route-point-id"),
    homeContextCount: await page.locator("[data-home-base-context]").count(),
  }, (await overlappingRoutePointContext.getAttribute("data-route-point-id")) === `${journeys[0].id}-point`
    && (await page.locator("[data-home-base-context]").count()) === 0);
  await historicalMarker.focus();
  await page.keyboard.press("Enter");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  const historicalContext = await context.evaluate((element) => ({
    periodId: element.getAttribute("data-home-base-period-id"),
    presence: element.getAttribute("data-home-base-presence"),
    text: element.textContent ?? "",
  }));
  await page.screenshot({ path: `${captureDir}/02-desktop-historical-context.png`, fullPage: false });
  record("rewind exposes and activates the exact historical Home period", { historicalContext }, Boolean(
    historicalContext.periodId === HISTORICAL_HOME.id
    && historicalContext.presence === "period-context"
    && historicalContext.text.includes("常住地 · 成都")
    && historicalContext.text.includes("2022-01-01–2024-12-31")
    && historicalContext.text.includes("历史生活阶段")
  ));
  await closeContext(page);
  await page.locator(".living-atlas__globe-focus-exit").click();
  await page.close();

  // City text is painted over the same geographic surface. Zoom from the Home
  // region so the Beijing label becomes eligible, then require an actual label
  // hit inside Home's 44 px target to use the renderer's one arbitration path.
  const arbitration = await openOwner({ width: 1280, height: 800 });
  const arbitrationPage = arbitration.page;
  await arbitrationPage.locator(".living-atlas__globe-focus").click();
  await arbitrationPage.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  const arbitrationMarker = await currentHomeMarker(arbitrationPage);
  const cityHomeOverlap = await revealHomeCityLabel(arbitrationPage, arbitrationMarker);
  record("deterministic city label physically overlaps Home and owns the hit", { cityHomeOverlap }, Boolean(
    cityHomeOverlap?.hitCity && cityHomeOverlap.cityLat && cityHomeOverlap.cityLon
  ));
  if (!cityHomeOverlap?.hitCity) {
    throw new Error(`Beijing city label did not overlap Home hit area: ${JSON.stringify(cityHomeOverlap)}`);
  }

  // Wheel after the SVG city glyph is proven to own the hit. That exercises
  // the delegated renderer wheel path rather than a nearby canvas coordinate.
  const beforeCityWheelZoom = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.().zoom ?? null);
  await arbitrationPage.mouse.move(cityHomeOverlap.x, cityHomeOverlap.y);
  await arbitrationPage.mouse.wheel(0, -240);
  await arbitrationPage.waitForFunction((previous) => {
    const current = window.__particleEarthDebug?.().zoom;
    return typeof current === "number" && previous !== null && current > previous;
  }, beforeCityWheelZoom, { timeout: 5_000 });
  const afterCityWheelZoom = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.().zoom ?? null);
  record("wheel beginning on city/Home overlap stays canonical renderer zoom", {
    beforeCityWheelZoom, afterCityWheelZoom,
  }, typeof beforeCityWheelZoom === "number"
    && typeof afterCityWheelZoom === "number"
    && afterCityWheelZoom > beforeCityWheelZoom);

  // Zoom legitimately moves the projection, so re-read the physical overlap.
  const postWheelOverlap = await revealHomeCityLabel(arbitrationPage, arbitrationMarker);
  if (!postWheelOverlap?.hitCity) {
    throw new Error(`Beijing city/Home overlap disappeared after renderer-owned wheel: ${JSON.stringify(postWheelOverlap)}`);
  }
  await arbitrationPage.mouse.click(postWheelOverlap.x, postWheelOverlap.y);
  const arbitrationContext = arbitrationPage.locator("[data-home-base-context]");
  await arbitrationContext.waitFor({ state: "visible", timeout: 5_000 });
  record("ordinary city-label contact inside Home region resolves to Home after higher renderer owners yield", {
    periodId: await arbitrationContext.getAttribute("data-home-base-period-id"),
  }, (await arbitrationContext.getAttribute("data-home-base-period-id")) === CURRENT_HOME.id);
  await closeContext(arbitrationPage);

  const beforeDrag = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.() ?? null);
  await arbitrationPage.mouse.move(postWheelOverlap.x, postWheelOverlap.y);
  await arbitrationPage.mouse.down();
  await arbitrationPage.mouse.move(postWheelOverlap.x + 64, postWheelOverlap.y + 20, { steps: 5 });
  await arbitrationPage.mouse.up();
  const afterDrag = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.() ?? null);
  record("drag beginning in city/Home overlap remains the canonical globe gesture", {
    before: beforeDrag ? { rotationX: beforeDrag.rotationX, rotationY: beforeDrag.rotationY } : null,
    after: afterDrag ? {
      rotationX: afterDrag.rotationX,
      rotationY: afterDrag.rotationY,
      manualFocusOwner: afterDrag.manualFocusOwner,
      dragAngularDisplacement: afterDrag.dragAngularDisplacement,
    } : null,
    homeContextCount: await arbitrationPage.locator("[data-home-base-context]").count(),
  }, Boolean(
    afterDrag?.manualFocusOwner
    && afterDrag.dragAngularDisplacement?.total > 0
    && (await arbitrationPage.locator("[data-home-base-context]").count()) === 0
  ));
  await arbitrationPage.close();

  // Globe coordinate-picking is the highest owner. Recreate the same physical
  // city/Home overlap, enter the existing composer pick mode, and require that
  // the city coordinate is accepted without ever opening Home context.
  const globePick = await openOwner({ width: 1280, height: 800 });
  const globePickPage = globePick.page;
  await globePickPage.locator(".living-atlas__globe-focus").click();
  await globePickPage.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  const globePickMarker = await currentHomeMarker(globePickPage);
  const globePickOverlap = await revealHomeCityLabel(globePickPage, globePickMarker);
  if (!globePickOverlap?.hitCity) {
    throw new Error(`Globe-pick city/Home overlap unavailable: ${JSON.stringify(globePickOverlap)}`);
  }
  await globePickPage.locator(".living-atlas__globe-focus-exit").click();
  await globePickPage.getByRole("button", { name: "记录旅程" }).click();
  await globePickPage.locator(".journey-composer").waitFor({ state: "visible", timeout: 5_000 });
  await globePickPage.getByRole("button", { name: /直接在地球上取点/ }).click();
  await globePickPage.waitForFunction(() => document.querySelector(".living-atlas")?.classList.contains("is-globe-picking"));
  const pickingCity = globePickPage.locator(".particle-earth-city").filter({ hasText: "北京" }).first();
  await pickingCity.waitFor({ state: "visible", timeout: 5_000 });
  await pickingCity.click();
  await globePickPage.waitForFunction(() => !document.querySelector(".living-atlas")?.classList.contains("is-globe-picking"), null, { timeout: 5_000 });
  const acceptedCoordinateText = await globePickPage.locator(
    ".journey-route-draft li:not(.is-empty) .journey-route-draft__main > small",
  ).first().textContent();
  const acceptedCoordinates = String(acceptedCoordinateText ?? "")
    .split(",")
    .map((value) => Number(value.trim()));
  const expectedCityCoordinates = [Number(globePickOverlap.cityLat), Number(globePickOverlap.cityLon)];
  const cityCoordinatePreserved = acceptedCoordinates.length === 2
    && acceptedCoordinates.every(Number.isFinite)
    && expectedCityCoordinates.every(Number.isFinite)
    && Math.abs(acceptedCoordinates[0] - expectedCityCoordinates[0]) <= 0.0001
    && Math.abs(acceptedCoordinates[1] - expectedCityCoordinates[1]) <= 0.0001;
  record("globe coordinate-pick wins over Home and preserves the selected city coordinate", {
    homeContextCount: await globePickPage.locator("[data-home-base-context]").count(),
    acceptedCoordinates,
    expectedCityCoordinates,
  }, (await globePickPage.locator("[data-home-base-context]").count()) === 0 && cityCoordinatePreserved);
  await globePickPage.close();

  // Compact mobile uses the same geographic marker; no Home tab/tool is added.
  // Compact mobile proves the same Home context through its accessible keyboard
  // target while Route Point pointer precedence remains independently covered.
  const mobile = await openOwner({ width: 390, height: 844 }, { journeyRows: mobileJourneys });
  const mobilePage = mobile.page;
  const mobileMarker = await currentHomeMarker(mobilePage);
  await mobileMarker.focus();
  await mobilePage.keyboard.press("Enter");
  const mobileContext = mobilePage.locator("[data-home-base-context]");
  await mobileContext.waitFor({ state: "visible", timeout: 5_000 });
  const mobilePlacement = await mobilePage.evaluate(() => {
    const node = document.querySelector("[data-home-base-context]");
    const chrome = document.querySelector(".mobile-v2__chrome");
    const marker = document.querySelector('[data-home-base-presence="current"]');
    if (!(node instanceof HTMLElement) || !(marker instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const chromeRect = chrome?.getBoundingClientRect();
    return {
      mobileMode: document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2"),
      inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      aboveChrome: chromeRect ? rect.bottom <= chromeRect.top + 1 : true,
      markerHit: Math.min(markerRect.width, markerRect.height),
      permanentHomeTabs: [...document.querySelectorAll("button")]
        .filter((button) => /Home Base|常住地/.test(button.textContent ?? "") && !button.matches(".living-atlas-globe__home-base")).length,
      suggestionsWhileContextOpen: document.querySelectorAll(".living-atlas__home-base-suggestion").length,
    };
  });
  await mobilePage.screenshot({ path: `${captureDir}/03-mobile-current-context.png`, fullPage: false });
  record("compact mobile keyboard activation opens the same context above native chrome with no permanent Home tab", {
    mobilePlacement,
  }, Boolean(
    mobilePlacement
    && mobilePlacement.mobileMode === "on"
    && mobilePlacement.inViewport
    && mobilePlacement.aboveChrome
    && mobilePlacement.markerHit >= 44
    && mobilePlacement.permanentHomeTabs === 0
    && mobilePlacement.suggestionsWhileContextOpen === 0
  ));
  await closeContext(mobilePage);
  await mobilePage.close();

  record("owner browser pages have no page errors", {
    desktop: desktop.pageErrors,
    mobile: mobile.pageErrors,
  }, desktop.pageErrors.length === 0 && mobile.pageErrors.length === 0);
} finally {
  await browser.close();
}

console.log(JSON.stringify({ checks }, null, 2));
if (failed) process.exit(1);
