// #375: the Journey Composer's mobile-primary progressive-disclosure
// architecture, driven in a real browser.
//
// The owner approved a capability map in which the primary surface carries only
// the Journey title, the Route Point list, add/search and the sticky Save, and
// every other capability is entered from there and returns there.
// `src/journey/composerMobileTasks.ts` is that map and its unit test proves the
// map is complete; this lane proves the product actually implements it: each
// entry opens the task that owns the capability, the capability's own controls
// are really there, and Back returns to the primary surface with focus on the
// control that was used to leave it.
//
// What this lane deliberately does NOT cover: a real soft keyboard. Chromium
// resizes the layout and visual viewport together, so the keyboard case is
// driven through the measured available-height contract the product uses
// (`--composer-available-height`) plus a viewport shrink. A physical device
// check stays a manual gap and is recorded as one rather than claimed here.
import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const results = [];
let failed = false;

function record(name, data, condition) {
  const row = { name, ...data, failed: !condition };
  results.push(row);
  console.log(JSON.stringify(row));
  if (!condition) failed = true;
}

const VIEWPORTS = [
  { label: "320", width: 320, height: 700 },
  { label: "360", width: 360, height: 780 },
  { label: "390", width: 390, height: 844 },
  { label: "430", width: 430, height: 860 },
  { label: "landscape-740x360", width: 740, height: 360 },
];

// Every task, the entry that opens it and a selector only that task can satisfy.
const TASKS = [
  {
    id: "journey-info",
    behindMore: false,
    capabilities: {
      "journey-dates": 'input[type="date"]',
      "journey-note": ".journey-story-fields textarea",
    },
  },
  {
    id: "media",
    behindMore: false,
    capabilities: {
      "media-upload": '.journey-media-picker input[type="file"]',
    },
  },
  {
    id: "appearance",
    behindMore: true,
    capabilities: {
      "light-color": ".journey-light-colors",
      "light-effect": ".journey-light-effect-list",
    },
  },
  {
    id: "location",
    behindMore: true,
    capabilities: {
      "manual-coordinates": ".journey-coordinate-fields",
      "globe-pick": ".journey-globe-pick-button",
    },
  },
];

// Capabilities the primary surface must hold directly, and the ones it must not
// show inline - "focused primary surface" is asserted, not asserted away.
const PRIMARY_PRESENT = {
  "journey-title": ".journey-title-field input",
  "place-search": ".journey-location-search input",
  "route-point-list": ".journey-route-draft",
  save: ".journey-composer__footer-actions button",
};
const PRIMARY_ABSENT = {
  "journey-dates": 'input[type="date"]',
  "light-color": ".journey-light-colors",
  "manual-coordinates": ".journey-coordinate-fields",
  "media-upload": ".journey-media-picker",
};

async function openComposer(browser, { width, height }, qaMode = "edit") {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const path = qaMode ? `/?qaState=journey-composer&qaMode=${qaMode}` : "/?qaState=journey-composer";
  await page.goto(new URL(path, baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const composer = page.locator(".journey-composer");
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  return { context, page, composer, pageErrors };
}

const counts = (page, selectors) => page.evaluate(
  (map) => Object.fromEntries(
    Object.entries(map).map(([key, selector]) => [key, document.querySelectorAll(selector).length]),
  ),
  selectors,
);

const browser = await launchQaBrowser();

try {
  for (const viewport of VIEWPORTS) {
    const run = await openComposer(browser, viewport);
    const { page } = run;
    try {
      const shell = await page.evaluate(() => {
        const composer = document.querySelector(".journey-composer");
        const task = composer?.querySelector("[data-composer-task]");
        const owners = [...composer.querySelectorAll("*")].filter((node) => {
          const style = getComputedStyle(node);
          const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
          return scrolls && node.scrollHeight > node.clientHeight + 1;
        });
        return {
          mobileLayout: composer?.getAttribute("data-mobile-layout"),
          activeTask: task?.getAttribute("data-composer-task") ?? null,
          scrollOwners: owners.map((node) => node.getAttribute("data-composer-scroll-owner")
            ?? node.className?.toString?.() ?? "unknown"),
        };
      });
      // Acceptance 3: one scroll owner per active task. A second scrolling
      // container inside the composer is the defect, not a style preference.
      record(`composer-mobile-ia:${viewport.label}:shell`, { viewport, shell, pageErrors: run.pageErrors },
        shell.mobileLayout === "true"
        && shell.activeTask === "primary"
        && shell.scrollOwners.length <= 1
        && shell.scrollOwners.every((owner) => owner === "editor")
        && run.pageErrors.length === 0);

      const present = await counts(page, PRIMARY_PRESENT);
      const absent = await counts(page, PRIMARY_ABSENT);
      record(`composer-mobile-ia:${viewport.label}:primary-surface`, { present, absent },
        Object.values(present).every((count) => count > 0)
        && Object.values(absent).every((count) => count === 0));

      // Every task: entry -> capability really present -> back -> focus restored.
      for (const task of TASKS) {
        if (task.behindMore) {
          await page.locator(".journey-composer__task-more").click();
          await page.locator("#journey-composer-more-menu").waitFor({ state: "visible" });
        }
        const entry = page.locator(`[data-composer-task-entry="${task.id}"]`);
        const entryBox = await entry.boundingBox();
        await entry.click();
        const panel = page.locator(`[data-composer-task="${task.id}"]`);
        await panel.waitFor({ state: "visible", timeout: 5_000 });
        const opened = await page.evaluate((selectors) => ({
          capabilities: Object.fromEntries(
            Object.entries(selectors).map(([key, selector]) => [key, document.querySelectorAll(selector).length]),
          ),
          headingFocused: document.activeElement?.tagName === "H3",
          headingText: document.activeElement?.textContent?.trim() ?? null,
        }), task.capabilities);
        // The back control has to be inside the same dialog, not a second modal.
        const backInsideDialog = await page.evaluate(() => {
          const back = document.querySelector("[data-composer-task-back]");
          const dialogs = document.querySelectorAll('.journey-composer [role="dialog"]');
          return Boolean(back) && dialogs.length === 0;
        });
        record(`composer-mobile-ia:${viewport.label}:${task.id}:entry`, {
          entryBox,
          opened,
          backInsideDialog,
        },
          Object.values(opened.capabilities).every((count) => count > 0)
          && opened.headingFocused
          && backInsideDialog
          // Acceptance 3 keeps every shared control a real touch target.
          && Boolean(entryBox) && entryBox.width >= 44 && entryBox.height >= 44);

        await page.locator("[data-composer-task-back]").click();
        await page.locator('[data-composer-task="primary"]').waitFor({ state: "visible" });
        // A More-path entry is unmounted with its menu, so its return control is
        // the More button the person opened the menu with.
        const expectedEntry = task.behindMore ? "more" : task.id;
        const returned = await page.evaluate((expected) => ({
          activeEntry: document.activeElement?.getAttribute("data-composer-task-entry") ?? null,
          menuOpen: Boolean(document.querySelector("#journey-composer-more-menu")),
          expected,
        }), expectedEntry);
        // Acceptance 4: return is explicit, not inferred - focus comes back to a
        // control that is really on screen, and the menu does not linger open.
        record(`composer-mobile-ia:${viewport.label}:${task.id}:return`, { returned },
          returned.activeEntry === expectedEntry && !returned.menuOpen);
      }

      // Acceptance 1 / owner decision: media belongs to a Route Point.
      const firstRow = page.locator(".journey-route-draft > li:not(.is-empty)").first();
      await firstRow.locator(".journey-route-draft__summary").click();
      const contextualUpload = await page.evaluate(() => {
        const row = document.querySelector(".journey-route-draft > li:not(.is-empty)");
        const upload = row?.querySelector('.journey-route-draft__media-upload input[type="file"]');
        const label = row?.querySelector(".journey-route-draft__media-upload");
        const rect = label?.getBoundingClientRect();
        return {
          present: Boolean(upload),
          accept: upload?.getAttribute("accept") ?? null,
          height: rect ? Math.round(rect.height) : 0,
        };
      });
      record(`composer-mobile-ia:${viewport.label}:route-point-media-upload`, { contextualUpload },
        contextualUpload.present
        && contextualUpload.accept?.includes("image/jpeg")
        && contextualUpload.height >= 44);

      // Acceptance 3: sticky actions never cover the final row. Scroll the one
      // scroll owner to its end and compare the last row against the footer.
      const sticky = await page.evaluate(() => {
        const editor = document.querySelector('[data-composer-scroll-owner="editor"]');
        if (editor) editor.scrollTop = editor.scrollHeight;
        return new Promise((resolve) => requestAnimationFrame(() => {
          const rows = [...document.querySelectorAll(".journey-route-draft > li")];
          const last = rows[rows.length - 1]?.getBoundingClientRect();
          const footer = document.querySelector(".journey-composer__footer")?.getBoundingClientRect();
          const save = [...document.querySelectorAll(".journey-composer__footer-actions button")].pop();
          const saveRect = save?.getBoundingClientRect();
          resolve({
            lastRowBottom: last ? Math.round(last.bottom) : null,
            footerTop: footer ? Math.round(footer.top) : null,
            saveVisible: Boolean(saveRect) && saveRect.bottom <= innerHeight + 0.5 && saveRect.height >= 44,
            overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          });
        }));
      });
      record(`composer-mobile-ia:${viewport.label}:sticky-save`, { sticky },
        sticky.lastRowBottom !== null
        && sticky.footerTop !== null
        && sticky.lastRowBottom <= sticky.footerTop + 0.5
        && sticky.saveVisible
        && sticky.overflowX === 0);

      // Acceptance 3: a reduced available height keeps the focused input and the
      // save action reachable. A soft keyboard shrinks only the visual viewport,
      // which Chromium will not emulate, so the visual viewport is overridden
      // and its own resize event dispatched: the product's real effect then does
      // the measuring, exactly as it would on a device.
      const keyboard = await page.evaluate(() => {
        const composer = document.querySelector(".journey-composer");
        const input = document.querySelector(".journey-title-field input");
        input?.focus();
        const reduced = Math.round(innerHeight * 0.55);
        Object.defineProperty(window.visualViewport, "height", {
          configurable: true,
          get: () => reduced,
        });
        window.visualViewport.dispatchEvent(new Event("resize"));
        // Two frames, not one: inside the first callback Chromium still reports
        // the pre-change used height, so a single frame measures the old layout
        // and blames the product for the measurement.
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const composerRect = composer.getBoundingClientRect();
          const inputRect = input?.getBoundingClientRect();
          const save = [...document.querySelectorAll(".journey-composer__footer-actions button")].pop();
          const saveRect = save?.getBoundingClientRect();
          const style = getComputedStyle(composer);
          resolve({
            reduced,
            published: composer.style.height,
            computed: style.height,
            // Reported so an override is named by the browser rather than guessed.
            box: {
              minHeight: style.minHeight,
              maxHeight: style.maxHeight,
              display: style.display,
              position: style.position,
              boxSizing: style.boxSizing,
              inset: `${style.top}/${style.bottom}`,
            },
            composerHeight: Math.round(composerRect.height),
            focusKept: document.activeElement === input,
            // The requirement is the user-facing one: while the keyboard takes
            // the lower part of the screen, the focused field and the save
            // action stay above it. Whether the dialog shrinks or repositions to
            // achieve that is an implementation detail.
            inputAboveKeyboard: Boolean(inputRect) && inputRect.top >= -0.5 && inputRect.bottom <= reduced + 0.5,
            saveAboveKeyboard: Boolean(saveRect) && saveRect.bottom <= reduced + 0.5 && saveRect.height >= 44,
          });
        })));
      });
      // Put the visual viewport back so the checks after this one measure the
      // normal surface rather than a simulated open keyboard.
      await page.evaluate(() => {
        delete window.visualViewport.height;
        window.visualViewport.dispatchEvent(new Event("resize"));
      });
      record(`composer-mobile-ia:${viewport.label}:available-height`, { keyboard },
        keyboard.published === `${keyboard.reduced}px`
        && keyboard.focusKept
        && keyboard.inputAboveKeyboard
        && keyboard.saveAboveKeyboard);

      // Acceptance 2: one selected draftId and one authoritative draft. Task
      // switching may change what is rendered; it may not change which record
      // is selected, nor which record a pending file belongs to.
      if (viewport.label === "390") {
        const expandedBefore = await page.evaluate(() => {
          const row = document.querySelector('[data-route-point-expanded="true"]');
          return row?.getAttribute("data-route-point-draft-id") ?? null;
        });
        await page.locator('[data-composer-task-entry="media"]').click();
        await page.locator('[data-composer-task="media"]').waitFor({ state: "visible" });
        await page.locator("[data-composer-task-back]").click();
        await page.locator('[data-composer-task="primary"]').waitFor({ state: "visible" });
        const expandedAfter = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-route-point-expanded="true"]')];
          return {
            draftIds: rows.map((row) => row.getAttribute("data-route-point-draft-id")),
            rowCount: document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length,
          };
        });
        record(`composer-mobile-ia:390:selection-survives-task-switch`, { expandedBefore, expandedAfter },
          Boolean(expandedBefore)
          && expandedAfter.draftIds.length === 1
          && expandedAfter.draftIds[0] === expandedBefore);

        // The contextual upload writes the record's draftId onto the pending
        // file; the media task must still show that ownership after a return.
        await page.locator('.journey-route-draft__media-upload input[type="file"]').setInputFiles({
          name: "route-point-owned.png",
          mimeType: "image/png",
          buffer: Buffer.from("qa"),
        });
        const readAssignment = () => page.evaluate(() => {
          const card = document.querySelector(".journey-media-mobile-card__assignment span");
          return card?.textContent?.trim() ?? null;
        });
        await page.locator('[data-composer-task-entry="media"]').click();
        await page.locator('[data-composer-task="media"]').waitFor({ state: "visible" });
        const assignedFirst = await readAssignment();
        await page.locator("[data-composer-task-back]").click();
        await page.locator('[data-composer-task="primary"]').waitFor({ state: "visible" });
        await page.locator('[data-composer-task-entry="media"]').click();
        await page.locator('[data-composer-task="media"]').waitFor({ state: "visible" });
        const assignedAgain = await readAssignment();
        await page.locator("[data-composer-task-back]").click();
        await page.locator('[data-composer-task="primary"]').waitFor({ state: "visible" });
        record("composer-mobile-ia:390:pending-media-ownership-survives", { assignedFirst, assignedAgain },
          Boolean(assignedFirst)
          && assignedFirst !== "整段旅程"
          && assignedFirst === assignedAgain);
      }

      record(`composer-mobile-ia:${viewport.label}:no-page-errors`, { pageErrors: run.pageErrors },
        run.pageErrors.length === 0);
    } finally {
      await run.context.close();
    }
  }

  const empty = await openComposer(browser, { width: 390, height: 844 }, "");
  try {
    const state = await empty.page.evaluate(() => ({
      activeTask: document.querySelector("[data-composer-task]")?.getAttribute("data-composer-task") ?? null,
      emptyRows: document.querySelectorAll(".journey-route-draft > li.is-empty").length,
      rows: document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length,
      title: document.querySelectorAll(".journey-title-field input").length,
      search: document.querySelectorAll(".journey-location-search input").length,
      entries: document.querySelectorAll("[data-composer-task-entry]").length,
      save: document.querySelectorAll(".journey-composer__footer-actions button").length,
    }));
    record("composer-mobile-ia:390:empty-route", { state, pageErrors: empty.pageErrors },
      state.activeTask === "primary"
      && state.rows === 0
      && state.emptyRows === 1
      && state.title === 1
      && state.search === 1
      // journey-info, media and the More control; the two More entries are
      // behind it and are covered by the entry/return checks above.
      && state.entries === 3
      && state.save >= 1
      && empty.pageErrors.length === 0);
  } finally {
    await empty.context.close();
  }

  // Desktop shares the architecture but keeps its inline layout: the task
  // surface must not leak into it.
  const desktop = await openComposer(browser, { width: 1280, height: 900 });
  try {
    const inline = await desktop.page.evaluate(() => ({
      mobileLayout: document.querySelector(".journey-composer")?.getAttribute("data-mobile-layout"),
      taskPanels: document.querySelectorAll("[data-composer-task]").length,
      narrative: document.querySelectorAll(".journey-composer__narrative").length,
      dates: document.querySelectorAll('input[type="date"]').length,
      lights: document.querySelectorAll(".journey-light-colors").length,
      precise: document.querySelectorAll(".journey-precise-location").length,
      picker: document.querySelectorAll(".journey-media-picker").length,
    }));
    record("composer-mobile-ia:desktop:inline-architecture", { inline },
      inline.mobileLayout === null
      && inline.taskPanels === 0
      && inline.narrative === 1
      && inline.dates === 2
      && inline.lights === 1
      && inline.precise === 1
      && inline.picker === 1
      && desktop.pageErrors.length === 0);
  } finally {
    await desktop.context.close();
  }
} finally {
  await browser.close();
}

await mkdir("artifacts/composer-mobile-ia", { recursive: true });
await writeFile("artifacts/composer-mobile-ia/results.json", `${JSON.stringify({
  baseUrl,
  manualGaps: [
    "A physical soft keyboard is not driven here: Chromium resizes the layout and visual viewport together. The available-height contract is exercised through --composer-available-height and a viewport shrink instead.",
    "Real device back-gesture behaviour is covered by the shared mobile surface history unit tests, not by this lane.",
  ],
  results,
}, null, 2)}\n`, "utf8");

console.error(`[qa-composer-mobile-ia] ${results.filter((row) => row.failed).length} failed of ${results.length}`);
process.exit(failed ? 1 : 0);
