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
  label: "深圳",
  latitude: 22.5431,
  longitude: 114.0579,
  startedOn: "2025-01-01",
  endedOn: null,
  source: "manual",
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
  // Keep today's active Journey on the same visible hemisphere as Shenzhen,
  // but well outside the renderer's Route Point hit threshold so ordinary Home
  // pointer ownership is exercised without manufacturing an overlap.
  journey("bbbbbbbb-2222-4222-8222-222222222222", "上海今夏", "2026-06-01", 31.2304, 121.4737),
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
    && currentContext.text.includes("常住地 · 深圳")
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
  await page.locator(".journey-story__close").click();
  await page.locator(".journey-story").waitFor({ state: "detached", timeout: 10_000 });
  const afterStory = await page.locator("[data-home-base-context]").count();
  record("Story immediately wins context ownership and Home does not auto-return", {
    duringStory, afterStory,
  }, duringStory === 0 && afterStory === 0);

  // Playback is the same ownership boundary.
  await clickProjectedHome(page, await currentHomeMarker(page));
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
  // fixture is geographically separated from current Shenzhen so the opening
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

  // Compact mobile uses the same geographic marker; no Home tab/tool is added.
  // The current Shenzhen Home is deliberately separated from both Journey Route
  // Points, so this proves ordinary Home activation without introducing an
  // empty-Atlas camera-seeding prerequisite into the ST-065 context contract.
  const mobile = await openOwner({ width: 390, height: 844 });
  const mobilePage = mobile.page;
  const mobileMarker = await currentHomeMarker(mobilePage);
  const mobilePointerOwner = await clickProjectedHome(mobilePage, mobileMarker);
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
  record("compact mobile opens the same context above native chrome with no permanent Home tab", {
    mobilePlacement, mobilePointerOwner,
  }, Boolean(
    mobilePlacement
    && mobilePlacement.mobileMode === "on"
    && mobilePlacement.inViewport
    && mobilePlacement.aboveChrome
    && mobilePlacement.markerHit >= 44
    && mobilePlacement.permanentHomeTabs === 0
    && mobilePlacement.suggestionsWhileContextOpen === 0
    && mobilePointerOwner.sceneOwnsHit
    && !mobilePointerOwner.homeOwnsHit
  ));
  await closeContext(mobilePage);
  await mobileMarker.focus();
  await mobilePage.keyboard.press("Enter");
  await mobileContext.waitFor({ state: "visible", timeout: 5_000 });
  record("compact mobile keyboard activation remains available", {}, await mobileContext.isVisible());
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
