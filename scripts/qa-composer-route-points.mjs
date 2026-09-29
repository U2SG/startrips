import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const results = [];
let failed = false;
let fatalError = null;

function locationSearchPayload({ id, label, context = "QA provider", latitude = 22.543096, longitude = 114.057865 }) {
  return JSON.stringify({
    results: [{
      id,
      label,
      labelEnglish: label,
      context,
      countryCode: "QA",
      latitude,
      longitude,
    }],
    attribution: { label: "QA locations", url: "https://example.test/locations" },
  });
}
function record(name, data, condition) {
  const row = { name, ...data, failed: !condition };
  results.push(row);
  console.log(JSON.stringify(row));
  if (!condition) failed = true;
}

async function openComposer(browser, { width, height, reducedMotion = "no-preference" }) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const url = new URL("/?qaState=journey-composer&qaMode=route-points", baseUrl).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator(".journey-composer");
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  const rows = page.locator(".journey-route-draft > li:not(.is-empty)");
  await rows.first().waitFor({ state: "visible", timeout: 10_000 });
  if (await rows.count() !== 12) throw new Error(`expected 12 route rows, got ${await rows.count()}`);
  return { context, page, composer, rows, pageErrors };
}

async function snapshotRows(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".journey-route-draft > li:not(.is-empty)")];
    return rows.map((row) => {
      const summary = row.querySelector(".journey-route-draft__summary");
      const actionButtons = [...row.querySelectorAll(".journey-route-draft__actions button")];
      const actionTargets = actionButtons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label"),
          disabled: button.disabled,
          width: rect.width,
          height: rect.height,
        };
      });
      return {
        draftId: row.getAttribute("data-route-point-draft-id"),
        position: Number(row.getAttribute("data-route-point-position")),
        expanded: row.getAttribute("data-route-point-expanded") === "true",
        label: summary?.querySelector("strong")?.textContent?.trim() ?? "",
        meta: summary?.querySelector("small")?.textContent?.trim() ?? "",
        summaryHeight: summary?.getBoundingClientRect().height ?? 0,
        actionTargets,
      };
    });
  });
}

function hasStableTargets(rows) {
  return rows.every((row) => row.summaryHeight >= 44
    && row.actionTargets.length === 1
    && row.actionTargets.every((target) => target.width >= 44 && target.height >= 44));
}

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const viewports = [
  { label: "320", width: 320, height: 720 },
  { label: "360", width: 360, height: 780 },
  { label: "390", width: 390, height: 844 },
  { label: "430", width: 430, height: 860 },
  { label: "compact-landscape", width: 568, height: 320 },
];

async function verifyImportedJourney({ label, width, height, editing }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: !editing, isMobile: !editing, reducedMotion: "reduce" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const mutations = [];
  const days = Array.from({ length: 8 }, (_, index) => ({
    dayNumber: index + 1, sourceDayTitle: `Day ${index + 1}`,
    calendarDate: `2026-10-${String(index + 1).padStart(2, "0")}`, partialDate: null, regionContext: "Synthetic Coast",
  }));
  const entries = days.flatMap((day, dayIndex) => ["Hub", "Cafe", "Coast House"].map((kind, order) => ({
    sourceEntryId: `source-${dayIndex}-${order}`, dayNumber: day.dayNumber, orderInDay: order + 1,
    name: kind === "Coast House" ? kind : `${kind} ${day.dayNumber}`,
    role: order === 2 ? "accommodation" : "attraction", aliases: [],
    countryCode: "QA", searchArea: "Synthetic Coast", regionContext: "Synthetic Coast",
  })));
  const recognition = { contractVersion: 1, recognizerVersion: "synthetic/1", sourceTitle: "Eight day coast route",
    sourceReportedDayCount: 8, sourceReportedPlaceCount: 24, days, entries,
  };
  const decisions = entries.map((entry, index) => ({ index,
    candidateId: `map-${entry.name}`, correctedQuery: null,
    isStop: index % 3 === 0, stayAnchorIndex: index % 3 === 0 ? null : Math.floor(index / 3) * 3,
    regionContext: "Synthetic Coast",
  }));
  // A late response tries to replace a human role/owner. The exact human span
  // wins even when the model also tries to demote the chosen target.
  decisions[0] = { ...decisions[0], isStop: false, stayAnchorIndex: 3 };
  decisions[1] = { ...decisions[1], isStop: true, stayAnchorIndex: null };
  decisions[2] = { ...decisions[2], stayAnchorIndex: 3 };
  let markReviewStarted;
  const reviewStarted = new Promise((resolve) => { markReviewStarted = resolve; });
  let releaseReview;
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
  let recognitionCalls = 0;
  let reviewCalls = 0;
  let savedJourney = null;
  let markReadStarted, releaseReading, markReadSettled, markReadAborted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseReading = resolve; });
  const readSettled = new Promise((resolve) => { markReadSettled = resolve; });
  const readAborted = new Promise((resolve) => { markReadAborted = resolve; });
  let readingWasAborted = false;
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/api/itinerary-import") {
      readingWasAborted = true;
      markReadAborted(request.failure()?.errorText);
    }
  });
  try {
    await page.route("**/api/itinerary-import/capabilities", (route) => route.fulfill({ status: 200,
      contentType: "application/json", body: JSON.stringify({ recognition: { configured: true, recognizerVersion: "synthetic/1", timeoutMs: 1_000 },
        linkFetch: { configured: true, driver: "synthetic", timeoutMs: 1_000 },
      }),
    }));
    await page.route("**/api/itinerary-import", async (route) => {
      recognitionCalls += 1;
      const held = !editing && recognitionCalls === 1;
      if (held) { markReadStarted(); await readGate; }
      try {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recognition,
          sourceRead: { readVia: "synthetic-text", contentType: "text/plain" },
        }) });
      } catch (error) {
        if (!held || !readingWasAborted) throw error;
      } finally {
        if (held) markReadSettled();
      }
    });
    await page.route("**/api/itinerary-import/review", async (route) => {
      reviewCalls += 1;
      const plan = route.request().postDataJSON().plan;
      markReviewStarted(plan);
      await reviewGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decisions }) });
    });
    await page.route("**/api/locations/search?*", (route) => {
      const name = new URL(route.request().url()).searchParams.get("q");
      const index = entries.findIndex((entry) => entry.name === name);
      return route.fulfill({ status: 200, contentType: "application/json", body: locationSearchPayload({
        id: `map-${name}`, label: name, context: "Synthetic Coast",
        latitude: name === "Human cafe" ? 23.123456 : 20 + Math.max(index, 0) / 100,
        longitude: name === "Human cafe" ? 112.123456 : 110 + Math.max(index, 0) / 100,
      }) });
    });
    await page.route("**/api/journeys{,/**}", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ journey: savedJourney, journeys: savedJourney ? [savedJourney] : [] }) });
        return;
      }
      const input = request.postDataJSON();
      mutations.push({ method: request.method(), input });
      const id = "00000000-0000-4000-8000-000000000001";
      savedJourney = { ...input, id, atlasId: "00000000-0000-4000-8000-000000000002",
        revision: editing ? 2 : 1, coverMediaAssetId: null, createdByUserId: "00000000-0000-4000-8000-000000000003",
        createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
        routePoints: input.routePoints.map((point, index) => ({ ...point, id: point.id,
          journeyId: id, sortOrder: index, createdAt: "2026-10-08T00:00:00.000Z",
        })),
        media: editing ? [0, 1, 2].map((index) => ({ id: `00000000-0000-4000-8000-00000000010${index}`,
          journeyId: id, routePointId: `00000000-0000-4000-8000-${String([22, 21, 26][index]).padStart(12, "0")}`,
          storageDriver: "qa", storageKey: `qa/story-seed-${index}`, fileName: `seed-${index}.png`,
          mimeType: "image/png", bytes: 68, sortOrder: index,
          uploadedByUserId: "00000000-0000-4000-8000-000000000003", createdAt: "2026-08-11T00:00:00.000Z",
        })) : [],
      };
      await route.fulfill({ status: request.method() === "POST" ? 201 : 200, contentType: "application/json", body: JSON.stringify({ journey: savedJourney }) });
    });

    await page.goto(new URL(`/?qaState=journey-composer${editing ? "&qaMode=route-points" : ""}`, baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.locator(".journey-composer").waitFor({ state: "visible" });
    const existingIds = await page.locator("[data-route-point-draft-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-route-point-draft-id")));
    await page.getByLabel("旅程标题", { exact: true }).fill("Human trip title");
    await page.locator('[data-composer-task-entry="journey-info"]').click();
    await page.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
    await page.getByLabel(/结束日期/).fill("2026-10-08");
    await page.locator(".journey-story-fields textarea").fill("Human Journey note");
    await page.locator("[data-composer-task-back]").click();
    await page.locator(".journey-composer__import-shortcut").click();
    await page.locator(".journey-itinerary-import__modes").getByRole("button", { name: "粘贴文本" }).click();
    await page.locator(".journey-itinerary-import__field textarea").fill("Synthetic eight day coast itinerary");
    if (!editing) {
      await page.locator(".journey-itinerary-import__field").getByRole("button", { name: "自动整理", exact: true }).click();
      await readStarted;
      await page.locator(".journey-itinerary-import__busy").waitFor({ state: "visible" });
      await page.getByRole("button", { name: "停止整理", exact: true }).click();
      const abortReason = await readAborted;
      releaseReading();
      await readSettled;
      await page.locator(".journey-itinerary-import__busy").waitFor({ state: "detached" });
      record("composer-import:mobile:cancel-late-reading-no-empty-journey", { abortReason, mutationCount: mutations.length },
        readingWasAborted && Boolean(abortReason) && mutations.length === 0
        && await page.locator(".journey-itinerary-import__result-heading").count() === 0
        && await page.locator(".journey-itinerary-import__field textarea").inputValue() === "Synthetic eight day coast itinerary");
    }
    await page.locator(".journey-itinerary-import__field").getByRole("button", { name: "自动整理", exact: true }).click();
    const reviewedPlan = await reviewStarted;
    const child = page.locator(".journey-itinerary-import__entry").nth(1);
    await child.locator(".journey-itinerary-import__entry-details > summary").click();
    await child.getByRole("button", { name: "途径点", exact: true }).click();
    await child.getByRole("button", { name: "上一停靠 · Hub 1", exact: true }).click();
    await child.getByRole("button", { name: "查找位置", exact: true }).click();
    await child.locator(".journey-itinerary-import__search input").fill("Human cafe");
    await child.locator(".journey-itinerary-import__search").getByRole("button", { name: "搜索", exact: true }).click();
    await child.locator(".journey-itinerary-import__candidates button").filter({ hasText: "Human cafe" }).click();
    await child.locator(".journey-itinerary-import__entry-details > summary").evaluate((summary) => {
      if (document.activeElement !== summary) throw new Error("Confirmed position did not return focus to its entry");
    });
    const region = child.getByLabel("所在区域", { exact: true });
    await region.fill("Human region");
    await region.focus();
    releaseReview();
    await page.locator(".journey-itinerary-import__busy").waitFor({ state: "detached" });
    const organization = { via: await child.getByRole("button", { name: "途径点", exact: true }).getAttribute("aria-pressed"),
      owner: await child.getByRole("button", { name: "上一停靠 · Hub 1", exact: true }).getAttribute("aria-pressed"),
      region: await region.inputValue(), focused: await region.evaluate((element) => document.activeElement === element),
    };
    const overview = await page.evaluate(() => ({
      dayCount: document.querySelectorAll(".journey-itinerary-import__day").length,
      openDays: document.querySelectorAll(".journey-itinerary-import__day[open]").length,
      pending: document.querySelector(".journey-itinerary-import__result-heading em")?.textContent ?? null,
      sourceControls: document.querySelectorAll(".journey-itinerary-import__modes").length,
      confirmButtons: [...document.querySelectorAll(".journey-itinerary-import button")].filter((button) => /确认.*(建议|停留|归属)/.test(button.textContent)).length,
      touchTargets: [...document.querySelectorAll(".journey-itinerary-import__organization button")].filter((button) => button.getClientRects().length)
        .map((button) => { const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height }; }),
    }));
    record(`composer-import:${label}:automatic-human-edit-lifetime`, { organization, overview, reviewedCount: reviewedPlan.entries.length },
      organization.via === "true" && organization.owner === "true" && organization.region === "Human region" && organization.focused
      && overview.dayCount === 8 && overview.openDays === 1 && overview.pending === null && overview.sourceControls === 0
      && overview.confirmButtons === 0 && overview.touchTargets.length > 0
      && overview.touchTargets.every((rect) => rect.width >= 44 && rect.height >= 44)
      && reviewedPlan.entries.length === 24 && mutations.length === 0);
    await mkdir("artifacts/composer-route-points", { recursive: true });
    await child.locator(".journey-itinerary-import__entry-details > summary").click();
    await page.screenshot({ path: `artifacts/composer-route-points/import-${label}.png` });
    await page.getByRole("button", { name: "添加 24 个地点到路线", exact: true }).click();
    await page.locator('[data-composer-task="primary"]').waitFor({ state: "visible" });
    const importedIds = await page.locator('[data-route-point-draft-id^="imported-"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-route-point-draft-id")));
    record(`composer-import:${label}:editable-route-and-metadata`, { importedCount: importedIds.length, existingCount: existingIds.length },
      importedIds.length === 24 && await page.getByLabel("旅程标题", { exact: true }).inputValue() === "Human trip title"
      && await page.locator("[data-route-point-draft-id]").count() === existingIds.length + 24 && mutations.length === 0);
    await page.screenshot({ path: `artifacts/composer-route-points/edit-${label}.png` });
    // Re-read and re-apply the same source through its ordinary entry. New
    // temporary UUIDs/model defaults must not replace the imported human rows.
    await page.locator(".journey-composer__import-shortcut").click();
    await page.locator(".journey-itinerary-import__modes").getByRole("button", { name: "粘贴文本" }).click();
    await page.locator(".journey-itinerary-import__field textarea").fill("Synthetic eight day coast itinerary");
    await page.locator(".journey-itinerary-import__field").getByRole("button", { name: "自动整理", exact: true }).click();
    await page.getByRole("button", { name: "添加 24 个地点到路线", exact: true }).click();
    await page.locator('[data-composer-task="primary"]').waitFor({ state: "visible" });
    const replayIds = await page.locator('[data-route-point-draft-id^="imported-"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-route-point-draft-id")));
    record(`composer-import:${label}:replay-keeps-human-rows`, { importedIds, replayIds },
      JSON.stringify(replayIds) === JSON.stringify(importedIds) && mutations.length === 0);
    await page.getByRole("button", { name: editing ? "保存修改" : "保存到星球", exact: true }).click();
    await page.locator("[data-qa-composer-projection]").waitFor({ state: "attached" });
    const input = mutations[0]?.input;
    const imported = input?.routePoints.slice(existingIds.length) ?? [];
    record(`composer-import:${label}:authorized-save-response`, { method: mutations[0]?.method,
      mutationCount: mutations.length, recognitionCalls, reviewCalls, imported, existingPointIds: input?.routePoints.slice(0, existingIds.length).map((point) => point.id),
      mediaOwners: savedJourney?.media.map((media) => media.routePointId),
    }, mutations.length === 1 && mutations[0].method === (editing ? "PATCH" : "POST") && recognitionCalls === (editing ? 2 : 3) && reviewCalls === 2
      && input.title === "Human trip title" && input.note === "Human Journey note" && input.startedOn === "2026-10-01" && input.endedOn === "2026-10-08"
      && (!editing || input.revision === 1) && imported.length === 24 && new Set(imported.map((point) => point.id)).size === 24
      && existingIds.every((draftId, index) => input.routePoints[index].id === draftId.slice("saved-".length))
      && (!editing || input.routePoints[2].note === "Record 03 keeps its note while moving.")
      && imported[1].isStop === false && imported[1].stayAnchorRoutePointId === imported[0].id
      && imported[1].regionContext === "Human region" && imported[1].latitude === 23.123456 && imported[1].longitude === 112.123456
      && imported[2].label === imported[5].label && imported[2].id !== imported[5].id && imported[2].occurredAt !== imported[5].occurredAt
      && savedJourney.media.length === (editing ? 3 : 0) && pageErrors.length === 0);
    await page.getByRole("button", { name: "关闭旅程编辑器", exact: true }).click();
    await page.locator(".journey-composer").waitFor({ state: "detached" });
    await page.locator("[data-qa-composer-reopen]").click();
    await page.locator(".journey-composer").waitFor({ state: "visible" });
    const readbackIds = await page.locator("[data-route-point-draft-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-route-point-draft-id")));
    const readbackChild = page.locator(`[data-route-point-draft-id="saved-${imported[1].id}"]`);
    await readbackChild.locator(".journey-route-draft__summary").click();
    record(`composer-import:${label}:response-readback-identities`, { readbackIds,
      owner: await readbackChild.locator(".journey-route-draft__stay-ownership").getByRole("button", { name: /跟上一停靠/ }).getAttribute("aria-pressed"),
    }, readbackIds.length === existingIds.length + 24 && readbackIds.includes(`saved-${imported[1].id}`)
      && await readbackChild.locator(".journey-route-draft__stay-ownership").getByRole("button", { name: /跟上一停靠/ }).getAttribute("aria-pressed") === "true"
      && await readbackChild.locator(".journey-route-draft__coordinates code").textContent() === "23.123456, 112.123456"
      && mutations.length === 1 && pageErrors.length === 0);
  } finally {
    releaseReading?.();
    releaseReview?.();
    await context.close();
  }
}

try {
  await verifyImportedJourney({ label: "desktop", width: 1280, height: 900, editing: true });
  await verifyImportedJourney({ label: "mobile", width: 390, height: 844, editing: false });
  for (const viewport of viewports) {
    const run = await openComposer(browser, viewport);
    try {
      const rows = await snapshotRows(run.page);
      const first = rows[0];
      const last = rows[rows.length - 1];
      const duplicateLabels = rows.filter((row) => row.label === "Shared label");
      const duplicateCoordinates = [];
      for (const row of [run.rows.nth(1), run.rows.nth(6)]) {
        await row.locator(".journey-route-draft__summary").click();
        const coordinate = await row.locator(".journey-route-draft__coordinates code").textContent();
        if (coordinate?.trim() === "22.543096, 114.057865") {
          duplicateCoordinates.push({ draftId: await row.getAttribute("data-route-point-draft-id") });
        }
        await row.locator(".journey-route-draft__summary").click();
      }
      const edgeMenus = [];
      for (const row of [run.rows.first(), run.rows.last()]) {
        await row.getByRole("button", { name: /更多操作/ }).click();
        edgeMenus.push(await row.locator('[role="menuitem"]').evaluateAll((buttons) => buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { disabled: button.disabled, width: rect.width, height: rect.height };
        })));
        await run.page.keyboard.press("Escape");
      }
      record(`composer-route-points:${viewport.label}:compact-contract`, {
        viewport,
        expandedCount: rows.filter((row) => row.expanded).length,
        first,
        last,
        duplicateLabelIds: duplicateLabels.map((row) => row.draftId),
        duplicateCoordinateIds: duplicateCoordinates.map((row) => row.draftId),
        edgeMenus,
        pageErrors: run.pageErrors,
      }, rows.length === 12
        && rows.filter((row) => row.expanded).length === 0
        && hasStableTargets(rows)
        && edgeMenus[0]?.[0]?.disabled === true
        && edgeMenus[0]?.[1]?.disabled === false
        && edgeMenus[1]?.[0]?.disabled === false
        && edgeMenus[1]?.[1]?.disabled === true
        && edgeMenus.every((menu) => menu.length === 3 && menu.every((target) => target.width >= 44 && target.height >= 44))
        && rows.every((row) => !/\d+\.\d{6}, \d+\.\d{6}/.test(row.meta))
        && duplicateLabels.length === 2
        && duplicateLabels[0].draftId !== duplicateLabels[1].draftId
        && duplicateCoordinates.length === 2
        && duplicateCoordinates[0].draftId !== duplicateCoordinates[1].draftId
        && run.pageErrors.length === 0);

      {
        const ownershipRow = run.rows.nth(1);
        await ownershipRow.locator(".journey-route-draft__summary").click();
        const ownership = ownershipRow.locator(".journey-route-draft__stay-ownership");
        await ownership.waitFor({ state: "visible" });
        const ownershipTargets = await ownership.locator("button").evaluateAll((buttons) => buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            label: button.textContent?.trim() ?? "",
            pressed: button.getAttribute("aria-pressed"),
            width: rect.width,
            height: rect.height,
          };
        }));
        record(`composer-route-points:${viewport.label}:stay-ownership-targets`, { ownershipTargets },
          ownershipTargets.length === 3
          && ownershipTargets[0]?.label === "跟上一停靠 · Shared label"
          && ownershipTargets[1]?.label === "跟下一停靠 · Record 04"
          && ownershipTargets[2]?.label === "独立"
          && ownershipTargets.every((target) => target.width >= 44 && target.height >= 44));

        if (viewport.label === "390") {
          const nextOwner = ownership.getByRole("button", { name: "跟下一停靠 · Record 04" });
          await nextOwner.focus();
          await run.page.keyboard.press("Enter");
          await run.page.waitForFunction(() => document.activeElement?.textContent?.includes("跟下一停靠")
            && document.activeElement?.getAttribute("aria-pressed") === "true");
          const nextFocus = await run.page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

          const independentOwner = ownership.getByRole("button", { name: "独立" });
          await independentOwner.focus();
          await run.page.keyboard.press("Enter");
          await run.page.waitForFunction(() => document.activeElement?.textContent?.trim() === "独立"
            && document.activeElement?.getAttribute("aria-pressed") === "true");
          const independentFocus = await run.page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

          const previousOwner = ownership.getByRole("button", { name: "跟上一停靠 · Shared label" });
          await previousOwner.focus();
          await run.page.keyboard.press("Enter");
          await run.page.waitForFunction(() => document.activeElement?.textContent?.includes("跟上一停靠")
            && document.activeElement?.getAttribute("aria-pressed") === "true");
          const finalOwnershipState = await ownership.locator("button").evaluateAll((buttons) => buttons.map((button) => ({
            label: button.textContent?.trim() ?? "",
            pressed: button.getAttribute("aria-pressed"),
          })));
          record("composer-route-points:stay-ownership-keyboard-focus-and-state", {
            nextFocus, independentFocus, finalOwnershipState,
          }, nextFocus === "跟下一停靠 · Record 04"
            && independentFocus === "独立"
            && finalOwnershipState[0]?.pressed === "true"
            && finalOwnershipState[1]?.pressed === "false"
            && finalOwnershipState[2]?.pressed === "false");
        }
      }

      if (viewport.label === "390") {
        let releaseVegasSearch = null;
        let markVegasSearchStarted = null;
        const vegasSearchStarted = new Promise((resolve) => { markVegasSearchStarted = resolve; });
        let releaseInterruptedSearch = null;
        let markInterruptedSearchStarted = null;
        const interruptedSearchStarted = new Promise((resolve) => { markInterruptedSearchStarted = resolve; });
        let markInterruptedSearchFulfilled = null;
        const interruptedSearchFulfilled = new Promise((resolve) => { markInterruptedSearchFulfilled = resolve; });

        await run.page.route("**/api/locations/search?*", async (route) => {
          const query = new URL(route.request().url()).searchParams.get("q") ?? "";
          if (query === "Las Vegas") {
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "LOCATION_SEARCH_UNAVAILABLE", message: "Location search unavailable" }),
            });
            return;
          }
          if (query === "Vegas") {
            markVegasSearchStarted?.();
            await new Promise((resolve) => { releaseVegasSearch = resolve; });
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: locationSearchPayload({ id: "delayed-provider", label: "Delayed Provider" }),
            });
            return;
          }
          if (query === "old query") {
            markInterruptedSearchStarted?.();
            await new Promise((resolve) => { releaseInterruptedSearch = resolve; });
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: locationSearchPayload({ id: "stale-provider", label: "Stale Provider" }),
            });
            markInterruptedSearchFulfilled?.();
            return;
          }
          if (query === "fresh query") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: locationSearchPayload({ id: "fresh-provider", label: "Fresh Provider" }),
            });
            return;
          }
          if (query === "Provider Add") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: locationSearchPayload({ id: "provider-add", label: "Las Vegas", context: "Same label and coordinates, new provider result" }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ results: [], attribution: null }),
          });
        });

        let savedJourneyRequest = null;
        await run.page.route("**/api/journeys/00000000-0000-4000-8000-000000000001", async (route) => {
          const request = route.request();
          if (request.method() !== "PATCH") {
            await route.fallback();
            return;
          }
          const submitted = request.postDataJSON();
          savedJourneyRequest = submitted;
          const journeyId = "00000000-0000-4000-8000-000000000001";
          const createdAt = "2026-08-11T00:00:00.000Z";
          const routePoints = submitted.routePoints.map((point, index) => ({
            ...point,
            id: point.id ?? `00000000-0000-4000-8000-${String(index + 900).padStart(12, "0")}`,
            journeyId,
            sortOrder: index,
            occurredAt: point.occurredAt ?? null,
            note: point.note ?? null,
            regionContext: point.regionContext ?? null,
            placeRole: point.placeRole ?? null,
            overviewVisibility: point.overviewVisibility ?? null,
            stayAnchorRoutePointId: point.stayAnchorRoutePointId ?? null,
            createdAt,
          }));
          const mediaRoutePointIds = [
            "00000000-0000-4000-8000-000000000022",
            "00000000-0000-4000-8000-000000000021",
            "00000000-0000-4000-8000-000000000026",
          ];
          const media = mediaRoutePointIds.map((routePointId, index) => ({
            id: `00000000-0000-4000-8000-00000000010${index}`,
            journeyId,
            routePointId,
            storageDriver: "qa",
            storageKey: `qa/story-seed-${index}`,
            fileName: `seed-${index}.png`,
            mimeType: "image/png",
            bytes: 68,
            sortOrder: index,
            uploadedByUserId: "00000000-0000-4000-8000-000000000003",
            createdAt,
          }));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              journey: {
                id: journeyId,
                atlasId: "00000000-0000-4000-8000-000000000002",
                title: submitted.title,
                startedOn: submitted.startedOn,
                endedOn: submitted.endedOn,
                note: submitted.note,
                lightColor: submitted.lightColor,
                lightEffect: submitted.lightEffect ?? null,
                coverMediaAssetId: null,
                revision: (submitted.revision ?? 1) + 1,
                createdByUserId: "00000000-0000-4000-8000-000000000003",
                createdAt,
                updatedAt: "2026-09-29T00:00:00.000Z",
                routePoints,
                media,
              },
            }),
          });
        });

        const persistenceRequests = [];
        run.page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.pathname.startsWith("/api/journeys") && request.method() !== "GET") {
            persistenceRequests.push({ method: request.method(), pathname: url.pathname });
          }
        });
        const initialSearchRowCount = await run.page.locator(".journey-route-draft > li:not(.is-empty)").count();
        const searchInput = run.page.getByPlaceholder("建筑、景点、街道、街区或城市");
        const searchSubmit = run.page.locator(".journey-location-search > button");
        const existingGroup = run.page.locator("[data-qa-composer-existing-results]");
        const externalGroup = run.page.locator("[data-qa-composer-external-results]");

        await searchInput.fill("Las Vegas");
        await existingGroup.waitFor({ state: "visible" });
        await run.page.waitForFunction(() => document.querySelectorAll("[data-qa-composer-existing-results] li").length === 2);
        const localMatches = await existingGroup.locator("li").evaluateAll((items) => items.map((item) => {
          const button = item.querySelector("button");
          const rect = button?.getBoundingClientRect();
          return {
            draftId: item.getAttribute("data-existing-route-point-draft-id"),
            text: item.textContent?.trim() ?? "",
            ariaLabel: button?.getAttribute("aria-label") ?? null,
            buttonWidth: rect?.width ?? 0,
            buttonHeight: rect?.height ?? 0,
          };
        }));
        record("composer-route-points:local-search-separate-records", { localMatches },
          localMatches.length === 2
          && localMatches.every((item) => item.draftId && item.buttonWidth >= 44 && item.buttonHeight >= 44)
          && localMatches[0].draftId !== localMatches[1].draftId
          && localMatches[0].text.includes("02")
          && localMatches[1].text.includes("07")
          && localMatches[0].ariaLabel === "定位 02 · Las Vegas"
          && localMatches[1].ariaLabel === "定位 07 · Las Vegas"
          && localMatches.every((item) => item.text.includes("22.543096, 114.057865")));

        const draft02 = localMatches[0].draftId;
        const draft07 = localMatches[1].draftId;
        const locate02 = existingGroup.locator(`li[data-existing-route-point-draft-id="${draft02}"] button`);
        await locate02.focus();
        await run.page.keyboard.press("Enter");
        await run.page.waitForFunction((draftId) => {
          const row = document.querySelector(`[data-route-point-draft-id="${draftId}"]`);
          return row?.getAttribute("data-route-point-expanded") === "true"
            && document.activeElement?.closest("[data-route-point-draft-id]")?.getAttribute("data-route-point-draft-id") === draftId;
        }, draft02);
        const row02 = run.page.locator(`[data-route-point-draft-id="${draft02}"]`);
        const locate02State = {
          note: await row02.locator("textarea").inputValue(),
          isStop: await row02.locator(".journey-route-draft__stop-toggle").getAttribute("aria-pressed") === "true",
          media: await row02.locator(".journey-route-draft__media-association small").textContent(),
        };
        record("composer-route-points:locate-record-02", { draft02, locate02State },
          locate02State.note === "Record 02 local search note."
          && locate02State.isStop === false
          && locate02State.media?.includes("seed-1.png")
          && await run.page.locator(".journey-route-draft > li:not(.is-empty)").count() === initialSearchRowCount
          && persistenceRequests.length === 0);

        await existingGroup.locator(`li[data-existing-route-point-draft-id="${draft07}"] button`).click();
        await run.page.waitForFunction((draftId) => document.querySelector(`[data-route-point-draft-id="${draftId}"]`)?.getAttribute("data-route-point-expanded") === "true", draft07);
        const row07 = run.page.locator(`[data-route-point-draft-id="${draft07}"]`);
        const locate07State = {
          note: await row07.locator("textarea").inputValue(),
          isStop: await row07.locator(".journey-route-draft__stop-toggle").getAttribute("aria-pressed") === "true",
          media: await row07.locator(".journey-route-draft__media-association small").textContent(),
        };
        record("composer-route-points:locate-record-07", { draft07, locate07State },
          locate07State.note === "Record 07 local search note."
          && locate07State.isStop === true
          && locate07State.media?.includes("seed-2.png")
          && await run.page.locator(".journey-route-draft > li:not(.is-empty)").count() === initialSearchRowCount
          && persistenceRequests.length === 0);

        await searchSubmit.click();
        await run.page.waitForFunction(() => !document.querySelector(".journey-location-search > button")?.disabled);
        const localAfterProviderFailure = await existingGroup.locator("li").count();
        const providerFailureMessage = await run.page.locator(".journey-composer__message").textContent();
        record("composer-route-points:no-provider-keeps-local-search", { localAfterProviderFailure, providerFailureMessage },
          localAfterProviderFailure === 2
          && Boolean(providerFailureMessage?.trim())
          && await externalGroup.count() === 0);

        await searchInput.fill("Vegas");
        await run.page.waitForFunction(() => document.querySelectorAll("[data-qa-composer-existing-results] li").length === 2);
        await searchSubmit.click();
        await vegasSearchStarted;
        await existingGroup.locator(`li[data-existing-route-point-draft-id="${draft07}"] button`).click();
        await row07.getByRole("button", { name: "更多操作 Las Vegas" }).click();
        await row07.locator(".journey-route-draft__menu").getByRole("menuitem", { name: "删除地点" }).click();
        await run.page.waitForFunction((draftId) => !document.querySelector(`[data-route-point-draft-id="${draftId}"]`), draft07);
        await run.page.waitForFunction((draftId) => !document.querySelector(`[data-existing-route-point-draft-id="${draftId}"]`), draft07);
        releaseVegasSearch?.();
        await run.page.waitForFunction(() => !document.querySelector(".journey-location-search > button")?.disabled);
        const afterDeleteDuringSearch = {
          existingIds: await existingGroup.locator("li").evaluateAll((items) => items.map((item) => item.getAttribute("data-existing-route-point-draft-id"))),
          deletedRowCount: await run.page.locator(`[data-route-point-draft-id="${draft07}"]`).count(),
          providerResultCount: await run.page.locator('[data-location-result-id="delayed-provider"]').count(),
        };
        record("composer-route-points:delete-during-search-does-not-resurrect", { draft07, afterDeleteDuringSearch },
          afterDeleteDuringSearch.existingIds.length === 1
          && !afterDeleteDuringSearch.existingIds.includes(draft07)
          && afterDeleteDuringSearch.deletedRowCount === 0
          && afterDeleteDuringSearch.providerResultCount === 1);

        await searchInput.fill("old query");
        await searchSubmit.click();
        await interruptedSearchStarted;
        await searchInput.fill("fresh query");
        await searchSubmit.click();
        await run.page.locator('[data-location-result-id="fresh-provider"]').waitFor({ state: "visible" });
        releaseInterruptedSearch?.();
        await interruptedSearchFulfilled;
        await run.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const interruptedState = {
          fresh: await run.page.locator('[data-location-result-id="fresh-provider"]').count(),
          stale: await run.page.locator('[data-location-result-id="stale-provider"]').count(),
          query: await searchInput.inputValue(),
        };
        record("composer-route-points:interrupted-search-keeps-newest-result", { interruptedState },
          interruptedState.fresh === 1
          && interruptedState.stale === 0
          && interruptedState.query === "fresh query");

        await searchInput.fill("Provider Add");
        await searchSubmit.click();
        const providerAdd = run.page.locator('[data-location-result-id="provider-add"] button');
        await providerAdd.waitFor({ state: "visible" });
        const beforeAddDraftIds = await run.page.locator(".journey-route-draft > li:not(.is-empty)").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-route-point-draft-id")));
        const providerAddTarget = await providerAdd.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height, ariaLabel: button.getAttribute("aria-label") };
        });
        await providerAdd.click();
        await run.page.waitForFunction((count) => document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length === count + 1, beforeAddDraftIds.length);
        const appended = run.page.locator(".journey-route-draft > li:not(.is-empty)").last();
        const addState = {
          beforeCount: beforeAddDraftIds.length,
          afterCount: await run.page.locator(".journey-route-draft > li:not(.is-empty)").count(),
          draftId: await appended.getAttribute("data-route-point-draft-id"),
          label: await appended.locator(".journey-route-draft__summary strong").textContent(),
          latitude: await appended.getAttribute("data-route-point-latitude"),
          longitude: await appended.getAttribute("data-route-point-longitude"),
          query: await searchInput.inputValue(),
          providerAddTarget,
        };
        record("composer-route-points:explicit-provider-add-appends-fresh-record", { addState },
          addState.afterCount === addState.beforeCount + 1
          && Boolean(addState.draftId)
          && !beforeAddDraftIds.includes(addState.draftId)
          && addState.label?.trim() === "Las Vegas"
          && addState.latitude === "22.543096"
          && addState.longitude === "114.057865"
          && addState.query === ""
          && providerAddTarget.ariaLabel === "添加 Las Vegas · Same label and coordinates, new provider result · QA"
          && providerAddTarget.width >= 44
          && providerAddTarget.height >= 44
          && persistenceRequests.length === 0);

        const record03 = run.rows.filter({
          has: run.page.locator(".journey-route-draft__summary strong").filter({ hasText: /^Record 03$/ }),
        }).first();
        const record03Summary = record03.locator(".journey-route-draft__summary");
        const record03DraftId = await record03.getAttribute("data-route-point-draft-id");
        await record03Summary.click();
        const expanded = record03.locator(".journey-route-draft__expanded");
        await expanded.waitFor({ state: "visible" });
        const expandedState = {
          expandedCount: await run.page.locator('.journey-route-draft > li[data-route-point-expanded="true"]').count(),
          // The expanded editor can carry other text inputs (media metadata,
          // stay/region correction, etc.). Bind the canonical Route Point name
          // through its stable identity instead of assuming it is the only input.
          name: await expanded.locator('[data-route-point-label-input]').inputValue(),
          note: await expanded.locator("textarea").inputValue(),
          hasStop: await expanded.locator(".journey-route-draft__stop-toggle").count() === 1,
          hasCoordinates: await expanded.locator(".journey-route-draft__coordinates code").count() === 1,
          mediaCount: Number(await expanded.locator(".journey-route-draft__media-association").getAttribute("data-route-point-media-count")),
          mediaText: await expanded.locator(".journey-route-draft__media-association small").textContent(),
        };
        record("composer-route-points:single-expanded-editor", { record03DraftId, expandedState },
          expandedState.expandedCount === 1
          && expandedState.name === "Record 03"
          && expandedState.note === "Record 03 keeps its note while moving."
          && expandedState.hasStop
          && expandedState.hasCoordinates
          && expandedState.mediaCount === 1
          && expandedState.mediaText?.includes("seed-0.png"));

        await record03.getByRole("button", { name: "更多操作 Record 03" }).click();
        await record03.getByRole("button", { name: "向前移动 Record 03" }).click();
        await run.page.waitForFunction((draftId) => {
          const row = document.querySelector(`[data-route-point-draft-id="${draftId}"]`);
          return row?.getAttribute("data-route-point-position") === "2";
        }, record03DraftId);
        await run.page.waitForFunction((draftId) => (
          document.activeElement?.closest("[data-route-point-draft-id]")?.getAttribute("data-route-point-draft-id") === draftId
        ), record03DraftId);
        const afterMove = await snapshotRows(run.page);
        const movedRecord = afterMove.find((row) => row.draftId === record03DraftId);
        const activeDraftId = await run.page.evaluate(() => document.activeElement?.closest("[data-route-point-draft-id]")?.getAttribute("data-route-point-draft-id") ?? null);
        record("composer-route-points:record03-reorder-identity", { record03DraftId, movedRecord, activeDraftId },
          movedRecord?.position === 2
          && movedRecord.expanded === true
          && movedRecord.label === "Record 03"
          && activeDraftId === record03DraftId);

        const more = record03.getByRole("button", { name: "更多操作 Record 03" });
        await more.focus();
        await run.page.keyboard.press("Enter");
        await record03.locator(".journey-route-draft__menu").waitFor({ state: "visible" });
        await run.page.keyboard.press("Escape");
        await record03.locator(".journey-route-draft__menu").waitFor({ state: "detached" });
        await run.page.waitForFunction((draftId) => (
          document.activeElement?.getAttribute("aria-label") === "更多操作 Record 03"
          && document.activeElement?.closest("[data-route-point-draft-id]")?.getAttribute("data-route-point-draft-id") === draftId
        ), record03DraftId);
        const focusAfterMenuClose = await run.page.evaluate(() => ({
          label: document.activeElement?.getAttribute("aria-label") ?? null,
          draftId: document.activeElement?.closest("[data-route-point-draft-id]")?.getAttribute("data-route-point-draft-id") ?? null,
        }));
        const composerStillOpen = await run.page.locator(".journey-composer").isVisible();
        record("composer-route-points:keyboard-more-close-focus", { focusAfterMenuClose, composerStillOpen },
          focusAfterMenuClose.label === "更多操作 Record 03"
          && focusAfterMenuClose.draftId === record03DraftId
          && composerStillOpen);

        const record04 = run.rows.filter({
          has: run.page.locator(".journey-route-draft__summary strong").filter({ hasText: /^Record 04$/ }),
        }).first();
        await record04.locator(".journey-route-draft__summary").click();
        const expandedIds = await run.page.locator('.journey-route-draft > li[data-route-point-expanded="true"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-route-point-draft-id")));
        record("composer-route-points:one-record-bound-expansion", { expandedIds }, expandedIds.length === 1 && expandedIds[0] !== record03DraftId);

        const record04DraftId = await record04.getAttribute("data-route-point-draft-id");
        await record04.getByRole("button", { name: "更多操作 Record 04" }).click();
        await record04.locator(".journey-route-draft__menu").getByRole("menuitem", { name: "删除地点" }).click();
        await run.page.waitForFunction((draftId) => !document.querySelector(`[data-route-point-draft-id="${draftId}"]`), record04DraftId);
        await run.page.waitForFunction(() => (
          document.activeElement?.querySelector?.("strong")?.textContent?.trim() === "Record 05"
        ));
        const deleteFocus = await run.page.evaluate(() => ({
          activeDraftId: document.activeElement?.closest("[data-route-point-draft-id]")?.getAttribute("data-route-point-draft-id") ?? null,
          activeLabel: document.activeElement?.querySelector?.("strong")?.textContent?.trim() ?? document.activeElement?.textContent?.trim() ?? "",
          rowCount: document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length,
        }));
        record("composer-route-points:delete-focus-surviving-neighbor", { record04DraftId, deleteFocus },
          deleteFocus.rowCount === 11
          && deleteFocus.activeLabel.includes("Record 05")
          && deleteFocus.activeDraftId !== record04DraftId);

        const lastRow = run.rows.last();
        const lastSummary = lastRow.locator(".journey-route-draft__summary");
        await lastSummary.evaluate((element) => element.focus({ preventScroll: true }));
        await run.page.keyboard.press("Enter");
        await run.page.waitForFunction(() => document.querySelector('.journey-route-draft > li:last-child')?.getAttribute("data-route-point-expanded") === "true");
        await run.page.waitForFunction(() => {
          const row = document.querySelector(".journey-route-draft > li:last-child");
          const summary = row?.querySelector(".journey-route-draft__summary");
          const footer = document.querySelector(".journey-composer__footer");
          const summaryRect = summary?.getBoundingClientRect();
          const footerRect = footer?.getBoundingClientRect();
          return Boolean(summaryRect && footerRect && summaryRect.top >= 0 && summaryRect.bottom <= footerRect.top + 1);
        });
        const scrollGeometry = await run.page.evaluate(() => {
          const row = document.querySelector(".journey-route-draft > li:last-child");
          const summary = row?.querySelector(".journey-route-draft__summary");
          const footer = document.querySelector(".journey-composer__footer");
          const summaryRect = summary?.getBoundingClientRect();
          const footerRect = footer?.getBoundingClientRect();
          return {
            summaryTop: summaryRect?.top ?? NaN,
            summaryBottom: summaryRect?.bottom ?? NaN,
            footerTop: footerRect?.top ?? NaN,
            viewportHeight: window.innerHeight,
          };
        });
        record("composer-route-points:last-row-scroll-above-sticky-actions", { scrollGeometry },
          Number.isFinite(scrollGeometry.summaryBottom)
          && Number.isFinite(scrollGeometry.footerTop)
          && scrollGeometry.summaryTop >= 0
          && scrollGeometry.summaryBottom <= scrollGeometry.footerTop + 1);

        const stopId = "00000000-0000-4000-8000-000000000020";
        const childId = "00000000-0000-4000-8000-000000000021";
        const childMediaId = "00000000-0000-4000-8000-000000000101";
        await run.page.getByRole("button", { name: "保存修改" }).click();
        const projectionOutput = run.page.locator("[data-qa-composer-projection]");
        await projectionOutput.waitFor({ state: "attached", timeout: 10_000 });
        const projection = await projectionOutput.evaluate((node) => ({
          overviewRoutePointIds: JSON.parse(node.getAttribute("data-overview-route-point-ids") ?? "[]"),
          stays: JSON.parse(node.getAttribute("data-stays") ?? "[]"),
          playback: JSON.parse(node.getAttribute("data-playback") ?? "[]"),
        }));
        const submittedChild = savedJourneyRequest?.routePoints?.find((point) => point.id === childId) ?? null;
        const owningStay = projection.stays.find((stay) => stay.routePointIds.includes(childId)) ?? null;
        const foldedMedia = projection.playback.find((step) => step.kind === "media" && step.assetId === childMediaId) ?? null;
        const childIndependentMedia = projection.playback.find((step) => (
          step.kind === "media" && step.routePointId === childId && step.assetId === childMediaId
        )) ?? null;
        const childStopBeat = projection.playback.find((step) => step.kind === "stop" && step.routePointId === childId) ?? null;
        record("composer-route-points:ownership-persists-into-overview-and-playback", {
          submittedChild,
          overviewRoutePointIds: projection.overviewRoutePointIds,
          owningStay,
          foldedMedia,
          childIndependentMedia,
          childStopBeat,
          persistenceRequests,
        }, Boolean(
          savedJourneyRequest
          && persistenceRequests.some((request) => request.method === "PATCH")
          && submittedChild?.stayAnchorRoutePointId === stopId
          && projection.overviewRoutePointIds.includes(stopId)
          && owningStay?.anchorRoutePointId === stopId
          && owningStay.routePointIds.includes(stopId)
          && owningStay.routePointIds.includes(childId)
          && owningStay.mediaAssetIds.includes(childMediaId)
          && foldedMedia?.routePointId === stopId
          && foldedMedia?.assetRoutePointId === childId
          && childIndependentMedia === null
          && childStopBeat === null
        ));
      }
    } finally {
      await run.context.close();
    }
  }

  const reduced = await openComposer(browser, { width: 390, height: 844, reducedMotion: "reduce" });
  try {
    const record03 = reduced.rows.filter({ hasText: "Record 03" }).first();
    const draftId = await record03.getAttribute("data-route-point-draft-id");
    await record03.locator(".journey-route-draft__summary").focus();
    await reduced.page.keyboard.press("Enter");
    await record03.getByRole("button", { name: "更多操作 Record 03" }).focus();
    await reduced.page.keyboard.press("Enter");
    await record03.getByRole("button", { name: "向前移动 Record 03" }).focus();
    await reduced.page.keyboard.press("Enter");
    await reduced.page.waitForFunction((id) => document.querySelector(`[data-route-point-draft-id="${id}"]`)?.getAttribute("data-route-point-position") === "2", draftId);
    const sample = await snapshotRows(reduced.page);
    record("composer-route-points:reduced-motion-keyboard-reorder", { draftId, moved: sample.find((row) => row.draftId === draftId), pageErrors: reduced.pageErrors },
      sample.find((row) => row.draftId === draftId)?.position === 2
      && sample.find((row) => row.draftId === draftId)?.expanded === true
      && reduced.pageErrors.length === 0);
  } finally {
    await reduced.context.close();
  }
} catch (error) {
  fatalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  failed = true;
  console.error(fatalError);
} finally {
  await browser.close();
}

const artifact = { summary: "composer-route-points", failed, fatalError, results };
await mkdir("artifacts/composer-route-points", { recursive: true });
await writeFile("artifacts/composer-route-points/results.json", `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));
if (failed) process.exitCode = 1;
