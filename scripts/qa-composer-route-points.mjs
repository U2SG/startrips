import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const results = [];
let failed = false;
let fatalError = null;

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
        const record03 = run.rows.filter({ hasText: "Record 03" }).first();
        const record03Summary = record03.locator(".journey-route-draft__summary");
        const record03DraftId = await record03.getAttribute("data-route-point-draft-id");
        await record03Summary.click();
        const expanded = record03.locator(".journey-route-draft__expanded");
        await expanded.waitFor({ state: "visible" });
        const expandedState = {
          expandedCount: await run.page.locator('.journey-route-draft > li[data-route-point-expanded="true"]').count(),
          name: await expanded.locator('input[type="text"]').inputValue(),
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
