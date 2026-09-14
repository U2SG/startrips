// #200 phase E owner-share QA: drive the real owner share surface in a browser
// at desktop, portrait-phone and phone-landscape.
//
// The `core` lane proves the share rules as pure functions — preset
// resolution, the fragment link form, the tokenless row model, active-row
// derivation. What only a browser can answer is the rest of acceptance: that
// both entry paths are reachable at every viewport, that the exact expiry the
// SERVER returned is the one rendered, that the copied text is the
// `/share#<token>` fragment form, that revoking removes a row from the active
// list, and that the surface carries no gradient, drop shadow, decorative
// rounding or emoji ornament while every control clears 44px.
//
// The owner API is stubbed at the network boundary because this lane has no
// database: `POST /api/shares` answers with a token and an expiry the client
// did not choose, which is exactly what makes "the owner sees the SERVER's
// expiry" falsifiable here. The server half of the same contract is covered by
// `server/routes/shares.test.ts` from phase A.
import { mkdir } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";

const TOKEN = "qaOwnerShareToken00000000000000000000000000";

/**
 * The expiry the stubbed server answers with.
 *
 * Derived from the clock the lane runs on rather than written as a literal: a
 * fixed date would silently become a past instant once the calendar passed it,
 * `activeShareRows` would filter the freshly created grant straight back out,
 * and the active-list and revoke assertions would start failing for a reason
 * that has nothing to do with the product.
 *
 * 123 days is deliberately not what any preset produces (1, 7 or 30), and the
 * odd minute is deliberately not a round offset from now, so a UI that echoed
 * its own requested expiry instead of the response could not render this value.
 */
const SERVER_EXPIRES_AT = (() => {
  const value = new Date(Date.now() + 123 * 24 * 60 * 60 * 1000);
  value.setSeconds(0, 0);
  value.setMinutes(6);
  return value.toISOString();
})();

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, compact: false },
  { name: "portrait-phone", width: 390, height: 844, compact: true },
  { name: "phone-landscape", width: 932, height: 430, compact: true },
];

const SURFACE_VIEWPORTS = [320, 360, 390, 430].map((width) => ({
  name: `surface-${width}`,
  width,
  height: 844,
}));
const surfaceArtifactDir = "artifacts/owner-share-surfaces";

const journeys = [
  makeJourney(0, "2026-08-20", "海风经过深圳湾", "#77c8c2", "深圳湾"),
  makeJourney(1, "2026-06-12", "夏夜抵达上海", "#e8a87c", "上海外滩"),
  makeJourney(2, "2025-12-28", "东京冬日散步", "#9fd356", "东京上野"),
];

function makeJourney(index, startedOn, title, lightColor, label) {
  const id = `qa-journey-${index}`;
  return {
    id,
    atlasId: "qa-atlas",
    title,
    startedOn,
    endedOn: null,
    note: "这是一段用于分享回归的旅程。",
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

const failures = [];
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
}

/**
 * The owner API, as a mutable little server. `state.shares` is the list the
 * panel reads back, so create and revoke are observable through it exactly the
 * way they are against the real routes.
 */
async function installOwnerApi(page, state) {
  const requests = state.requests;
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys }),
  }));
  await page.route("**/api/shares", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      requests.push({ kind: "create", body });
      if (state.createGate) await state.createGate;
      const id = `share-${state.shares.length + 1}`;
      state.shares.unshift({
        id,
        createdAt: new Date().toISOString(),
        expiresAt: SERVER_EXPIRES_AT,
        revokedAt: null,
        lastAccessedAt: null,
        status: "active",
        journeyCount: body.journeyIds.length,
        journeys: body.journeyIds.map((journeyId) => ({
          id: journeyId,
          title: journeys.find((journey) => journey.id === journeyId)?.title ?? "",
        })),
      });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          share: {
            id,
            createdAt: new Date().toISOString(),
            expiresAt: SERVER_EXPIRES_AT,
            journeyCount: body.journeyIds.length,
          },
          token: TOKEN,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ shares: state.shares }),
    });
  });
  await page.route("**/api/shares/*/revoke", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    requests.push({ kind: "revoke", id });
    const share = state.shares.find((entry) => entry.id === id);
    if (share) {
      share.status = "revoked";
      share.revokedAt = new Date().toISOString();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ share: share ?? null }),
    });
  });
}

/** Click an icon-only control, which carries its name as `aria-label`. */
async function clickLabel(page, label) {
  const clicked = await page.evaluate((wanted) => {
    const button = [...document.querySelectorAll("button")]
      .find((element) => (element.getAttribute("aria-label") ?? "").trim() === wanted);
    if (!button) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`no control labelled ${label}`);
  await page.waitForTimeout(180);
}

/**
 * Click a control by whichever way this viewport names it.
 *
 * The share entries are labelled buttons in the desktop header and icon-only
 * buttons in the compact mobile header, so the accessible name is the stable
 * identity across viewports while the visible text is not.
 */
async function clickNamed(page, name) {
  const clicked = await page.evaluate((wanted) => {
    const button = [...document.querySelectorAll("button")].find((element) => {
      const label = (element.getAttribute("aria-label") ?? "").trim();
      const text = (element.textContent ?? "").trim();
      return label === wanted || text.includes(wanted);
    });
    if (!button) return false;
    button.click();
    return true;
  }, name);
  if (!clicked) throw new Error(`no control named ${name}`);
  await page.waitForTimeout(180);
}

async function clickText(page, text) {
  const clicked = await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")]
      .find((element) => (element.textContent ?? "").trim().includes(label));
    if (!button) return false;
    button.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`no button matching ${text}`);
  await page.waitForTimeout(180);
}

async function openCollapsedMobileStory(page) {
  const chip = page.locator(".mobile-v2__journey-chip, [data-mobile-sheet-trigger]").first();
  await chip.click();
  const open = page.getByRole("button", { name: /打开故事/ }).first();
  await open.click();
  const story = page.locator(".journey-story");
  await story.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => (
    document.querySelector(".journey-story")?.getAttribute("data-mobile-presentation") === "in-context"
  ));
}

async function shareFromCollapsedMobileStory(page, repeatIntent = false) {
  const atlasTrigger = page.locator('[data-atlas-share-trigger="true"]');
  const disabled = await atlasTrigger.isDisabled();
  await page.getByRole("button", { name: "管理旅程", exact: true }).first().click();
  await page.waitForFunction(() => (
    document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage"
  ));
  const storyShare = page.locator('.journey-story [data-share-journey-trigger="true"]');
  await storyShare.waitFor({ state: "visible", timeout: 10_000 });
  if (repeatIntent) {
    await storyShare.evaluate((button) => {
      button.click();
      button.click();
    });
  } else {
    await storyShare.click();
  }
  return disabled;
}

async function surfaceState(page) {
  return page.evaluate(() => {
    const story = document.querySelector(".journey-story");
    const share = document.querySelector(".journey-share__dialog");
    const modals = [...document.querySelectorAll('[aria-modal="true"]')]
      .filter((node) => node instanceof HTMLElement && getComputedStyle(node).display !== "none");
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return {
      story: Boolean(story),
      share: Boolean(share),
      modalCount: modals.length,
      activeAtlasShareTrigger: active?.dataset.atlasShareTrigger === "true",
      atlasInert: Boolean(document.querySelector(".living-atlas [inert], .living-atlas[inert]")),
    };
  });
}

async function waitForMobileSurfaceHistorySettled(page) {
  await page.waitForFunction(() => {
    const state = window.history.state;
    const stack = state && typeof state === "object"
      ? state.__startripsMobileSurfaceStack
      : null;
    return !Array.isArray(stack) || stack.length === 0;
  });
}

async function historyBackAndWaitForPopState(page) {
  await page.evaluate(() => new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    window.history.back();
  }));
}

async function closeShareAndWaitForHistoryReconcile(page, mobileHistory) {
  if (!mobileHistory) {
    await clickLabel(page, "关闭分享");
    await page.locator(".journey-share__dialog").waitFor({ state: "detached", timeout: 10_000 });
    return;
  }

  const closed = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((element) => (element.getAttribute("aria-label") ?? "").trim() === "关闭分享");
    if (!(button instanceof HTMLButtonElement)) return false;
    window.__qaOwnerShareClosePopStateSeen = false;
    window.addEventListener("popstate", () => {
      window.__qaOwnerShareClosePopStateSeen = true;
    }, { once: true });
    button.click();
    return true;
  });
  if (!closed) throw new Error("owner-share QA could not find the exact close control");
  await page.locator(".journey-share__dialog").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForFunction(() => window.__qaOwnerShareClosePopStateSeen === true, undefined, { timeout: 10_000 });
  await waitForMobileSurfaceHistorySettled(page);
}

async function captureSurface(page, viewportName, label) {
  await mkdir(surfaceArtifactDir, { recursive: true });
  const path = `${surfaceArtifactDir}/${viewportName}-${label}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}

/**
 * The editorial-ink audit, run against the computed style of every element in
 * the dialog rather than against the stylesheet source, so a value inherited
 * from elsewhere is caught too.
 */
async function ornamentScan(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".journey-share");
    if (!root) return null;
    const offenders = { gradient: [], shadow: [], rounding: [], blur: [], emoji: [] };
    const smallTargets = [];
    // The radio dot identifies single choice; the lamb's orbit is part of the
    // shared brand mark. Neither is a rounded panel or control. Keep the
    // exemption on these exact shapes so surrounding surfaces remain audited.
    const roundingAllowed = (element) => element.matches(
      'input[type="radio"] + span[aria-hidden], .startrips-brand-mark > .startrips-brand-mark__orbit[aria-hidden="true"]',
    );
    const emojiPattern = /\p{Extended_Pictographic}/u;
    for (const element of root.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      // SVG elements expose an SVGAnimatedString here rather than a string.
      const name = typeof element.className === "string" && element.className
        ? element.className
        : element.tagName;
      if (/gradient/i.test(style.backgroundImage)) offenders.gradient.push(String(name));
      if (style.boxShadow && style.boxShadow !== "none") offenders.shadow.push(String(name));
      if (style.filter?.includes("blur") || style.backdropFilter?.includes("blur")) {
        offenders.blur.push(String(name));
      }
      const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
      if (radius > 0 && !roundingAllowed(element)) offenders.rounding.push(`${name}:${style.borderTopLeftRadius}`);
      for (const node of element.childNodes) {
        if (node.nodeType === 3 && emojiPattern.test(node.textContent ?? "")) {
          offenders.emoji.push(String(name));
        }
      }
      if (element.tagName === "BUTTON" || element.tagName === "LABEL" || element.tagName === "INPUT") {
        const rect = element.getBoundingClientRect();
        const hidden = style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.05;
        // The native checkbox/radio inputs are visually hidden on purpose; the
        // 44px target is the label that wraps them.
        const visuallyHidden = element.tagName === "INPUT" && rect.height <= 2;
        if (!hidden && !visuallyHidden && rect.height > 0 && rect.height < 44) {
          smallTargets.push({ name: String(name), height: Math.round(rect.height * 10) / 10 });
        }
      }
    }
    return { offenders, smallTargets };
  });
}

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.compact,
      isMobile: viewport.compact,
      deviceScaleFactor: 1,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    // Record what the copy affordance hands to the clipboard, and still call
    // through so the button's copied state behaves normally. The recorded
    // argument IS the product value; asserting on it rather than on a
    // clipboard round-trip keeps this check about the link the owner copies
    // instead of about headless clipboard permissions.
    await page.addInitScript(() => {
      const original = navigator.clipboard?.writeText?.bind(navigator.clipboard);
      window.__qaClipboardWrites = [];
      if (original) {
        navigator.clipboard.writeText = (text) => {
          window.__qaClipboardWrites.push(text);
          return original(text);
        };
      }
      // Headless Chromium on Linux exposes no `navigator.share`, so without
      // this the native-share half of the acceptance would never render and
      // never be measured — the lane would only ever prove the fallback. This
      // defines it before the app loads, which is the "where available" case;
      // the copy affordance is asserted separately and does not depend on it.
      window.__qaShareCalls = [];
      Object.defineProperty(navigator, "share", {
        configurable: true,
        writable: true,
        value: (data) => {
          window.__qaShareCalls.push(data);
          return Promise.resolve();
        },
      });
    });
    const state = { shares: [], requests: [], createGate: null };
    await installOwnerApi(page, state);
    await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => document.body.textContent?.includes("海风经过深圳湾"),
      undefined,
      { timeout: 20_000 },
    );

    // --- Entry path B: several Journeys, one link. -------------------------
    await clickNamed(page, "分享多段旅程");
    await page.locator(".journey-share__dialog").waitFor({ timeout: 10_000 });
    check(`${viewport.name}/multi-entry-reachable`, true);

    // Select two of the three, so the request proves the set is exactly what
    // was ticked rather than "every Journey in the Atlas".
    const selected = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.journey-share__selection input[type="checkbox"]')];
      boxes[0]?.click();
      boxes[1]?.click();
      return boxes.length;
    });
    check(`${viewport.name}/selection-lists-every-journey`, selected === journeys.length, { selected });

    await page.evaluate(() => {
      const preset = [...document.querySelectorAll('input[name="journey-share-expiry"]')]
        .find((input) => input.value === "30d");
      preset?.click();
    });
    await clickText(page, "创建分享链接");
    await page.locator("[data-share-link]").waitFor({ timeout: 10_000 });

    const created = await page.evaluate(() => ({
      link: document.querySelector("[data-share-link]")?.textContent?.trim() ?? "",
      expiresAttr: document.querySelector("[data-share-expires-at]")?.getAttribute("data-share-expires-at") ?? "",
      expiryText: document.querySelector("[data-share-expires-at]")?.textContent?.trim() ?? "",
      bodyText: document.querySelector(".journey-share__dialog")?.textContent ?? "",
    }));

    const createRequest = state.requests.find((entry) => entry.kind === "create");
    check(
      `${viewport.name}/request-carries-exactly-the-selected-set`,
      createRequest?.body.journeyIds.length === 2,
      createRequest?.body.journeyIds,
    );

    // Acceptance 4: the copy affordance yields the fragment form.
    const linkOk = created.link === `${new URL(origin).origin}/share#${TOKEN}`;
    check(`${viewport.name}/link-is-fragment-form`, linkOk, created.link);
    check(
      `${viewport.name}/token-not-in-path-or-query`,
      linkOk && new URL(created.link).pathname === "/share" && new URL(created.link).search === "",
      created.link,
    );

    // Acceptance 3: the shown expiry is the SERVER's value, not the requested one.
    const expected = new Date(SERVER_EXPIRES_AT);
    const pad = (part) => String(part).padStart(2, "0");
    const expectedText = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`
      + ` ${pad(expected.getHours())}:${pad(expected.getMinutes())}`;
    check(
      `${viewport.name}/shows-server-expiry-exactly`,
      created.expiresAttr === SERVER_EXPIRES_AT && created.expiryText === expectedText,
      { attr: created.expiresAttr, text: created.expiryText, expectedText },
    );

    // Acceptance 6: the bearer sentence is on screen before the owner leaves.
    check(
      `${viewport.name}/states-anyone-with-the-link-can-view-not-edit`,
      created.bodyText.includes("任何获得此链接的人都可以在有效期内查看所选旅程，但不能编辑。"),
    );
    check(
      `${viewport.name}/states-the-link-is-shown-once`,
      created.bodyText.includes("只在创建时显示一次"),
    );

    // Copy, and assert on the exact text the affordance wrote.
    await clickText(page, "复制链接");
    const written = await page.evaluate(() => window.__qaClipboardWrites ?? []);
    check(
      `${viewport.name}/copy-yields-the-fragment-link`,
      written.length === 1 && written[0] === created.link,
      written,
    );

    // Acceptance 4, second clause: native share is used where available. The
    // button exists only because `navigator.share` does, and it must hand over
    // the same fragment link the copy affordance yields.
    await clickText(page, "分享…");
    const shared = await page.evaluate(() => window.__qaShareCalls ?? []);
    check(
      `${viewport.name}/native-share-hands-over-the-fragment-link`,
      shared.length === 1 && shared[0]?.url === created.link,
      shared,
    );

    // Acceptance 8 says "the UI", not "the compose step": audit the created
    // surface, which carries controls the compose step never renders.
    const createdOrnament = await ornamentScan(page);
    check(`${viewport.name}/created-no-gradient`, createdOrnament?.offenders.gradient.length === 0, createdOrnament?.offenders.gradient);
    check(`${viewport.name}/created-no-drop-shadow`, createdOrnament?.offenders.shadow.length === 0, createdOrnament?.offenders.shadow);
    check(`${viewport.name}/created-no-decorative-rounding`, createdOrnament?.offenders.rounding.length === 0, createdOrnament?.offenders.rounding);
    check(`${viewport.name}/created-no-blur`, createdOrnament?.offenders.blur.length === 0, createdOrnament?.offenders.blur);
    check(`${viewport.name}/created-no-emoji-ornament`, createdOrnament?.offenders.emoji.length === 0, createdOrnament?.offenders.emoji);
    check(`${viewport.name}/created-touch-targets-at-least-44px`, createdOrnament?.smallTargets.length === 0, createdOrnament?.smallTargets);

    // Acceptance 7: the token is not re-retrievable. Leave the creation
    // surface and assert the raw token is gone from the whole document.
    await clickText(page, "完成");
    await page.waitForTimeout(220);
    const afterDone = await page.evaluate((token) => ({
      html: document.documentElement.innerHTML.includes(token),
      rows: [...document.querySelectorAll("[data-share-row]")].length,
      rowText: [...document.querySelectorAll("[data-share-row]")].map((row) => row.textContent ?? ""),
    }), TOKEN);
    check(`${viewport.name}/token-not-re-retrievable`, afterDone.html === false, afterDone.html);
    check(`${viewport.name}/active-list-shows-the-new-link`, afterDone.rows === 1, afterDone);
    check(
      `${viewport.name}/active-row-shows-scope-and-expiry`,
      afterDone.rowText.every((text) => text.includes("有效至") && text.includes(expectedText)),
      afterDone.rowText,
    );

    // The custom `datetime-local` input is only mounted by the 自定义 preset,
    // so the scans above have never seen it. Tick it once and audit it.
    await page.evaluate(() => {
      const custom = [...document.querySelectorAll('input[name="journey-share-expiry"]')]
        .find((input) => input.value === "custom");
      custom?.click();
    });
    await page.waitForTimeout(160);
    const customOrnament = await ornamentScan(page);
    const customMounted = await page.evaluate(
      () => Boolean(document.querySelector(".journey-share__custom-expiry")),
    );
    check(`${viewport.name}/custom-expiry-input-is-offered`, customMounted === true);
    check(`${viewport.name}/custom-expiry-touch-target-at-least-44px`, customOrnament?.smallTargets.length === 0, customOrnament?.smallTargets);
    check(`${viewport.name}/custom-expiry-no-decorative-rounding`, customOrnament?.offenders.rounding.length === 0, customOrnament?.offenders.rounding);

    const ornament = await ornamentScan(page);
    check(`${viewport.name}/no-gradient`, ornament?.offenders.gradient.length === 0, ornament?.offenders.gradient);
    check(`${viewport.name}/no-drop-shadow`, ornament?.offenders.shadow.length === 0, ornament?.offenders.shadow);
    check(`${viewport.name}/no-decorative-rounding`, ornament?.offenders.rounding.length === 0, ornament?.offenders.rounding);
    check(`${viewport.name}/no-blur`, ornament?.offenders.blur.length === 0, ornament?.offenders.blur);
    check(`${viewport.name}/no-emoji-ornament`, ornament?.offenders.emoji.length === 0, ornament?.offenders.emoji);
    check(`${viewport.name}/touch-targets-at-least-44px`, ornament?.smallTargets.length === 0, ornament?.smallTargets);

    // Acceptance 5: revoking leaves the active list.
    await clickText(page, "撤销链接");
    await page.waitForTimeout(320);
    const afterRevoke = await page.evaluate(() => [...document.querySelectorAll("[data-share-row]")].length);
    check(`${viewport.name}/revoked-link-leaves-the-active-list`, afterRevoke === 0, { afterRevoke });
    check(
      `${viewport.name}/revoke-reached-the-server`,
      state.requests.some((entry) => entry.kind === "revoke"),
      state.requests.map((entry) => entry.kind),
    );

    await closeShareAndWaitForHistoryReconcile(page, viewport.compact);

    // --- Entry path A: exactly one Journey. --------------------------------
    // Reached from the surface each viewport actually offers: the mobile sheet
    // on a compact screen, the story's edit mode on desktop.
    if (viewport.compact) {
      await page.evaluate(() => {
        const chip = document.querySelector(".mobile-v2__journey-chip")
          ?? document.querySelector("[data-mobile-sheet-trigger]");
        if (chip instanceof HTMLElement) chip.click();
      });
      await page.waitForTimeout(260);
    } else {
      await page.evaluate(() => {
        const rail = document.querySelector(".living-atlas__journey-rail ol li button");
        if (rail instanceof HTMLElement) rail.click();
      });
      await page.waitForTimeout(420);
      await page.evaluate(() => {
        const open = [...document.querySelectorAll("button")]
          .find((element) => (element.getAttribute("aria-label") ?? "").startsWith("打开旅程："));
        open?.click();
      });
      await page.locator(".journey-story").waitFor({ timeout: 15_000 });
      check(
        `${viewport.name}/reading-keeps-share-in-edit-mode`,
        await page.locator(".journey-story [data-share-journey-trigger]").count() === 0,
      );
      await page.locator(".journey-story").getByRole("button", { name: "编辑故事", exact: true }).click();
      await page.locator(".journey-story [data-share-journey-trigger]").waitFor({ timeout: 10_000 });
    }

    const singleShareTrigger = viewport.compact
      ? page.locator('.mobile-v2__sheet [data-share-journey-trigger="true"]')
      : page.locator('.journey-story [data-share-journey-trigger="true"]');
    await singleShareTrigger.waitFor({ state: "visible", timeout: 10_000 });
    check(`${viewport.name}/single-entry-reachable`, await singleShareTrigger.isVisible());
    await singleShareTrigger.click();

    await page.locator(".journey-share__dialog").waitFor({ timeout: 10_000 });
    const single = await page.evaluate(() => ({
      heading: document.querySelector("#journey-share-title")?.textContent ?? "",
      selectionOffered: Boolean(document.querySelector(".journey-share__selection")),
    }));
    // Locked to one Journey: no selection list, and the title names it.
    check(
      `${viewport.name}/single-share-is-locked-to-one-journey`,
      single.selectionOffered === false && single.heading.includes("分享「"),
      single,
    );
    await clickText(page, "创建分享链接");
    await page.locator("[data-share-link]").waitFor({ timeout: 10_000 });
    const singleRequest = state.requests.filter((entry) => entry.kind === "create").at(-1);
    check(
      `${viewport.name}/single-share-requests-exactly-one-journey`,
      singleRequest?.body.journeyIds.length === 1,
      singleRequest?.body.journeyIds,
    );

    await context.close();
  }

  // #356: mobile Story and Share are one top-level presentation slot. Keep
  // this focused matrix small: the full share behavior above already covers
  // creation/revoke, while these four widths pin replacement/history/focus.
  for (const viewport of SURFACE_VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const state = { shares: [], requests: [], createGate: null };
    await installOwnerApi(page, state);
    await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => document.body.textContent?.includes("海风经过深圳湾"),
      undefined,
      { timeout: 20_000 },
    );

    // Collapsed Story receives external-keyboard Escape exactly once.
    await openCollapsedMobileStory(page);
    const beforeEscape = await surfaceState(page);
    check(`${viewport.name}/story-alone-before-escape`,
      beforeEscape.story && !beforeEscape.share && beforeEscape.modalCount <= 1,
      beforeEscape);
    await page.keyboard.press("Escape");
    await page.locator(".journey-story").waitFor({ state: "detached", timeout: 10_000 });
    const afterEscape = await surfaceState(page);
    check(`${viewport.name}/escape-closes-collapsed-story`, !afterEscape.story && !afterEscape.share, afterEscape);

    // Story -> Esc -> Share leaves only Share and one modal focus owner. The
    // Journey-detail share trigger is the legal foreground trigger while the
    // underlying sheet remains after Story closes.
    await page.locator('.mobile-v2__sheet [data-share-journey-trigger="true"]').click();
    await page.locator(".journey-share__dialog").waitFor({ state: "visible", timeout: 10_000 });
    const afterEscapeShare = await surfaceState(page);
    check(`${viewport.name}/story-escape-then-share-is-exclusive`,
      !afterEscapeShare.story && afterEscapeShare.share && afterEscapeShare.modalCount === 1,
      afterEscapeShare);
    await page.keyboard.press("Escape");
    await page.locator(".journey-share__dialog").waitFor({ state: "detached", timeout: 10_000 });

    // Story -> Share is replacement, not coexistence. While Story owns the
    // compact surface, Atlas multi-share is disabled so it cannot open under
    // Story; Story's own share intent goes through the same replacement helper.
    // Two same-turn Story share intents still converge on one final Share.
    await openCollapsedMobileStory(page);
    const atlasShareDisabled = await shareFromCollapsedMobileStory(page, true);
    check(`${viewport.name}/atlas-multi-share-disabled-while-story-owns-surface`,
      atlasShareDisabled,
      { atlasShareDisabled });
    await page.locator(".journey-share__dialog").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".journey-story").waitFor({ state: "detached", timeout: 10_000 });
    const replaced = await surfaceState(page);
    const replacementCapture = await captureSurface(page, viewport.name, "story-to-share");
    check(`${viewport.name}/story-to-share-replaces-top-level-owner`,
      !replaced.story && replaced.share && replaced.modalCount === 1,
      { ...replaced, replacementCapture });
    check(`${viewport.name}/share-inerts-background`, replaced.atlasInert, replaced);

    // A share mutation owns the surface until its server result is known. A
    // hardware/browser Back during create must restore the same Share history
    // layer instead of unmounting the one place that can receive the token.
    let releaseCreate;
    state.createGate = new Promise((resolve) => { releaseCreate = resolve; });
    await page.getByRole("button", { name: "创建分享链接" }).click();
    await page.getByRole("button", { name: "正在创建…" }).waitFor({ state: "visible", timeout: 10_000 });
    await historyBackAndWaitForPopState(page);
    const pendingBack = await surfaceState(page);
    check(`${viewport.name}/back-does-not-dismiss-pending-share-create`,
      pendingBack.share && !pendingBack.story && pendingBack.modalCount === 1,
      pendingBack);
    releaseCreate();
    state.createGate = null;
    await page.locator('[data-share-link="true"]').waitFor({ state: "visible", timeout: 10_000 });

    // Escape is a non-history-button close path. It must still reconcile the
    // stale Story/sheet predecessor rather than leaving ghost Back entries.
    await page.keyboard.press("Escape");
    await page.locator(".journey-share__dialog").waitFor({ state: "detached", timeout: 10_000 });

    // Reopen immediately while the cleanup-owned history traversal may still
    // be in flight. The token write must wait for that traversal, but Back
    // ownership must exist immediately: if a create becomes pending in this
    // window, Browser Back cannot consume underlying navigation.
    await page.locator('[data-atlas-share-trigger="true"]').click();
    await page.locator(".journey-share__dialog").waitFor({ state: "visible", timeout: 10_000 });
    const rapidReopen = await surfaceState(page);
    check(`${viewport.name}/rapid-reopen-survives-history-reconcile`,
      rapidReopen.share && !rapidReopen.story && rapidReopen.modalCount === 1,
      rapidReopen);
    const rapidReopenJourney = page.getByRole("checkbox", {
      name: /^海风经过深圳湾\s*2026-08-20$/,
    });
    await rapidReopenJourney.check();
    check(`${viewport.name}/rapid-reopen-explicitly-selects-fixture-journey`,
      await rapidReopenJourney.isChecked(),
      { journeyTitle: "海风经过深圳湾", startedOn: "2026-08-20" });
    let releaseDeferredCreate;
    state.createGate = new Promise((resolve) => { releaseDeferredCreate = resolve; });
    await page.getByRole("button", { name: "创建分享链接" }).click();
    await page.getByRole("button", { name: "正在创建…" }).waitFor({ state: "visible", timeout: 10_000 });
    await historyBackAndWaitForPopState(page);
    const deferredPendingBack = await surfaceState(page);
    check(`${viewport.name}/rapid-reopen-pending-create-retains-back-ownership`,
      deferredPendingBack.share && !deferredPendingBack.story && deferredPendingBack.modalCount === 1,
      deferredPendingBack);
    releaseDeferredCreate();
    state.createGate = null;
    await page.locator('[data-share-link="true"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.locator(".journey-share__dialog").waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForFunction(() => {
      const state = window.history.state;
      const stack = state && typeof state === "object"
        ? state.__startripsMobileSurfaceStack
        : null;
      return !Array.isArray(stack) || stack.length === 0;
    });
    check(`${viewport.name}/escape-after-replacement-clears-ghost-history`,
      !(await surfaceState(page)).share,
      await surfaceState(page));

    // Recreate the Story -> Share replacement for the explicit Browser Back
    // ordering and orientation assertions below.
    await openCollapsedMobileStory(page);
    await shareFromCollapsedMobileStory(page);
    await page.locator(".journey-share__dialog").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".journey-story").waitFor({ state: "detached", timeout: 10_000 });

    // Orientation/breakpoint transitions cannot resurrect Story or create a
    // second modal owner while Share remains current.
    await page.setViewportSize({ width: 844, height: viewport.width });
    await page.waitForTimeout(100);
    const landscape = await surfaceState(page);
    check(`${viewport.name}/orientation-keeps-one-share-owner`,
      !landscape.story && landscape.share && landscape.modalCount === 1,
      landscape);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(100);

    // Same-document Back closes Share and must not reveal the replaced Story
    // token. Focus may return only to the still-connected Atlas trigger.
    await page.evaluate(() => window.history.back());
    await page.locator(".journey-share__dialog").waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForFunction(() => {
      const state = window.history.state;
      const stack = state && typeof state === "object"
        ? state.__startripsMobileSurfaceStack
        : null;
      return !Array.isArray(stack) || stack.length === 0;
    });
    const afterBack = await surfaceState(page);
    const backCapture = await captureSurface(page, viewport.name, "after-back");
    check(`${viewport.name}/back-closes-share-without-ghost-story`,
      !afterBack.story && !afterBack.share && afterBack.modalCount === 0,
      { ...afterBack, backCapture });
    check(`${viewport.name}/share-close-restores-legal-atlas-focus`,
      afterBack.activeAtlasShareTrigger,
      afterBack);

    await context.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ lane: "owner-share", results }, null, 2));
if (failures.length) {
  console.error(`owner-share FAILED:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("owner-share OK");
