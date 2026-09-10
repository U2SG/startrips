// #253 - desktop globe focus mode must own the viewport with exactly one piece
// of persistent chrome: a top-left return control.
//
// What this lane grades, on the real `LivingAtlasGlobe` (the `?qaState=
// living-atlas&qaMode=globe-chrome` sibling fixture, which swaps the stubbed QA
// globe for the product one):
//
//   * ordinary Atlas and focus mode render zero `.living-atlas-globe__mode`
//     nodes and none of the retired renderer-mode copy;
//   * nothing interactive can be sampled in the top-right region;
//   * ordinary desktop keeps one keyboard-reachable intent affordance which
//     enters the SAME Semantic Earth Dive path, while the zoom/drag guidance
//     remains independent from whether the detail utility cluster is mounted;
//   * entering focus mode from the detail map lands on the particle earth, so
//     MapLibre's own navigation and attribution controls are not left behind
//     as a second piece of chrome;
//   * the return control is top-left, >= 44x44, named 返回图谱, has a
//     focus-visible outline, and is not wrapped in a header panel;
//   * clicking it and pressing Escape both restore `data-globe-focus`, leave
//     `history.length` unchanged and leave the selected Journey selected;
//   * the gesture hint retires on the first wheel input and on the dwell alone,
//     and does not come back for the same visit.
//
// Deliberate coverage boundaries, stated rather than implied:
//   * The top-right sample on the `living-atlas` fixture is STRUCTURALLY empty:
//     under `?qaState=living-atlas` the AuthGateway takes its QA-bypass branch
//     and renders no account dock at all. The dock proof therefore lives in the
//     `atlas-gateway` pass at the end of this file, which drives the real
//     gateway and asserts the whole declared ownership transition together:
//     `inert` + `aria-hidden` + the isolation class + computed `visibility`,
//     `opacity` and `pointer-events`. That pass WAITS for the settled state
//     rather than sampling once, because `setCinematicIsolation` reaches the
//     gateway through a passive effect and `data-globe-focus` flipping is not
//     proof the portal-side presentation has caught up; the first run of this
//     lane read `visibility: visible` under isolation and `hidden` after
//     release, i.e. each reading lagged the transition by one step. Every
//     reading records the dock's class list, its element count and the nearest
//     `visibility: hidden` ancestor, so a future failure separates a genuinely
//     stuck isolation from a too-early read.
//   * #253's QA matrix also names 1366x768 and 125% browser zoom. Section 6
//     covers both, narrowly, on top of the three viewports the acceptance
//     names; see `ZOOM_CONDITIONS` for exactly what the zoom pass emulates and
//     what it does not.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const VIEWPORTS = [
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "2560x1440", width: 2560, height: 1440 },
];
// #253 review (U2SG P2): the owning issue's QA matrix names 1366x768 and
// browser zoom 100% / 125% "at minimum", and its acceptance calls out short
// desktop and 125% separately. These are the two conditions the acceptance
// viewports above do not reach.
//
// How 125% is emulated, stated rather than implied: browser zoom shrinks the
// CSS viewport and scales every CSS pixel. `deviceScaleFactor` alone does NOT
// do that - it changes device pixels per CSS pixel and leaves layout identical,
// which is DPR, the thing #243 owns. So the emulation is both halves: the CSS
// viewport is divided by the zoom factor AND the scale factor is raised.
// 1366 / 1.25 = 1092.8 -> 1093x614 CSS px, which is still comfortably above the
// 760px compact-mobile breakpoint (`COMPACT_MOBILE_MEDIA_QUERY`), so this pass
// grades the desktop composition and not the mobile one.
//
// What it does NOT emulate: real browser zoom also affects font boundary
// rounding and scrollbar sizing. Those are not what this contract is about.
// Note also what a 125% pass cannot discriminate: `getBoundingClientRect()`
// reports CSS pixels, so the control's 44px floor reads 44 at any zoom and
// re-asserting it here would prove nothing new. The reduced CSS viewport is the
// real variable, so this pass grades the five things the reviewer named:
// return-control geometry and position, top-right emptiness, retired renderer
// chrome, the transient hint, and the preserved return context.
const ZOOM_CONDITIONS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1366x768@125%", width: 1093, height: 614, deviceScaleFactor: 1.25 },
];
const HINT_DWELL_MS = 4000; // src/scene/globeGestureHint.ts

const journeys = [0, 1, 2, 3].map((index) => {
  const startedOn = ["2026-08-20", "2026-06-12", "2025-12-28", "2024-04-09"][index];
  const id = `qa-journey-${index}`;
  return {
    id,
    atlasId: "qa-atlas",
    title: ["海风经过深圳湾", "夏夜抵达上海", "东京冬日散步", "春天在巴黎醒来"][index],
    startedOn,
    endedOn: null,
    note: "这是一段用于全屏地球 chrome 回归的旅程。",
    lightColor: ["#77c8c2", "#e8a87c", "#9fd356", "#b39ddb"][index],
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
      label: ["深圳湾", "上海外滩", "东京上野", "巴黎左岸"][index],
      isStop: true,
      occurredAt: null,
      note: null,
      createdAt: `${startedOn}T00:00:00.000Z`,
    }],
    media: [],
  };
});

const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
let failed = false;

function record(entry) {
  checks.push(entry);
  if (entry.failed) failed = true;
}

async function stubAtlasApi(page) {
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys }),
  }));
  // Keep the detail-map toggle deterministic against the app's own same-origin
  // style proxy: there is no API behind the Vite server in this lane, so an
  // unstubbed style would fail on network availability rather than on chrome.
  await page.route(
    /\/api\/mapstyle\?path=styles(?:%2F|\/)fiord(?:$|&)/i,
    (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        name: "QA empty detailed-earth style",
        sources: {},
        layers: [],
      }),
    }),
  );
}

async function openAtlas(viewport, { reducedMotion = "no-preference" } = {}) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    // A viewport may declare its own scale factor: that is how browser zoom is
    // emulated (see the `ZOOM_CONDITIONS` note below). Everything else runs at 1.
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    reducedMotion,
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  await stubAtlasApi(page);
  await page.goto(
    `${origin}/?qaState=living-atlas&qaMode=globe-chrome&qaLite=1`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator(".living-atlas__active").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".living-atlas-globe__controls").waitFor({ state: "attached", timeout: 20_000 });
  return { page, pageErrors };
}

const settle = (page) => page.evaluate(() => new Promise((resolve) => (
  requestAnimationFrame(() => requestAnimationFrame(resolve))
)));

/** Read everything the focus-mode composition is graded on, in one evaluate. */
function readComposition(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".living-atlas");
    const exit = document.querySelector(".living-atlas__globe-focus-exit");
    const exitRect = exit ? exit.getBoundingClientRect() : null;
    const exitStyle = exit ? getComputedStyle(exit) : null;
    const text = document.body.textContent ?? "";

    // Sample the top-right region rather than one point: the issue's complaint
    // is a cluster, and a single probe could miss a control by a few pixels.
    const interactiveSelector = "button, a, [role=button], [role=link], input, select, textarea";
    const samples = [];
    for (const dx of [8, 24, 56, 104, 168, 240]) {
      for (const dy of [8, 24, 48, 72, 96]) {
        const x = innerWidth - dx;
        const y = dy;
        const hit = document.elementFromPoint(x, y);
        const interactive = hit instanceof Element
          && Boolean(
            hit.closest(interactiveSelector)
            || hit.closest(".account-dock")
            || hit.closest(".living-atlas-globe__controls"),
          );
        if (interactive) {
          samples.push({
            x,
            y,
            tag: hit.tagName,
            className: typeof hit.className === "string" ? hit.className : null,
            name: hit.getAttribute("aria-label") ?? hit.textContent?.trim().slice(0, 40) ?? null,
          });
        }
      }
    }

    return {
      focusMarker: root?.getAttribute("data-globe-focus") ?? null,
      controlsCount: document.querySelectorAll(".living-atlas-globe__controls").length,
      modeCount: document.querySelectorAll(".living-atlas-globe__mode").length,
      diveIntentCount: document.querySelectorAll('[data-earth-dive-intent="true"]').length,
      diveIntentName: document.querySelector('[data-earth-dive-intent="true"]')?.getAttribute("aria-label") ?? null,
      modeNoteCount: document.querySelectorAll(".living-atlas-globe__mode-note").length,
      legacyModeCopy: ["深入真实地图", "返回粒子地球", "REGION MAP", "ART GLOBE"].some((copy) => text.includes(copy)),
      globeSectionChildren: [...(document.querySelector(".living-atlas-globe")?.children ?? [])]
        .map((child) => (typeof child.className === "string" ? child.className : child.tagName)),
      interactiveTopRight: samples,
      exit: exit
        ? {
          accessibleName: exit.getAttribute("aria-label"),
          label: exit.textContent?.trim() ?? null,
          width: exitRect.width,
          height: exitRect.height,
          left: exitRect.left,
          top: exitRect.top,
          right: exitRect.right,
          cssRight: exitStyle.right,
          cssLeft: exitStyle.left,
          parentClass: typeof exit.parentElement?.className === "string"
            ? exit.parentElement.className
            : null,
          focused: document.activeElement === exit,
          outlineStyle: exitStyle.outlineStyle,
          outlineWidth: exitStyle.outlineWidth,
        }
        : null,
      activeRailJourney: document
        .querySelector(".living-atlas__journey-rail button.is-active strong")
        ?.textContent?.trim() ?? null,
      historyLength: window.history.length,
    };
  });
}

/**
 * Select a Journey that is NOT the one the Atlas defaults to. Without this the
 * "still selected after return" assertion would pass on the fallback value and
 * prove nothing.
 */
async function selectNonDefaultJourney(page) {
  const defaultTitle = await page.evaluate(() => (
    document.querySelector(".living-atlas__journey-rail button.is-active strong")
      ?.textContent?.trim() ?? null
  ));
  const railTitles = (await page.locator(".living-atlas__journey-rail li button strong").allTextContents())
    .map((title) => title.trim());
  const wanted = railTitles.find((title) => title !== defaultTitle) ?? railTitles[0];
  await page.locator(".living-atlas__journey-rail li button", { hasText: wanted }).first().click();
  await page.waitForFunction(
    (title) => document
      .querySelector(".living-atlas__journey-rail button.is-active strong")
      ?.textContent?.trim() === title,
    wanted,
    { timeout: 5_000 },
  );
  return { defaultTitle, selectedTitle: wanted, changed: wanted !== defaultTitle };
}

async function activateDiveIntent(page, { targetStage = "detail", tabWalk = false } = {}) {
  const intent = page.locator('[data-earth-dive-intent="true"]');
  const count = await intent.count();
  if (count !== 1) throw new Error(`expected one semantic Dive intent affordance, got ${count}`);

  let tabReached = false;
  if (tabWalk) {
    await page.evaluate(() => {
      document.querySelector("[data-qa-dive-tab-sentinel]")?.remove();
      const controls = document.querySelector(".living-atlas-globe__controls");
      if (!controls?.parentElement) return;
      const sentinel = document.createElement("button");
      sentinel.type = "button";
      sentinel.dataset.qaDiveTabSentinel = "true";
      sentinel.textContent = "qa-before-semantic-dive";
      sentinel.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
      controls.parentElement.insertBefore(sentinel, controls);
      sentinel.focus();
    });
    await page.keyboard.press("Tab");
    tabReached = await intent.evaluate((button) => document.activeElement === button);
  } else {
    await intent.focus();
  }

  const before = await intent.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const name = button.getAttribute("aria-label") ?? "";
    return {
      name,
      focused: document.activeElement === button,
      focusVisible: button.matches(":focus-visible"),
      width: rect.width,
      height: rect.height,
      visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01,
      forbiddenModeLanguage: /真实地图|REGION MAP|ART GLOBE|particle|detail/i.test(name),
    };
  });
  await page.keyboard.press("Enter");
  await page.evaluate(() => document.querySelector("[data-qa-dive-tab-sentinel]")?.remove());

  if (targetStage === "detail") {
    await page.locator(".detailed-earth-map").waitFor({ state: "attached", timeout: 8_000 });
    await page.waitForFunction(() => (
      document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") === "detail"
    ), null, { timeout: 20_000 });
  } else if (targetStage === "particle") {
    await page.waitForFunction(() => {
      const globe = document.querySelector(".living-atlas-globe");
      return globe?.getAttribute("data-earth-mode") === "particle"
        && globe?.getAttribute("data-earth-dive") === "particle";
    }, null, { timeout: 20_000 });
  } else if (targetStage === "blending") {
    await page.waitForFunction(() => (
      document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive") === "blending"
    ), null, { timeout: 20_000 });
  }

  return { count, tabReached, ...before };
}

async function readDetailUtilities(page) {
  return page.evaluate(() => {
    const hitOwned = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || Boolean(hit && element.contains(hit));
    };
    const language = document.querySelector(".living-atlas-globe__language");
    const languageButtons = [...(language?.querySelectorAll("button") ?? [])];
    const pick = document.querySelector(".living-atlas-globe__pick");
    return {
      languageCount: language ? 1 : 0,
      languageButtons: languageButtons.length,
      languageHitTestable: languageButtons.every(hitOwned),
      pickCount: pick ? 1 : 0,
      pickHitTestable: hitOwned(pick),
    };
  });
}

async function enterFocus(page, { keyboard = false } = {}) {
  const trigger = page.locator(".living-atlas__globe-focus");
  if (keyboard) {
    // Focus the trigger through the keyboard so the return control it hands
    // focus to resolves `:focus-visible`, which is what the acceptance grades.
    await trigger.focus();
    await page.keyboard.press("Enter");
  } else {
    await trigger.click();
  }
  await page.waitForFunction(() => (
    document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on"
  ), null, { timeout: 5_000 });
  await settle(page);
}

const waitForExitedFocus = (page) => page.waitForFunction(() => (
  document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "off"
), null, { timeout: 5_000 });

const countHint = (page) => page.evaluate(() => (
  document.querySelectorAll(".living-atlas-globe__mode-note").length
));

/**
 * Probe MapLibre's actual native control subtree, not only its parent layer.
 * `inert` must close keyboard/accessibility ownership and the owner-keyed
 * pointer boundary must keep control centers out of hit testing while the
 * particle globe owns input. The temporary sentinel gives us a real Tab walk
 * from immediately before the map subtree instead of inferring tabbability from
 * attributes alone.
 */
async function probeNativeMapControls(page) {
  const snapshot = await page.evaluate(() => {
    const map = document.querySelector(".detailed-earth-map");
    const controls = [...document.querySelectorAll(
      ".maplibregl-control-container button, .maplibregl-control-container a",
    )].filter((control) => control instanceof HTMLElement);
    const hitTestable = controls.flatMap((control) => {
      const rect = control.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return [];
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === control || control.contains(hit))
        ? [{
          tag: control.tagName,
          name: control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40) ?? null,
          x,
          y,
        }]
        : [];
    });
    const attribution = document.querySelector(".maplibregl-ctrl-attrib");
    const attributionStyle = attribution ? getComputedStyle(attribution) : null;
    const attributionRect = attribution?.getBoundingClientRect() ?? null;
    return {
      owner: map?.getAttribute("data-dive-owner") ?? null,
      rootInert: map instanceof HTMLElement ? map.inert : null,
      rootAriaHidden: map?.getAttribute("aria-hidden") ?? null,
      controlCount: controls.length,
      hitTestable,
      controlTabIndexes: controls.map((control) => control.tabIndex),
      controlsInsideInert: controls.filter((control) => Boolean(control.closest("[inert]"))).length,
      controlsInsideAriaHidden: controls.filter((control) => Boolean(control.closest('[aria-hidden="true"]'))).length,
      attributionPresent: Boolean(attribution),
      attributionEmpty: attribution?.classList.contains("maplibregl-attrib-empty") ?? null,
      attributionPointerEvents: attributionStyle?.pointerEvents ?? null,
      attributionInsideInert: attribution instanceof Element
        ? Boolean(attribution.closest("[inert]"))
        : null,
      attributionInsideAriaHidden: attribution instanceof Element
        ? Boolean(attribution.closest('[aria-hidden="true"]'))
        : null,
      // The empty QA style has no legal/source attribution to render, so MapLibre
      // legitimately applies `.maplibregl-attrib-empty { display:none }`. Keep
      // visibility as diagnostics only; ownership is graded on the real native
      // control shell and the shared inert/pointer boundary below.
      attributionVisible: Boolean(
        attribution
        && attributionStyle
        && attributionRect
        && attributionStyle.display !== "none"
        && attributionStyle.visibility !== "hidden"
        && Number.parseFloat(attributionStyle.opacity || "1") > 0
        && attributionRect.width > 0
        && attributionRect.height > 0
      ),
    };
  });

  const tabSequence = [];
  if (snapshot.controlCount > 0) {
    await page.evaluate(() => {
      document.querySelector("[data-qa-native-control-sentinel]")?.remove();
      const map = document.querySelector(".detailed-earth-map");
      if (!map?.parentElement) return;
      const sentinel = document.createElement("button");
      sentinel.type = "button";
      sentinel.dataset.qaNativeControlSentinel = "true";
      sentinel.textContent = "qa-tab-sentinel";
      sentinel.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
      map.parentElement.insertBefore(sentinel, map);
      sentinel.focus();
    });
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      tabSequence.push(await page.evaluate(() => {
        const active = document.activeElement;
        return {
          tag: active?.tagName ?? null,
          className: active && "className" in active && typeof active.className === "string"
            ? active.className
            : null,
          inMapControl: active instanceof Element
            ? Boolean(active.closest(".maplibregl-control-container"))
            : false,
          inDetailedMap: active instanceof Element
            ? Boolean(active.closest(".detailed-earth-map"))
            : false,
        };
      }));
    }
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      document.querySelector("[data-qa-native-control-sentinel]")?.remove();
    });
  }

  return {
    ...snapshot,
    tabSequence,
    tabReachedControl: tabSequence.some((entry) => entry.inMapControl),
    tabReachedDetailedMap: tabSequence.some((entry) => entry.inDetailedMap),
  };
}

try {
  // 1. The three acceptance viewports: chrome absence, empty top-right, the
  //    return control's own contract, and a click exit that preserves context.
  for (const viewport of VIEWPORTS) {
    const { page, pageErrors } = await openAtlas(viewport);
    try {
      const ordinary = await readComposition(page);
      const selection = await selectNonDefaultJourney(page);
      const historyBefore = await page.evaluate(() => window.history.length);

      await enterFocus(page);
      const focused = await readComposition(page);

      // The hint is armed on entry; the first wheel input retires it, and it
      // does not come back for this visit.
      const hintArmed = focused.modeNoteCount;
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, -240);
      await page.waitForFunction(() => (
        document.querySelectorAll(".living-atlas-globe__mode-note").length === 0
      ), null, { timeout: 5_000 }).catch(() => undefined);
      const hintAfterGesture = await countHint(page);

      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      await settle(page);
      const returned = await readComposition(page);

      const exit = focused.exit;
      const invalid = ordinary.focusMarker !== "off"
        || ordinary.controlsCount !== 1
        || ordinary.modeCount !== 0
        || ordinary.diveIntentCount !== 1
        || ordinary.legacyModeCopy
        // Owner review on PR 257: #253 owns the focus-mode composition, so the
        // ordinary surface keeps the permanent guidance it has always shown.
        || ordinary.modeNoteCount !== 1
        || !selection.changed
        || focused.focusMarker !== "on"
        || focused.controlsCount !== 0
        || focused.modeCount !== 0
        || focused.diveIntentCount !== 0
        || focused.legacyModeCopy
        || focused.interactiveTopRight.length > 0
        || !exit
        || exit.accessibleName !== "返回图谱"
        || exit.label !== "返回图谱"
        || exit.width < 43.5
        || exit.height < 43.5
        // Geometry, not the computed `right`: Chromium resolves `right` on an
        // absolutely positioned element to a used length even when the
        // stylesheet says `auto`. That the rule carries no `right` anchor is
        // asserted statically in src/journey/LivingAtlasApp.test.ts.
        || exit.left > viewport.width / 3
        || exit.top > 96
        || viewport.width - exit.right < viewport.width / 2
        || !exit.parentClass?.includes("living-atlas")
        || exit.parentClass.includes("header")
        || !exit.focused
        || hintArmed !== 1
        || hintAfterGesture !== 0
        || returned.focusMarker !== "off"
        || returned.controlsCount !== 1
        || returned.modeCount !== 0
        || returned.diveIntentCount !== 1
        || returned.legacyModeCopy
        // Retiring the hint inside focus mode does not consume the ordinary
        // surface's own line: returning restores the full ordinary chrome.
        || returned.modeNoteCount !== 1
        || returned.activeRailJourney !== selection.selectedTitle
        || returned.historyLength !== historyBefore
        || pageErrors.length > 0;

      record({
        name: `globe-focus-chrome/${viewport.name}`,
        ordinary: {
          focusMarker: ordinary.focusMarker,
          controlsCount: ordinary.controlsCount,
          modeCount: ordinary.modeCount,
          modeNoteCount: ordinary.modeNoteCount,
          legacyModeCopy: ordinary.legacyModeCopy,
        },
        focused: {
          focusMarker: focused.focusMarker,
          controlsCount: focused.controlsCount,
          modeCount: focused.modeCount,
          legacyModeCopy: focused.legacyModeCopy,
          globeSectionChildren: focused.globeSectionChildren,
          interactiveTopRight: focused.interactiveTopRight,
        },
        exit,
        hint: { armedOnEntry: hintArmed, afterFirstWheel: hintAfterGesture },
        selection,
        historyLength: { beforeEnter: historyBefore, afterExit: returned.historyLength },
        returned: {
          focusMarker: returned.focusMarker,
          controlsCount: returned.controlsCount,
          modeNoteCount: returned.modeNoteCount,
          activeRailJourney: returned.activeRailJourney,
        },
        pageErrors,
        failed: invalid,
      });
    } finally {
      await page.close();
    }
  }

  // 2. Second exit path: keyboard entry (so `:focus-visible` resolves) and
  //    Escape, reaching the same end states with history untouched.
  {
    const viewport = VIEWPORTS[1];
    const { page, pageErrors } = await openAtlas(viewport);
    try {
      const selection = await selectNonDefaultJourney(page);
      const historyBefore = await page.evaluate(() => window.history.length);
      await enterFocus(page, { keyboard: true });
      const focused = await readComposition(page);
      await page.keyboard.press("Escape");
      await waitForExitedFocus(page);
      await settle(page);
      const returned = await readComposition(page);
      const focusVisibleOutline = Boolean(focused.exit)
        && focused.exit.outlineStyle !== "none"
        && Number.parseFloat(focused.exit.outlineWidth) > 0;
      record({
        name: "globe-focus-escape-exit",
        viewport: viewport.name,
        exitFocused: focused.exit?.focused ?? null,
        outlineStyle: focused.exit?.outlineStyle ?? null,
        outlineWidth: focused.exit?.outlineWidth ?? null,
        focusVisibleOutline,
        interactiveTopRight: focused.interactiveTopRight,
        selection,
        historyLength: { beforeEnter: historyBefore, afterExit: returned.historyLength },
        returnedFocusMarker: returned.focusMarker,
        returnedActiveRailJourney: returned.activeRailJourney,
        pageErrors,
        failed: focused.focusMarker !== "on"
          || focused.controlsCount !== 0
          || !focusVisibleOutline
          || !focused.exit?.focused
          || !selection.changed
          || returned.focusMarker !== "off"
          || returned.controlsCount !== 1
          || returned.activeRailJourney !== selection.selectedTitle
          || returned.historyLength !== historyBefore
          || pageErrors.length > 0,
      });
    } finally {
      await page.close();
    }
  }

  // 3. Reduced motion reaches the same end states, and the hint retires on the
  //    dwell alone - no wheel, no drag, no `transitionend` in the path.
  {
    const viewport = VIEWPORTS[0];
    const { page, pageErrors } = await openAtlas(viewport, { reducedMotion: "reduce" });
    try {
      const historyBefore = await page.evaluate(() => window.history.length);
      await enterFocus(page);
      const focused = await readComposition(page);
      const hintArmed = focused.modeNoteCount;
      await page.waitForFunction(() => (
        document.querySelectorAll(".living-atlas-globe__mode-note").length === 0
      ), null, { timeout: HINT_DWELL_MS + 6_000 });
      const hintAfterDwell = await countHint(page);
      // A second visit arms a fresh hint; the retired one never re-appears in
      // the visit that dismissed it.
      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      await enterFocus(page);
      const rearmed = await countHint(page);
      await page.keyboard.press("Escape");
      await waitForExitedFocus(page);
      await settle(page);
      const returned = await readComposition(page);
      record({
        name: "globe-focus-reduced-motion-and-dwell",
        viewport: viewport.name,
        focusedFocusMarker: focused.focusMarker,
        focusedControlsCount: focused.controlsCount,
        interactiveTopRight: focused.interactiveTopRight,
        hint: { armedOnEntry: hintArmed, afterDwell: hintAfterDwell, rearmedOnNextVisit: rearmed },
        historyLength: { beforeEnter: historyBefore, afterExit: returned.historyLength },
        returnedFocusMarker: returned.focusMarker,
        returnedControlsCount: returned.controlsCount,
        returnedModeNoteCount: returned.modeNoteCount,
        pageErrors,
        failed: focused.focusMarker !== "on"
          || focused.controlsCount !== 0
          || hintArmed !== 1
          || hintAfterDwell !== 0
          || rearmed !== 1
          || returned.focusMarker !== "off"
          || returned.controlsCount !== 1
          || returned.modeNoteCount !== 1
          || returned.historyLength !== historyBefore
          || pageErrors.length > 0,
      });
    } finally {
      await page.close();
    }
  }

  // 4. #308: renderer-mode chrome is gone, but ordinary Atlas still exposes one
  //    keyboard-reachable spatial intent that enters and exits the SAME Semantic
  //    Earth Dive. Establish the timeline value inside the existing #253 focus
  //    composition, then prove Journey + explicit Route Point + timeline + history
  //    survive the complete ordinary particle -> detail -> particle round trip.
  {
    const viewport = VIEWPORTS[0];
    const { page, pageErrors } = await openAtlas(viewport);
    try {
      const selection = await selectNonDefaultJourney(page);
      const selectedJourney = journeys.find((journey) => journey.title === selection.selectedTitle);
      const routePointId = selectedJourney?.routePoints[0]?.id ?? null;
      if (!routePointId) throw new Error("selected QA Journey has no Route Point");
      await page.locator(`[data-qa-globe-route-point-activate="${routePointId}"]`).evaluate((button) => button.click());
      await page.locator(`[data-route-point-context][data-route-point-id="${routePointId}"]`).waitFor({ state: "attached", timeout: 5_000 });

      // The rewind scrubber belongs to globe-focus composition, not ordinary
      // desktop Atlas. Read the explicit Route Point-derived position there,
      // then return to ordinary Atlas before exercising Semantic Dive.
      await enterFocus(page);
      const timelineInFocus = page.locator('.globe-time-scrubber__track');
      await timelineInFocus.waitFor({ state: "visible", timeout: 5_000 });
      await timelineInFocus.focus();
      const timelineBefore = await timelineInFocus.getAttribute("aria-valuenow");
      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      await settle(page);

      // #253 intentionally clears the contextual panel when focus composition
      // exits. Re-assert the same explicit Route Point before starting the Dive;
      // this makes the preservation boundary exactly particle -> detail -> particle
      // instead of accidentally grading focus-mode teardown semantics.
      await page.locator(`[data-qa-globe-route-point-activate="${routePointId}"]`).evaluate((button) => button.click());
      await page.locator(`[data-route-point-context][data-route-point-id="${routePointId}"]`).waitFor({ state: "attached", timeout: 5_000 });

      const ordinary = await readComposition(page);
      const historyBefore = ordinary.historyLength;
      const routePointBefore = await page.locator("[data-route-point-context]").getAttribute("data-route-point-id");
      const enterIntent = await activateDiveIntent(page, { tabWalk: true });
      const detailUtilities = await readDetailUtilities(page);
      const detailOwnerControls = await probeNativeMapControls(page);
      const detail = await readComposition(page);
      const returnIntent = await activateDiveIntent(page, { targetStage: "particle" });
      await settle(page);
      const returned = await readComposition(page);
      const routePointAfter = await page.locator("[data-route-point-context]").getAttribute("data-route-point-id");

      // Re-enter the same focus/timeline composition only to observe the value;
      // Semantic Dive itself must not invent a second timeline surface.
      await enterFocus(page);
      const timelineAfter = await page.locator('.globe-time-scrubber__track').getAttribute("aria-valuenow");
      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      await settle(page);

      record({
        name: "semantic-dive-keyboard-context-roundtrip",
        viewport: viewport.name,
        selection,
        routePoint: { before: routePointBefore, after: routePointAfter },
        timeline: { before: timelineBefore, after: timelineAfter },
        historyLength: { before: historyBefore, afterDiveReturn: returned.historyLength },
        enterIntent,
        returnIntent,
        ordinary: {
          modeCount: ordinary.modeCount,
          diveIntentCount: ordinary.diveIntentCount,
          legacyModeCopy: ordinary.legacyModeCopy,
        },
        detail: {
          modeCount: detail.modeCount,
          diveIntentCount: detail.diveIntentCount,
          legacyModeCopy: detail.legacyModeCopy,
        },
        detailUtilities,
        detailOwnerControls,
        returned: {
          modeCount: returned.modeCount,
          diveIntentCount: returned.diveIntentCount,
          legacyModeCopy: returned.legacyModeCopy,
          activeRailJourney: returned.activeRailJourney,
        },
        pageErrors,
        failed: !selection.changed
          || routePointBefore !== routePointId
          || routePointAfter !== routePointId
          || timelineBefore === null
          || timelineAfter !== timelineBefore
          || returned.historyLength !== historyBefore
          || ordinary.modeCount !== 0
          || ordinary.diveIntentCount !== 1
          || ordinary.legacyModeCopy
          || !enterIntent.tabReached
          || !enterIntent.focused
          || !enterIntent.focusVisible
          || !enterIntent.visible
          || enterIntent.width < 43.5
          || enterIntent.height < 43.5
          || enterIntent.forbiddenModeLanguage
          || detail.modeCount !== 0
          || detail.diveIntentCount !== 1
          || detail.legacyModeCopy
          || detailUtilities.languageCount !== 1
          || detailUtilities.languageButtons < 2
          || !detailUtilities.languageHitTestable
          || detailUtilities.pickCount !== 1
          || !detailUtilities.pickHitTestable
          || detailOwnerControls.owner !== "detail"
          || !detailOwnerControls.attributionPresent
          || detailOwnerControls.attributionInsideInert
          || detailOwnerControls.attributionInsideAriaHidden
          || detailOwnerControls.attributionPointerEvents === "none"
          || returnIntent.forbiddenModeLanguage
          || returned.modeCount !== 0
          || returned.diveIntentCount !== 1
          || returned.legacyModeCopy
          || returned.activeRailJourney !== selection.selectedTitle
          || pageErrors.length > 0,
      });
    } finally {
      await page.close();
    }
  }
  // 4b. Codex review on PR 257: focus mode can be entered from the detail map.
  //     MapLibre installs its own navigation control bottom-right and its
  //     attribution bottom-left, so leaving the detail renderer mounted would
  //     contradict the single-control promise with chrome this app does not
  //     own. Entering focus mode must land on the particle earth.
  {
    const viewport = VIEWPORTS[1];
    const { page, pageErrors } = await openAtlas(viewport);
    try {
      await activateDiveIntent(page);
      await page.locator(".detailed-earth-map").waitFor({ state: "attached", timeout: 8_000 });
      await page.waitForFunction(() => (
        document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") === "detail"
      ), null, { timeout: 15_000 });
      const detailOwnerControls = await probeNativeMapControls(page);

      await enterFocus(page);
      let returnedToParticle = true;
      try {
        await page.waitForFunction(() => {
          const globe = document.querySelector(".living-atlas-globe");
          return globe?.getAttribute("data-earth-mode") === "particle"
            && document.querySelectorAll(".living-atlas-globe__detail-layer").length === 0;
        }, null, { timeout: 15_000 });
      } catch {
        returnedToParticle = false;
      }
      await settle(page);
      const composition = await readComposition(page);
      const mapChrome = await page.evaluate(() => ({
        earthMode: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") ?? null,
        detailLayer: document.querySelectorAll(".living-atlas-globe__detail-layer").length,
        detailMap: document.querySelectorAll(".detailed-earth-map").length,
        maplibreControls: document.querySelectorAll(".maplibregl-control-container").length,
        // The promised composition: the return control is the only chrome the
        // app renders over the globe, sampled as the interactive elements that
        // are actually hit-testable anywhere on the viewport edges.
        interactiveEdgeHits: (() => {
          const hits = [];
          const probes = [];
          for (const x of [12, 60, innerWidth / 2, innerWidth - 60, innerWidth - 12]) {
            for (const y of [12, 60, innerHeight - 60, innerHeight - 12]) probes.push([x, y]);
          }
          for (const [x, y] of probes) {
            const hit = document.elementFromPoint(Math.round(x), Math.round(y));
            const control = hit instanceof Element
              ? hit.closest("button, a, [role=button], [role=link], input, select, textarea")
              : null;
            if (!control) continue;
            hits.push({
              x: Math.round(x),
              y: Math.round(y),
              className: typeof control.className === "string" ? control.className : control.tagName,
              name: control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40) ?? null,
            });
          }
          return hits;
        })(),
      }));

      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      await settle(page);
      const returned = await readComposition(page);

      // The focus-mode composition owns exactly two interactive things: the
      // return control (#253) and the time scrubber (#21, which #253 lists as
      // preserved context). Anything else hit-testable at a viewport edge is
      // the stray chrome this round exists to catch.
      const strayChrome = mapChrome.interactiveEdgeHits.filter((hit) => (
        !hit.className.includes("living-atlas__globe-focus-exit")
        && !hit.className.includes("globe-time-scrubber")
      ));
      record({
        name: "focus-mode-entered-from-detail-map",
        viewport: viewport.name,
        returnedToParticle,
        detailOwnerControls,
        ...mapChrome,
        strayChrome,
        focusMarker: composition.focusMarker,
        controlsCount: composition.controlsCount,
        interactiveTopRight: composition.interactiveTopRight,
        returned: {
          focusMarker: returned.focusMarker,
          controlsCount: returned.controlsCount,
          modeCount: returned.modeCount,
          modeNoteCount: returned.modeNoteCount,
        },
        pageErrors,
        failed: !returnedToParticle
          // The same shared boundary must restore MapLibre's native controls
          // when detail legitimately owns input, including visible attribution.
          || detailOwnerControls.owner !== "detail"
          || detailOwnerControls.rootInert !== false
          || detailOwnerControls.rootAriaHidden === "true"
          || detailOwnerControls.controlCount === 0
          || detailOwnerControls.hitTestable.length === 0
          || !detailOwnerControls.tabReachedControl
          || !detailOwnerControls.attributionPresent
          || detailOwnerControls.attributionInsideInert
          || detailOwnerControls.attributionInsideAriaHidden
          || detailOwnerControls.attributionPointerEvents === "none"
          || mapChrome.earthMode !== "particle"
          || mapChrome.detailMap !== 0
          || mapChrome.maplibreControls !== 0
          || strayChrome.length > 0
          || composition.focusMarker !== "on"
          || composition.controlsCount !== 0
          || composition.interactiveTopRight.length > 0
          || returned.focusMarker !== "off"
          || returned.controlsCount !== 1
          || returned.modeCount !== 0
          || returned.modeNoteCount !== 1
          || pageErrors.length > 0,
      });
    } finally {
      await page.close();
    }
  }

  // 4c. #253 review (U2SG P2), rebuilt for #252's Semantic Earth Dive. The
  //     race the round above cannot reach: 4b waits for `data-earth-mode=
  //     "detail"`, i.e. a dive that already committed. The dangerous window is
  //     the earlier one. Under #259 that window has a name: `data-earth-dive=
  //     "blending"` is the stage where the detail surface is at `opacity: 1`
  //     while the particle globe still owns the gestures, so MapLibre's own
  //     navigation and attribution controls are ON SCREEN in a mode that
  //     promises a single control. It lasts the blend length (900ms with motion
  //     enabled, which `openAtlas` uses), so it is a real window rather than a
  //     timing hack.
  //
  //     What changed in the FIX, and therefore in what this round can assert:
  //     the old implementation cancelled an in-flight target inside a layout
  //     effect, so the first frame focus mode owned was already clean. #253 now
  //     suspends the Dive as a resolver INPUT, and the resolver publishes one
  //     stage per frame on a rAF loop - so the return is a bounded animation,
  //     not a synchronous commit, and asserting a clean first frame would be
  //     asserting something the design does not promise. The promise that
  //     survives is stronger and is what is graded here: across every frame of
  //     that return, the detail layer never becomes INTERACTIVE while focus
  //     mode owns the page, and the layer is gone once the return completes.
  {
    const viewport = VIEWPORTS[1];
    const { page, pageErrors } = await openAtlas(viewport);
    try {
      const blendingIntent = await activateDiveIntent(page, { targetStage: "blending" });
      let reachedBlendingWindow = true;
      reachedBlendingWindow = blendingIntent.focused && !blendingIntent.forbiddenModeLanguage;
      // Regression-family check for ordinary Earth Dive: blending is visible,
      // but particle still owns input. Grade the real MapLibre buttons/links
      // here before focus mode is involved, including a real Tab walk.
      const ordinaryBlendControls = reachedBlendingWindow
        ? await probeNativeMapControls(page)
        : null;

      // Every frame from here on is sampled. This is the replacement for the
      // old single-frame assertion: the resolver walks home over several
      // frames, and the thing that must hold on ALL of them is that no frame
      // pairs `data-globe-focus="on"` with a hit-testable detail surface.
      await page.evaluate(() => {
        const samples = [];
        window.__diveFrames = samples;
        const tick = () => {
          const globe = document.querySelector(".living-atlas-globe");
          const layer = document.querySelector(".living-atlas-globe__detail-layer");
          const map = document.querySelector(".detailed-earth-map");
          const controls = [...document.querySelectorAll(
            ".maplibregl-control-container button, .maplibregl-control-container a",
          )].filter((control) => control instanceof HTMLElement);
          const controlHitCount = controls.filter((control) => {
            const rect = control.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const hit = document.elementFromPoint(
              Math.round(rect.left + rect.width / 2),
              Math.round(rect.top + rect.height / 2),
            );
            return Boolean(hit && (hit === control || control.contains(hit)));
          }).length;
          samples.push({
            focus: document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") ?? null,
            stage: globe?.getAttribute("data-earth-dive") ?? null,
            owner: globe?.getAttribute("data-earth-dive-owner") ?? null,
            layerPointerEvents: layer ? window.getComputedStyle(layer).pointerEvents : null,
            maplibreControls: document.querySelectorAll(".maplibregl-control-container").length,
            nativeControlCount: controls.length,
            controlHitCount,
            controlSequentialFocusCount: controls.filter((control) => (
              control.tabIndex >= 0 && !control.closest("[inert]")
            )).length,
            detailRootInert: map instanceof HTMLElement ? map.inert : null,
            detailRootAriaHidden: map?.getAttribute("aria-hidden") ?? null,
          });
          if (samples.length < 600) window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
      });

      await enterFocus(page);
      const atFocusFrame = await page.evaluate(() => {
        const globe = document.querySelector(".living-atlas-globe");
        return {
          earthMode: globe?.getAttribute("data-earth-mode") ?? null,
          stage: globe?.getAttribute("data-earth-dive") ?? null,
          owner: globe?.getAttribute("data-earth-dive-owner") ?? null,
          detailLayer: document.querySelectorAll(".living-atlas-globe__detail-layer").length,
        };
      });

      // The suspension resolves towards `particle` one stage per frame, so this
      // is a bounded wait on the declared end state rather than a settle.
      let returnedToParticle = true;
      try {
        await page.waitForFunction(() => {
          const globe = document.querySelector(".living-atlas-globe");
          return globe?.getAttribute("data-earth-dive") === "particle"
            && document.querySelectorAll(".living-atlas-globe__detail-layer").length === 0;
        }, null, { timeout: 15_000 });
      } catch {
        returnedToParticle = false;
      }

      await settle(page);
      const frames = await page.evaluate(() => {
        const samples = window.__diveFrames ?? [];
        const focusFrames = samples.filter((sample) => sample.focus === "on");
        return {
          total: samples.length,
          focusFrames: focusFrames.length,
          // The whole promise of the mode, per frame: while focus owns the
          // page, the detail surface may not be touchable.
          interactiveWhileFocused: focusFrames.filter((sample) => (
            sample.layerPointerEvents && sample.layerPointerEvents !== "none"
          )),
          ownedByDetailWhileFocused: focusFrames.filter((sample) => sample.owner === "detail"),
          nativeControlsExposedWhileFocused: focusFrames.filter((sample) => (
            sample.nativeControlCount > 0
            && (
              sample.controlHitCount > 0
              || sample.controlSequentialFocusCount > 0
              || sample.detailRootInert !== true
              || sample.detailRootAriaHidden !== "true"
            )
          )),
          // Stages actually observed while focused, so a round that never saw
          // the return cannot look the same as one that did.
          stagesWhileFocused: [...new Set(focusFrames.map((sample) => sample.stage))],
          lastFocusFrame: focusFrames.at(-1) ?? null,
        };
      });
      const composition = await readComposition(page);
      const settledChrome = await page.evaluate(() => ({
        earthMode: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") ?? null,
        stage: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive") ?? null,
        detailLayer: document.querySelectorAll(".living-atlas-globe__detail-layer").length,
        detailMap: document.querySelectorAll(".detailed-earth-map").length,
        maplibreControls: document.querySelectorAll(".maplibregl-control-container").length,
        // The same edge probe as round 4b, so stray chrome is graded identically.
        interactiveEdgeHits: (() => {
          const hits = [];
          const probes = [];
          for (const x of [12, 60, innerWidth / 2, innerWidth - 60, innerWidth - 12]) {
            for (const y of [12, 60, innerHeight - 60, innerHeight - 12]) probes.push([x, y]);
          }
          for (const [x, y] of probes) {
            const hit = document.elementFromPoint(Math.round(x), Math.round(y));
            const control = hit instanceof Element
              ? hit.closest("button, a, [role=button], [role=link], input, select, textarea")
              : null;
            if (!control) continue;
            hits.push({
              x: Math.round(x),
              y: Math.round(y),
              className: typeof control.className === "string" ? control.className : control.tagName,
              name: control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40) ?? null,
            });
          }
          return hits;
        })(),
      }));
      const strayChrome = settledChrome.interactiveEdgeHits.filter((hit) => (
        !hit.className.includes("living-atlas__globe-focus-exit")
        && !hit.className.includes("globe-time-scrubber")
      ));

      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      await settle(page);
      const returned = await readComposition(page);

      // Blast radius of the suspension: it tears the map down from a stage the
      // band still wants, a pairing that did not exist before. The ordinary
      // dive must still work on the next attempt, i.e. readiness has to be
      // reported again on a second mount.
      let detailReachableAgain = true;
      try {
        await activateDiveIntent(page);
        await page.locator(".detailed-earth-map").waitFor({ state: "attached", timeout: 8_000 });
        await page.waitForFunction(() => (
          document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") === "detail"
        ), null, { timeout: 20_000 });
      } catch {
        detailReachableAgain = false;
      }

      record({
        name: "focus-suspends-unsettled-dive",
        viewport: viewport.name,
        reachedBlendingWindow,
        ordinaryBlendControls,
        atFocusFrame,
        returnedToParticle,
        frames,
        settledChrome: {
          earthMode: settledChrome.earthMode,
          stage: settledChrome.stage,
          detailLayer: settledChrome.detailLayer,
          detailMap: settledChrome.detailMap,
          maplibreControls: settledChrome.maplibreControls,
        },
        strayChrome,
        focusMarker: composition.focusMarker,
        controlsCount: composition.controlsCount,
        interactiveTopRight: composition.interactiveTopRight,
        returned: {
          focusMarker: returned.focusMarker,
          controlsCount: returned.controlsCount,
          modeCount: returned.modeCount,
        },
        detailReachableAgain,
        pageErrors,
        failed: !reachedBlendingWindow
          // Ordinary blending is the regression-family case: the map is visible
          // but native controls must already have relinquished pointer/Tab/a11y
          // ownership before focus mode exists. Attribution remains visible.
          || !ordinaryBlendControls
          || ordinaryBlendControls.owner !== "particle"
          || ordinaryBlendControls.rootInert !== true
          || ordinaryBlendControls.rootAriaHidden !== "true"
          || ordinaryBlendControls.controlCount === 0
          || ordinaryBlendControls.hitTestable.length > 0
          || ordinaryBlendControls.tabReachedControl
          || ordinaryBlendControls.tabReachedDetailedMap
          || ordinaryBlendControls.controlsInsideInert !== ordinaryBlendControls.controlCount
          || ordinaryBlendControls.controlsInsideAriaHidden !== ordinaryBlendControls.controlCount
          || !ordinaryBlendControls.attributionPresent
          || ordinaryBlendControls.attributionInsideInert !== true
          || ordinaryBlendControls.attributionInsideAriaHidden !== true
          || ordinaryBlendControls.attributionPointerEvents !== "none"
          // A round that never sampled a focused frame proves nothing.
          || frames.focusFrames === 0
          // The per-frame promise: never touchable, never the input owner, and
          // no MapLibre button/link regains hit-test/Tab/a11y ownership on the
          // focus-suspension reverse path.
          || frames.interactiveWhileFocused.length > 0
          || frames.ownedByDetailWhileFocused.length > 0
          || frames.nativeControlsExposedWhileFocused.length > 0
          // Ownership is already home on the very first focused frame: leaving
          // `detail` releases it on the same frame, so this holds even though
          // the stage itself needs a few frames to walk back.
          || atFocusFrame.owner === "detail"
          // ... and the return actually completes.
          || !returnedToParticle
          || settledChrome.stage !== "particle"
          || settledChrome.earthMode !== "particle"
          || settledChrome.detailLayer !== 0
          || settledChrome.detailMap !== 0
          || settledChrome.maplibreControls !== 0
          || strayChrome.length > 0
          || composition.focusMarker !== "on"
          || composition.controlsCount !== 0
          || composition.interactiveTopRight.length > 0
          || returned.focusMarker !== "off"
          || returned.controlsCount !== 1
          || returned.modeCount !== 0
          || !detailReachableAgain
          || pageErrors.length > 0,
      });
    } finally {
      await page.close();
    }
  }

  // 5. The account dock. This needs the real AuthGateway, so it runs on the
  //    `atlas-gateway` sibling of the same fixture: under `?qaState=living-atlas`
  //    the gateway takes its QA-bypass branch, renders no dock and supplies a
  //    no-op cinematic-isolation hook, which would make this assertion vacuous.
  {
    const viewport = VIEWPORTS[1];
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      reducedMotion: "reduce",
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let authenticated = false;
    const session = {
      session: {
        id: "qa-session",
        userId: "qa-user",
        token: "qa-token",
        expiresAt: "2027-01-01T00:00:00.000Z",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        activeOrganizationId: "qa-org",
      },
      user: {
        id: "qa-user",
        name: "QA Traveler",
        email: "qa@example.com",
        emailVerified: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
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
        body: JSON.stringify({
          atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "同行记忆" },
          role: "owner",
        }),
      }));
      await stubAtlasApi(page);
      await page.goto(
        `${origin}/?qaState=atlas-gateway&qaMode=globe-chrome&qaLite=1`,
        { waitUntil: "domcontentloaded" },
      );
      await page.locator('input[type="email"]').fill("qa@example.com");
      await page.locator('input[type="password"]').fill("password1234");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.locator(".account-dock__tab").waitFor({ state: "visible", timeout: 20_000 });
      await page.locator(".living-atlas-globe__controls").waitFor({ state: "attached", timeout: 20_000 });

      // Owner review on PR 257: record the state that OWNS the presentation,
      // not just the symptom, so a red round says which half is wrong.
      const readDock = () => page.evaluate(() => {
        const docks = document.querySelectorAll(".account-dock");
        const dock = docks[0];
        if (!dock) return null;
        const style = getComputedStyle(dock);
        let hiddenAncestor = null;
        for (let node = dock.parentElement; node; node = node.parentElement) {
          if (getComputedStyle(node).visibility === "hidden") {
            hiddenAncestor = typeof node.className === "string" ? node.className : node.tagName;
            break;
          }
        }
        return {
          inert: dock.inert === true,
          ariaHidden: dock.getAttribute("aria-hidden"),
          isolationClass: dock.classList.contains("is-cinematic-hidden"),
          visibility: style.visibility,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          classList: [...dock.classList],
          dockCount: docks.length,
          connected: dock.isConnected,
          hiddenAncestor,
          continuityCinematic: document.querySelectorAll(".auth-continuity.is-cinematic").length,
          focusableCount: dock.querySelectorAll("button, a, input").length,
        };
      });

      /**
       * The declared contract is ONE ownership transition: inert, aria-hidden,
       * the isolation class and visual absence move together. It is reached
       * through a passive effect on the React side, so the lane waits for the
       * settled state instead of sampling the frame after the focus marker
       * flips; a state that never settles still fails, with the last reading
       * recorded.
       */
      const waitForDockState = (isolated) => page.waitForFunction((expected) => {
        const dock = document.querySelector(".account-dock");
        if (!dock) return false;
        const style = getComputedStyle(dock);
        const inert = dock.inert === true;
        const ariaHidden = dock.getAttribute("aria-hidden") === "true";
        const isolationClass = dock.classList.contains("is-cinematic-hidden");
        const invisible = style.visibility === "hidden";
        return expected
          ? inert && ariaHidden && isolationClass && invisible
          : !inert && !ariaHidden && !isolationClass && !invisible;
      }, isolated, { timeout: 8_000 }).then(() => true).catch(() => false);

      // The dock is left open before entering, which is the state the issue
      // reports as clustering against the exit control.
      await page.locator(".account-dock__tab").click();
      const releasedBefore = await waitForDockState(false);
      const beforeEnter = await readDock();
      await enterFocus(page);
      const isolatedSettled = await waitForDockState(true);
      const composition = await readComposition(page);
      const inFocus = await readDock();
      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      const releasedSettled = await waitForDockState(false);
      await settle(page);
      const afterExit = await readDock();

      record({
        name: "account-dock-isolated-in-focus-mode",
        viewport: viewport.name,
        settled: { beforeEnter: releasedBefore, inFocus: isolatedSettled, afterExit: releasedSettled },
        beforeEnter,
        inFocus,
        afterExit,
        interactiveTopRight: composition.interactiveTopRight,
        focusedControlsCount: composition.controlsCount,
        pageErrors,
        failed: !releasedBefore
          || !isolatedSettled
          || !releasedSettled
          || !beforeEnter
          || beforeEnter.inert !== false
          || beforeEnter.isolationClass !== false
          || !inFocus
          || inFocus.inert !== true
          || inFocus.ariaHidden !== "true"
          || inFocus.isolationClass !== true
          || inFocus.visibility !== "hidden"
          || inFocus.pointerEvents !== "none"
          || composition.interactiveTopRight.length > 0
          || composition.controlsCount !== 0
          || !afterExit
          || afterExit.inert !== false
          || afterExit.ariaHidden !== null
          || afterExit.isolationClass !== false
          || afterExit.visibility === "hidden"
          || pageErrors.length > 0,
      });
    } finally {
      await page.close();
    }
  }

  // 6. #253 review (U2SG P2): the two conditions #253's QA matrix names that
  //    the acceptance viewports do not reach - short desktop (1366x768) and
  //    125% browser zoom. Deliberately narrow, per the reviewer: the same
  //    contract, not a duplicate of the whole matrix.
  for (const viewport of ZOOM_CONDITIONS) {
    const { page, pageErrors } = await openAtlas(viewport);
    try {
      const ordinary = await readComposition(page);
      const journey = await selectNonDefaultJourney(page);
      await enterFocus(page);
      const focused = await readComposition(page);
      const hintOnEntry = await countHint(page);

      // The return control has to be genuinely inside the top-left safe area
      // at a shorter viewport too, not merely "not on the right": a control
      // that had drifted to the middle would still satisfy a right-anchor
      // check on its own.
      //
      // Geometry, not the computed `right`, for the same reason section 1
      // states: Chromium resolves `right` on an absolutely positioned element
      // to a used length even when the stylesheet says `auto`, so reading it
      // here would fail on a correct control. The absence of a `right` anchor
      // in the rule is asserted statically in LivingAtlasApp.test.ts.
      const topLeft = Boolean(
        focused.exit
        && focused.exit.left >= 0
        && focused.exit.left <= viewport.width / 3
        && focused.exit.top >= 0
        && focused.exit.top <= 96
        && viewport.width - focused.exit.right >= viewport.width / 2,
      );
      // The one geometry reading that is NOT trivially satisfied at 125%: the
      // control must still fit inside the reduced viewport rather than being
      // pushed under an edge.
      const withinViewport = await page.evaluate(() => {
        const exit = document.querySelector(".living-atlas__globe-focus-exit");
        if (!exit) return null;
        const rect = exit.getBoundingClientRect();
        return {
          fits: rect.right <= innerWidth && rect.bottom <= innerHeight,
          innerWidth,
          innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          // `data-mobile-v2` is ALWAYS present and carries `on` / `off`
          // (`compactMobileLayoutMarker`), so its presence proves nothing —
          // the value is the contract.
          compactMobile: document.querySelector('[data-mobile-v2="on"]') !== null,
        };
      });

      await page.locator(".living-atlas__globe-focus-exit").click();
      await waitForExitedFocus(page);
      await settle(page);
      const returned = await readComposition(page);

      record({
        name: "short-desktop-and-browser-zoom",
        viewport: viewport.name,
        emulates: viewport.deviceScaleFactor
          ? `1366x768 at ${viewport.deviceScaleFactor * 100}% browser zoom, i.e. ${viewport.width}x${viewport.height} CSS px`
          : "1366x768 at 100% browser zoom",
        withinViewport,
        journey,
        ordinary: {
          controlsCount: ordinary.controlsCount,
          modeCount: ordinary.modeCount,
          focusMarker: ordinary.focusMarker,
        },
        focused: {
          focusMarker: focused.focusMarker,
          controlsCount: focused.controlsCount,
          modeCount: focused.modeCount,
          legacyModeCopy: focused.legacyModeCopy,
          interactiveTopRight: focused.interactiveTopRight,
          exit: focused.exit,
        },
        topLeft,
        hintOnEntry,
        returned: {
          focusMarker: returned.focusMarker,
          controlsCount: returned.controlsCount,
          modeCount: returned.modeCount,
          activeRailJourney: returned.activeRailJourney,
          historyLength: returned.historyLength,
        },
        historyUnchanged: returned.historyLength === ordinary.historyLength,
        pageErrors,
        failed: !withinViewport
          // A compact-mobile composition here would mean this pass graded the
          // wrong product surface, so it is a failure rather than a note.
          || withinViewport.compactMobile
          || !withinViewport.fits
          || ordinary.controlsCount !== 1
          || ordinary.modeCount !== 0
          || ordinary.diveIntentCount !== 1
          || ordinary.legacyModeCopy
          // Retired renderer-mode chrome is absent from the DOM, not just off-screen.
          || focused.controlsCount !== 0
          || focused.modeCount !== 0
          || focused.diveIntentCount !== 0
          || focused.legacyModeCopy
          // The top right stays empty.
          || focused.interactiveTopRight.length > 0
          // The return control: top-left, named, unwrapped.
          || !topLeft
          || focused.exit?.accessibleName !== "返回图谱"
          || focused.exit?.parentClass?.includes("living-atlas__header")
          // The hint is present on entry, i.e. transient guidance still arms.
          || hintOnEntry !== 1
          // Return context survives at this size too.
          || returned.focusMarker !== "off"
          || returned.controlsCount !== 1
          || returned.modeCount !== 0
          || returned.diveIntentCount !== 1
          || returned.legacyModeCopy
          || returned.activeRailJourney !== journey.selectedTitle
          || returned.historyLength !== ordinary.historyLength
          || pageErrors.length > 0,
      });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
