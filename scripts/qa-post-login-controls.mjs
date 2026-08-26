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

    for (const [label, width, height] of [
      ["compact", 320, 800],
      ["mobile-small", 360, 800],
      ["mobile", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const trigger = page.getByRole("button", { name: /直接在地球上取点/ });
      await trigger.click();
      const cancel = page.locator(".journey-globe-pick-hint button");
      await cancel.waitFor({ state: "visible" });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      const pickMetrics = await page.evaluate(() => {
        const composer = document.querySelector(".journey-composer");
        const globe = document.querySelector(".living-atlas__globe");
        const cancelButton = document.querySelector(".journey-globe-pick-hint button");
        const hint = document.querySelector(".journey-globe-pick-hint");
        const cancelRect = cancelButton?.getBoundingClientRect();
        const hintRect = hint?.getBoundingClientRect();
        return {
          activeLabel: document.activeElement?.textContent?.trim() ?? null,
          activeInsideComposer: Boolean(composer?.contains(document.activeElement)),
          globeInert: globe instanceof HTMLElement ? globe.inert : null,
          bodyOverflow: document.body.style.overflow,
          composerVisibility: composer ? getComputedStyle(composer).visibility : null,
          cancelButton: cancelRect ? {
            width: Math.round(cancelRect.width),
            height: Math.round(cancelRect.height),
          } : null,
          hint: hintRect ? {
            x: Math.round(hintRect.x),
            y: Math.round(hintRect.y),
            right: Math.round(hintRect.right),
            bottom: Math.round(hintRect.bottom),
          } : null,
          overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          overflowY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
        };
      });

      await page.keyboard.press("Tab");
      const tabEscapedHiddenComposer = await page.evaluate(() => {
        const composer = document.querySelector(".journey-composer");
        return !composer?.contains(document.activeElement);
      });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".journey-composer-backdrop")?.classList.contains("is-globe-picking"));
      await page.waitForFunction(
        () => document.activeElement?.classList.contains("journey-globe-pick-button") ?? false,
        null,
        { timeout: 1000, polling: 25 },
      );
      const restored = await page.evaluate(() => {
        const composer = document.querySelector(".journey-composer");
        const globe = document.querySelector(".living-atlas__globe");
        const active = document.activeElement;
        return {
          activeText: active?.textContent?.trim() ?? null,
          activeIsTrigger: active?.classList.contains("journey-globe-pick-button") ?? false,
          globeInert: globe instanceof HTMLElement ? globe.inert : null,
          bodyOverflow: document.body.style.overflow,
          composerVisibility: composer ? getComputedStyle(composer).visibility : null,
        };
      });

      const pickFailed = pickMetrics.globeInert !== false
        || pickMetrics.bodyOverflow !== "hidden"
        || pickMetrics.composerVisibility !== "hidden"
        || pickMetrics.activeInsideComposer
        || !String(pickMetrics.activeLabel).includes("取消")
        || !pickMetrics.cancelButton
        || pickMetrics.cancelButton.width < 43
        || pickMetrics.cancelButton.height < 43
        || !pickMetrics.hint
        || pickMetrics.hint.x < 0
        || pickMetrics.hint.right > width
        || pickMetrics.hint.bottom > height
        || pickMetrics.overflowX > 0
        || pickMetrics.overflowY > 0
        || !tabEscapedHiddenComposer
        || !restored.activeIsTrigger
        || restored.globeInert !== true
        || restored.bodyOverflow !== "hidden"
        || restored.composerVisibility !== "visible";
      record(`composer-${label}-globe-pick-focus`, {
        items: [],
        overflowX: pickMetrics.overflowX,
        overflowY: pickMetrics.overflowY,
      }, {
        pickMetrics,
        tabEscapedHiddenComposer,
        restored,
        failed: pickFailed,
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

    for (const [label, width, height, mobile] of [
      ["mobile-narrow", 320, 800, true],
      ["mobile-compact", 360, 800, true],
      ["mobile", 390, 844, true],
      ["tablet", 768, 1024, false],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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

      await page.locator(".account-dock__tab").click();
      const panel = page.locator(".account-dock__panel");
      await panel.waitFor({ state: "visible" });
      const panelMetrics = await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          viewportOverflowX: Math.max(0, Math.round(rect.right - innerWidth)) + Math.max(0, Math.round(-rect.left)),
          viewportOverflowY: Math.max(0, Math.round(rect.bottom - innerHeight)) + Math.max(0, Math.round(-rect.top)),
          overflowX: element.scrollWidth - element.clientWidth,
          overflowY: element.scrollHeight - element.clientHeight,
          buttons: [...element.querySelectorAll("button")].map((button) => {
            const buttonRect = button.getBoundingClientRect();
            return { width: Math.round(buttonRect.width), height: Math.round(buttonRect.height) };
          }),
        };
      });
      const minimumButtonHeight = mobile ? 43 : 31;
      const invalidPanel = panelMetrics.viewportOverflowX > 0
        || panelMetrics.viewportOverflowY > 0
        || panelMetrics.overflowX > 0
        || panelMetrics.overflowY > 0
        || panelMetrics.buttons.some((button) => button.height < minimumButtonHeight);
      results.push({
        name: `account-${label}-panel`,
        ...panelMetrics,
        minimumButtonHeight,
        failed: invalidPanel,
      });
      if (invalidPanel) failed = true;

      await page.locator(".account-dock__tab").click();
      await panel.waitFor({ state: "hidden" });
    }

    await page.goto(`${origin}/?qaState=globe-controls-gateway&qaLite=1`, { waitUntil: "domcontentloaded" });
    const globeControls = page.locator(".living-atlas-globe__controls");
    await globeControls.waitFor({ state: "visible" });
    await page.locator(".account-dock__tab").waitFor({ state: "visible" });

    for (const [label, width, height, mobile] of [
      ["mobile-narrow", 320, 800, true],
      ["mobile-compact", 360, 800, true],
      ["mobile", 390, 844, true],
      ["tablet", 768, 1024, false],
    ]) {
      await page.setViewportSize({ width, height });
      // Chromium can report one-frame-stale media-query geometry immediately
      // after a viewport resize; wait for style + layout to settle.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await page.evaluate(() => {
        const controls = document.querySelector(".living-atlas-globe__controls");
        const account = document.querySelector(".account-dock__tab");
        if (!controls || !account) return null;
        const controlsRect = controls.getBoundingClientRect();
        const accountRect = account.getBoundingClientRect();
        const overlapX = Math.max(0, Math.min(controlsRect.right, accountRect.right) - Math.max(controlsRect.left, accountRect.left));
        const overlapY = Math.max(0, Math.min(controlsRect.bottom, accountRect.bottom) - Math.max(controlsRect.top, accountRect.top));
        return {
          controls: {
            x: Math.round(controlsRect.x),
            y: Math.round(controlsRect.y),
            width: Math.round(controlsRect.width),
            height: Math.round(controlsRect.height),
          },
          account: {
            x: Math.round(accountRect.x),
            y: Math.round(accountRect.y),
            width: Math.round(accountRect.width),
            height: Math.round(accountRect.height),
          },
          overlapArea: Math.round(overlapX * overlapY),
          viewportOverflowX: Math.max(0, Math.round(controlsRect.right - innerWidth)) + Math.max(0, Math.round(-controlsRect.left)),
          buttons: [...controls.querySelectorAll("button")].map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              name: (button.getAttribute("aria-label") || button.textContent || "button").trim().replace(/\s+/g, " "),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }),
          modeTextVisible: getComputedStyle(document.querySelector(".living-atlas-globe__mode > span")).display !== "none",
          compactPickVisible: getComputedStyle(document.querySelector(".living-atlas-globe__pick-label-compact")).display !== "none",
          overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          overflowY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
        };
      });
      const minimumButtonHeight = mobile ? 43 : 35;
      const invalidControls = !metrics
        || metrics.overlapArea > 0
        || metrics.viewportOverflowX > 0
        || metrics.overflowX > 0
        || metrics.overflowY > 0
        || metrics.buttons.some((button) => button.height < minimumButtonHeight)
        || (mobile && metrics.controls.height > 52)
        || (mobile && width > 340 && !metrics.compactPickVisible)
        || (mobile && width <= 340 && (metrics.modeTextVisible || metrics.compactPickVisible));
      results.push({
        name: `globe-controls-${label}`,
        ...metrics,
        minimumButtonHeight,
        failed: invalidControls,
      });
      if (invalidControls) failed = true;
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      const pickState = document.createElement("div");
      pickState.className = "journey-composer-backdrop is-globe-picking";
      pickState.dataset.qaPickState = "true";
      document.body.append(pickState);
    });
    // Pointer blocking applies immediately; opacity follows the app's global
    // transition and needs a short settle before visual-state assertions.
    await page.waitForTimeout(150);
    const focusedPickState = await page.evaluate(() => {
      const controls = document.querySelector(".living-atlas-globe__controls");
      const account = document.querySelector(".account-dock");
      const controlsStyle = getComputedStyle(controls);
      const accountStyle = getComputedStyle(account);
      return {
        controlsVisibility: controlsStyle.visibility,
        controlsOpacity: controlsStyle.opacity,
        controlsPointerEvents: controlsStyle.pointerEvents,
        accountVisibility: accountStyle.visibility,
        accountOpacity: accountStyle.opacity,
        accountPointerEvents: accountStyle.pointerEvents,
      };
    });
    await page.evaluate(() => {
      const before = document.createElement("button");
      before.type = "button";
      before.dataset.qaFocusBefore = "true";
      before.textContent = "before";
      const after = document.createElement("button");
      after.type = "button";
      after.dataset.qaFocusAfter = "true";
      after.textContent = "after";
      document.body.prepend(before);
      document.body.append(after);
      before.focus();
    });
    await page.keyboard.press("Tab");
    const keyboardSkippedHiddenUtilities = await page.evaluate(() => (
      document.activeElement?.getAttribute("data-qa-focus-after") === "true"
    ));
    await page.evaluate(() => {
      document.querySelector('[data-qa-focus-before="true"]')?.remove();
      document.querySelector('[data-qa-focus-after="true"]')?.remove();
    });
    const invalidPickState = focusedPickState.controlsVisibility !== "hidden"
      || Number(focusedPickState.controlsOpacity) > 0.01
      || focusedPickState.controlsPointerEvents !== "none"
      || focusedPickState.accountVisibility !== "hidden"
      || Number(focusedPickState.accountOpacity) > 0.01
      || focusedPickState.accountPointerEvents !== "none"
      || !keyboardSkippedHiddenUtilities;
    results.push({
      name: "globe-pick-focused-state",
      ...focusedPickState,
      keyboardSkippedHiddenUtilities,
      failed: invalidPickState,
    });
    if (invalidPickState) failed = true;
    await page.evaluate(() => document.querySelector('[data-qa-pick-state="true"]')?.remove());
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
