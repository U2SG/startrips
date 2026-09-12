// #232 - the Home Base suggestion must be a quiet card beside the Atlas
// timeline: non-modal, absent while Journey Story or Journey Playback owns the
// screen, and gone for good once the member answers 「暂时不用」.
//
// The persistence half is real here rather than mocked away: the stub holds the
// recorded answer for the whole run, so the reload check below reads the same
// answer a database would have kept. A dismissal that only survived component
// state would still pass an in-page check and fail this one.
import { mkdirSync } from "node:fs";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const captureDir = "artifacts/home-base-suggestion";
mkdirSync(captureDir, { recursive: true });

const SHENZHEN = { latitude: 22.5431, longitude: 114.0579 };

function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * Four distinct Journeys, every one starting and ending around the same metro,
 * spanning well over the V1 90-day window. That is exactly the owner's
 * `suggested` gate: 4 Journeys, >= 90 days, >= 2 starts, >= 2 ends, and no
 * runner-up region at all. The dates are relative to the run so the fixture
 * never expires.
 */
function journeyFixture(index, daysAgo) {
  const startedOn = isoDaysAgo(daysAgo);
  const id = `qa-home-base-journey-${index}`;
  return {
    id,
    atlasId: "qa-atlas",
    title: `深圳往返 ${index}`,
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
        id: `${id}-start`,
        journeyId: id,
        sortOrder: 0,
        latitude: SHENZHEN.latitude,
        longitude: SHENZHEN.longitude,
        label: "深圳",
        isStop: true,
        occurredAt: `${startedOn}T08:00:00.000Z`,
        note: null,
        createdAt: `${startedOn}T08:00:00.000Z`,
      },
      {
        id: `${id}-end`,
        journeyId: id,
        sortOrder: 1,
        latitude: SHENZHEN.latitude,
        longitude: SHENZHEN.longitude,
        label: "深圳",
        isStop: true,
        occurredAt: `${startedOn}T20:00:00.000Z`,
        note: null,
        createdAt: `${startedOn}T20:00:00.000Z`,
      },
    ],
    media: [],
  };
}

const journeys = [
  journeyFixture(1, 300),
  journeyFixture(2, 220),
  journeyFixture(3, 150),
  journeyFixture(4, 40),
];

const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
let failed = false;

function record(name, data, condition) {
  const entry = { name, ...data, failed: !condition };
  checks.push(entry);
  if (entry.failed) failed = true;
}

/** The recorded answer, held for the whole run so a reload can see it. */
let storedDismissal = null;
let dismissalWrites = 0;

async function stubAtlasApi(page) {
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ journeys }),
  }));
  // The dismissal routes come first: `**/api/home-bases` would otherwise also
  // match the dismissal path.
  await page.route("**/api/home-bases/dismissal", async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      dismissalWrites += 1;
      storedDismissal = {
        kind: body.kind,
        digest: body.evidenceDigest,
        dismissedAt: body.dismissedOn,
      };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ dismissal: storedDismissal }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dismissal: storedDismissal }),
    });
  });
  await page.route("**/api/home-bases", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ periods: [] }),
  }));
}

async function openAtlas() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await stubAtlasApi(page);
  await page.goto(
    `${origin}/?qaState=living-atlas&qaLite=1&qaHomeBaseSuggestion=1`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 20_000 });
  return { page, pageErrors };
}

async function openTimelineView(page) {
  await page.locator(".living-atlas__header button", { hasText: "时间线" }).click();
  await page.locator(".journey-timeline").waitFor({ state: "visible", timeout: 10_000 });
}

const card = "[data-home-base-suggestion]";

try {
  const run = await openAtlas();
  const { page } = run;
  await openTimelineView(page);

  const suggestion = page.locator(card);
  await suggestion.waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: `${captureDir}/01-card-beside-timeline.png`, fullPage: false });

  const placement = await page.evaluate(() => {
    const node = document.querySelector("[data-home-base-suggestion]");
    const timeline = document.querySelector(".journey-timeline");
    if (!node || !timeline) return null;
    const cardRect = node.getBoundingClientRect();
    const timelineRect = timeline.getBoundingClientRect();
    return {
      variant: node.getAttribute("data-home-base-suggestion"),
      placeLabel: node.getAttribute("data-home-base-place-label"),
      text: node.textContent ?? "",
      sharesParent: node.parentElement === timeline.parentElement,
      // "Beside the Atlas timeline" is checked geometrically: the card sits
      // inside the region the timeline occupies, not in some unrelated corner.
      insideTimelineRegion: cardRect.top >= timelineRect.top
        && cardRect.bottom <= timelineRect.bottom + 1
        && cardRect.left >= timelineRect.left
        && cardRect.right <= timelineRect.right,
      // And it covers only the foot of it, so the rail above stays readable.
      coveredFraction: (cardRect.height * cardRect.width)
        / (timelineRect.height * timelineRect.width),
      cardRect: { top: cardRect.top, bottom: cardRect.bottom, width: cardRect.width },
      timelineRect: { top: timelineRect.top, bottom: timelineRect.bottom },
      timelineVisible: timelineRect.width > 0 && timelineRect.height > 0,
      actions: [...node.querySelectorAll("[data-home-base-suggestion-action]")]
        .map((button) => ({
          kind: button.getAttribute("data-home-base-suggestion-action"),
          label: button.textContent,
          height: button.getBoundingClientRect().height,
        })),
    };
  });
  record("card renders beside the Atlas timeline with the issue's evidence copy", { placement }, Boolean(
    placement
    && placement.variant === "initial"
    && placement.placeLabel === "深圳"
    && placement.sharesParent
    && placement.timelineVisible
    && placement.insideTimelineRegion
    && placement.coveredFraction < 0.3
    && placement.text.includes("看起来深圳是你这一阶段经常出发和回来的地方。")
    && placement.text.includes("最近几段旅程经常从深圳附近开始或结束。")
    && !placement.text.includes("我们检测到")
    && placement.actions.length === 3
    && placement.actions.every((action) => action.height >= 44)
    && placement.actions.map((action) => action.kind).join(",")
      === "confirm,dismiss_soft,dismiss_rejected",
  ));

  const nonModal = await page.evaluate(() => {
    const node = document.querySelector("[data-home-base-suggestion]");
    const hit = document.querySelector(".journey-timeline__hit-area");
    if (!node || !hit) return null;
    const rect = hit.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    );
    const main = document.querySelector(".living-atlas");
    return {
      role: node.getAttribute("role"),
      ariaModal: node.getAttribute("aria-modal"),
      timelineInert: document.querySelector(".journey-timeline")?.closest("[inert]") !== null,
      dialogCount: document.querySelectorAll("[role=\"dialog\"], [aria-modal=\"true\"]").length,
      atlasInert: main?.hasAttribute("inert") ?? true,
      // Whatever is on top at the first Journey card's centre must be that
      // card, not the suggestion and not a backdrop over it.
      topmostIsTimeline: Boolean(topmost && topmost.closest(".journey-timeline")),
    };
  });
  record("card is non-modal and leaves the Atlas interactive behind it", { nonModal }, Boolean(
    nonModal
    && nonModal.role === null
    && nonModal.ariaModal === null
    && nonModal.dialogCount === 0
    && nonModal.atlasInert === false
    && nonModal.timelineInert === false
    && nonModal.topmostIsTimeline,
  ));

  // Clicking straight through to Journey Story proves the Atlas really is
  // interactive, and gives the Story suppression its own observation.
  await page.locator(".journey-timeline__hit-area").first().click();
  await page.locator(".journey-story").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(120);
  const duringStory = await page.locator(card).count();
  await page.screenshot({ path: `${captureDir}/02-absent-during-story.png` });
  record("no suggestion while Journey Story is open", { duringStory }, duringStory === 0);

  await page.keyboard.press("Escape");
  await page.locator(".journey-story").waitFor({ state: "detached", timeout: 15_000 });
  await openTimelineView(page);
  await page.locator(card).waitFor({ state: "visible", timeout: 15_000 });
  record("suggestion returns once the narrative surface closes", {}, true);

  // Journey Playback is started from the planet view's active Journey.
  await page.getByRole("button", { name: "地球", exact: true }).click();
  await page.locator(".living-atlas__active-play").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".living-atlas__active-play").click();
  await page.locator(".living-atlas__playback-mode-menu button", { hasText: "完整播放" })
    .first()
    .click();
  await page.locator(".journey-playback").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(200);
  const duringPlayback = await page.evaluate(() => ({
    cards: document.querySelectorAll("[data-home-base-suggestion]").length,
    playbackOpen: Boolean(document.querySelector(".journey-playback")),
  }));
  await page.screenshot({ path: `${captureDir}/03-absent-during-playback.png` });
  record("no suggestion while Journey Playback is open", { duringPlayback },
    duringPlayback.playbackOpen && duringPlayback.cards === 0);

  await page.keyboard.press("Escape");
  await page.locator(".journey-playback").waitFor({ state: "detached", timeout: 20_000 });
  await openTimelineView(page);
  await page.locator(card).waitFor({ state: "visible", timeout: 15_000 });

  // The member answers 「暂时不用」.
  await page.locator("[data-home-base-suggestion-action=\"dismiss_soft\"]").click();
  await page.locator(card).waitFor({ state: "detached", timeout: 15_000 });
  await page.screenshot({ path: `${captureDir}/04-dismissed.png` });
  record("dismissing removes the card and records one persisted answer",
    { dismissalWrites, storedDismissal },
    dismissalWrites === 1
    && storedDismissal?.kind === "soft"
    && typeof storedDismissal?.digest === "string"
    && storedDismissal.digest.length > 0);

  // A reload is the whole point: the answer has to come back from the server.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 20_000 });
  await openTimelineView(page);
  await page.waitForTimeout(600);
  const afterReload = await page.evaluate(() => ({
    cards: document.querySelectorAll("[data-home-base-suggestion]").length,
    timelineVisible: Boolean(document.querySelector(".journey-timeline")),
  }));
  await page.screenshot({ path: `${captureDir}/05-still-absent-after-reload.png` });
  record("the dismissal survives a reload", { afterReload, dismissalWrites },
    afterReload.timelineVisible && afterReload.cards === 0 && dismissalWrites === 1);

  record("page errors", { pageErrors: run.pageErrors }, run.pageErrors.length === 0);
  await page.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ checks }, null, 2));
if (failed) process.exit(1);
