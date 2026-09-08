import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const browser = await launchQaBrowser();
const checks = [];
let failed = false;
const organizerSelector = ".story-media-organizer";
const tileSelector = `${organizerSelector} .story-media-organizer__tile`;
const destinationSelector = `${organizerSelector} .story-media-organizer__destination`;
const journeyId = "00000000-0000-4000-8000-000000000001";
const sourcePointId = "00000000-0000-4000-8000-000000000004";
const destinationPointId = "00000000-0000-4000-8000-000000000005";
const assetId = (index) => `00000000-0000-4000-8000-00000000010${index}`;
const fixture = {
  id: journeyId, atlasId: "00000000-0000-4000-8000-000000000002",
  title: "媒体整理 QA", startedOn: "2026-08-11", endedOn: "2026-08-13",
  note: "有状态媒体归类与排序验证。", lightColor: "#77c8c2", revision: 1,
  createdByUserId: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
  coverMediaAssetId: assetId(0),
  routePoints: [
    { id: sourcePointId, label: "海岸起点", latitude: 1.29, longitude: 103.85 },
    { id: destinationPointId, label: "城市终点", latitude: 1.31, longitude: 103.87 },
  ].map((point, sortOrder) => ({
    ...point, journeyId, sortOrder, isStop: true, occurredAt: null, createdAt: "2026-08-11T00:00:00.000Z",
  })),
  media: Array.from({ length: 6 }, (_, index) => ({
    id: assetId(index), journeyId,
    routePointId: index < 3 ? sourcePointId : index === 3 ? destinationPointId : null,
    storageDriver: "qa", storageKey: `qa/seed-${index}.png`, fileName: `seed-${index}.png`,
    mimeType: "image/png", bytes: 68, sortOrder: index,
    uploadedByUserId: "00000000-0000-4000-8000-000000000003", createdAt: "2026-08-11T00:00:00.000Z",
  })),
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function record(name, details) {
  checks.push({ name, ...details });
  if (details.failed) failed = true;
}

try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 1, reducedMotion: "reduce",
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let currentJourney = structuredClone(fixture);
  const moveRequests = [], undoRequests = [], reorderRequests = [];
  let journeyReadCount = 0;
  let releaseMoveRequest = () => undefined;
  let holdNextMove = true;
  const ordered = () => [...currentJourney.media].sort((left, right) => left.sortOrder - right.sortOrder);
  const assignments = () => ordered().map(({ id, routePointId }) => ({ id, routePointId }));
  const saveMedia = (media) => {
    currentJourney = { ...currentJourney, revision: currentJourney.revision + 1,
      media: media.map((asset, sortOrder) => ({ ...asset, sortOrder })) };
  };
  const fulfill = (route, body, status = 200) => route.fulfill({
    status, contentType: "application/json", body: JSON.stringify(body),
  });
  await page.route("**/api/auth/get-session", (route) => fulfill(route, null));
  await page.route("**/api/journeys", (route) => {
    journeyReadCount += 1;
    return fulfill(route, { journeys: [currentJourney] });
  });
  await page.route("**/api/uploads/assets/*/read-url", (route) => fulfill(route, {
    url: onePixelGif, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  await page.route("**/api/uploads/assets/move", async (route) => {
    const input = route.request().postDataJSON();
    moveRequests.push(input);
    if (holdNextMove) {
      holdNextMove = false;
      await new Promise((resolve) => { releaseMoveRequest = resolve; });
    }
    const moving = new Set(input.assetIds), media = ordered();
    saveMedia([...media.filter((asset) => !moving.has(asset.id)),
      ...media.filter((asset) => moving.has(asset.id)).map((asset) => ({ ...asset, routePointId: input.routePointId }))]);
    await fulfill(route, { journey: currentJourney });
  });
  await page.route("**/api/uploads/assets/move/undo", async (route) => {
    const input = route.request().postDataJSON();
    undoRequests.push(input);
    const byId = new Map(currentJourney.media.map((asset) => [asset.id, asset]));
    const placements = new Map(input.assignments.map(({ assetId: id, routePointId }) => [id, routePointId]));
    const moved = new Set(placements.keys());
    const expectedOrder = [...input.assetOrder.filter((id) => !moved.has(id)), ...input.assetOrder.filter((id) => moved.has(id))];
    if (!same(ordered().map((asset) => asset.id), expectedOrder)
      || input.assignments.some(({ assetId: id }) => byId.get(id)?.routePointId !== input.expectedRoutePointId)) {
      await fulfill(route, { error: "MEDIA_MOVE_UNDO_STALE", message: "QA 撤销状态已过期" }, 409);
      return;
    }
    saveMedia(input.assetOrder.map((id) => ({ ...byId.get(id),
      routePointId: placements.has(id) ? placements.get(id) : byId.get(id).routePointId })));
    await fulfill(route, { journey: currentJourney });
  });
  await page.route("**/api/uploads/assets/reorder", async (route) => {
    const input = route.request().postDataJSON();
    reorderRequests.push(input);
    const byId = new Map(currentJourney.media.map((asset) => [asset.id, asset]));
    saveMedia(input.assetIds.map((id) => byId.get(id)));
    await fulfill(route, { journey: currentJourney });
  });

  try {
    // The standalone Story fixture synthesizes an upload on every refresh. The
    // Atlas fixture exercises mutation -> listJourneys -> actual rendered data.
    await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
    await page.locator(".mobile-v2__journey-chip").click();
    await page.locator(".mobile-v2__sheet").getByRole("button", { name: /打开故事/ }).click();
    const storyRoot = page.locator(".journey-story");
    await storyRoot.waitFor({ state: "visible" });
    const organizer = page.locator(organizerSelector);
    const moveSelectToggle = page.locator(".journey-story__media-select-toggle");
    const manageTrigger = page.locator(".journey-story__mobile-media-menu-trigger:visible").first();
    const tile = (index) => page.locator(`${tileSelector}[aria-label*="seed-${index}.png"]`);
    const destination = (name) => page.locator(destinationSelector).filter({
      has: page.locator(".story-media-organizer__destination-name", { hasText: name }),
    });
    const gridNames = () => page.locator(tileSelector).evaluateAll((tiles) => tiles.map((button) => (
      button.getAttribute("aria-label")?.match(/seed-\d+\.png/)?.[0] ?? "unknown"
    )));
    const readCounts = () => page.locator(destinationSelector).evaluateAll((cards) => Object.fromEntries(cards.map((card) => [
      card.querySelector(".story-media-organizer__destination-name")?.textContent?.trim(),
      Number(card.querySelector(".story-media-organizer__folder b")?.textContent),
    ])));
    const waitForCounts = (source, target, loose) => page.waitForFunction(({ selector, expected }) => {
      const cards = [...document.querySelectorAll(selector)];
      return cards.length === 3 && cards.every((card) => {
        const name = card.querySelector(".story-media-organizer__destination-name")?.textContent?.trim();
        return Number(card.querySelector(".story-media-organizer__folder b")?.textContent) === expected[name];
      });
    }, { selector: destinationSelector, expected: { 海岸起点: source, 城市终点: target, 旅程散页: loose } });
    const openMediaSheet = async () => {
      await page.waitForFunction(() => document.querySelector(".journey-story__mobile-media-menu-trigger")?.getAttribute("aria-label") === "管理当前媒体");
      await manageTrigger.click();
      const sheet = page.locator(".journey-story__mobile-media-sheet");
      await sheet.waitFor({ state: "visible" });
      return sheet;
    };
    const enterManage = async () => {
      await manageTrigger.click();
      await page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "manage");
    };
    const openReclassification = async () => {
      const sheet = await openMediaSheet();
      await sheet.getByRole("button", { name: "移动媒体 / 重新归类" }).click();
      await sheet.waitFor({ state: "detached" });
      await organizer.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector(".journey-story__media-select-toggle")?.getAttribute("aria-pressed") === "true");
    };
    const settledMove = async () => {
      await page.locator(".journey-story__move-undo").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector(".story-media-organizer")?.getAttribute("aria-busy") === "false"
        && document.querySelector(".journey-story__move-undo")?.disabled === false);
    };
    const undoMove = async () => {
      await page.locator(".journey-story__move-undo").click();
      await waitForCounts(3, 1, 2);
      await page.waitForFunction(() => document.querySelector(".journey-story__order-message")?.textContent?.includes("已撤销媒体移动"));
    };

    const viewerManageLabel = await manageTrigger.getAttribute("aria-label");
    record("story-mobile-media-reclassification-viewer-trigger", { viewerManageLabel, failed: viewerManageLabel !== "管理旅程" });
    await enterManage();
    const sheet = await openMediaSheet();
    const reclassify = sheet.getByRole("button", { name: "移动媒体 / 重新归类" });
    const organize = sheet.getByRole("button", { name: "整理媒体" });
    const reclassifyBox = await reclassify.boundingBox(), organizeBox = await organize.boundingBox();
    await reclassify.click();
    await sheet.waitFor({ state: "detached" });
    await organizer.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("journey-story__media-select-toggle"));
    const directMoveModeActive = await moveSelectToggle.getAttribute("aria-pressed") === "true";
    const directMoveTouchTarget = reclassifyBox ? Math.min(reclassifyBox.width, reclassifyBox.height) : 0;
    const organizeTouchTarget = organizeBox ? Math.min(organizeBox.width, organizeBox.height) : 0;
    record("story-mobile-media-reclassification-direct-entry", {
      directMoveModeActive, directMoveTouchTarget, organizeTouchTarget, destinations: await readCounts(),
      failed: !directMoveModeActive || directMoveTouchTarget < 44 || organizeTouchTarget < 44,
    });
    await waitForCounts(3, 1, 2);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer"
      && document.activeElement?.getAttribute("aria-label") === "管理旅程");
    await enterManage();
    await openReclassification();
    await page.evaluate(() => window.history.back());
    await page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-mobile-mode") === "viewer"
      && document.activeElement?.getAttribute("aria-label") === "管理旅程");
    record("story-mobile-media-reclassification-exit-contract", { escapeAndBackRestoreViewerFocus: true, failed: false });

    await enterManage();
    await openReclassification();
    const originalOrder = await gridNames(), originalAssignments = assignments();
    await tile(0).click();
    await tile(2).click();
    const selectedCount = await page.locator(`${tileSelector}[aria-pressed="true"]`).count();
    const targetLabel = await destination("城市终点").getAttribute("aria-label");
    const readsBeforeMove = journeyReadCount;
    const moveRequest = page.waitForRequest((request) => request.url().endsWith("/api/uploads/assets/move"));
    await destination("城市终点").click();
    await moveRequest;
    await page.waitForFunction(() => document.querySelector(".story-media-organizer")?.getAttribute("aria-busy") === "true");
    const noMoveConfirmation = await page.locator(".journey-story__media-move-confirm").count() === 0;
    await page.keyboard.press("Escape");
    const pendingState = { mode: await storyRoot.getAttribute("data-mobile-mode"),
      selected: await page.locator(`${tileSelector}[aria-pressed="true"]`).count(),
      enabledDestinations: await page.locator(`${destinationSelector}:not(:disabled)`).count(), counts: await readCounts() };
    releaseMoveRequest();
    await settledMove();
    await waitForCounts(1, 3, 2);
    const movedOrder = await gridNames();
    const routeCounts = await page.locator(".journey-story__route-points [data-route-point-id]").evaluateAll((buttons) => buttons.map((button) => Number(button.querySelector("small")?.textContent)));
    record("story-mobile-media-reclassification-direct-commit", {
      selectedCount, targetLabel, noMoveConfirmation, pendingState,
      request: moveRequests[0], counts: await readCounts(), routeCounts, movedOrder, refreshed: journeyReadCount > readsBeforeMove,
      failed: selectedCount !== 2 || !targetLabel?.includes("移入所选 2 项") || !noMoveConfirmation
        || pendingState.mode !== "manage" || pendingState.selected !== 2 || pendingState.enabledDestinations !== 0
        || pendingState.counts.海岸起点 !== 3 || pendingState.counts.城市终点 !== 1
        || moveRequests.length !== 1 || moveRequests[0].routePointId !== destinationPointId
        || !same(moveRequests[0].assetIds, [assetId(0), assetId(2)]) || journeyReadCount <= readsBeforeMove
        || !same(routeCounts, [1, 3]) || !same(movedOrder, ["seed-4.png", "seed-5.png", "seed-1.png", "seed-3.png", "seed-0.png", "seed-2.png"]),
    });
    await undoMove();
    const restoredOrder = await gridNames();
    record("story-mobile-media-reclassification-undo-restores-state", {
      request: undoRequests[0], restoredOrder, restoredAssignments: assignments(), counts: await readCounts(),
      failed: undoRequests.length !== 1 || undoRequests[0].expectedRoutePointId !== destinationPointId
        || !same(undoRequests[0].assetOrder, fixture.media.map((asset) => asset.id))
        || !same(restoredOrder, originalOrder) || !same(assignments(), originalAssignments),
    });

    // Use the real dnd-kit keyboard sensor, not HTML5 drag events or callbacks.
    // Aggregate Story order is loose media first, then route chapters. Seeds 1
    // and 2 are adjacent in the second row of the mobile three-column grid.
    const firstGrip = page.getByRole("button", { name: "拖动 seed-1.png：同地点排序，或移到目标卡片", exact: true });
    await firstGrip.scrollIntoViewIfNeeded();
    await firstGrip.focus();
    await page.keyboard.press("Space");
    await page.locator(".story-media-organizer__drag-stack").waitFor({ state: "visible" });
    await page.keyboard.press("ArrowRight");
    // Collision measurement and its accessible announcement settle after the
    // key event. Dropping immediately can still use the previous over target.
    await page.waitForFunction((id) => [...document.querySelectorAll('[id^="DndLiveRegion"]')]
      .some((node) => node.textContent?.includes(`over droppable area ${id}`)), assetId(2), { timeout: 3_000 })
      .catch(async (error) => {
        const targets = await page.locator('[id^="DndLiveRegion"]').allTextContents();
        throw new Error(`Keyboard sort did not select seed-2: ${JSON.stringify(targets)}`, { cause: error });
      });
    const reorderResponse = page.waitForResponse((response) => response.url().endsWith("/api/uploads/assets/reorder"));
    await page.keyboard.press("Space");
    await reorderResponse;
    await page.waitForFunction(({ selector }) => document.querySelectorAll(selector)[3]?.getAttribute("aria-label")?.includes("seed-2.png")
      && document.querySelector(".journey-story__media-select-toggle")?.disabled === false, { selector: tileSelector });
    const reorderedOrder = await gridNames();
    record("story-mobile-media-reclassification-same-chapter-reorder", {
      request: reorderRequests[0], reorderedOrder, counts: await readCounts(),
      failed: reorderRequests.length !== 1
        || !same(reorderRequests[0].assetIds, [0, 2, 1, 3, 4, 5].map(assetId))
        || !same(reorderedOrder, ["seed-4.png", "seed-5.png", "seed-0.png", "seed-2.png", "seed-1.png", "seed-3.png"])
        || currentJourney.media.some((asset) => fixture.media.find((original) => original.id === asset.id)?.routePointId !== asset.routePointId),
    });

    // A pointer drop reaches the same move transaction. Wait past the sensor's
    // 200 ms activation delay; never dispatch synthetic HTML5 drop events.
    await organizer.evaluate((element) => { element.scrollTop = 0; });
    const grip = page.getByRole("button", { name: "拖动 seed-0.png：同地点排序，或移到目标卡片", exact: true });
    await grip.scrollIntoViewIfNeeded();
    const start = await grip.boundingBox(), drop = await destination("旅程散页").boundingBox();
    if (!start || !drop) throw new Error("QA drag source or destination has no bounds");
    const beforeDragOrder = ordered().map((asset) => asset.id);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(240);
    await page.locator(".story-media-organizer__drag-stack").waitFor({ state: "visible" });
    await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 12 });
    const dragRequest = page.waitForRequest((request) => request.url().endsWith("/api/uploads/assets/move"));
    await page.mouse.up();
    await dragRequest;
    await settledMove();
    await waitForCounts(2, 1, 3);
    record("story-mobile-media-reclassification-drop-to-destination", {
      request: moveRequests[1], counts: await readCounts(),
      failed: moveRequests.length !== 2 || moveRequests[1].routePointId !== null
        || !same(moveRequests[1].assetIds, [assetId(0)]) || await page.locator(".journey-story__media-move-confirm").count() !== 0,
    });
    await undoMove();
    record("story-mobile-media-reclassification-drop-undo-keeps-reorder", {
      order: ordered().map((asset) => asset.id), renderedOrder: await gridNames(),
      failed: undoRequests.length !== 2 || !same(ordered().map((asset) => asset.id), beforeDragOrder)
        || !same(await gridNames(), reorderedOrder),
    });
    record("story-mobile-media-reclassification-runtime-errors", {
      consoleErrors, pageErrors, failed: consoleErrors.length > 0 || pageErrors.length > 0,
    });
  } finally {
    releaseMoveRequest();
    await page.close();
  }
} finally {
  console.log("Reclassification checks completed before exit:", JSON.stringify(checks));
  await browser.close();
}
console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
