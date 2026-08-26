import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const browser = await launchQaBrowser();
const results = [];
let failed = false;

const journeys = [
  makeJourney(0, "2026-08-20", "海风经过深圳湾", "#77c8c2", "深圳湾"),
  makeJourney(1, "2026-06-12", "夏夜抵达上海", "#e8a87c", "上海外滩"),
  makeJourney(2, "2025-12-28", "东京冬日散步", "#9fd356", "东京上野"),
  makeJourney(3, "2024-04-09", "春天在巴黎醒来", "#b39ddb", "巴黎左岸"),
];

function makeJourney(index, startedOn, title, lightColor, label) {
  const id = `qa-journey-${index}`;
  return {
    id,
    atlasId: "qa-atlas",
    title,
    startedOn,
    endedOn: null,
    note: "这是一段用于登录后体验回归的旅程。",
    lightColor,
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 1,
    createdByUserId: "qa-user",
    createdAt: `${startedOn}T00:00:00.000Z`,
    updatedAt: `${startedOn}T00:00:00.000Z`,
    routePoints: [{
      id: `qa-point-${index}`,
      journeyId: id,
      sortOrder: 0,
      latitude: 22.5 + index,
      longitude: 114 + index,
      label,
      isStop: true,
      occurredAt: null,
      note: null,
      createdAt: `${startedOn}T00:00:00.000Z`,
    }],
    media: [],
  };
}

function overlapPairs(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      if (overlapX > 2 && overlapY > 2) {
        pairs.push({ a: a.name, b: b.name, area: Math.round(overlapX * overlapY) });
      }
    }
  }
  return pairs;
}

async function scanButtons(page, rootSelector, clipSelector = null) {
  return page.evaluate(({ rootSelector, clipSelector }) => {
    const root = document.querySelector(rootSelector);
    if (!root) return null;
    const clip = clipSelector ? document.querySelector(clipSelector)?.getBoundingClientRect() : null;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const bounds = clip ?? viewport;
    const items = [...root.querySelectorAll("button")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(rect.right, bounds.right, viewport.right) - Math.max(rect.left, bounds.left, viewport.left));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, bounds.bottom, viewport.bottom) - Math.max(rect.top, bounds.top, viewport.top));
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0.05
          && style.pointerEvents !== "none"
          && visibleWidth > 2
          && visibleHeight > 2;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: (element.getAttribute("aria-label") || element.textContent || "button")
            .trim().replace(/\s+/g, " ").slice(0, 80),
          left: Math.max(rect.left, bounds.left, viewport.left),
          top: Math.max(rect.top, bounds.top, viewport.top),
          right: Math.min(rect.right, bounds.right, viewport.right),
          bottom: Math.min(rect.bottom, bounds.bottom, viewport.bottom),
        };
      });
    return {
      items,
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      overflowY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    };
  }, { rootSelector, clipSelector });
}

function record(name, scan, extra = {}) {
  if (!scan) {
    failed = true;
    results.push({ name, failed: true, reason: "missing-root" });
    return;
  }
  const overlaps = overlapPairs(scan.items);
  const result = { name, overlaps, overflowX: scan.overflowX, overflowY: scan.overflowY, ...extra };
  if (overlaps.length || scan.overflowX || scan.overflowY || extra.failed) failed = true;
  results.push(result);
}

async function clickText(page, text) {
  await page.evaluate((label) => {
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === label)
      ?.click();
  }, text);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

async function verifyAtlasShell() {
  console.error("[qa-post-login] atlas shell");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await page.route("**/api/journeys", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ journeys }),
    }));
    await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas__active").waitFor({ state: "visible" });

    for (const [label, width, height] of [
      ["mobile-compact", 360, 800],
      ["mobile", 390, 844],
      ["tablet", 768, 1024],
    ]) {
      await page.setViewportSize({ width, height });
      await clickText(page, "地球");
      const brandNavOverlap = await page.evaluate(() => {
        const brand = document.querySelector(".living-atlas__brand")?.getBoundingClientRect();
        const nav = document.querySelector(".living-atlas__header nav")?.getBoundingClientRect();
        if (!brand || !nav) return -1;
        return Math.round(
          Math.max(0, Math.min(brand.right, nav.right) - Math.max(brand.left, nav.left))
          * Math.max(0, Math.min(brand.bottom, nav.bottom) - Math.max(brand.top, nav.top)),
        );
      });
      const planet = await scanButtons(page, ".living-atlas");
      record(`atlas-${label}-planet`, planet, {
        brandNavOverlap,
        failed: brandNavOverlap !== 0,
      });

      await clickText(page, "时间线");
      const timeline = await scanButtons(page, ".living-atlas");
      record(`atlas-${label}-timeline`, timeline, {
        brandNavOverlap,
        failed: brandNavOverlap !== 0,
      });
    }
  } finally {
    await page.close();
  }
}

async function verifyComposerMediaActions() {
  console.error("[qa-post-login] composer media actions");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}/?qaState=journey-composer&qaMode=edit`, { waitUntil: "domcontentloaded" });
    const fileInput = page.locator(".journey-media-picker input[type=file]");
    await fileInput.setInputFiles([
      { name: "very-long-summer-memory-one.jpg", mimeType: "image/jpeg", buffer: Buffer.from("a") },
      { name: "night-train-window-two.png", mimeType: "image/png", buffer: Buffer.from("b") },
    ]);

    for (const [label, width, height, mobile] of [
      ["mobile", 390, 844, true],
      ["tablet", 768, 1024, false],
      ["desktop", 1280, 800, false],
    ]) {
      await page.setViewportSize({ width, height });
      const actionMetrics = await page.evaluate(() => (
        [...document.querySelectorAll(".journey-media-fields__actions")].map((group) => (
          [...group.querySelectorAll("button")].map((button) => {
            const rect = button.getBoundingClientRect();
            return { width: Math.round(rect.width), height: Math.round(rect.height) };
          })
        ))
      ));
      const invalidActions = actionMetrics.some((group) => {
        if (group.length !== 3) return true;
        if (group.some((button) => button.width < 43 || button.height < (mobile ? 43 : 35))) return true;
        return mobile && Math.max(...group.map((button) => button.width)) - Math.min(...group.map((button) => button.width)) > 1;
      });
      record(`composer-${label}-media-actions`, await scanButtons(page, ".journey-composer", ".journey-composer__editor"), {
        actionMetrics,
        failed: invalidActions,
      });
    }
  } finally {
    await page.close();
  }
}

async function verifyAccountDock() {
  console.error("[qa-post-login] account dock");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  let authenticated = false;
  const session = {
    session: {
      id: "qa-session",
      userId: "qa-user",
      token: "qa-token",
      expiresAt: "2026-08-27T00:00:00.000Z",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      activeOrganizationId: "qa-org",
    },
    user: {
      id: "qa-user",
      name: "QA Traveler",
      email: "qa@example.com",
      emailVerified: true,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    },
  };
  try {
    await page.route("**/api/auth/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/sign-in/email")) {
        authenticated = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      if (pathname.endsWith("/get-session")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(authenticated ? session : null),
        });
        return;
      }
      if (pathname.endsWith("/organization/list")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ id: "qa-org", name: "QA Atlas", slug: "qa-atlas" }]),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/atlases/current", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "同行记忆" }, role: "owner" }),
    }));
    await page.route("**/api/journeys", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ journeys }),
    }));
    await page.goto(`${origin}/?qaState=atlas-gateway&qaLite=1`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').fill("qa@example.com");
    await page.locator('input[type="password"]').fill("password1234");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".account-dock__tab").waitFor({ state: "visible" });
    await page.locator(".living-atlas__active").waitFor({ state: "visible" });

    for (const [label, width, height] of [
      ["mobile", 390, 844],
      ["tablet", 768, 1024],
    ]) {
      await page.setViewportSize({ width, height });
      const tabNavOverlap = await page.evaluate(() => {
        const tab = document.querySelector(".account-dock__tab")?.getBoundingClientRect();
        const nav = document.querySelector(".living-atlas__header nav")?.getBoundingClientRect();
        if (!tab || !nav) return -1;
        return Math.round(
          Math.max(0, Math.min(tab.right, nav.right) - Math.max(tab.left, nav.left))
          * Math.max(0, Math.min(tab.bottom, nav.bottom) - Math.max(tab.top, nav.top)),
        );
      });
      record(`account-${label}-closed`, await scanButtons(page, ".living-atlas"), {
        tabNavOverlap,
        failed: tabNavOverlap !== 0,
      });
    }

    await page.locator(".account-dock__tab").click();
    const panelMetrics = await page.locator(".account-dock__panel").evaluate((panel) => ({
      overflowX: panel.scrollWidth - panel.clientWidth,
      overflowY: panel.scrollHeight - panel.clientHeight,
      buttons: [...panel.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
    }));
    const invalidPanel = panelMetrics.overflowX > 0
      || panelMetrics.overflowY > 0
      || panelMetrics.buttons.some((button) => button.height < 31);
    results.push({ name: "account-panel", ...panelMetrics, failed: invalidPanel });
    if (invalidPanel) failed = true;
  } finally {
    await page.close();
  }
}

try {
  await verifyAtlasShell();
  await verifyComposerMediaActions();
  await verifyAccountDock();
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
if (failed) process.exitCode = 1;
