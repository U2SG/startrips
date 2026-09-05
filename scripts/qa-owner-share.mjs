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
    // The radio dot of the expiry choice is the selection grammar itself: a
    // round mark is what distinguishes single choice from the square
    // multi-select mark beside it. It is allowed to be round; nothing else is.
    const roundingAllowed = (element) => element.matches('input[type="radio"] + span[aria-hidden]');
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
    });
    const state = { shares: [], requests: [] };
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

    await clickLabel(page, "关闭分享");
    await page.waitForTimeout(200);

    // --- Entry path A: exactly one Journey. --------------------------------
    // Reached from the surface each viewport actually offers: the mobile sheet
    // on a compact screen, the story's manage row on desktop.
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
    }

    const singleTrigger = await page.evaluate(() => {
      const trigger = document.querySelector("[data-share-journey-trigger]");
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.click();
      return true;
    });
    check(`${viewport.name}/single-entry-reachable`, singleTrigger === true);

    if (singleTrigger) {
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
    }

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
