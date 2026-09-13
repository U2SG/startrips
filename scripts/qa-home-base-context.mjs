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
  label: "广州",
  latitude: 23.1291,
  longitude: 113.2644,
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
  journey("aaaaaaaa-1111-4111-8111-111111111111", "广州旧日", "2023-06-01", 23.1291, 113.2644),
  journey("bbbbbbbb-2222-4222-8222-222222222222", "深圳今夏", "2026-06-01", 35.6762, 139.6503),
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

async function installOwnerApi(page) {
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
    status: 200, contentType: "application/json", body: JSON.stringify({ journeys }),
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

async function openOwner(viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installOwnerApi(page);
  // This contract starts from the EXISTING projected Home anchor, so the lane
  // must mount the real LivingAtlasGlobe rather than LivingAtlasQaGlobe (which
  // intentionally has no geographic Home projection surface).
  await page.goto(`${origin}/?qaState=atlas-gateway&qaMode=globe-chrome`, { waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 30_000 });
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
  return { page, pageErrors };
}

async function currentHomeMarker(page) {
  return page.locator(`[data-home-base-period-id="${CURRENT_HOME.id}"]`);
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
  await marker.click();
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
    markerMetrics, currentContext,
  }, Boolean(
    markerMetrics.width >= 44
    && markerMetrics.height >= 44
    && markerMetrics.tabIndex === 0
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
  await (await currentHomeMarker(page)).click();
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
  // The historical Journey point intentionally shares this Home coordinate.
  // Pointer activation must keep the existing Route Point owner; keyboard Home
  // activation remains available and clears that subordinate point context.
  await historicalMarker.click();
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
    && historicalContext.text.includes("常住地 · 广州")
    && historicalContext.text.includes("2022-01-01–2024-12-31")
    && historicalContext.text.includes("历史生活阶段")
  ));
  await closeContext(page);
  await page.locator(".living-atlas__globe-focus-exit").click();
  await page.close();

  // Compact mobile uses the same geographic marker; no Home tab/tool is added.
  const mobile = await openOwner({ width: 390, height: 844 });
  const mobilePage = mobile.page;
  const mobileMarker = await currentHomeMarker(mobilePage);
  await mobileMarker.click();
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
