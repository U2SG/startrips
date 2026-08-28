import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const finalAcceptanceOnly = process.argv.includes("--final-acceptance");
const browser = await launchQaBrowser(finalAcceptanceOnly
  ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }
  : undefined);
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
    await page.locator(".living-atlas").waitFor({ state: "visible" });

    for (const [label, width, height] of [
      ["mobile-compact", 360, 800],
      ["mobile", 390, 844],
      ["tablet", 768, 1024],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const mobile = width <= 760;
      if (mobile) {
        await page.locator(".mobile-v2__journey-chip").waitFor({ state: "visible" });
        const mobileShell = await page.evaluate(() => {
          const root = document.querySelector(".living-atlas");
          const chrome = document.querySelector(".mobile-v2__chrome");
          const chromeRect = chrome?.getBoundingClientRect();
          const primaryTouchTargets = [...document.querySelectorAll(
            ".mobile-v2__header button, .mobile-v2__timeline .globe-time-scrubber__play",
          )].map((element) => {
            const rect = element.getBoundingClientRect();
            return Math.min(rect.width, rect.height);
          });
          return {
            mobileV2: root?.getAttribute("data-mobile-v2"),
            desktopHeader: document.querySelectorAll(".living-atlas__header").length,
            desktopCard: document.querySelectorAll(".living-atlas__active").length,
            desktopRail: document.querySelectorAll(".living-atlas__journey-rail").length,
            mobileChip: document.querySelectorAll(".mobile-v2__journey-chip").length,
            mobileTimeline: document.querySelectorAll(".mobile-v2__timeline").length,
            chromeHeight: chromeRect ? Math.round(chromeRect.height) : null,
            minPrimaryTouchTarget: primaryTouchTargets.length > 0 ? Math.min(...primaryTouchTargets) : null,
          };
        });
        record(`atlas-${label}-earth-first`, await scanButtons(page, ".living-atlas"), {
          ...mobileShell,
          failed: mobileShell.mobileV2 !== "on"
            || mobileShell.desktopHeader !== 0
            || mobileShell.desktopCard !== 0
            || mobileShell.desktopRail !== 0
            || mobileShell.mobileChip !== 1
            || mobileShell.mobileTimeline !== 1
            || mobileShell.chromeHeight === null
            || mobileShell.chromeHeight > 125
            || mobileShell.minPrimaryTouchTarget === null
            || mobileShell.minPrimaryTouchTarget < 44,
        });
        continue;
      }

      await page.locator(".living-atlas__active").waitFor({ state: "visible" });
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

async function verifyMobileV2InteractionContract() {
  console.error("[qa-post-login] mobile v2 interaction contract");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await page.route("**/api/journeys", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ journeys }),
    }));
    await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
    const chip = page.locator(".mobile-v2__journey-chip");
    await chip.waitFor({ state: "visible" });

    const pickerTrigger = page.getByRole("button", { name: "打开全部旅程" });
    await pickerTrigger.click();
    const picker = page.locator(".mobile-v2__picker");
    await picker.waitFor({ state: "visible" });
    const pickerRootFocused = await picker.evaluate((element) => document.activeElement === element);
    const pickerCloseBox = await picker.locator(":scope > header button").boundingBox();
    const pickerCloseTouchTarget = pickerCloseBox ? Math.min(pickerCloseBox.width, pickerCloseBox.height) : 0;
    const pickerBackgroundInert = await page.locator(".mobile-v2__header").evaluate((element) => element.inert);
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached" });
    const pickerFocusRestored = await pickerTrigger.evaluate((element) => document.activeElement === element);

    await pickerTrigger.click();
    await picker.waitFor({ state: "visible" });
    const journeyButtons = picker.locator("ol li button");
    await journeyButtons.last().click();
    await picker.waitFor({ state: "detached" });
    const selectedJourneyId = await chip.getAttribute("data-playback-journey");

    await page.getByRole("button", { name: "回放我的星球" }).click();
    await chip.click();
    const sheet = page.locator(".mobile-v2__sheet");
    await sheet.waitFor({ state: "visible" });
    const sheetRootFocused = await sheet.evaluate((element) => document.activeElement === element);
    const sheetBackgroundInert = await page.locator(".mobile-v2__chrome").evaluate((element) => element.inert);
    const pinnedTitleBefore = await sheet.locator("h2").textContent();
    await page.waitForTimeout(1_050);
    const playbackJourneyAfter = await chip.getAttribute("data-playback-journey");
    const pinnedTitleAfter = await sheet.locator("h2").textContent();
    await page.keyboard.press("Tab");
    const sheetTabTrapped = await sheet.evaluate((element) => element.contains(document.activeElement));
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    const sheetFocusRestored = await chip.evaluate((element) => document.activeElement === element);

    await chip.click();
    await sheet.waitFor({ state: "visible" });
    await sheet.getByRole("button", { name: /真实地图/ }).click();
    const realMap = page.locator(".mobile-v2__real-map");
    await realMap.waitFor({ state: "visible" });
    const mapRootFocused = await realMap.evaluate((element) => document.activeElement === element);
    const mapCloseBox = await realMap.locator(":scope > header > button").boundingBox();
    const mapCloseTouchTarget = mapCloseBox ? Math.min(mapCloseBox.width, mapCloseBox.height) : 0;
    const mapBackgroundInert = await page.locator(".mobile-v2__header").evaluate((element) => element.inert);
    await page.keyboard.press("Escape");
    await realMap.waitFor({ state: "detached" });
    let mapFocusRestored = false;
    try {
      await page.waitForFunction(
        () => document.activeElement?.classList.contains("mobile-v2__journey-chip"),
        null,
        { timeout: 1_500 },
      );
      mapFocusRestored = true;
    } catch {
      mapFocusRestored = false;
    }

    const interaction = {
      name: "mobile-v2-playback-modal-contract",
      pickerRootFocused,
      pickerCloseTouchTarget,
      pickerBackgroundInert,
      pickerFocusRestored,
      selectedJourneyId,
      sheetRootFocused,
      sheetBackgroundInert,
      pinnedTitleBefore,
      pinnedTitleAfter,
      playbackJourneyAfter,
      sheetTabTrapped,
      sheetFocusRestored,
      mapRootFocused,
      mapCloseTouchTarget,
      mapBackgroundInert,
      mapFocusRestored,
      failed: !pickerRootFocused
        || pickerCloseTouchTarget < 44
        || !pickerBackgroundInert
        || !pickerFocusRestored
        || !selectedJourneyId
        || !sheetRootFocused
        || !sheetBackgroundInert
        || pinnedTitleBefore !== pinnedTitleAfter
        || playbackJourneyAfter === selectedJourneyId
        || !sheetTabTrapped
        || !sheetFocusRestored
        || !mapRootFocused
        || mapCloseTouchTarget < 44
        || !mapBackgroundInert
        || !mapFocusRestored,
    };
    if (interaction.failed) failed = true;
    results.push(interaction);
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
      if (mobile) {
        const mobileMetrics = await page.evaluate(() => ({
          cards: document.querySelectorAll(".journey-media-mobile-card").length,
          manageButtons: document.querySelectorAll(".journey-media-mobile-card__menu").length,
          assignmentButtons: document.querySelectorAll(".journey-media-mobile-card__assignment").length,
          desktopActionGroups: document.querySelectorAll(".journey-media-fields__actions").length,
        }));
        record(`composer-${label}-media-actions`, await scanButtons(page, ".journey-composer", ".journey-composer__editor"), {
          mobileMetrics,
          failed: mobileMetrics.cards !== 2
            || mobileMetrics.manageButtons !== 2
            || mobileMetrics.assignmentButtons !== 2
            || mobileMetrics.desktopActionGroups !== 0,
        });
        continue;
      }

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
      const invalidActions = actionMetrics.length !== 2 || actionMetrics.some((group) => {
        if (group.length !== 3) return true;
        if (group.some((button) => button.width < 39 || button.height < 39)) return true;
        return group.some((button) => !button.ariaLabel || !button.tooltip || button.visibleText !== "");
      });
      record(`composer-${label}-media-actions`, await scanButtons(page, ".journey-composer", ".journey-composer__editor"), {
        actionMetrics,
        failed: invalidActions,
      });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const firstManageTrigger = page.locator(".journey-media-mobile-card__menu").first();
    const assertNestedSheetFocus = async (openSheet, selector, label) => {
      await openSheet();
      const sheet = page.locator(selector);
      await sheet.waitFor({ state: "visible" });
      const initialFocusInside = await sheet.evaluate((root) => root.contains(document.activeElement));
      let tabStayedInside = initialFocusInside;
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press("Tab");
        tabStayedInside = tabStayedInside && await sheet.evaluate((root) => root.contains(document.activeElement));
      }
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      const focusRestored = await firstManageTrigger.evaluate((button) => document.activeElement === button);
      const result = { name: label, initialFocusInside, tabStayedInside, focusRestored, failed: !initialFocusInside || !tabStayedInside || !focusRestored };
      results.push(result);
      if (result.failed) failed = true;
    };
    await assertNestedSheetFocus(
      () => firstManageTrigger.click(),
      ".journey-media-mobile-sheet:not(.is-assignment):not(.is-confirming)",
      "composer-mobile-management-focus",
    );
    await assertNestedSheetFocus(
      async () => {
        await firstManageTrigger.click();
        await page.getByRole("button", { name: "调整归属" }).click();
      },
      ".journey-media-mobile-sheet.is-assignment",
      "composer-mobile-assignment-focus",
    );
    await assertNestedSheetFocus(
      async () => {
        await firstManageTrigger.click();
        await page.getByRole("button", { name: "移除媒体" }).click();
      },
      ".journey-media-mobile-sheet.is-confirming",
      "composer-mobile-confirm-focus",
    );

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
    await page.locator(width <= 760 ? ".mobile-v2__journey-chip" : ".living-atlas__active").waitFor({ state: "visible" });
    const focusExitHitTest = await page.evaluate((mobile) => {
      const exit = document.querySelector(".living-atlas__globe-focus-exit");
      const create = document.querySelector(".living-atlas__create")
        ?? document.querySelector('.mobile-v2__header button[aria-label="记录新旅程"]');
      if (!(create instanceof HTMLElement)) return null;
      const rect = create.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (mobile) {
        return {
          mobile: true,
          exitExists: exit instanceof HTMLElement,
          hitInsideCreate: Boolean(hit && create.contains(hit)),
        };
      }
      if (!(exit instanceof HTMLElement)) return null;
      return {
        mobile: false,
        exitExists: true,
        exitAriaHidden: exit.getAttribute("aria-hidden"),
        exitTabIndex: exit.tabIndex,
        exitPointerEvents: getComputedStyle(exit).pointerEvents,
        hitIsExit: hit === exit || exit.contains(hit),
        hitInsideCreate: Boolean(hit && create.contains(hit)),
      };
    }, width <= 760);
    const invalidFocusExit = !focusExitHitTest
      || (focusExitHitTest.mobile
        ? focusExitHitTest.exitExists || !focusExitHitTest.hitInsideCreate
        : !focusExitHitTest.exitExists
          || focusExitHitTest.exitAriaHidden !== "true"
          || focusExitHitTest.exitTabIndex !== -1
          || focusExitHitTest.exitPointerEvents !== "none"
          || focusExitHitTest.hitIsExit
          || !focusExitHitTest.hitInsideCreate);
    if (invalidFocusExit) {
      throw new Error(`globe-focus exit contract failed: ${JSON.stringify(focusExitHitTest)}`);
    }
    await page.getByRole("button", { name: /记录(?:新)?旅程/ }).click();
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
    await page.locator(".mobile-v2__journey-chip").waitFor({ state: "visible" });

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
        const nav = (document.querySelector(".mobile-v2__header nav")
          ?? document.querySelector(".living-atlas__header nav"))?.getBoundingClientRect();
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

async function verifyFinalAcceptanceMobileFlow() {
  console.error("[qa-post-login] final acceptance mobile app flow");
  const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  const tinyAudio = "data:audio/mpeg;base64,AAAA";
  const targetTitle = "FINAL ACCEPTANCE · NIGHT TRAIN";
  const targetJourney = {
    id: "fa-journey-target",
    atlasId: "qa-atlas",
    title: targetTitle,
    startedOn: "2026-08-20",
    endedOn: null,
    note: "用于最终验收的真实应用旅程。",
    lightColor: "#77c8c2",
    lightEffect: "aurora",
    coverMediaAssetId: "fa-image-1",
    revision: 1,
    createdByUserId: "qa-user",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    routePoints: [
      {
        id: "fa-point-1",
        journeyId: "fa-journey-target",
        sortOrder: 0,
        latitude: 22.5431,
        longitude: 114.0579,
        label: "深圳湾起点",
        isStop: true,
        occurredAt: null,
        note: "夜色刚刚开始。",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
      {
        id: "fa-point-2",
        journeyId: "fa-journey-target",
        sortOrder: 1,
        latitude: 31.2304,
        longitude: 121.4737,
        label: "上海外滩终点",
        isStop: true,
        occurredAt: null,
        note: "抵达以后风还没有停。",
        createdAt: "2026-08-20T01:00:00.000Z",
      },
    ],
    media: [
      {
        id: "fa-image-1",
        journeyId: "fa-journey-target",
        routePointId: "fa-point-1",
        storageDriver: "qa",
        storageKey: "qa/final-image.gif",
        fileName: "final-memory.gif",
        mimeType: "image/gif",
        bytes: 35,
        sortOrder: 0,
        uploadedByUserId: "qa-user",
        createdAt: "2026-08-20T00:10:00.000Z",
      },
      {
        id: "fa-soundtrack-1",
        journeyId: "fa-journey-target",
        routePointId: null,
        storageDriver: "qa",
        storageKey: "qa/final-soundtrack.mp3",
        fileName: "final-night-theme.mp3",
        mimeType: "audio/mpeg",
        bytes: 4,
        sortOrder: 1,
        uploadedByUserId: "qa-user",
        createdAt: "2026-08-20T00:11:00.000Z",
      },
    ],
  };
  const latestJourney = {
    ...makeJourney(90, "2026-08-25", "LATEST EMPTY JOURNEY", "#e8a87c", "默认最新地点"),
    id: "fa-journey-latest",
    routePoints: [{
      ...makeJourney(90, "2026-08-25", "LATEST EMPTY JOURNEY", "#e8a87c", "默认最新地点").routePoints[0],
      id: "fa-latest-point",
      journeyId: "fa-journey-latest",
    }],
  };

  const requestedViewport = process.env.QA_FINAL_VIEWPORT?.trim() ?? "";
  const viewports = [
    ["320", 320, 800],
    ["360", 360, 800],
    ["390", 390, 844],
    ["430", 430, 932],
  ].filter(([label]) => !requestedViewport || label === requestedViewport);
  if (requestedViewport && viewports.length === 0) {
    throw new Error(`Unknown QA_FINAL_VIEWPORT: ${requestedViewport}`);
  }

  for (const [viewportLabel, width, height] of viewports) {
    console.error(`[qa-post-login] final:${viewportLabel}:start`);
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const activateControl = async (locator, label) => {
      await locator.evaluate((element) => {
        element.scrollIntoView({ block: "center", inline: "center" });
      });
      await page.evaluate(() => new Promise((resolve) => (
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )));
      const actionability = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          visible: rect.width > 0
            && rect.height > 0
            && style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) > 0.01,
          enabled: !(element instanceof HTMLButtonElement) || !element.disabled,
          pointerEvents: style.pointerEvents,
          hitOwned: hit === element || element.contains(hit),
          hitTag: hit?.tagName ?? null,
          hitClass: hit instanceof Element ? hit.getAttribute("class") : null,
        };
      });
      if (
        !actionability.visible
        || !actionability.enabled
        || actionability.pointerEvents === "none"
        || !actionability.hitOwned
      ) {
        throw new Error(`${label} is not actionable: ${JSON.stringify(actionability)}`);
      }
      await locator.evaluate((element) => element.click());
    };
    const setInputValue = async (locator, value, label) => {
      await locator.evaluate((element) => {
        element.scrollIntoView({ block: "center", inline: "center" });
      });
      await page.evaluate(() => new Promise((resolve) => (
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )));
      const actionability = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
        return {
          input,
          visible: rect.width > 0
            && rect.height > 0
            && style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) > 0.01,
          enabled: input && !element.disabled,
          editable: input && !element.readOnly,
          pointerEvents: style.pointerEvents,
          hitOwned: hit === element || element.contains(hit),
          hitTag: hit?.tagName ?? null,
          hitClass: hit instanceof Element ? hit.getAttribute("class") : null,
        };
      });
      if (
        !actionability.input
        || !actionability.visible
        || !actionability.enabled
        || !actionability.editable
        || actionability.pointerEvents === "none"
        || !actionability.hitOwned
      ) {
        throw new Error(`${label} is not editable: ${JSON.stringify(actionability)}`);
      }
      const appliedValue = await locator.evaluate((element, nextValue) => {
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!valueSetter) throw new Error("native input value setter is unavailable");
        element.focus({ preventScroll: true });
        valueSetter.call(element, nextValue);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return element.value;
      }, value);
      if (appliedValue !== value) {
        throw new Error(`${label} value did not apply`);
      }
    };
    const readDocumentLayout = () => page.evaluate(() => ({
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      overflowY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    }));
    let authenticated = false;
    let signInRequests = 0;
    let sessionRequests = 0;
    let stateJourneys = [targetJourney, latestJourney];
    let createdJourney = null;
    let uploadSequence = 0;
    const uploadMetadata = new Map();
    let journeyPostCount = 0;
    let uploadStartCount = 0;
    let uploadPartUrlCount = 0;
    let uploadPartPutCount = 0;
    let uploadCompleteCount = 0;
    let playbackLayout = null;
    let composerLayout = null;
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
    });

    const session = {
      session: {
        id: "fa-session",
        userId: "qa-user",
        token: "fa-token",
        expiresAt: "2026-09-27T00:00:00.000Z",
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
          signInRequests += 1;
          authenticated = true;
          await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
          return;
        }
        if (pathname.endsWith("/get-session")) {
          sessionRequests += 1;
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
        body: JSON.stringify({
          atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "Final acceptance" },
          role: "owner",
        }),
      }));
      await page.route("**/api/journeys", async (route) => {
        const request = route.request();
        if (request.method() === "POST") {
          journeyPostCount += 1;
          const input = request.postDataJSON();
          const journeyId = `fa-created-${viewportLabel}`;
          const createdAt = "2026-08-27T00:00:00.000Z";
          createdJourney = {
            id: journeyId,
            atlasId: "qa-atlas",
            title: input.title,
            startedOn: input.startedOn,
            endedOn: input.endedOn ?? null,
            note: input.note ?? null,
            lightColor: input.lightColor,
            lightEffect: input.lightEffect ?? null,
            coverMediaAssetId: null,
            revision: 1,
            createdByUserId: "qa-user",
            createdAt,
            updatedAt: createdAt,
            routePoints: input.routePoints.map((point, index) => ({
              id: `fa-created-point-${viewportLabel}-${index}`,
              journeyId,
              sortOrder: index,
              latitude: point.latitude,
              longitude: point.longitude,
              label: point.label ?? null,
              isStop: point.isStop,
              occurredAt: point.occurredAt ?? null,
              note: point.note ?? null,
              createdAt,
            })),
            media: [],
          };
          stateJourneys = [...stateJourneys, createdJourney];
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({ journey: createdJourney }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ journeys: stateJourneys }),
        });
      });
      await page.route("**/api/uploads/assets/*/read-url", (route) => {
        const assetId = new URL(route.request().url()).pathname.split("/").at(-2);
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            url: assetId === "fa-soundtrack-1" ? tinyAudio : onePixelGif,
            expiresAt: "2026-09-27T00:00:00.000Z",
          }),
        });
      });
      await page.route("**/api/locations/search?*", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [{
            id: "fa:search-place",
            label: "FINAL QA SEARCH PLACE",
            labelLocal: "最终验收搜索地点",
            labelEnglish: "FINAL QA SEARCH PLACE",
            context: "QA City",
            countryCode: "QA",
            latitude: 22.2819,
            longitude: 114.1589,
          }],
          attribution: { label: "FINAL QA GEO", url: "https://example.com/qa-geo" },
        }),
      }));
      await page.route("**/api/locations/reverse?*", (route) => {
        const url = new URL(route.request().url());
        const latitude = Number(url.searchParams.get("latitude"));
        const longitude = Number(url.searchParams.get("longitude"));
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: {
              id: "fa:globe-place",
              label: "FINAL QA GLOBE PICK",
              context: "QA Globe",
              countryCode: "QA",
              latitude,
              longitude,
            },
            attribution: { label: "FINAL QA REVERSE", url: "https://example.com/qa-reverse" },
          }),
        });
      });
      await page.route("**/api/uploads/start", async (route) => {
        uploadStartCount += 1;
        const metadata = route.request().postDataJSON();
        const uploadId = `fa-upload-${viewportLabel}-${++uploadSequence}`;
        uploadMetadata.set(uploadId, metadata);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ uploadId, partSize: 1_048_576, partCount: 1 }),
        });
      });
      await page.route("**/api/uploads/*/parts/*", async (route) => {
        uploadPartUrlCount += 1;
        const parts = new URL(route.request().url()).pathname.split("/");
        const uploadId = parts.at(-3);
        const partNumber = parts.at(-1);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            url: `${origin}/qa-upload/${uploadId}/${partNumber}`,
            headers: {},
          }),
        });
      });
      await page.route("**/qa-upload/**", (route) => {
        if (route.request().method() === "PUT") uploadPartPutCount += 1;
        return route.fulfill({
          status: 200,
          headers: { etag: '"fa-etag"' },
          body: "",
        });
      });
      await page.route("**/api/uploads/*/complete", async (route) => {
        uploadCompleteCount += 1;
        const pathname = new URL(route.request().url()).pathname;
        const uploadId = pathname.split("/").at(-2);
        const metadata = uploadMetadata.get(uploadId) ?? {};
        const asset = {
          id: `fa-created-media-${viewportLabel}-${uploadCompleteCount}`,
          journeyId: createdJourney?.id ?? metadata.journeyId,
          routePointId: metadata.routePointId ?? null,
          storageDriver: "qa",
          storageKey: `qa/${uploadId}`,
          fileName: metadata.fileName ?? "final-upload.png",
          mimeType: metadata.mimeType ?? "image/png",
          bytes: metadata.bytes ?? 1,
          sortOrder: createdJourney?.media.length ?? 0,
          uploadedByUserId: "qa-user",
          createdAt: "2026-08-27T00:05:00.000Z",
        };
        if (createdJourney) {
          createdJourney = { ...createdJourney, media: [...createdJourney.media, asset] };
          stateJourneys = stateJourneys.map((journey) => (
            journey.id === createdJourney.id ? createdJourney : journey
          ));
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ asset }),
        });
      });
      console.error(`[qa-post-login] final:${viewportLabel}:routes-ready`);

      await page.goto(`${origin}/?qaState=final-acceptance&qaPhase=ready`, {
        waitUntil: "commit",
        timeout: 10_000,
      });
      try {
        await page.locator(".auth-card--login-v3.is-ready").waitFor({ state: "visible", timeout: 20_000 });
      } catch (error) {
        const loginReadyDebug = await page.evaluate(() => ({
          href: location.href,
          readyState: document.readyState,
          rootChildren: document.querySelector("#root")?.childElementCount ?? null,
          bodyText: document.body.innerText.slice(0, 500),
          viteOverlay: document.querySelector("vite-error-overlay")?.shadowRoot?.textContent?.slice(0, 1_000) ?? null,
          scripts: [...document.scripts].map((script) => script.src || "inline"),
        }));
        throw new Error(`Final acceptance login did not become ready: ${JSON.stringify({ loginReadyDebug, failedRequests })}`, { cause: error });
      }
      console.error(`[qa-post-login] final:${viewportLabel}:login-ready`);
      await setInputValue(page.locator('input[type="email"]'), "qa@example.com", "login email input");
      await setInputValue(page.locator('input[type="password"]'), "password1234", "login password input");
      console.error(`[qa-post-login] final:${viewportLabel}:login-inputs-ready`);
      const loginButton = page.getByRole("button", { name: "登录", exact: true });
      const loginHit = await loginButton.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== "hidden",
          enabled: !(button instanceof HTMLButtonElement) || !button.disabled,
          pointerEvents: getComputedStyle(button).pointerEvents,
          hitOwned: hit === button || button.contains(hit),
        };
      });
      if (!loginHit.visible || !loginHit.enabled || loginHit.pointerEvents === "none" || !loginHit.hitOwned) {
        throw new Error(`login control is not actionable: ${JSON.stringify(loginHit)}`);
      }
      const signInRequest = page.waitForRequest((request) => (
        new URL(request.url()).pathname.endsWith("/sign-in/email")
      ), { timeout: 8_000 });
      await loginButton.evaluate((button) => button.click());
      await signInRequest;
      console.error(`[qa-post-login] final:${viewportLabel}:login-request`);
      const signalPage = await context.newPage();
      try {
        await signalPage.route("**/api/auth/get-session", (route) => route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "null",
        }));
        await signalPage.goto(`${origin}/?qaState=login-v3&qaPhase=ready&qaLite=1`, {
          waitUntil: "domcontentloaded",
          timeout: 8_000,
        });
        await signalPage.evaluate(() => {
          localStorage.setItem("better-auth.message", JSON.stringify({
            event: "session",
            data: { trigger: "qa-final-acceptance-session-gain" },
            clientId: "qa-final-acceptance-signal-page",
            timestamp: Math.floor(Date.now() / 1_000),
          }));
        });
      } finally {
        await signalPage.close();
      }
      console.error(`[qa-post-login] final:${viewportLabel}:session-refresh`);
      try {
        await page.locator(".auth-continuity.is-released").waitFor({ state: "visible", timeout: 15_000 });
      } catch (error) {
        const loginDebug = await page.evaluate(() => ({
          continuityClass: document.querySelector(".auth-continuity")?.className ?? null,
          authCardClass: document.querySelector(".auth-card--login-v3")?.className ?? null,
          alert: document.querySelector("[role=alert]")?.textContent?.trim() ?? null,
        }));
        throw new Error(`final acceptance login did not release: ${JSON.stringify({ signInRequests, sessionRequests, authenticated, loginDebug })}`, { cause: error });
      }
      await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 8_000 });
      await page.waitForFunction(() => (
        document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") === "atlas"
        && window.__particleEarthDebug?.().quality === "high"
        && window.__particleEarthDebug?.().canvases === 1
      ), null, { timeout: 20_000 });
      console.error(`[qa-post-login] final:${viewportLabel}:atlas-ready`);
      const mobileV2 = await page.locator(".living-atlas").getAttribute("data-mobile-v2");
      if (mobileV2 !== "on") {
        throw new Error(`Final acceptance expected Mobile V2 at ${viewportLabel}px, got ${mobileV2}`);
      }
      const persistentBeforeResponsive = await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
        window.__qaFinalAcceptanceCanvas = canvas;
        window.__qaFinalAcceptanceDebug = window.__particleEarthDebug;
        return { canvas: Boolean(canvas), debug: Boolean(window.__particleEarthDebug) };
      });
      if (!persistentBeforeResponsive.canvas || !persistentBeforeResponsive.debug) {
        throw new Error(`Final acceptance persistent Earth missing before Mobile V2 flow: ${JSON.stringify(persistentBeforeResponsive)}`);
      }

      const pickerTrigger = page.locator('.mobile-v2__header button[aria-label="打开全部旅程"]');
      await activateControl(pickerTrigger, "Mobile V2 journey picker control");
      const picker = page.locator(".mobile-v2__picker");
      await picker.waitFor({ state: "visible" });
      await activateControl(
        picker.locator("li button").filter({ hasText: targetTitle }),
        "Mobile V2 target journey control",
      );
      await picker.waitFor({ state: "detached" });
      const mobileChip = page.locator(".mobile-v2__journey-chip");
      await mobileChip.waitFor({ state: "visible" });
      const chipText = await mobileChip.textContent();
      if (!String(chipText).includes(targetTitle)) {
        throw new Error(`Mobile V2 picker selected the wrong journey: ${chipText}`);
      }
      await activateControl(mobileChip, "Mobile V2 journey chip");
      const mobileSheet = page.locator(".mobile-v2__sheet");
      await mobileSheet.waitFor({ state: "visible" });
      await activateControl(
        mobileSheet.locator(".mobile-v2__sheet-actions .is-primary"),
        "Mobile V2 open story control",
      );
      await page.locator(".journey-story").waitFor({ state: "visible" });
      const storyTitle = await page.locator(".journey-story h2").first().textContent();
      if (!String(storyTitle).includes(targetTitle)) {
        throw new Error(`Story continuity selected the wrong journey: ${storyTitle}`);
      }
      console.error(`[qa-post-login] final:${viewportLabel}:story-ready`);
      await activateControl(page.locator(".journey-story__close"), "story close control");
      await page.locator(".journey-story").waitFor({ state: "detached" });
      console.error(`[qa-post-login] final:${viewportLabel}:story-closed`);

      // #43's cinematic playback surface remains a desktop contract. Cross the
      // responsive boundary on the same authenticated page and require the
      // persistent Earth canvas/controller to survive before exercising it.
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.waitForFunction(() => (
        document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") === "off"
        && Boolean(document.querySelector(".living-atlas__header"))
        && Boolean(document.querySelector(".living-atlas__journey-rail"))
      ), null, { timeout: 5_000 });
      const responsiveDesktop = await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
        return {
          sameCanvas: window.__qaFinalAcceptanceCanvas === canvas,
          sameControllerDebug: window.__qaFinalAcceptanceDebug === window.__particleEarthDebug,
          mobileV2: document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") ?? null,
          canvases: document.querySelectorAll('canvas[data-three-scene="particle-earth"]').length,
        };
      });
      if (!responsiveDesktop.sameCanvas || !responsiveDesktop.sameControllerDebug || responsiveDesktop.canvases !== 1) {
        throw new Error(`Final acceptance responsive desktop handoff failed: ${JSON.stringify(responsiveDesktop)}`);
      }
      await activateControl(
        page.locator(".living-atlas__journey-rail li button").filter({ hasText: targetTitle }),
        "desktop target journey control",
      );
      await page.waitForFunction((expectedTitle) => (
        document.querySelector(".living-atlas__active h2")?.textContent?.includes(expectedTitle) ?? false
      ), targetTitle, { timeout: 5_000 });
      await page.waitForFunction(() => {
        const scene = document.querySelector(".particle-earth-scene");
        return scene?.getAttribute("data-route-focus-phase") !== "idle"
          && Boolean(scene?.getAttribute("data-route-focus-lat"));
      }, null, { timeout: 5_000 });
      console.error(`[qa-post-login] final:${viewportLabel}:desktop-journey-ready`);
      const playButton = page.getByRole("button", { name: "播放旅程" });
      await playButton.waitFor({ state: "visible" });
      await activateControl(playButton, "playback start control");
      if (await page.locator(".journey-playback").count() === 0) {
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll("button")]
            .find((candidate) => candidate.textContent?.includes("播放旅程"));
          return button instanceof HTMLButtonElement && !button.disabled;
        }, null, { timeout: 8_000 });
        await activateControl(playButton, "playback start control after soundtrack prefetch");
      }
      await page.locator(".journey-playback").waitFor({ state: "visible", timeout: 8_000 });
      await page.locator(".journey-playback__soundtrack").waitFor({ state: "attached", timeout: 5_000 });
      await page.waitForFunction(() => [
        ".account-dock",
        ".living-atlas__header",
        ".living-atlas__journey-rail",
        ".living-atlas__active",
        ".living-atlas-globe__controls",
      ].every((selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility === "hidden"
          && Number.parseFloat(style.opacity) === 0
          && style.pointerEvents === "none";
      }), null, { timeout: 5_000 });
      const cinematic = await page.evaluate(() => {
        const atlas = document.querySelector(".living-atlas");
        const auth = document.querySelector(".auth-continuity");
        const account = document.querySelector(".account-dock");
        const header = document.querySelector(".living-atlas__header");
        const rail = document.querySelector(".living-atlas__journey-rail");
        const active = document.querySelector(".living-atlas__active");
        const controls = document.querySelector(".living-atlas-globe__controls");
        const playback = document.querySelector(".journey-playback");
        const playbackAudio = playback?.querySelector("audio");
        const soundtrackStrip = document.querySelector(".journey-playback__soundtrack");
        const hidden = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility === "hidden"
            && Number.parseFloat(style.opacity) === 0
            && style.pointerEvents === "none";
        };
        return {
          atlasPlayback: atlas?.classList.contains("is-playback") ?? false,
          authCinematic: auth?.classList.contains("is-cinematic") ?? false,
          accountInert: account instanceof HTMLElement ? account.inert : null,
          accountHidden: hidden(account),
          headerInert: header instanceof HTMLElement ? header.inert : null,
          headerHidden: hidden(header),
          railInert: rail instanceof HTMLElement ? rail.inert : null,
          railHidden: hidden(rail),
          activeInert: active instanceof HTMLElement ? active.inert : null,
          activeHidden: hidden(active),
          controlsHidden: hidden(controls),
          playbackInteractive: playback ? getComputedStyle(playback).pointerEvents !== "none" : false,
          soundtrackUsable: playbackAudio instanceof HTMLAudioElement
            && Boolean(playbackAudio.currentSrc || playbackAudio.src)
            && playbackAudio.loop,
          soundtrackPlaying: soundtrackStrip?.classList.contains("is-playing") ?? false,
          particleCanvases: document.querySelectorAll('canvas[data-three-scene="particle-earth"]').length,
          soundtrack: document.querySelector(".journey-playback__soundtrack small")?.textContent?.trim() ?? "",
        };
      });
      const cinematicFailed = !cinematic.atlasPlayback
        || !cinematic.authCinematic
        || cinematic.accountInert !== true
        || !cinematic.accountHidden
        || cinematic.headerInert !== true
        || !cinematic.headerHidden
        || cinematic.railInert !== true
        || !cinematic.railHidden
        || cinematic.activeInert !== true
        || !cinematic.activeHidden
        || !cinematic.controlsHidden
        || !cinematic.playbackInteractive
        || !cinematic.soundtrackUsable
        || !cinematic.soundtrackPlaying
        || cinematic.particleCanvases !== 1
        || cinematic.soundtrack !== "final-night-theme";
      if (cinematicFailed) {
        throw new Error(`Playback cinematic isolation failed: ${JSON.stringify(cinematic)}`);
      }
      playbackLayout = await readDocumentLayout();
      if (playbackLayout.overflowX > 0 || playbackLayout.overflowY > 0) {
        throw new Error(`Playback document overflow: ${JSON.stringify(playbackLayout)}`);
      }
      console.error(`[qa-post-login] final:${viewportLabel}:cinematic-verified`);
      console.error(`[qa-post-login] final:${viewportLabel}:playback-ready`);
      const playbackStepBefore = await page.locator(".journey-playback").getAttribute("data-playback-step");
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction((previousStep) => (
        document.querySelector(".journey-playback")?.getAttribute("data-playback-step") !== previousStep
      ), playbackStepBefore, { timeout: 2_000 });
      await page.keyboard.press("Escape");
      await page.locator(".journey-playback").waitFor({ state: "detached" });
      await page.waitForFunction(() => {
        const account = document.querySelector(".account-dock");
        const header = document.querySelector(".living-atlas__header");
        return account instanceof HTMLElement
          && header instanceof HTMLElement
          && !account.inert
          && !header.inert
          && getComputedStyle(account).visibility !== "hidden";
      });
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => (
        document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") === "on"
        && Boolean(document.querySelector(".mobile-v2__header"))
        && Boolean(document.querySelector(".mobile-v2__journey-chip"))
      ), null, { timeout: 5_000 });
      const responsiveMobile = await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
        return {
          sameCanvas: window.__qaFinalAcceptanceCanvas === canvas,
          sameControllerDebug: window.__qaFinalAcceptanceDebug === window.__particleEarthDebug,
          mobileV2: document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") ?? null,
          canvases: document.querySelectorAll('canvas[data-three-scene="particle-earth"]').length,
        };
      });
      if (!responsiveMobile.sameCanvas || !responsiveMobile.sameControllerDebug || responsiveMobile.canvases !== 1) {
        throw new Error(`Final acceptance responsive mobile restore failed: ${JSON.stringify(responsiveMobile)}`);
      }
      console.error(`[qa-post-login] final:${viewportLabel}:playback-exited`);

      await activateControl(
        page.locator('.mobile-v2__header button[aria-label="记录新旅程"]'),
        "create journey control",
      );
      await page.locator(".journey-composer").waitFor({ state: "visible" });
      composerLayout = await readDocumentLayout();
      if (composerLayout.overflowX > 0 || composerLayout.overflowY > 0) {
        throw new Error(`Composer document overflow: ${JSON.stringify(composerLayout)}`);
      }
      console.error(`[qa-post-login] final:${viewportLabel}:composer-ready`);
      await page.getByLabel("旅程标题").fill(`FINAL CREATED ${viewportLabel}`);
      await page.getByLabel("开始日期").fill("2026-08-27");
      const locationSearch = page.getByPlaceholder("建筑、景点、街道、街区或城市");
      await locationSearch.fill("final qa");
      await activateControl(
        page.getByRole("button", { name: "搜索", exact: true }),
        "location search control",
      );
      console.error(`[qa-post-login] final:${viewportLabel}:search-ready`);
      await activateControl(
        page.getByRole("button", { name: /FINAL QA SEARCH PLACE/ }),
        "location search result",
      );
      await page.waitForFunction(() => (
        document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length === 1
      ));
      console.error(`[qa-post-login] final:${viewportLabel}:search-result-added`);

      const globePick = page.getByRole("button", { name: /直接在地球上取点/ });
      await activateControl(globePick, "globe pick control");
      await page.waitForFunction(() => (
        document.querySelector(".living-atlas")?.classList.contains("is-globe-picking")
        && document.querySelector(".particle-earth-scene")?.getAttribute("data-globe-point-pick") === "true"
      ));
      try {
        await page.waitForFunction(() => {
          const backdrop = document.querySelector(".journey-composer-backdrop.is-globe-picking");
          const composer = document.querySelector(".journey-composer");
          return backdrop instanceof HTMLElement
            && composer instanceof HTMLElement
            && getComputedStyle(backdrop).pointerEvents === "none"
            && getComputedStyle(composer).visibility === "hidden";
        }, null, { timeout: 5_000 });
      } catch (error) {
        const pickState = await page.evaluate(() => {
          const backdrop = document.querySelector(".journey-composer-backdrop.is-globe-picking");
          const composer = document.querySelector(".journey-composer");
          const state = (element) => element instanceof HTMLElement ? {
            className: element.className,
            visibility: getComputedStyle(element).visibility,
            opacity: getComputedStyle(element).opacity,
            pointerEvents: getComputedStyle(element).pointerEvents,
            transitionProperty: getComputedStyle(element).transitionProperty,
            transitionDuration: getComputedStyle(element).transitionDuration,
          } : null;
          return { backdrop: state(backdrop), composer: state(composer) };
        });
        throw new Error(`Globe pick isolation did not settle: ${JSON.stringify(pickState)}`, { cause: error });
      }
      console.error(`[qa-post-login] final:${viewportLabel}:globe-pick-ready`);
      const particleCanvas = page.locator('canvas[data-three-scene="particle-earth"]');
      const canvasPick = await particleCanvas.evaluate((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(clientX, clientY);
        const hitOwned = hit === canvas || canvas.contains(hit);
        if (hitOwned) {
          canvas.dispatchEvent(new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            button: 0,
            buttons: 0,
            isPrimary: true,
            pointerId: 4242,
            pointerType: "mouse",
          }));
        }
        return {
          hitOwned,
          width: rect.width,
          height: rect.height,
          hitTag: hit?.tagName ?? null,
          hitClass: hit instanceof Element ? hit.getAttribute("class") : null,
          hitId: hit instanceof Element ? hit.id : null,
          hitParentClass: hit?.parentElement?.getAttribute("class") ?? null,
        };
      });
      if (!canvasPick.hitOwned || canvasPick.width <= 0 || canvasPick.height <= 0) {
        throw new Error(`Final acceptance globe canvas is not pickable: ${JSON.stringify(canvasPick)}`);
      }
      console.error(`[qa-post-login] final:${viewportLabel}:globe-pick-hit`);
      await page.waitForFunction(() => (
        !document.querySelector(".living-atlas")?.classList.contains("is-globe-picking")
        && document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length === 2
      ), null, { timeout: 8_000 });
      await page.getByText("已根据坐标识别为「FINAL QA GLOBE PICK」，可继续修改。").waitFor({
        state: "visible",
        timeout: 5_000,
      });
      console.error(`[qa-post-login] final:${viewportLabel}:reverse-geocode-ready`);
      await page.locator(".journey-media-picker input[type=file]").setInputFiles({
        name: `final-${viewportLabel}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(`final-acceptance-${viewportLabel}`),
      });
      console.error(`[qa-post-login] final:${viewportLabel}:upload-started`);
      await activateControl(
        page.getByRole("button", { name: "保存到星球" }),
        "save journey control",
      );
      await page.locator(".journey-composer").waitFor({ state: "detached", timeout: 15_000 });
      if (
        uploadStartCount !== 1
        || uploadPartUrlCount !== 1
        || uploadPartPutCount !== 1
        || uploadCompleteCount !== 1
      ) {
        throw new Error(`Multipart upload chain failed: ${JSON.stringify({ uploadStartCount, uploadPartUrlCount, uploadPartPutCount, uploadCompleteCount })}`);
      }
      console.error(`[qa-post-login] final:${viewportLabel}:upload-complete`);
      await page.getByText("旅程已抵达你的私人图谱。").waitFor({ state: "visible", timeout: 5_000 });
      console.error(`[qa-post-login] final:${viewportLabel}:journey-saved`);
      await page.waitForFunction((expectedTitle) => (
        document.querySelector(".mobile-v2__journey-chip")?.textContent?.includes(expectedTitle) ?? false
      ), `FINAL CREATED ${viewportLabel}`, { timeout: 8_000 });
      console.error(`[qa-post-login] final:${viewportLabel}:active-journey-verified`);

      const finalState = await page.evaluate(() => ({
        overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        overflowY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
        particleCanvases: document.querySelectorAll('canvas[data-three-scene="particle-earth"]').length,
        earthStage: document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") ?? null,
        activeTitle: document.querySelector(".mobile-v2__journey-copy strong")?.textContent?.trim() ?? "",
      }));
      const unexpectedErrors = [...consoleErrors, ...pageErrors].filter((message) => (
        !message.includes("favicon")
        && !message.includes("play()")
      ));
      const flowFailed = journeyPostCount !== 1
        || uploadStartCount !== 1
        || uploadPartUrlCount !== 1
        || uploadPartPutCount !== 1
        || uploadCompleteCount !== 1
        || !createdJourney
        || createdJourney.routePoints.length !== 2
        || createdJourney.media.length !== 1
        || finalState.overflowX > 0
        || finalState.overflowY > 0
        || finalState.particleCanvases !== 1
        || finalState.earthStage !== "atlas"
        || finalState.activeTitle !== `FINAL CREATED ${viewportLabel}`
        || unexpectedErrors.length > 0;
      results.push({
        name: `final-acceptance-mobile-${viewportLabel}`,
        cinematic,
        playbackLayout,
        composerLayout,
        journeyPostCount,
        uploadStartCount,
        uploadPartUrlCount,
        uploadPartPutCount,
        uploadCompleteCount,
        createdJourney: createdJourney ? {
          id: createdJourney.id,
          title: createdJourney.title,
          routePointCount: createdJourney.routePoints.length,
          mediaCount: createdJourney.media.length,
        } : null,
        finalState,
        errors: unexpectedErrors,
        failed: flowFailed,
      });
      if (flowFailed) failed = true;
      else console.error(`[qa-post-login] final:${viewportLabel}:final-pass`);
    } catch (error) {
      failed = true;
      results.push({
        name: `final-acceptance-mobile-${viewportLabel}`,
        failed: true,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        consoleErrors,
        pageErrors,
        failedRequests,
      });
    } finally {
      await context.close();
    }
  }
}

async function verifyTransientJourneyFocus() {
  console.error("[qa-post-login] transient journey focus");
  const runCase = async (animated) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      const suffix = animated ? "&qaMotion=animate" : "";
      await page.goto(`${origin}/?qaState=journey-routes${suffix}`, { waitUntil: "domcontentloaded" });
      const host = page.locator('[data-scene-ready="true"]');
      await host.waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => {
        const debug = window.__particleEarthDebug?.();
        return debug
          && Math.abs(debug.positionX - 0.7) < 0.001
          && Math.abs(debug.positionY + 0.23) < 0.001;
      }, null, { timeout: 8_000 });
      const positionBefore = await page.evaluate(() => {
        const debug = window.__particleEarthDebug?.();
        return { x: debug?.positionX ?? 0, y: debug?.positionY ?? 0 };
      });
      await page.locator('[data-qa-route="qa-route-night-train"]').click();
      await page.waitForFunction(() => (
        document.querySelector(".particle-earth-scene")?.getAttribute("data-route-focus-phase") === "settled"
      ), null, { timeout: 12_000 });
      const arrived = await page.evaluate(() => {
        const scene = document.querySelector(".particle-earth-scene");
        const debug = window.__particleEarthDebug?.();
        return {
          arrivalX: Number(scene?.getAttribute("data-focus-arrival-x")),
          arrivalY: Number(scene?.getAttribute("data-focus-arrival-y")),
          centerX: Number(scene?.getAttribute("data-focus-arrival-center-x")),
          centerY: Number(scene?.getAttribute("data-focus-arrival-center-y")),
          targetX: Number(scene?.getAttribute("data-focus-target-x")),
          targetY: Number(scene?.getAttribute("data-focus-target-y")),
          positionX: debug?.positionX ?? 0,
          positionY: debug?.positionY ?? 0,
          rotationX: debug?.rotationX ?? 0,
          rotationY: debug?.rotationY ?? 0,
        };
      });
      const arrivalError = Math.hypot(
        arrived.arrivalX - arrived.centerX,
        arrived.arrivalY - arrived.centerY,
      );
      const positionArrivalDelta = Math.hypot(
        arrived.positionX - positionBefore.x,
        arrived.positionY - positionBefore.y,
      );
      if (arrivalError > 4 || positionArrivalDelta > 0.002 || pageErrors.length > 0) {
        throw new Error(`Transient focus arrival failed: ${JSON.stringify({ arrivalError, positionArrivalDelta, pageErrors })}`);
      }
      let release = null;
      if (animated) {
        // The arrival should stay still during the intentional inactivity hold.
        await page.waitForTimeout(5_000);
        const held = await page.evaluate(() => {
          const debug = window.__particleEarthDebug?.();
          return {
            rotationX: debug?.rotationX ?? 0,
            rotationY: debug?.rotationY ?? 0,
            positionX: debug?.positionX ?? 0,
            positionY: debug?.positionY ?? 0,
          };
        });
        const holdRotationDelta = Math.hypot(
          held.rotationX - arrived.rotationX,
          held.rotationY - arrived.rotationY,
        );
        const holdPositionDelta = Math.hypot(
          held.positionX - arrived.positionX,
          held.positionY - arrived.positionY,
        );
        if (holdRotationDelta > 0.01 || holdPositionDelta > 0.002) {
          throw new Error(`Transient focus hold failed: ${JSON.stringify({ held, arrived, holdPositionDelta, holdRotationDelta })}`);
        }

        // After 20s of inactivity, upright recovery begins at a constant 15°/s.
        await page.waitForFunction((startRotationX) => {
          const debug = window.__particleEarthDebug?.();
          return Boolean(debug && Math.abs(debug.rotationX - startRotationX) > 0.03);
        }, held.rotationX, { timeout: 20_000 });
        const alignStart = await page.evaluate(() => {
          const debug = window.__particleEarthDebug?.();
          return {
            at: performance.now(),
            rotationX: debug?.rotationX ?? 0,
            rotationY: debug?.rotationY ?? 0,
            positionX: debug?.positionX ?? 0,
            positionY: debug?.positionY ?? 0,
          };
        });
        await page.waitForTimeout(1_000);
        const alignAfterOneSecond = await page.evaluate(() => {
          const debug = window.__particleEarthDebug?.();
          return {
            at: performance.now(),
            rotationX: debug?.rotationX ?? 0,
            rotationY: debug?.rotationY ?? 0,
          };
        });
        const alignSeconds = Math.max(0.001, (alignAfterOneSecond.at - alignStart.at) / 1_000);
        const alignRateDegrees = Math.abs(
          (alignAfterOneSecond.rotationX - alignStart.rotationX) * 180 / Math.PI / alignSeconds,
        );
        if (alignRateDegrees < 12 || alignRateDegrees > 18) {
          throw new Error(`Transient focus alignment speed failed: ${JSON.stringify({ alignRateDegrees, alignStart, alignAfterOneSecond })}`);
        }

        // Longitude auto-rotation must wait for upright alignment, then resume.
        await page.waitForFunction(() => {
          const debug = window.__particleEarthDebug?.();
          return Boolean(debug && Math.abs(debug.rotationX) < 0.002);
        }, null, { timeout: 8_000 });
        const upright = await page.evaluate(() => {
          const debug = window.__particleEarthDebug?.();
          return {
            rotationY: debug?.rotationY ?? 0,
            positionX: debug?.positionX ?? 0,
            positionY: debug?.positionY ?? 0,
          };
        });
        await page.waitForFunction((startRotationY) => {
          const debug = window.__particleEarthDebug?.();
          return Boolean(debug && Math.abs(debug.rotationY - startRotationY) > 0.02);
        }, upright.rotationY, { timeout: 4_000 });
        release = await page.evaluate(() => {
          const scene = document.querySelector(".particle-earth-scene");
          const debug = window.__particleEarthDebug?.();
          return {
            targetX: Number(scene?.getAttribute("data-focus-target-x")),
            targetY: Number(scene?.getAttribute("data-focus-target-y")),
            positionX: debug?.positionX ?? 0,
            positionY: debug?.positionY ?? 0,
            rotationY: debug?.rotationY ?? 0,
          };
        });
        const releaseDrift = Math.hypot(
          release.targetX - arrived.arrivalX,
          release.targetY - arrived.arrivalY,
        );
        const releasePositionDelta = Math.hypot(
          release.positionX - arrived.positionX,
          release.positionY - arrived.positionY,
        );
        if (
          releaseDrift < 5
          || releasePositionDelta > 0.002
          || Math.abs(release.rotationY - upright.rotationY) <= 0.02
        ) {
          throw new Error(`Transient focus release failed: ${JSON.stringify({ releaseDrift, releasePositionDelta, arrived, upright, release })}`);
        }
      }
      results.push({
        name: animated ? "transient-journey-focus-animated" : "transient-journey-focus-reduced-motion",
        arrivalError,
        positionArrivalDelta,
        release,
        failed: false,
      });
    } catch (error) {
      failed = true;
      results.push({
        name: animated ? "transient-journey-focus-animated" : "transient-journey-focus-reduced-motion",
        failed: true,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        pageErrors,
      });
    } finally {
      await page.close();
    }
  };
  await runCase(false);
  await runCase(true);
}

try {
  if (finalAcceptanceOnly) {
    await verifyFinalAcceptanceMobileFlow();
  } else {
    await verifyAtlasShell();
    await verifyMobileV2InteractionContract();
    await verifyComposerMediaActions();
    await verifyComposerGlobeRoundTrip();
    await verifyTransientJourneyFocus();
    await verifyAccountDock();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
if (failed) process.exitCode = 1;
