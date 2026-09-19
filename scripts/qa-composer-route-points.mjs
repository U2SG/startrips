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
    && row.actionTargets.length === 3
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

try {
  for (const viewport of viewports) {
    const run = await openComposer(browser, viewport);
    try {
      const rows = await snapshotRows(run.page);
      const first = rows[0];
      const last = rows[rows.length - 1];
      const duplicateLabels = rows.filter((row) => row.label === "Shared label");
      const duplicateCoordinates = rows.filter((row) => row.meta.includes("22.543096, 114.057865"));
      record(`composer-route-points:${viewport.label}:compact-contract`, {
        viewport,
        expandedCount: rows.filter((row) => row.expanded).length,
        first,
        last,
        duplicateLabelIds: duplicateLabels.map((row) => row.draftId),
        duplicateCoordinateIds: duplicateCoordinates.map((row) => row.draftId),
        pageErrors: run.pageErrors,
      }, rows.length === 12
        && rows.filter((row) => row.expanded).length === 0
        && hasStableTargets(rows)
        && first.actionTargets[0]?.disabled === true
        && first.actionTargets[1]?.disabled === false
        && last.actionTargets[0]?.disabled === false
        && last.actionTargets[1]?.disabled === true
        && duplicateLabels.length === 2
        && duplicateLabels[0].draftId !== duplicateLabels[1].draftId
        && duplicateCoordinates.length === 2
        && duplicateCoordinates[0].draftId !== duplicateCoordinates[1].draftId
        && run.pageErrors.length === 0);

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
          isStop: await row02.locator('.journey-checkbox input[type="checkbox"]').isChecked(),
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
          isStop: await row07.locator('.journey-checkbox input[type="checkbox"]').isChecked(),
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

        const record03 = run.rows.filter({ hasText: "Record 03" }).first();
        const record03Summary = record03.locator(".journey-route-draft__summary");
        const record03DraftId = await record03.getAttribute("data-route-point-draft-id");
        await record03Summary.click();
        const expanded = record03.locator(".journey-route-draft__expanded");
        await expanded.waitFor({ state: "visible" });
        const expandedState = {
          expandedCount: await run.page.locator('.journey-route-draft > li[data-route-point-expanded="true"]').count(),
          // #375 added a contextual media upload to the expanded record, so the
          // name field is addressed explicitly rather than as "the only input".
          name: await expanded.locator('input:not([type="checkbox"]):not([type="file"])').inputValue(),
          note: await expanded.locator("textarea").inputValue(),
          hasStop: await expanded.locator('.journey-checkbox input[type="checkbox"]').count() === 1,
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

        const record04 = run.rows.filter({ hasText: "Record 04" }).first();
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
