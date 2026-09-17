import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const browser = await launchQaBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
let failure = null;
let journeyMutationCount = 0;
let uploadMutationCount = 0;

const journeyId = "qa-preview-journey";
const journey = {
  id: journeyId,
  atlasId: "qa-atlas",
  title: "Persisted preview source",
  startedOn: "2026-09-10",
  endedOn: "2026-09-12",
  note: "Persisted Journey note",
  lightColor: "#77c8c2",
  lightEffect: null,
  coverMediaAssetId: null,
  revision: 4,
  createdByUserId: "qa-user",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  routePoints: Array.from({ length: 8 }, (_, index) => ({
    id: `qa-preview-point-${index}`,
    journeyId,
    sortOrder: index,
    latitude: index === 1 || index === 5 ? 22.543096 : 22.2 + index * 0.09,
    longitude: index === 1 || index === 5 ? 114.057865 : 113.8 + index * 0.11,
    label: `Preview point ${index + 1}`,
    isStop: index % 2 === 0,
    occurredAt: `2026-09-${String(10 + Math.min(index, 2)).padStart(2, "0")}T0${index}:00:00.000Z`,
    note: index === 2 ? "Persisted point note" : null,
    createdAt: "2026-09-10T00:00:00.000Z",
  })),
  media: [],
};

function fail(message, detail = null) {
  throw new Error(detail === null ? message : `${message}: ${JSON.stringify(detail)}`);
}

try {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "GET" && url.pathname.startsWith("/api/journeys")) journeyMutationCount += 1;
    if (request.method() !== "GET" && url.pathname.startsWith("/api/uploads")) uploadMutationCount += 1;
  });
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys: [journey] }),
  }));
  await page.route(`**/api/journeys/${journeyId}`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ journey }) });
    }
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "QA_SAVE_FAILURE", message: "QA save failure" }),
    });
  });

  await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas__active-hit-area").waitFor({ state: "visible" });
  await page.locator(".living-atlas__active-hit-area").click();
  await page.locator(".journey-story").waitFor({ state: "visible" });
  await page.locator(".journey-story").getByRole("button", { name: "编辑故事", exact: true }).click();
  await page.getByRole("button", { name: "编辑旅程" }).click();
  await page.locator(".journey-composer").waitFor({ state: "visible" });

  await page.locator(".journey-title-field input").fill("Unsaved preview title");
  await page.locator(".journey-story-fields textarea").fill("Unsaved Journey note for Playback Preview");
  await page.locator('.journey-light-color-list button[aria-label$="#8ca8df"]').click();

  const targetRow = page.locator('[data-route-point-draft-id="saved-qa-preview-point-2"]');
  await targetRow.locator(".journey-route-draft__summary").click();
  const pointNote = targetRow.locator("textarea");
  await pointNote.fill("Unsaved Route Point note");
  const pointLabel = targetRow.locator('input[type="text"]').first();
  if (await pointLabel.count()) await pointLabel.fill("Unsaved Route Point label");

  const moveDown = targetRow.getByRole("button", { name: /向后移动/ });
  await moveDown.click();
  await page.waitForFunction(() => (
    document.querySelector('[data-route-point-draft-id="saved-qa-preview-point-2"]')?.getAttribute("data-route-point-position") === "4"
  ));

  await page.locator('.journey-media-picker input[type="file"]').setInputFiles({
    name: "local-pending.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });

  await page.locator(".journey-composer__route").evaluate((element) => { element.scrollTop = 180; });
  await pointNote.focus();
  const before = await page.evaluate(() => {
    const route = document.querySelector(".journey-composer__route");
    const target = document.querySelector('[data-route-point-draft-id="saved-qa-preview-point-2"] textarea');
    return {
      scrollTop: route?.scrollTop ?? -1,
      focusMatches: document.activeElement === target,
      order: [...document.querySelectorAll(".journey-route-draft > li[data-route-point-draft-id]")].map((element) => element.getAttribute("data-route-point-draft-id")),
    };
  });
  if (!before.focusMatches) fail("route-point editing focus was not established", before);

  await page.locator("[data-playback-preview-trigger]").click();
  await page.locator(".journey-playback").waitFor({ state: "visible" });
  await page.locator(".journey-playback__intro h2").filter({ hasText: "Unsaved preview title" }).waitFor({ state: "visible" });
  const activePreview = await page.evaluate(() => {
    const composer = document.querySelector(".journey-composer");
    const backdrop = document.querySelector(".journey-composer-backdrop");
    const overlay = document.querySelector(".journey-playback");
    return {
      composerVisibility: composer ? getComputedStyle(composer).visibility : null,
      composerInert: composer instanceof HTMLElement ? composer.inert : null,
      previewClass: backdrop?.classList.contains("is-playback-previewing") ?? false,
      overlayMode: overlay?.getAttribute("data-playback-mode"),
      status: document.querySelector(".journey-playback__status")?.textContent?.trim() ?? "",
      focusColor: document.querySelector("[data-qa-app-route-preview]")?.getAttribute("data-focus-color") ?? "",
      // The backdrop owns the `visibility` declaration; the Composer only
      // inherits it. Report both, plus the containment relation, so a failure
      // says whether the rule missed or the wrong element was measured.
      backdropVisibility: backdrop ? getComputedStyle(backdrop).visibility : null,
      composerCount: document.querySelectorAll(".journey-composer").length,
      composerParent: composer?.parentElement?.className ?? null,
      composerInBackdrop: backdrop?.contains(composer) ?? null,
    };
  });
  if (
    activePreview.composerVisibility !== "hidden"
    || activePreview.composerInert !== true
    || !activePreview.previewClass
    || activePreview.overlayMode !== "full"
    || activePreview.focusColor.toLowerCase() !== "#8ca8df"
    || !activePreview.status.includes("1 个本地未上传媒体未包含")
    || journeyMutationCount !== 0
    || uploadMutationCount !== 0
  ) fail("active draft Playback Preview contract failed", { activePreview, journeyMutationCount, uploadMutationCount });

  await page.getByRole("button", { name: "退出播放" }).click();
  await page.locator(".journey-playback").waitFor({ state: "detached" });
  await page.locator(".journey-composer").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.matches('[data-route-point-draft-id="saved-qa-preview-point-2"] textarea') ?? false);
  const returned = await page.evaluate(() => {
    const route = document.querySelector(".journey-composer__route");
    const target = document.querySelector('[data-route-point-draft-id="saved-qa-preview-point-2"]');
    return {
      title: document.querySelector(".journey-title-field input")?.value ?? "",
      journeyNote: document.querySelector(".journey-story-fields textarea")?.value ?? "",
      pointNote: target?.querySelector("textarea")?.value ?? "",
      position: target?.getAttribute("data-route-point-position"),
      expanded: target?.getAttribute("data-route-point-expanded"),
      scrollTop: route?.scrollTop ?? -1,
      focusMatches: document.activeElement === target?.querySelector("textarea"),
      composerVisibility: getComputedStyle(document.querySelector(".journey-composer")).visibility,
    };
  });
  if (
    returned.title !== "Unsaved preview title"
    || returned.journeyNote !== "Unsaved Journey note for Playback Preview"
    || returned.pointNote !== "Unsaved Route Point note"
    || returned.position !== "4"
    || returned.expanded !== "true"
    || !returned.focusMatches
    || returned.composerVisibility !== "visible"
    || Math.abs(returned.scrollTop - before.scrollTop) > 2
  ) fail("Composer return context changed after Playback Preview", { before, returned });

  // A user-initiated failed save leaves the draft in place. Previewing again
  // must not retry persistence or upload the pending local File behind the user's back.
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByRole("alert").waitFor({ state: "visible" });
  if (journeyMutationCount !== 1 || uploadMutationCount !== 0) {
    fail("save-failure setup did not remain isolated", { journeyMutationCount, uploadMutationCount });
  }
  await pointNote.focus();
  await page.locator("[data-playback-preview-trigger]").click();
  await page.locator(".journey-playback").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "退出播放" }).click();
  await page.locator(".journey-playback").waitFor({ state: "detached" });
  await page.locator(".journey-composer").waitFor({ state: "visible" });
  if (journeyMutationCount !== 1 || uploadMutationCount !== 0) {
    fail("repeat preview caused persistence side effects", { journeyMutationCount, uploadMutationCount });
  }

  console.log(JSON.stringify({
    ok: true,
    before,
    returned,
    journeyMutationCount,
    uploadMutationCount,
  }, null, 2));
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();
}

if (failure) process.exitCode = 1;
