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
      ["compact", 320, 800, true],
      ["mobile", 390, 844, true],
      ["tablet", 768, 1024, false],
      ["desktop", 1280, 800, false],
    ]) {
      await page.setViewportSize({ width, height });
      const actionMetrics = await page.evaluate(() => (
        [...document.querySelectorAll(".journey-media-fields__actions")].map((group) => (
          [...group.querySelectorAll("button")].map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              ariaLabel: button.getAttribute("aria-label"),
              tooltip: button.getAttribute("data-tooltip"),
              visibleText: button.textContent?.trim() ?? "",
            };
          })
        ))
      ));
      const invalidActions = actionMetrics.some((group) => {
        if (group.length !== 3) return true;
        if (group.some((button) => button.width < (mobile ? 43 : 39) || button.height < (mobile ? 43 : 39))) return true;
        if (group.some((button) => !button.ariaLabel || !button.tooltip || button.visibleText !== "")) return true;
        return mobile && group.some((button) => button.width > 45 || button.height > 45);
      });
      record(`composer-${label}-media-actions`, await scanButtons(page, ".journey-composer", ".journey-composer__editor"), {
        actionMetrics,
        failed: invalidActions,
      });
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    const tooltipAction = page.locator(".journey-media-fields__actions .icon-action-button:not(:disabled)").first();
    await tooltipAction.scrollIntoViewIfNeeded();
    await tooltipAction.hover();
    await page.waitForFunction(() => {
      const button = document.querySelector(".journey-media-fields__actions .icon-action-button:not(:disabled)");
      return button && Number(getComputedStyle(button, "::after").opacity) >= 0.9;
    });
    const hoverTooltip = await tooltipAction.evaluate((button) => ({
      opacity: Number(getComputedStyle(button, "::after").opacity),
      content: getComputedStyle(button, "::after").content,
    }));
    await tooltipAction.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => {
      const button = document.querySelector(".journey-media-fields__actions .icon-action-button:not(:disabled)");
      return button === document.activeElement
        && button.matches(":focus-visible")
        && Number(getComputedStyle(button, "::after").opacity) >= 0.9;
    });
    const focusTooltip = await tooltipAction.evaluate((button) => ({
      focused: document.activeElement === button,
      focusVisible: button.matches(":focus-visible"),
      opacity: Number(getComputedStyle(button, "::after").opacity),
      content: getComputedStyle(button, "::after").content,
    }));
    const tooltipFailed = hoverTooltip.opacity < 0.9
      || !hoverTooltip.content.includes("移除媒体")
      || !focusTooltip.focused
      || !focusTooltip.focusVisible
      || focusTooltip.opacity < 0.9
      || !focusTooltip.content.includes("移除媒体");
    results.push({
      name: "composer-icon-action-tooltip-hover-focus",
      hoverTooltip,
      focusTooltip,
      failed: tooltipFailed,
    });
    if (tooltipFailed) failed = true;

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

    // Review P2 regression: normal modal close must restore the opener only
    // after the atlas siblings have been released from inert. The preview's
    // reopen button is an atlas sibling, so the old cleanup order reproduced
    // Chromium dropping focus to <body>.
    await page.getByRole("button", { name: "关闭旅程编辑器" }).click();
    await page.locator(".journey-composer").waitFor({ state: "detached" });
    const reopen = page.locator("[data-qa-composer-reopen]");
    await reopen.focus();
    await reopen.click();
    await page.locator(".journey-composer").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "关闭旅程编辑器" }).click();
    await page.locator(".journey-composer").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-qa-composer-reopen") ?? false);
    const modalCloseFocus = await page.evaluate(() => {
      const reopenButton = document.querySelector("[data-qa-composer-reopen]");
      return {
        activeIsReopen: document.activeElement === reopenButton,
        reopenInert: reopenButton instanceof HTMLElement ? Boolean(reopenButton.closest("[inert]")) : null,
        bodyOverflow: document.body.style.overflow,
      };
    });
    results.push({
      name: "composer-normal-close-focus-restoration",
      ...modalCloseFocus,
      failed: !modalCloseFocus.activeIsReopen
        || modalCloseFocus.reopenInert !== false
        || modalCloseFocus.bodyOverflow !== "",
    });
    if (results.at(-1).failed) failed = true;
  } finally {
    await page.close();
  }
}

async function verifyComposerGlobeRoundTrip() {
  console.error("[qa-post-login] app globe success round-trip");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  let reverseMode = "success";
  let reverseRequestCount = 0;
  let firstReverseStarted = null;
  let releaseFirstReverse = null;

  function deferred() {
    let resolve;
    const promise = new Promise((next) => { resolve = next; });
    return { promise, resolve };
  }

  function resetReverse(mode) {
    reverseMode = mode;
    reverseRequestCount = 0;
    firstReverseStarted = deferred();
    releaseFirstReverse = deferred();
  }

  const reversePayload = (label, provider) => ({
    result: label ? {
      id: `qa:${label}`,
      label,
      context: "QA reverse geocode",
      countryCode: "QA",
      latitude: 37.76942,
      longitude: -122.48621,
    } : null,
    attribution: provider ? { label: provider, url: "https://example.com/qa-geocode" } : null,
  });

  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys }),
  }));
  await page.route("**/api/locations/reverse?*", async (route) => {
    reverseRequestCount += 1;
    const requestNumber = reverseRequestCount;
    if (reverseMode === "failure") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "QA_REVERSE_UNAVAILABLE", message: "reverse unavailable" }),
      });
      return;
    }
    if (reverseMode === "empty") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(reversePayload(null, null)),
      });
      return;
    }
    if ((reverseMode === "stale" || reverseMode === "pending-delete") && requestNumber === 1) {
      firstReverseStarted?.resolve();
      await releaseFirstReverse?.promise;
      const label = reverseMode === "stale" ? "OLD QA PLACE" : "DELETED QA PLACE";
      const provider = reverseMode === "stale" ? "OLD QA PROVIDER" : "DELETED QA PROVIDER";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(reversePayload(label, provider)),
      });
      return;
    }
    const label = reverseMode === "stale" ? "NEW QA PLACE" : "QA PICKED PLACE";
    const provider = reverseMode === "stale" ? "NEW QA PROVIDER" : "QA GEO PROVIDER";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reversePayload(label, provider)),
    });
  });

  const routeItems = () => page.locator(".journey-route-draft > li:not(.is-empty)");
  const readPreview = () => page.locator("[data-qa-app-route-preview]").evaluate((element) => {
    const raw = element.getAttribute("data-route-points") ?? "[]";
    return JSON.parse(raw);
  });
  const settleRender = () => page.evaluate(() => new Promise((resolve) => (
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  )));
  const openFreshComposer = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas__active").waitFor({ state: "visible" });
    const focusExitHitTest = await page.evaluate(() => {
      const exit = document.querySelector(".living-atlas__globe-focus-exit");
      const create = document.querySelector(".living-atlas__create");
      if (!(exit instanceof HTMLElement) || !(create instanceof HTMLElement)) return null;
      const rect = create.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        exitAriaHidden: exit.getAttribute("aria-hidden"),
        exitTabIndex: exit.tabIndex,
        exitPointerEvents: getComputedStyle(exit).pointerEvents,
        hitIsExit: hit === exit || exit.contains(hit),
        hitInsideCreate: Boolean(hit && create.contains(hit)),
      };
    });
    if (
      !focusExitHitTest
      || focusExitHitTest.exitAriaHidden !== "true"
      || focusExitHitTest.exitTabIndex !== -1
      || focusExitHitTest.exitPointerEvents !== "none"
      || focusExitHitTest.hitIsExit
      || !focusExitHitTest.hitInsideCreate
    ) {
      throw new Error(`hidden globe-focus exit intercepted atlas hit testing: ${JSON.stringify(focusExitHitTest)}`);
    }
    await page.getByRole("button", { name: /记录旅程/ }).click();
    await page.locator(".journey-composer").waitFor({ state: "visible" });
    await page.locator("[data-qa-app-route-preview]").waitFor({ state: "attached" });
  };
  const completePick = async () => {
    const trigger = page.getByRole("button", { name: /直接在地球上取点/ });
    await trigger.scrollIntoViewIfNeeded();
    await settleRender();
    const scrollBefore = await page.locator(".journey-composer__editor").evaluate((element) => element.scrollTop);
    const countBefore = await routeItems().count();
    await trigger.click();
    await page.locator(".journey-globe-pick-hint").waitFor({ state: "visible" });
    // This waits on the actual LivingAtlasApp handoff: startGlobePick flips
    // globePickActive, releases the globe from inert, and supplies
    // completeGlobePick as the globe component's onGlobePointPick callback.
    await page.waitForFunction(() => {
      const root = document.querySelector(".living-atlas");
      const composer = document.querySelector(".journey-composer");
      const globeButton = document.querySelector("[data-qa-app-globe-point-pick]");
      return root?.classList.contains("is-globe-picking")
        && composer
        && getComputedStyle(composer).visibility === "hidden"
        && globeButton instanceof HTMLButtonElement
        && !globeButton.disabled
        && !globeButton.closest("[inert]");
    });
    const picking = await page.evaluate(() => {
      const root = document.querySelector(".living-atlas");
      const composer = document.querySelector(".journey-composer");
      const globeButton = document.querySelector("[data-qa-app-globe-point-pick]");
      return {
        appPickActive: root?.classList.contains("is-globe-picking") ?? false,
        composerVisibility: composer ? getComputedStyle(composer).visibility : null,
        bodyOverflow: document.body.style.overflow,
        globeButtonInert: globeButton instanceof HTMLElement ? Boolean(globeButton.closest("[inert]")) : null,
        globeButtonDisabled: globeButton instanceof HTMLButtonElement ? globeButton.disabled : null,
      };
    });
    // The QA globe stands in for WebGL hit-testing; dispatch its React click
    // directly so unrelated atlas chrome cannot intercept the synthetic pointer.
    // The button still calls the onGlobePointPick prop supplied by LivingAtlasApp.
    await page.locator("[data-qa-app-globe-point-pick]").evaluate((button) => button.click());
    await page.waitForFunction(() => {
      const root = document.querySelector(".living-atlas");
      const composer = document.querySelector(".journey-composer");
      return !root?.classList.contains("is-globe-picking")
        && composer
        && getComputedStyle(composer).visibility === "visible"
        && (document.activeElement?.classList.contains("journey-globe-pick-button") ?? false);
    });
    await page.waitForFunction((expected) => (
      document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length === expected
    ), countBefore + 1);
    await page.waitForFunction((expected) => {
      const output = document.querySelector("[data-qa-app-route-preview]");
      const points = JSON.parse(output?.getAttribute("data-route-points") ?? "[]");
      return points.length === expected;
    }, countBefore + 1);
    const scrollAfter = await page.locator(".journey-composer__editor").evaluate((element) => element.scrollTop);
    const preview = await readPreview();
    const lastPoint = preview.at(-1) ?? null;
    const returned = await page.evaluate(() => ({
      appPickActive: document.querySelector(".living-atlas")?.classList.contains("is-globe-picking") ?? false,
      bodyOverflow: document.body.style.overflow,
      composerVisibility: getComputedStyle(document.querySelector(".journey-composer")).visibility,
      activeIsTrigger: document.activeElement?.classList.contains("journey-globe-pick-button") ?? false,
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      overflowY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    }));
    return { countBefore, scrollBefore, scrollAfter, picking, preview, lastPoint, returned };
  };

  try {
    for (const [label, width, height] of [
      ["compact", 320, 800],
      ["mobile-small", 360, 800],
      ["mobile", 390, 844],
    ]) {
      resetReverse("success");
      await openFreshComposer(width, height);
      const roundTrip = await completePick();
      await page.getByText("已根据坐标识别为「QA PICKED PLACE」，可继续修改。").waitFor({ state: "visible" });
      const routeCountAfter = await routeItems().count();
      const labelValue = await routeItems().last().locator('input[aria-label^="地点 "]').inputValue();
      const coordinateText = await routeItems().last().locator(".journey-route-draft__main > small").textContent();
      const successFailed = !roundTrip.picking.appPickActive
        || roundTrip.picking.composerVisibility !== "hidden"
        || roundTrip.picking.bodyOverflow !== "hidden"
        || roundTrip.picking.globeButtonInert !== false
        || roundTrip.picking.globeButtonDisabled !== false
        || roundTrip.returned.appPickActive
        || routeCountAfter !== roundTrip.countBefore + 1
        || Math.abs(roundTrip.scrollAfter - roundTrip.scrollBefore) > 2
        || !roundTrip.returned.activeIsTrigger
        || roundTrip.returned.bodyOverflow !== "hidden"
        || roundTrip.returned.composerVisibility !== "visible"
        || roundTrip.returned.overflowX > 0
        || roundTrip.returned.overflowY > 0
        || Math.abs((roundTrip.lastPoint?.lat ?? 0) - 37.76942) > 0.000001
        || Math.abs((roundTrip.lastPoint?.lon ?? 0) - (-122.48621)) > 0.000001
        || roundTrip.lastPoint?.isStop !== true
        || labelValue !== "QA PICKED PLACE"
        || !String(coordinateText).includes("37.769420, -122.486210");
      results.push({
        name: `app-${label}-globe-pick-success-roundtrip`,
        ...roundTrip,
        routeCountAfter,
        labelValue,
        coordinateText,
        failed: successFailed,
      });
      if (successFailed) failed = true;
    }

    for (const mode of ["empty", "failure"]) {
      resetReverse(mode);
      await openFreshComposer(390, 844);
      const roundTrip = await completePick();
      const expectedMessage = mode === "empty"
        ? "已从地球添加地点，未识别到对应名称；可手动补充。"
        : "已从地球添加地点；坐标识别暂不可用，可手动补充名称。";
      await page.getByText(expectedMessage).waitFor({ state: "visible" });
      const lastInput = routeItems().last().locator('input[aria-label^="地点 "]');
      const beforeManual = await lastInput.inputValue();
      const manualLabel = `手动地点-${mode}`;
      await lastInput.fill(manualLabel);
      await page.waitForFunction((expectedLabel) => {
        const output = document.querySelector("[data-qa-app-route-preview]");
        const points = JSON.parse(output?.getAttribute("data-route-points") ?? "[]");
        return points.at(-1)?.label === expectedLabel;
      }, manualLabel);
      const preview = await readPreview();
      const degradationFailed = beforeManual !== ""
        || await routeItems().count() !== roundTrip.countBefore + 1
        || preview.at(-1)?.label !== manualLabel
        || !roundTrip.returned.activeIsTrigger
        || Math.abs(roundTrip.scrollAfter - roundTrip.scrollBefore) > 2;
      results.push({
        name: `app-globe-pick-geocode-${mode}-degradation`,
        expectedMessage,
        beforeManual,
        manualLabel,
        previewLast: preview.at(-1) ?? null,
        failed: degradationFailed,
      });
      if (degradationFailed) failed = true;
    }

    // #36 review regression: deleting the just-picked point while its lookup is
    // pending must clear the shared "正在识别…" state, and the late response must
    // stay unable to resurrect either the point or its status/attribution.
    resetReverse("pending-delete");
    await openFreshComposer(390, 844);
    await completePick();
    await firstReverseStarted.promise;
    await page.getByText("已从地球添加地点；正在识别坐标对应的名称…").waitFor({ state: "visible" });
    const deletedResponse = page.waitForResponse((response) => (
      response.url().includes("/api/locations/reverse?")
      && response.url().includes("latitude=37.76942")
    ));
    await routeItems().last().getByRole("button", { name: "删除地点" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length === 0);
    await page.locator(".journey-composer__message").waitFor({ state: "detached" });
    releaseFirstReverse.resolve();
    await deletedResponse;
    await settleRender();
    const deletedPreview = await readPreview();
    const deletedLookupState = await page.evaluate(() => ({
      message: document.querySelector(".journey-composer__message")?.textContent?.trim() ?? "",
      attribution: document.querySelector(".journey-location-attribution")?.textContent?.trim() ?? "",
    }));
    const deletedLookupFailed = deletedPreview.length !== 0
      || deletedLookupState.message !== ""
      || deletedLookupState.attribution.includes("DELETED QA PROVIDER");
    results.push({
      name: "app-globe-pick-delete-pending-geocode",
      deletedPreview,
      deletedLookupState,
      failed: deletedLookupFailed,
    });
    if (deletedLookupFailed) failed = true;

    // Hold the old response behind an explicit barrier. Only release it after
    // the newer response is visible, then await the old network response and
    // two render frames before asserting it cannot replace current UI state.
    resetReverse("stale");
    await openFreshComposer(390, 844);
    await completePick();
    await firstReverseStarted.promise;
    await completePick();
    await page.getByText("已根据坐标识别为「NEW QA PLACE」，可继续修改。").waitFor({ state: "visible" });
    await page.getByText("地点数据 NEW QA PROVIDER").waitFor({ state: "visible" });
    const staleResponse = page.waitForResponse((response) => (
      response.url().includes("/api/locations/reverse?")
      && response.url().includes("latitude=37.76942")
    ));
    releaseFirstReverse.resolve();
    await staleResponse;
    await settleRender();
    const staleState = await page.evaluate(() => ({
      message: document.querySelector(".journey-composer__message")?.textContent?.trim() ?? "",
      attribution: document.querySelector(".journey-location-attribution")?.textContent?.trim() ?? "",
    }));
    const stalePreview = await readPreview();
    const staleFailed = reverseRequestCount !== 2
      || staleState.message !== "已根据坐标识别为「NEW QA PLACE」，可继续修改。"
      || !staleState.attribution.includes("NEW QA PROVIDER")
      || staleState.attribution.includes("OLD QA PROVIDER")
      || stalePreview.length !== 2
      || stalePreview.at(0)?.label !== "OLD QA PLACE"
      || stalePreview.at(-1)?.label !== "NEW QA PLACE";
    results.push({
      name: "app-globe-pick-stale-geocode-isolation",
      reverseRequestCount,
      staleState,
      stalePreview,
      failed: staleFailed,
    });
    if (staleFailed) failed = true;
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
  await verifyComposerGlobeRoundTrip();
  await verifyAccountDock();
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
if (failed) process.exitCode = 1;
