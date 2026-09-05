// #200 phase D guest-viewer QA: drive the real `/share#<token>` document in a
// browser and measure what a recipient can actually reach.
//
// The `core` lane proves the capability contract and the read-only story
// markup. What only a browser can answer is the rest of acceptance: that the
// whole Atlas shell renders no owner affordance at desktop, portrait-phone and
// phone-landscape sizes; that the globe, the story and playback still work;
// that the token never leaves the fragment; and that a grant which dies while
// the page is open produces the polished unavailable state rather than a blank
// screen.
//
// The guest API is stubbed at the network boundary because this lane has no
// database and no object storage. Everything it asserts is browser behaviour
// given a well-formed guest payload; the server side of the same contract is
// covered by the integration tests from phases A to C.
//
// What this lane deliberately does NOT cover: creating a link, which is the
// owner surface `qa-owner-share.mjs` drives; the real presign lifetime
// (the stub answers instantly), and Story fullscreen media playback, which
// needs a decodable video the stub does not serve.
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
// 43 base64url characters: the shape `generateShareToken()` produces.
const TOKEN = "qaGuestShareToken0000000000000000000000000A";
const shareUrl = (fragment = TOKEN) => new URL(`/share#${fragment}`, baseUrl).toString();

// #194 shared layout contract, copied here on purpose: this lane must fail if
// the app's own query drifts away from the one the mobile mode is defined by.
const COMPACT_MOBILE_MEDIA_QUERY = "(max-width: 760px), (max-width: 960px) and (max-height: 480px) and (any-pointer: coarse)";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, compact: false },
  { name: "portrait-phone", width: 390, height: 844, compact: true },
  { name: "phone-landscape", width: 932, height: 430, compact: true },
];

/** Owner affordances, by the copy each one renders. None may exist for a guest. */
const FORBIDDEN_CONTROL_TEXT = [
  "记录旅程",
  "记录新旅程",
  "记录第一段旅程",
  "下一段旅程",
  "管理旅程",
  "管理当前媒体",
  "媒体排序",
  "编辑旅程",
  "删除旅程",
  "添加照片或视频",
  "上传配乐",
  "替换配乐",
  "移除配乐",
  "删除媒体",
  "设为封面",
  "邀请另一位",
  "编辑图谱",
  "退出登录",
  // #200 phase E owner share affordances. `canShareAtlas` was declared but
  // unused until phase E, so before it these four could not have been rendered
  // by anything; now that they exist, a guest must still reach none of them.
  "分享旅程",
  "分享多段旅程",
  "创建分享链接",
  "撤销链接",
];

const sharedJourneys = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "海风经过深圳湾",
    startedOn: "2026-08-20",
    endedOn: null,
    note: "路线本身成为这一晚的记忆。",
    lightColor: "#77c8c2",
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 2,
    previousJourneyId: null,
    nextJourneyId: "22222222-2222-4222-8222-222222222222",
    routePoints: [
      { id: "aaaaaaa1-1111-4111-8111-111111111111", latitude: 22.5431, longitude: 114.0579, label: "深圳湾", isStop: true, occurredAt: null, note: "海风一直没有停。" },
      { id: "aaaaaaa2-1111-4111-8111-111111111111", latitude: 22.1987, longitude: 113.5439, label: "珠海情侣路", isStop: true, occurredAt: null, note: null },
    ],
    media: [],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "夏夜抵达上海",
    startedOn: "2026-06-12",
    endedOn: "2026-06-15",
    note: "灯光沿着江面慢慢退远。",
    lightColor: "#e8a87c",
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 1,
    previousJourneyId: "11111111-1111-4111-8111-111111111111",
    nextJourneyId: null,
    routePoints: [
      { id: "bbbbbbb1-2222-4222-8222-222222222222", latitude: 31.2304, longitude: 121.4737, label: "上海外滩", isStop: true, occurredAt: null, note: null },
    ],
    media: [],
  },
];

// The two ends of the granted set, derived the way the product derives them:
// `LivingAtlasApp` sorts with `sortJourneysChronologically` on load, so the
// story's 上一段/下一段 pair is decided by date order, not payload order. The
// rail is that sorted list reversed, so its FIRST entry is the far end.
const CHRONOLOGICAL = [...sharedJourneys].sort((left, right) => left.startedOn.localeCompare(right.startedOn));
const NEAR_END_TITLE = CHRONOLOGICAL[0].title;
const FAR_END_TITLE = CHRONOLOGICAL[CHRONOLOGICAL.length - 1].title;

/** Wait until the open story dialog is actually showing `title`. */
async function storyShowing(page, title) {
  await page.locator(".journey-story").waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    (wanted) => (document.querySelector(".journey-story")?.textContent ?? "").includes(wanted),
    title,
    { timeout: 15_000 },
  );
}

function sharedPayload(journeys = sharedJourneys, expiresAt = "2036-10-10T10:30:00.000Z") {
  return {
    share: { expiresAt, journeyCount: journeys.length },
    journeys,
  };
}

const browser = await launchQaBrowser({
  headless: true,
  // The guest shell mounts the particle globe, which needs WebGL on the CI
  // runner exactly like the other globe lanes.
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const failures = [];
const requestedUrls = [];

/**
 * Install the guest API. `journeysResponse` decides what the shared read
 * answers, so one page can watch the grant die under it.
 */
async function installGuestApi(page, state) {
  await page.route("**/api/shared/journeys", (route) => {
    const authorization = route.request().headers().authorization ?? "";
    if (authorization !== `Bearer ${TOKEN}`) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "SHARE_UNAVAILABLE", message: "Share link unavailable" }),
      });
    }
    return route.fulfill({
      status: state.journeysStatus,
      contentType: "application/json",
      headers: { "cache-control": "private, no-store" },
      body: JSON.stringify(state.journeysStatus === 200
        ? sharedPayload(state.journeys, state.expiresAt ?? undefined)
        : { error: "SHARE_UNAVAILABLE", message: "Share link unavailable" }),
    });
  });
  await page.route("**/api/shared/assets/*/read-url", (route) => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "MEDIA_UNAVAILABLE", message: "Media unavailable" }),
  }));
  // Nothing owner-side may be requested at all; answering these makes an
  // accidental call visible in `requestedUrls` instead of hanging the page.
  await page.route("**/api/journeys**", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "OWNER_ROUTE_REACHED" }),
  }));
  await page.route("**/api/atlases/**", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "OWNER_ROUTE_REACHED" }),
  }));
  await page.route("**/api/auth/**", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "OWNER_ROUTE_REACHED" }),
  }));
}

async function newGuestPage(context, state) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => requestedUrls.push(request.url()));
  await installGuestApi(page, state);
  return { page, consoleErrors };
}

/** Every visible interactive control the guest document renders, by label. */
async function visibleControls(page) {
  return page.evaluate(() => [...document.querySelectorAll("button, a[href], input, select, textarea")]
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) > 0.05
        && rect.width > 1
        && rect.height > 1;
    })
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type"),
      label: (element.getAttribute("aria-label") || element.textContent || "")
        .trim().replace(/\s+/g, " ").slice(0, 60),
    })));
}

/** Every control, visible or not — a hidden file input is still an upload. */
async function allControlText(page) {
  return page.evaluate(() => ({
    text: document.body.innerText,
    labels: [...document.querySelectorAll("[aria-label], [title]")]
      .map((element) => `${element.getAttribute("aria-label") ?? ""}|${element.getAttribute("title") ?? ""}`)
      .join("\n"),
    fileInputs: document.querySelectorAll('input[type="file"]').length,
  }));
}

// `hasTouch` makes `any-pointer: coarse` true, which is the second clause of
// the shared layout query and the only way the phone-landscape case can be
// compact at all. Without it the 932x430 assertion would resolve on width
// alone and prove nothing about the contract it claims to check.
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  hasTouch: true,
});

try {
  // ---------------------------------------------------------------- 1. layouts
  for (const viewport of VIEWPORTS) {
    const state = { journeysStatus: 200, journeys: sharedJourneys, expiresAt: undefined };
    const { page, consoleErrors } = await newGuestPage(context, state);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(shareUrl(), { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 30_000 });
    // The scene lives inside the aria-hidden persistent-earth host, so this
    // reads its readiness attribute rather than asking about visibility.
    await page.waitForFunction(
      () => document.querySelector(".particle-earth-scene")?.getAttribute("data-scene-ready") === "true",
      undefined,
      { timeout: 30_000 },
    );

    const compact = await page.evaluate(
      (query) => window.matchMedia(query).matches,
      COMPACT_MOBILE_MEDIA_QUERY,
    );
    if (compact !== viewport.compact) {
      failures.push(`${viewport.name}: shared layout contract resolved compact=${compact}, expected ${viewport.compact}`);
    }

    const controls = await visibleControls(page);
    const surfaces = await allControlText(page);
    const forbidden = FORBIDDEN_CONTROL_TEXT.filter((text) =>
      surfaces.text.includes(text) || surfaces.labels.includes(text));
    if (forbidden.length > 0) {
      failures.push(`${viewport.name}: guest document offers owner affordances ${JSON.stringify(forbidden)}`);
    }
    if (surfaces.fileInputs !== 0) {
      failures.push(`${viewport.name}: guest document has ${surfaces.fileInputs} file input(s)`);
    }

    // The granted journeys are there. The compact layouts show one journey at
    // a time in the mobile chrome and the rest behind 全部旅程, so the title
    // assertion is per-layout while the globe assertion is not: every rendered
    // route must be inside the granted set at every size.
    const shownTitles = sharedJourneys.filter((journey) => surfaces.text.includes(journey.title));
    if (viewport.compact ? shownTitles.length < 1 : shownTitles.length !== sharedJourneys.length) {
      failures.push(`${viewport.name}: rendered ${shownTitles.length}/${sharedJourneys.length} shared journey titles`);
    }
    if (viewport.compact) {
      // 全部旅程 is a viewing surface, so a guest keeps it; opening it must
      // list the whole granted set and offer no create action.
      const openedPicker = await page.evaluate(() => {
        const trigger = [...document.querySelectorAll("button")]
          .find((button) => button.getAttribute("aria-label") === "打开全部旅程");
        if (!trigger) return false;
        trigger.click();
        return true;
      });
      if (!openedPicker) {
        failures.push(`${viewport.name}: no 全部旅程 entry point for a guest`);
      } else {
        await page.locator(".mobile-v2__picker").waitFor({ timeout: 10_000 });
        const picker = await page.evaluate(() => {
          const root = document.querySelector(".mobile-v2__picker");
          return {
            text: root?.textContent ?? "",
            entries: root?.querySelectorAll("ol li button").length ?? -1,
            create: root?.querySelectorAll(".mobile-v2__picker-create").length ?? -1,
          };
        });
        if (picker.entries !== sharedJourneys.length) {
          failures.push(`${viewport.name}: 全部旅程 lists ${picker.entries} journeys, expected ${sharedJourneys.length}`);
        }
        if (picker.create !== 0) {
          failures.push(`${viewport.name}: 全部旅程 offers a create action to a guest`);
        }
        for (const journey of sharedJourneys) {
          if (!picker.text.includes(journey.title)) {
            failures.push(`${viewport.name}: 全部旅程 omits "${journey.title}"`);
          }
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      }
    }
    const journeyIds = await page.evaluate(() => [...document.querySelectorAll("[data-journey-route]")]
      .map((node) => node.getAttribute("data-journey-route")));
    const outsideScope = journeyIds.filter((id) =>
      id && !sharedJourneys.some((journey) => journey.id === id) && !id.startsWith("draft-"));
    if (outsideScope.length > 0) {
      failures.push(`${viewport.name}: globe rendered routes outside the granted set ${JSON.stringify(outsideScope)}`);
    }
    if (journeyIds.length === 0) {
      failures.push(`${viewport.name}: the globe rendered no granted route at all`);
    }

    // The globe still turns for a guest: rotate it and read the scene's own
    // rotation back rather than trusting that a drag was dispatched.
    const before = await page.evaluate(() => window.__particleEarthDebug?.() ?? null);
    const canvas = page.locator('canvas[data-three-scene="particle-earth"]');
    const bounds = await canvas.boundingBox();
    if (!before || !bounds) {
      failures.push(`${viewport.name}: particle globe is not interactive for a guest`);
    } else {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 120, bounds.y + bounds.height / 2, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => window.__particleEarthDebug?.() ?? null);
      if (!after || Math.abs(after.rotation - before.rotation) < 0.001) {
        failures.push(`${viewport.name}: dragging the globe did not rotate it (${before?.rotation} -> ${after?.rotation})`);
      }
    }

    console.log([
      `[qa-guest-share] ${viewport.name} ${viewport.width}x${viewport.height}`,
      `compact=${compact}`,
      `visibleControls=${controls.length}`,
      `fileInputs=${surfaces.fileInputs}`,
      `forbidden=${forbidden.length}`,
      `routes=${journeyIds.length}`,
    ].join(" "));

    if (consoleErrors.length > 0) {
      failures.push(`${viewport.name}: console errors ${JSON.stringify(consoleErrors.slice(0, 4))}`);
    }
    await page.close();
  }

  // -------------------------------------------------- 2. story and playback
  {
    const state = { journeysStatus: 200, journeys: sharedJourneys, expiresAt: undefined };
    const { page, consoleErrors } = await newGuestPage(context, state);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(shareUrl(), { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 30_000 });
    // The scene lives inside the aria-hidden persistent-earth host, so this
    // reads its readiness attribute rather than asking about visibility.
    await page.waitForFunction(
      () => document.querySelector(".particle-earth-scene")?.getAttribute("data-scene-ready") === "true",
      undefined,
      { timeout: 30_000 },
    );

    // A guest reaches a Journey through the rail, exactly like an owner.
    await page.locator(".living-atlas__journey-rail ol li button").first().click();
    await page.waitForTimeout(300);
    const storyOpened = await page.evaluate(() => {
      const open = [...document.querySelectorAll("button")]
        .find((button) => (button.textContent ?? "").includes("打开故事"));
      if (!open) return false;
      open.click();
      return true;
    });
    if (!storyOpened) {
      failures.push("story: no 打开故事 entry point in the shared viewer");
    } else {
      await storyShowing(page, FAR_END_TITLE);
      const story = await page.evaluate(() => {
        const root = document.querySelector(".journey-story");
        return {
          text: root?.textContent ?? "",
          fileInputs: root?.querySelectorAll('input[type="file"]').length ?? -1,
          mediaAdd: root?.querySelectorAll(".journey-story__media-add").length ?? -1,
          mediaActions: root?.querySelectorAll(".journey-story__media-actions").length ?? -1,
          routePoints: root?.querySelectorAll("[data-route-point-id]").length ?? -1,
          navigation: [...(root?.querySelectorAll(".journey-story__navigation button") ?? [])]
            .map((button) => ({
              label: (button.textContent ?? "").trim(),
              disabled: button.disabled,
            })),
        };
      });
      const storyForbidden = FORBIDDEN_CONTROL_TEXT.filter((text) => story.text.includes(text));
      if (storyForbidden.length > 0) {
        failures.push(`story: read-only dialog offers ${JSON.stringify(storyForbidden)}`);
      }
      if (story.fileInputs !== 0 || story.mediaAdd !== 0 || story.mediaActions !== 0) {
        failures.push(`story: mutation surfaces present ${JSON.stringify(story)}`);
      }
      if (story.routePoints < 2) {
        failures.push(`story: only ${story.routePoints} route points are inspectable`);
      }
      // Scope closure, far end. The rail is `[...journeys].reverse()` over a
      // chronologically sorted list (LivingAtlasApp), so its FIRST entry is the
      // chronologically LAST journey of the granted set: 上一段 leads back into
      // the set and 下一段 has nowhere to go. Asserting the opposite here is
      // what made this lane red — the product was closing the set correctly.
      const previous = story.navigation.find((button) => button.label.includes("上一段"));
      const next = story.navigation.find((button) => button.label.includes("下一段"));
      if (previous?.disabled !== false) {
        failures.push("story: 上一段 is not reachable inside the granted set");
      }
      if (!next?.disabled) {
        failures.push("story: 下一段 leaves the granted set at its last journey");
      }
      console.log([
        "[qa-guest-share] story",
        `routePoints=${story.routePoints}`,
        `fileInputs=${story.fileInputs}`,
        `forbidden=${storyForbidden.length}`,
        `previousDisabled=${previous?.disabled}`,
        `nextDisabled=${next?.disabled}`,
      ].join(" "));
      await page.keyboard.press("Escape");
      // The dialog is conditionally rendered, so a closed story is a detached
      // node. Waiting for that rather than for a fixed delay is what keeps the
      // next block from reading the journey that was already open.
      await page.locator(".journey-story").waitFor({ state: "detached", timeout: 15_000 });

      // Scope closure, near end. Both ends of the granted set have to be shut,
      // and only one of them is visible from a single journey. The rail's last
      // entry is the chronologically first journey, where the pair inverts.
      await page.locator(".living-atlas__journey-rail ol li button").last().click();
      // The rail marks the selected Journey with aria-current, so this waits on
      // the selection itself rather than on a delay.
      await page.locator('.living-atlas__journey-rail ol li:last-child button[aria-current="true"]')
        .waitFor({ timeout: 15_000 });
      const nearOpened = await page.evaluate(() => {
        const open = [...document.querySelectorAll("button")]
          .find((button) => (button.textContent ?? "").includes("打开故事"));
        if (!open) return false;
        open.click();
        return true;
      });
      if (!nearOpened) {
        failures.push("story: no 打开故事 entry point for the first journey of the granted set");
      } else {
        await storyShowing(page, NEAR_END_TITLE);
        const near = await page.evaluate(() =>
          [...(document.querySelectorAll(".journey-story__navigation button") ?? [])]
            .map((button) => ({
              label: (button.textContent ?? "").trim(),
              disabled: button.disabled,
            })));
        const nearPrevious = near.find((button) => button.label.includes("上一段"));
        const nearNext = near.find((button) => button.label.includes("下一段"));
        if (!nearPrevious?.disabled) {
          failures.push("story: 上一段 leaves the granted set at its first journey");
        }
        if (nearNext?.disabled !== false) {
          failures.push("story: 下一段 is not reachable from the first journey of the granted set");
        }
        console.log([
          "[qa-guest-share] story near end",
          `previousDisabled=${nearPrevious?.disabled}`,
          `nextDisabled=${nearNext?.disabled}`,
        ].join(" "));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
      }
    }

    // Playback stays available: it is a viewing capability (#200), and the
    // overlay must mount without any edit affordance.
    // 播放旅程 opens the mode menu; a mode option starts the run.
    const playbackStarted = await page.evaluate(() => {
      const play = [...document.querySelectorAll("button")]
        .find((button) => (button.textContent ?? "").includes("播放旅程"));
      if (!play) return false;
      play.click();
      return true;
    }) && await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const option = document.querySelector('[data-playback-mode-option="full"]');
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    });
    if (!playbackStarted) {
      failures.push("playback: no 播放旅程 entry point in the shared viewer");
    } else {
      await page.locator(".journey-playback").waitFor({ timeout: 20_000 });
      const playback = await page.evaluate(() => {
        const root = document.querySelector(".journey-playback");
        return {
          text: root?.textContent ?? "",
          fileInputs: root?.querySelectorAll('input[type="file"]').length ?? -1,
        };
      });
      const playbackForbidden = FORBIDDEN_CONTROL_TEXT.filter((text) => playback.text.includes(text));
      if (playbackForbidden.length > 0 || playback.fileInputs !== 0) {
        failures.push(`playback: overlay exposes ${JSON.stringify({ playbackForbidden, fileInputs: playback.fileInputs })}`);
      }
      console.log(`[qa-guest-share] playback mounted forbidden=${playbackForbidden.length} fileInputs=${playback.fileInputs}`);
    }

    // The token stays in the fragment and nowhere else, in a document that has
    // now pushed history entries and opened two overlays.
    const tokenExposure = await page.evaluate((token) => ({
      pathname: location.pathname,
      search: location.search,
      hasFragmentToken: location.hash.includes(token),
      pathOrQueryLeak: (location.pathname + location.search).includes(token),
      localStorage: Object.entries(localStorage).some(([key, value]) =>
        key.includes(token) || String(value).includes(token)),
      sessionStorage: Object.entries(sessionStorage).some(([key, value]) =>
        key.includes(token) || String(value).includes(token)),
      historyState: JSON.stringify(history.state ?? null).includes(token),
    }), TOKEN);
    if (
      tokenExposure.pathOrQueryLeak
      || tokenExposure.localStorage
      || tokenExposure.sessionStorage
      || tokenExposure.historyState
      || !tokenExposure.hasFragmentToken
    ) {
      failures.push(`token exposure: ${JSON.stringify(tokenExposure)}`);
    }
    const leakedRequests = requestedUrls.filter((url) => url.includes(TOKEN));
    if (leakedRequests.length > 0) {
      failures.push(`token exposure: ${leakedRequests.length} request URL(s) carried the token`);
    }
    const ownerRequests = requestedUrls.filter((url) =>
      /\/api\/(journeys|atlases|auth)/.test(url) || url.includes("/api/uploads"));
    if (ownerRequests.length > 0) {
      failures.push(`owner routes requested by a guest: ${JSON.stringify([...new Set(ownerRequests)].slice(0, 4))}`);
    }
    console.log([
      "[qa-guest-share] token stays in the fragment",
      `requests=${requestedUrls.length}`,
      `tokenInRequestUrls=${leakedRequests.length}`,
      `ownerRequests=${ownerRequests.length}`,
      `noindex=${await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute("content"))}`,
      `referrer=${await page.evaluate(() => document.querySelector('meta[name="referrer"]')?.getAttribute("content"))}`,
    ].join(" "));

    const documentHeaders = await page.evaluate(() => ({
      robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null,
      referrer: document.querySelector('meta[name="referrer"]')?.getAttribute("content") ?? null,
    }));
    if (documentHeaders.robots !== "noindex, nofollow") {
      failures.push(`shared document is indexable: robots=${documentHeaders.robots}`);
    }
    if (documentHeaders.referrer !== "no-referrer") {
      failures.push(`shared document may leak its URL: referrer=${documentHeaders.referrer}`);
    }

    if (consoleErrors.length > 0) {
      // The stubbed media route answers 404 by design, so a failed asset read
      // is expected; anything else is not.
      const unexpected = consoleErrors.filter((message) =>
        !/read-url/.test(message) && !/404/.test(message));
      if (unexpected.length > 0) {
        failures.push(`story/playback console errors ${JSON.stringify(unexpected.slice(0, 4))}`);
      }
    }
    await page.close();
  }


  // ------------------------------ 2b. #199 media playback under a share grant
  //
  // #200 phase F acceptance: the media-playback affordance #199 added must
  // stay discoverable in a SHARED Story view. It is the one capability that
  // exists nowhere else in the phone viewer, so a guest losing it would be
  // invariant 6 ("low chrome removes redundancy, not capability") failing
  // against a narrower identity rather than against a narrower layout.
  //
  // The control renders from `scopedMedia.length > 1` and the mobile layout,
  // neither of which is capability-gated — but nothing asserted that until
  // now, and the Manage entry that shares its action cluster IS gated, so the
  // two could have been removed together.
  {
    const withMedia = sharedJourneys.map((journey, index) => (index === 0
      ? {
        ...journey,
        media: [
          { id: "cccccccc-1111-4111-8111-111111111111", routePointId: null, fileName: "one.png", mimeType: "image/png", bytes: 128 },
          { id: "cccccccc-2222-4222-8222-222222222222", routePointId: null, fileName: "two.png", mimeType: "image/png", bytes: 128 },
        ],
      }
      : journey));
    const state = { journeysStatus: 200, journeys: withMedia, expiresAt: undefined };
    const { page, consoleErrors } = await newGuestPage(context, state);
    // Registered after `installGuestApi`, so it wins: this page's guest media
    // reads resolve to a decodable one-pixel PNG instead of the 404 the rest
    // of the lane wants. The URL is a data URI, so no image request leaves the
    // page and the token-exposure assertions elsewhere are unaffected.
    await page.route("**/api/shared/assets/*/read-url", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "private, no-store" },
      body: JSON.stringify({
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      }),
    }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shareUrl(), { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector(".particle-earth-scene")?.getAttribute("data-scene-ready") === "true",
      undefined,
      { timeout: 30_000 },
    );

    const mediaJourneyTitle = withMedia[0].title;
    // A compact viewport renders no desktop journey rail — section 1 above
    // measures that same contract — so the guest reaches a Journey through
    // 全部旅程, exactly as a recipient on a phone does.
    const opened = await page.evaluate(async (title) => {
      const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
      const trigger = [...document.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "打开全部旅程");
      if (!trigger) return "no-picker-entry";
      trigger.click();
      await settle();
      const entry = [...document.querySelectorAll(".mobile-v2__picker ol li button")]
        .find((button) => (button.textContent ?? "").includes(title));
      if (!entry) return "no-picker-row";
      entry.click();
      await settle();
      const open = [...document.querySelectorAll("button")]
        .find((button) => (button.textContent ?? "").includes("打开故事"));
      if (!open) {
        const labels = [...document.querySelectorAll("button")]
          .map((button) => (button.getAttribute("aria-label") || button.textContent || "").trim().slice(0, 24))
          .filter(Boolean);
        return `no-story-entry: ${JSON.stringify(labels.slice(0, 12))}`;
      }
      open.click();
      return "opened";
    }, mediaJourneyTitle);
    if (opened !== "opened") {
      failures.push(`guest #199: could not open the shared story (${opened})`);
    } else {
      await storyShowing(page, mediaJourneyTitle);
      const affordance = await page.evaluate(() => {
        const story = document.querySelector(".journey-story");
        const play = document.querySelector(".journey-story__mobile-media-play");
        const box = play?.getBoundingClientRect();
        return {
          mobileMode: story?.getAttribute("data-mobile-mode") ?? null,
          present: Boolean(play),
          disabled: play instanceof HTMLButtonElement ? play.disabled : null,
          pressed: play?.getAttribute("aria-pressed") ?? null,
          label: play?.getAttribute("aria-label") ?? null,
          // #199 put it in the viewer cluster, never inside the management
          // sheet — which a guest has none of, so it must be in the cluster.
          inViewerCluster: Boolean(play?.closest(".journey-story__mobile-media-actions")),
          manageSheets: document.querySelectorAll(".journey-story__mobile-media-sheet").length,
          // A guest still gets no Manage entry sharing that cluster.
          manageTriggers: document.querySelectorAll(".journey-story__mobile-media-menu-trigger").length,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
        };
      });
      if (!affordance.present || affordance.disabled !== false) {
        failures.push(`guest #199: no usable media playback affordance ${JSON.stringify(affordance)}`);
      }
      if (!affordance.inViewerCluster || affordance.manageTriggers !== 0 || affordance.manageSheets !== 0) {
        failures.push(`guest #199: affordance is misplaced or a manage surface leaked ${JSON.stringify(affordance)}`);
      }
      // The 44px touch target #199 established, unchanged by the guest mode.
      if (affordance.width < 44 || affordance.height < 44) {
        failures.push(`guest #199: touch target ${affordance.width}x${affordance.height} is under 44px`);
      }
      // It has to actually drive the sequence, not merely render.
      let toggled = null;
      try {
        await page.locator(".journey-story__mobile-media-play").click();
        await page.waitForFunction(
          () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "true",
          undefined,
          { timeout: 5_000 },
        );
        await page.locator(".journey-story__mobile-media-play").click();
        await page.waitForFunction(
          () => document.querySelector(".journey-story__mobile-media-play")?.getAttribute("aria-pressed") === "false",
          undefined,
          { timeout: 5_000 },
        );
        toggled = true;
      } catch (error) {
        toggled = false;
        failures.push(`guest #199: playback did not toggle under a grant (${error.message})`);
      }
      // #126 Playback and #199 sequence playback are viewing capabilities; the
      // guest Story must still expose no owner affordance around them.
      const storyText = await page.evaluate(() => document.querySelector(".journey-story")?.textContent ?? "");
      const leaked = FORBIDDEN_CONTROL_TEXT.filter((text) => storyText.includes(text));
      if (leaked.length > 0) {
        failures.push(`guest #199: owner affordances beside the play control ${JSON.stringify(leaked)}`);
      }
      console.log([
        "[qa-guest-share] guest #199 media playback",
        `mobileMode=${affordance.mobileMode}`,
        `present=${affordance.present}`,
        `cluster=${affordance.inViewerCluster}`,
        `target=${Math.round(affordance.width)}x${Math.round(affordance.height)}`,
        `toggled=${toggled}`,
        `manageTriggers=${affordance.manageTriggers}`,
      ].join(" "));
    }
    const unexpected = consoleErrors.filter((message) =>
      !/read-url/.test(message) && !/404/.test(message));
    if (unexpected.length > 0) {
      failures.push(`guest #199 console errors ${JSON.stringify(unexpected.slice(0, 4))}`);
    }
    await page.close();
  }

  // ----------------------------------------------------- 3. unavailable states
  {
    // An invalid fragment never makes a request at all.
    const state = { journeysStatus: 200, journeys: sharedJourneys, expiresAt: undefined };
    const { page } = await newGuestPage(context, state);
    await page.goto(shareUrl("not-a-real-token"), { waitUntil: "domcontentloaded" });
    await page.locator('[data-shared-atlas-state="unavailable"]').waitFor({ timeout: 15_000 });
    const text = await page.evaluate(() => document.body.innerText);
    if (!text.includes("这条分享链接已失效")) {
      failures.push(`invalid fragment: unavailable copy missing, got ${JSON.stringify(text.slice(0, 120))}`);
    }
    if (text.includes("SHARE_UNAVAILABLE") || text.includes("404")) {
      failures.push("invalid fragment: internal error code shown to a recipient");
    }
    console.log("[qa-guest-share] invalid fragment shows the polished unavailable state");
    await page.close();
  }

  {
    // The deep-link path. The static handler serves the same document for
    // `/share/`, so a trailing slash must reach the shared viewer and not the
    // owner app — for a signed-in owner that would open their own Atlas at a
    // URL carrying someone else's token.
    const state = { journeysStatus: 200, journeys: sharedJourneys, expiresAt: undefined };
    const { page } = await newGuestPage(context, state);
    await page.goto(new URL(`/share/#${TOKEN}`, baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 30_000 });
    // `.living-atlas` mounts while the guest read is still in flight, so the
    // rail is empty for a frame or two. Wait for the thing being asserted —
    // reading the document straight after the shell appears was a race, not a
    // routing failure.
    await page.waitForFunction(
      (title) => (document.body.innerText ?? "").includes(title),
      sharedJourneys[0].title,
      { timeout: 30_000 },
    );
    const trailing = await page.evaluate(() => ({
      text: document.body.innerText,
      authGate: document.querySelectorAll(".auth-gate").length,
      fileInputs: document.querySelectorAll('input[type="file"]').length,
    }));
    if (trailing.authGate !== 0) {
      failures.push("/share/ fell through to the owner login gate");
    }
    if (!trailing.text.includes(sharedJourneys[0].title) || trailing.fileInputs !== 0) {
      failures.push(`/share/ did not render the read-only viewer: ${JSON.stringify({ fileInputs: trailing.fileInputs })}`);
    }
    const trailingForbidden = FORBIDDEN_CONTROL_TEXT.filter((text) => trailing.text.includes(text));
    if (trailingForbidden.length > 0) {
      failures.push(`/share/ offers owner affordances ${JSON.stringify(trailingForbidden)}`);
    }
    console.log("[qa-guest-share] /share/ resolves to the read-only viewer, not the owner app");
    await page.close();
  }

  {
    // A revoked or expired grant: the guest read answers the generic 404.
    const state = { journeysStatus: 404, journeys: sharedJourneys, expiresAt: undefined };
    const { page } = await newGuestPage(context, state);
    await page.goto(shareUrl(), { waitUntil: "domcontentloaded" });
    await page.locator('[data-shared-atlas-state="unavailable"]').waitFor({ timeout: 15_000 });
    const revoked = await page.evaluate(() => ({
      text: document.body.innerText,
      atlas: document.querySelectorAll(".living-atlas").length,
    }));
    if (!revoked.text.includes("这条分享链接已失效") || !revoked.text.includes("请联系分享者获取新的链接")) {
      failures.push(`revoked grant: unavailable copy missing, got ${JSON.stringify(revoked.text.slice(0, 120))}`);
    }
    if (revoked.atlas !== 0) {
      failures.push("revoked grant: the Atlas shell is still mounted");
    }
    console.log("[qa-guest-share] a dead grant replaces the viewer, it does not blank it");
    await page.close();
  }

  {
    // #200's live-scope case: the owner moved one photo out of a shared
    // journey. The stubbed read-url route answers MEDIA_UNAVAILABLE for every
    // asset, so the whole shared payload's media is withdrawn at once — and
    // the link still works, so the session must survive all of it.
    const journeysWithMedia = sharedJourneys.map((journey, index) => index === 0
      ? {
        ...journey,
        media: [{
          id: "cccccccc-3333-4333-8333-333333333333",
          routePointId: journey.routePoints[0].id,
          fileName: "withdrawn.jpg",
          mimeType: "image/jpeg",
          bytes: 4096,
        }],
      }
      : journey);
    const state = { journeysStatus: 200, journeys: journeysWithMedia, expiresAt: undefined };
    const { page } = await newGuestPage(context, state);
    await page.goto(shareUrl(), { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 30_000 });
    // The scene lives inside the aria-hidden persistent-earth host, so this
    // reads its readiness attribute rather than asking about visibility.
    await page.waitForFunction(
      () => document.querySelector(".particle-earth-scene")?.getAttribute("data-scene-ready") === "true",
      undefined,
      { timeout: 30_000 },
    );
    // Give every read-url attempt time to fail.
    await page.waitForTimeout(900);
    const survived = await page.evaluate(() => ({
      atlas: document.querySelectorAll(".living-atlas").length,
      unavailable: document.querySelectorAll('[data-shared-atlas-state="unavailable"]').length,
      title: document.body.innerText.includes("海风经过深圳湾"),
    }));
    if (survived.atlas !== 1 || survived.unavailable !== 0 || !survived.title) {
      failures.push(`withdrawn media ended the session: ${JSON.stringify(survived)}`);
    }
    console.log("[qa-guest-share] one withdrawn asset does not end a live shared session");
    await page.close();
  }

  {
    // Acceptance 6: the grant dies while the page is open. The payload reports
    // an expiry two seconds out, so the viewer's revalidation fires on a live
    // session — and the server, which is the authority, has meanwhile revoked
    // the link.
    const state = {
      journeysStatus: 200,
      journeys: sharedJourneys,
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    };
    const { page } = await newGuestPage(context, state);
    await page.goto(shareUrl(), { waitUntil: "domcontentloaded" });
    await page.locator(".living-atlas").waitFor({ timeout: 30_000 });
    // Only revoke once the boot read has actually rendered a granted journey.
    // Flipping earlier could 404 the boot read itself and pass this case for
    // the wrong reason.
    await page.waitForFunction(
      (title) => document.body.innerText.includes(title),
      sharedJourneys[0].title,
      { timeout: 20_000 },
    );
    state.journeysStatus = 404;
    // The viewer re-reads at SHARE_EXPIRY_RECHECK_MIN_MS (15 s) at the
    // earliest, so this waits well past that floor rather than racing it.
    await page.locator('[data-shared-atlas-state="unavailable"]').waitFor({ timeout: 45_000 });
    const expired = await page.evaluate(() => ({
      text: document.body.innerText,
      atlas: document.querySelectorAll(".living-atlas").length,
      blank: document.body.innerText.trim().length === 0,
    }));
    if (!expired.text.includes("这条分享链接已失效") || expired.atlas !== 0 || expired.blank) {
      failures.push(`mid-session expiry: ${JSON.stringify(expired)}`);
    }
    console.log("[qa-guest-share] a grant that dies mid-session ends the viewer with the polished state");
    await page.close();
  }

} finally {
  await context.close();
  await browser.close();
}

if (failures.length > 0) {
  throw new Error(`[qa-guest-share] ${failures.join("; ")}`);
}
console.log("[qa-guest-share] the shared viewer is read-only at every QA viewport and the token never leaves the fragment");
