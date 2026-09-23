// #291 - Route Point activation must reveal one truthful Atlas context surface
// before Story, without becoming a camera owner or inventing media locations.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const journeyId = "qa-context-journey";
const photoPointId = "qa-context-photo";
const secondPhotoPointId = "qa-context-photo-b";
const thirdPhotoPointId = "qa-context-photo-c";
const textPointId = "qa-context-text";
const photoAssetId = "qa-context-photo-asset";
const secondPhotoAssetId = "qa-context-photo-asset-b";
const thirdPhotoAssetId = "qa-context-photo-asset-c";
const siblingJourneyId = "qa-context-sibling-journey";
const siblingPointId = "qa-context-sibling-point";

const journey = {
  id: journeyId,
  atlasId: "qa-atlas",
  title: "维港的一天",
  startedOn: "2026-04-06",
  endedOn: null,
  note: "",
  lightColor: "#77c8c2",
  lightEffect: null,
  coverMediaAssetId: photoAssetId,
  revision: 1,
  createdByUserId: "qa-user",
  createdAt: "2026-04-06T00:00:00.000Z",
  updatedAt: "2026-04-06T00:00:00.000Z",
  routePoints: [
    {
      id: photoPointId,
      journeyId,
      sortOrder: 0,
      latitude: 22.2855,
      longitude: 114.1577,
      label: "中环码头",
      isStop: true,
      occurredAt: "2026-04-06T09:30:00.000Z",
      note: "海风很轻，船靠岸的时候没有说话。",
      createdAt: "2026-04-06T09:30:00.000Z",
    },
    {
      id: secondPhotoPointId,
      journeyId,
      sortOrder: 1,
      latitude: 22.2912,
      longitude: 114.1654,
      label: "西九龙",
      isStop: true,
      occurredAt: "2026-04-06T10:00:00.000Z",
      note: "第二段影像。",
      createdAt: "2026-04-06T10:00:00.000Z",
    },
    {
      id: thirdPhotoPointId,
      journeyId,
      sortOrder: 2,
      latitude: 22.2774,
      longitude: 114.1430,
      label: "山顶",
      isStop: true,
      occurredAt: "2026-04-06T10:30:00.000Z",
      note: "第三段影像。",
      createdAt: "2026-04-06T10:30:00.000Z",
    },
    {
      id: textPointId,
      journeyId,
      sortOrder: 3,
      latitude: 22.2931,
      longitude: 114.1694,
      label: "九龙海旁",
      isStop: true,
      occurredAt: null,
      note: "这一站只留下了一句话。",
      createdAt: "2026-04-06T11:00:00.000Z",
    },
  ],
  media: [
    {
      id: photoAssetId,
      journeyId,
      routePointId: photoPointId,
      storageDriver: "qa",
      storageKey: photoAssetId,
      fileName: "harbour.jpg",
      mimeType: "image/jpeg",
      bytes: 128,
      sortOrder: 0,
      uploadedByUserId: "qa-user",
      createdAt: "2026-04-06T09:31:00.000Z",
    },
    {
      id: secondPhotoAssetId, journeyId, routePointId: secondPhotoPointId, storageDriver: "qa",
      storageKey: secondPhotoAssetId, fileName: "kowloon.jpg", mimeType: "image/jpeg", bytes: 128,
      sortOrder: 1, uploadedByUserId: "qa-user", createdAt: "2026-04-06T10:01:00.000Z",
    },
    {
      id: thirdPhotoAssetId, journeyId, routePointId: thirdPhotoPointId, storageDriver: "qa",
      storageKey: thirdPhotoAssetId, fileName: "peak.jpg", mimeType: "image/jpeg", bytes: 128,
      sortOrder: 2, uploadedByUserId: "qa-user", createdAt: "2026-04-06T10:31:00.000Z",
    },
  ],
};

const siblingJourney = {
  ...journey,
  id: siblingJourneyId,
  title: "另一段可见旅程",
  coverMediaAssetId: null,
  revision: 1,
  routePoints: [{
    id: siblingPointId,
    journeyId: siblingJourneyId,
    sortOrder: 0,
    latitude: 22.31,
    longitude: 114.22,
    label: "另一段旅程的路线点",
    isStop: true,
    occurredAt: null,
    note: "",
    createdAt: "2026-04-05T10:00:00.000Z",
  }],
  media: [],
};

// The real-pointer round must start with personal Route Points on the product's
// naturally visible hemisphere. The long-form media/Story rounds below keep the
// Hong Kong fixture; this interaction-only projection uses the public Southwest
// geography from the original report instead of silently steering the camera to
// an off-screen test record before grading the hit surface.
const interactionJourney = {
  ...journey,
  title: "美国西南路线点命中",
  routePoints: journey.routePoints.map((point, index) => ({
    ...point,
    ...[
      { latitude: 34.0522, longitude: -118.2437, label: "洛杉矶" },
      { latitude: 36.1699, longitude: -115.1398, label: "拉斯维加斯" },
      { latitude: 36.0544, longitude: -112.1401, label: "大峡谷" },
      { latitude: 36.9147, longitude: -111.4558, label: "Page" },
    ][index],
  })),
};

const sameCoordinateJourneyId = "qa-same-coordinate-journey";
const same02Id = "qa-same-coordinate-02";
const same07Id = "qa-same-coordinate-07";
const SAME_LATITUDE = 22.2855;
const SAME_LONGITUDE = 114.1577;

function sameCoordinatePoint(id, sortOrder, latitude, longitude, label, note = null) {
  return {
    id,
    journeyId: sameCoordinateJourneyId,
    sortOrder,
    latitude,
    longitude,
    label,
    isStop: false,
    occurredAt: `2026-04-06T${String(8 + sortOrder).padStart(2, "0")}:00:00.000Z`,
    note,
    createdAt: `2026-04-06T${String(8 + sortOrder).padStart(2, "0")}:00:00.000Z`,
  };
}

const sameCoordinateRoutePoints = [
  sameCoordinatePoint("qa-same-coordinate-01", 0, 22.2801, 114.1501, "入口"),
  sameCoordinatePoint(same02Id, 1, SAME_LATITUDE, SAME_LONGITUDE, "码头 · 清晨", "清晨从这里经过。"),
  sameCoordinatePoint("qa-same-coordinate-03", 2, 22.2862, 114.1584, "码头 · 清晨"),
  sameCoordinatePoint("qa-same-coordinate-04", 3, 22.2872, 114.1594, "第四段"),
  sameCoordinatePoint("qa-same-coordinate-05", 4, 22.2882, 114.1604, "第五段"),
  sameCoordinatePoint("qa-same-coordinate-06", 5, 22.2892, 114.1614, "第六段"),
  sameCoordinatePoint(same07Id, 6, SAME_LATITUDE, SAME_LONGITUDE, "码头 · 夜里", "夜里又从这里经过。"),
  sameCoordinatePoint("qa-same-coordinate-08", 7, 22.2902, 114.1624, "出口"),
];

const sameCoordinateJourney = {
  id: sameCoordinateJourneyId,
  atlasId: "qa-atlas",
  title: "同一坐标的两段路线点上下文",
  startedOn: "2026-04-06",
  endedOn: null,
  note: "",
  lightColor: "#77c8c2",
  lightEffect: null,
  coverMediaAssetId: null,
  revision: 1,
  createdByUserId: "qa-user",
  createdAt: "2026-04-06T00:00:00.000Z",
  updatedAt: "2026-04-06T00:00:00.000Z",
  routePoints: sameCoordinateRoutePoints,
  media: [],
};

const sameCoordinateSuccessorJourneyId = "qa-same-coordinate-successor";
const sameCoordinateSuccessorJourney = {
  ...sameCoordinateJourney,
  id: sameCoordinateSuccessorJourneyId,
  title: "Later Journey owner",
  startedOn: "2026-04-07",
  revision: 1,
  routePoints: [{
    ...sameCoordinateRoutePoints[0],
    id: "qa-same-coordinate-successor-point",
    journeyId: sameCoordinateSuccessorJourneyId,
    sortOrder: 0,
    latitude: 22.31,
    longitude: 114.22,
    label: "Later owner point",
    occurredAt: "2026-04-07T09:00:00.000Z",
    note: null,
    createdAt: "2026-04-07T09:00:00.000Z",
  }],
  media: [],
};

const reorderedSameCoordinateJourney = {
  ...sameCoordinateJourney,
  revision: 2,
  routePoints: [
    sameCoordinateRoutePoints[0],
    sameCoordinateRoutePoints[6],
    sameCoordinateRoutePoints[2],
    sameCoordinateRoutePoints[3],
    sameCoordinateRoutePoints[4],
    sameCoordinateRoutePoints[5],
    sameCoordinateRoutePoints[1],
    sameCoordinateRoutePoints[7],
  ].map((point, index) => ({ ...point, sortOrder: index })),
};

const sameCoordinateGuestToken = "qaGuestShareToken0000000000000000000000000A";
const sharedSameCoordinateJourney = {
  id: sameCoordinateJourneyId,
  title: "共享的同坐标路线点",
  startedOn: "2026-04-06",
  endedOn: null,
  note: "",
  lightColor: "#77c8c2",
  lightEffect: null,
  coverMediaAssetId: null,
  revision: 1,
  previousJourneyId: null,
  nextJourneyId: null,
  routePoints: [
    { id: "qa-shared-prev", latitude: 22.2801, longitude: 114.1501, label: "共享入口", isStop: false, occurredAt: null, note: null },
    { id: same02Id, latitude: SAME_LATITUDE, longitude: SAME_LONGITUDE, label: "共享 · 清晨", isStop: false, occurredAt: null, note: "只分享清晨记录。" },
    { id: same07Id, latitude: SAME_LATITUDE, longitude: SAME_LONGITUDE, label: "共享 · 夜里", isStop: false, occurredAt: null, note: "只分享夜里记录。" },
    { id: "qa-shared-next", latitude: 22.2902, longitude: 114.1624, label: "共享出口", isStop: false, occurredAt: null, note: null },
  ],
  media: [],
};

const crossReadingJourneyId = "qa-cross-reading-journey";
const crossReadingAId = "qa-cross-reading-a";
const crossReadingBId = "qa-cross-reading-b";
const crossReadingCId = "qa-cross-reading-c";
const crossReadingTargetNote = "只是在这里读到第二段文字，不改变刚才的观察位置。";
const crossReadingJourney = {
  id: crossReadingJourneyId,
  atlasId: "qa-atlas",
  title: "跨路线点临时阅读",
  startedOn: "2026-05-01",
  endedOn: "2026-05-03",
  note: "",
  lightColor: "#77c8c2",
  lightEffect: null,
  coverMediaAssetId: null,
  revision: 1,
  createdByUserId: "qa-user",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-03T00:00:00.000Z",
  routePoints: [
    { id: crossReadingAId, journeyId: crossReadingJourneyId, sortOrder: 0, latitude: 22.28, longitude: 114.15, label: "来源 A", isStop: true, occurredAt: "2026-05-01T09:00:00.000Z", note: "A 的记录", createdAt: "2026-05-01T09:00:00.000Z" },
    { id: crossReadingBId, journeyId: crossReadingJourneyId, sortOrder: 1, latitude: 22.29, longitude: 114.16, label: "阅读目标 B", isStop: false, occurredAt: "2026-05-02T09:00:00.000Z", note: crossReadingTargetNote, createdAt: "2026-05-02T09:00:00.000Z" },
    { id: crossReadingCId, journeyId: crossReadingJourneyId, sortOrder: 2, latitude: 22.30, longitude: 114.17, label: "来源 C", isStop: true, occurredAt: "2026-05-03T09:00:00.000Z", note: "C 的记录", createdAt: "2026-05-03T09:00:00.000Z" },
  ],
  media: [],
};

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

async function stubAtlasApi(page, journeysPayload = [siblingJourney, journey]) {
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys: journeysPayload }),
  }));
  for (const [assetId, color, delay] of [
    [photoAssetId, "%23254a48", 120],
    [secondPhotoAssetId, "%234a3525", 20],
    [thirdPhotoAssetId, "%232c3555", 20],
  ]) {
    await page.route(`**/api/uploads/assets/${assetId}/read-url`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='${color}'/%3E%3C/svg%3E`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
  }
}

async function openFocusAtlas({
  viewport = { width: 1280, height: 720 },
  compact = false,
  reduceMotion = false,
  journeysPayload = [siblingJourney, journey],
  initialPointId = photoPointId,
  realScene = false,
} = {}) {
  const page = await browser.newPage({
    viewport,
    isMobile: compact,
    hasTouch: compact,
    reducedMotion: reduceMotion ? "reduce" : "no-preference",
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await stubAtlasApi(page, journeysPayload);
  // #291 grades the Atlas route-point activation/context contract, not scene
  // startup throughput. The earlier real-scene version timed out before ready in
  // CI, so this dedicated flag keeps the existing deterministic QA globe while
  // still invoking the production `onJourneyRoutePointActivate` callback. The
  // ordinary globe-chrome lane remains on the real globe and continues to own
  // raycast/focus-mode chrome coverage.
  const sceneParams = realScene ? "&qaRealRoutePointScene=1" : "&qaLite=1&qaSpatialHandoff=1";
  await page.goto(
    `${origin}/?qaState=living-atlas&qaMode=globe-chrome&qaRoutePointContext=1${sceneParams}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator("[data-qa-route-point-context-focus]").waitFor({ state: "attached", timeout: 20_000 });
  await page.locator(`[data-qa-route-point-context-activate="${initialPointId}"]`).waitFor({ state: "attached", timeout: 5_000 });
  if (!compact) {
    await page.locator(".living-atlas__active").waitFor({ state: "visible", timeout: 5_000 });
    if (realScene) {
      // The normal Atlas may still be showing the inferred Home Base camera even
      // though the latest Journey owns the active card. Select the Journey through
      // the real rail before grading its real pointer surface; this is the user
      // action that releases Home-owned camera composition, not a QA camera hack.
      const targetJourney = journeysPayload.find((candidate) => candidate.id === journeyId);
      if (!targetJourney) throw new Error(`missing real-scene Journey ${journeyId}`);
      const focusProbe = page.locator("[data-qa-route-point-context-focus]");
      const revisionBeforeSelection = Number(await focusProbe.getAttribute("data-focus-revision") ?? 0);
      await page.locator(".living-atlas__journey-rail button", { hasText: targetJourney.title }).first().click();
      await page.waitForFunction((before) => (
        Number(document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-revision") ?? 0) > before
      ), revisionBeforeSelection, { timeout: 5_000 });
    }
    await page.locator(".living-atlas__globe-focus").click();
    await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  } else {
    await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") === "on");
  }
  if (realScene) {
    // This round grades the Route Point pointer surface, so wait on that exact
    // interaction contract rather than the broader land-mask/coastline build.
    // A marker must be genuinely projected and visible before the pointer round
    // starts; if route projection never becomes usable this still fails closed.
    const realRoutePoint = page.locator(
      `.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id]:visible`,
    ).first();
    try {
      await realRoutePoint.waitFor({ state: "visible", timeout: 20_000 });
    } catch (error) {
      const diagnostics = await page.evaluate((targetJourneyId) => {
        const scene = document.querySelector(".particle-earth-scene");
        const layer = document.querySelector(".particle-earth-route-layer");
        const markers = [...document.querySelectorAll(
          `.particle-earth-route__point[data-journey-route="${targetJourneyId}"][data-route-point-id]`,
        )].map((marker) => {
          const element = marker;
          const group = element.closest(".particle-earth-route");
          const style = getComputedStyle(element);
          const groupStyle = group ? getComputedStyle(group) : null;
          const rect = element.getBoundingClientRect();
          return {
            id: element.getAttribute("data-route-point-id"),
            display: style.display,
            inlineDisplay: element.style.display || null,
            visibility: style.visibility,
            opacity: style.opacity,
            rect: [rect.left, rect.top, rect.width, rect.height],
            cx: element.getAttribute("cx"),
            cy: element.getAttribute("cy"),
            r: element.getAttribute("r"),
            temporal: element.getAttribute("data-temporal-reveal"),
            temporalVisible: element.getAttribute("data-temporal-visible"),
            groupOpacity: groupStyle?.opacity ?? null,
            groupTemporal: group?.getAttribute("data-temporal-reveal") ?? null,
            groupClass: group?.getAttribute("class") ?? null,
          };
        });
        const layerStyle = layer ? getComputedStyle(layer) : null;
        const layerRect = layer?.getBoundingClientRect();
        return {
          markerCount: markers.length,
          markers,
          layer: {
            opacity: layerStyle?.opacity ?? null,
            display: layerStyle?.display ?? null,
            visibility: layerStyle?.visibility ?? null,
            rect: layerRect ? [layerRect.left, layerRect.top, layerRect.width, layerRect.height] : null,
          },
          scene: scene ? {
            ready: scene.getAttribute("data-scene-ready"),
            routeFocusPhase: scene.getAttribute("data-route-focus-phase"),
            routeFocusLat: scene.getAttribute("data-route-focus-lat"),
            routeFocusLon: scene.getAttribute("data-route-focus-lon"),
            routeFocusZoom: scene.getAttribute("data-route-focus-zoom"),
            focusPointLat: scene.getAttribute("data-focus-point-lat"),
            focusPointLon: scene.getAttribute("data-focus-point-lon"),
            focusArrivalX: scene.getAttribute("data-focus-arrival-x"),
            focusArrivalY: scene.getAttribute("data-focus-arrival-y"),
            focusArrivalCenterX: scene.getAttribute("data-focus-arrival-center-x"),
            focusArrivalCenterY: scene.getAttribute("data-focus-arrival-center-y"),
            focusViewportCenterX: scene.getAttribute("data-focus-viewport-center-x"),
            focusViewportCenterY: scene.getAttribute("data-focus-viewport-center-y"),
            journeyRouteProjectionReady: window.__particleEarthDebug?.().journeyRouteProjectionReady ?? null,
          } : null,
          atlasGlobeFocus: document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") ?? null,
        };
      }, journeyId);
      throw new Error(`real Route Point never became visible: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
  } else {
    await page.waitForTimeout(80);
  }
  return { page, pageErrors };
}

async function sceneFocusSnapshot(page) {
  return page.locator("[data-qa-route-point-context-focus]").evaluate((host) => ({
    focusRevision: host.getAttribute("data-focus-revision"),
    focusPoint: host.getAttribute("data-focus-point"),
    focusRoute: host.getAttribute("data-focus-route"),
    activeRoute: host.getAttribute("data-active-route"),
  }));
}

async function activateRoutePointId(page, pointId) {
  const trigger = page.locator(`[data-qa-route-point-context-activate="${pointId}"]`);
  await trigger.waitFor({ state: "attached", timeout: 5_000 });
  await trigger.evaluate((button) => button.click());
}

async function activateRoutePoint(page, pointIndex) {
  const pointId = journey.routePoints[pointIndex]?.id;
  if (!pointId) throw new Error(`route point ${pointIndex} is unavailable`);
  await activateRoutePointId(page, pointId);
}

async function routePointActivationEvidence(page) {
  return page.locator(".particle-earth-scene").evaluate((host) => ({
    source: host.getAttribute("data-route-point-activation-source"),
    journeyId: host.getAttribute("data-route-point-activation-journey-id"),
    routePointId: host.getAttribute("data-route-point-activation-id"),
    eventTarget: host.getAttribute("data-route-point-activation-event-target"),
    clientX: Number(host.getAttribute("data-route-point-activation-client-x")),
    clientY: Number(host.getAttribute("data-route-point-activation-client-y")),
    projectedX: Number(host.getAttribute("data-route-point-activation-projected-x")),
    projectedY: Number(host.getAttribute("data-route-point-activation-projected-y")),
  }));
}

async function clickRoutePointMarker(page, routeId, pointId) {
  const marker = page.locator(`.particle-earth-route__point[data-journey-route="${routeId}"][data-route-point-id="${pointId}"]`);
  await marker.waitFor({ state: "visible", timeout: 5_000 });
  const box = await marker.boundingBox();
  if (!box) throw new Error(`Route Point ${pointId} has no projected marker geometry`);
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(target.x, target.y);
  return { box, target };
}

async function clickRoutePointLabel(page, routeId, pointId) {
  const label = page.locator(`.particle-earth-route__label[data-journey-route="${routeId}"][data-route-point-id="${pointId}"]`);
  await label.waitFor({ state: "visible", timeout: 5_000 });
  const hitTarget = label.locator(".particle-earth-route__label-hit");
  const box = await hitTarget.boundingBox();
  if (!box) throw new Error(`Route Point ${pointId} has no visible label hit geometry`);
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(target.x, target.y);
  return { box, target };
}

async function findBlankGlobePoint(page) {
  const target = await page.evaluate(() => {
    const debug = window.__particleEarthDebug?.();
    const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
    if (!debug || !(canvas instanceof HTMLCanvasElement)) return null;
    const markers = [...document.querySelectorAll(".particle-earth-route__point")]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const canvasRect = canvas.getBoundingClientRect();
    const centerX = canvasRect.left + debug.projectedGlobeCenterPx.x;
    const centerY = canvasRect.top + debug.projectedGlobeCenterPx.y;
    const radius = debug.projectedGlobeRadiusPx;
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const x = centerX + Math.cos(angle) * radius * 0.55;
      const y = centerY + Math.sin(angle) * radius * 0.55;
      const element = document.elementFromPoint(x, y);
      const clearOfMarkers = markers.every((rect) => {
        const markerX = rect.x + rect.width / 2;
        const markerY = rect.y + rect.height / 2;
        return Math.hypot(x - markerX, y - markerY) > 44;
      });
      if (element === canvas && clearOfMarkers) return { x, y };
    }
    return null;
  });
  if (!target) throw new Error("could not find an unobstructed blank globe surface point");
  return target;
}

async function clickBlankGlobe(page) {
  const target = await findBlankGlobePoint(page);
  await page.mouse.click(target.x, target.y);
  return target;
}

async function dragBlankGlobe(page) {
  const target = await findBlankGlobePoint(page);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 36, target.y + 18, { steps: 4 });
  await page.mouse.up();
  return target;
}

try {
  // Grade real pointer/keyboard interaction against whichever active-Journey
  // Route Point the current real camera actually exposes. Route Point context
  // must not require QA to move the product camera to an otherwise off-screen
  // record just to manufacture a hit target. The content-specific round below
  // still pins the canonical photo fixture.
  // Pointer identity is independent of the cinematic route-focus flight. Use the
  // product's supported reduced-motion path so this real-scene round waits on
  // projected hit geometry, not on SwiftShader frame throughput in CI.
  const interactionRun = await openFocusAtlas({
    realScene: true,
    reduceMotion: true,
    journeysPayload: [siblingJourney, interactionJourney],
  });
  const interactionPage = interactionRun.page;
  const interactionBeforeFocus = await sceneFocusSnapshot(interactionPage);

  // Owner P2: the globe can expose hit targets for sibling Journeys, but Route
  // Point context is subordinate to the existing semantic active-Journey owner.
  // Attempting B while A is active must not reveal B or move focus/camera state.
  const siblingTrigger = interactionPage.locator(`[data-qa-route-point-context-activate="${siblingPointId}"]`);
  await siblingTrigger.waitFor({ state: "attached", timeout: 5_000 });
  await siblingTrigger.evaluate((button) => button.click());
  const afterSiblingAttempt = await sceneFocusSnapshot(interactionPage);
  const siblingState = {
    contextCount: await interactionPage.locator("[data-route-point-context]").count(),
    activeRoute: afterSiblingAttempt.activeRoute,
  };
  record("sibling Journey Route Point cannot split semantic ownership", {
    beforeFocus: interactionBeforeFocus, afterSiblingAttempt, siblingState,
  },
    siblingState.contextCount === 0
    && siblingState.activeRoute === journeyId
    && JSON.stringify(interactionBeforeFocus) === JSON.stringify(afterSiblingAttempt));

  // The real globe owns camera composition. Choose a marker that is actually
  // projected into the current viewport instead of assuming the first Journey
  // record must be visible. This remains an actual pointer hit through the
  // production Three.js/SVG interaction path and binds every assertion to the
  // stable Route Point identity exposed by that hit target.
  const visibleMarker = interactionPage.locator(
    `.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id]:visible`,
  ).first();
  await visibleMarker.waitFor({ state: "visible", timeout: 5_000 });
  const markerPointId = await visibleMarker.getAttribute("data-route-point-id");
  if (!markerPointId) throw new Error("visible active-Journey Route Point marker has no stable id");
  const markerClick = await clickRoutePointMarker(interactionPage, journeyId, markerPointId);
  const interactionContext = interactionPage.locator("[data-route-point-context]");
  await interactionContext.waitFor({ state: "visible", timeout: 5_000 });
  const markerActivation = await routePointActivationEvidence(interactionPage);
  const selectedMarkerRole = await interactionPage.locator(
    `.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${markerPointId}"]`,
  ).getAttribute("data-attention-role");
  record("actual marker hit owns the same context identity", {
    markerPointId, markerClick, markerActivation, selectedMarkerRole,
  },
    markerActivation.source === "marker"
    && markerActivation.journeyId === journeyId
    && markerActivation.routePointId === markerPointId
    && markerActivation.eventTarget?.startsWith("canvas")
    && Math.abs(markerActivation.clientX - markerActivation.projectedX) < 12
    && Math.abs(markerActivation.clientY - markerActivation.projectedY) < 12
    && selectedMarkerRole === "selected");

  const interactionCloseButton = interactionContext.locator("[data-route-point-context-close]");
  const closeBox = await interactionCloseButton.boundingBox();
  await interactionCloseButton.click();
  await interactionContext.waitFor({ state: "detached", timeout: 5_000 });
  record("context close control is touch-safe and clears only the temporary selection", { closeBox }, Boolean(
    closeBox && closeBox.width >= 44 && closeBox.height >= 44
  ));

  // Labels have their own declutter/culling policy, so grade whichever stable
  // active-Journey label is actually visible rather than assuming it belongs to
  // the marker chosen above. Identity must survive that independent hit surface.
  const visibleLabel = interactionPage.locator(
    `.particle-earth-route__label[data-journey-route="${journeyId}"][data-route-point-id]:visible`,
  ).first();
  await visibleLabel.waitFor({ state: "visible", timeout: 5_000 });
  const labelPointId = await visibleLabel.getAttribute("data-route-point-id");
  if (!labelPointId) throw new Error("visible active-Journey Route Point label has no stable id");
  const labelClick = await clickRoutePointLabel(interactionPage, journeyId, labelPointId);
  await interactionContext.waitFor({ state: "visible", timeout: 5_000 });
  const labelActivation = await routePointActivationEvidence(interactionPage);
  record("actual label hit preserves stable Route Point identity", { labelPointId, labelClick, labelActivation },
    labelActivation.source === "label"
    && labelActivation.journeyId === journeyId
    && labelActivation.routePointId === labelPointId);
  const focusModeBeforeEscape = await interactionPage.locator(".living-atlas").getAttribute("data-globe-focus");
  await interactionPage.keyboard.press("Escape");
  await interactionContext.waitFor({ state: "detached", timeout: 5_000 });
  const focusModeAfterEscape = await interactionPage.locator(".living-atlas").getAttribute("data-globe-focus");
  record("Escape closes context without exiting globe focus", { focusModeBeforeEscape, focusModeAfterEscape },
    focusModeBeforeEscape === focusModeAfterEscape);

  const labelTrigger = interactionPage.locator(
    `.particle-earth-route__label[data-journey-route="${journeyId}"][data-route-point-id="${labelPointId}"]`,
  );
  await labelTrigger.focus();
  await labelTrigger.press("Enter");
  await interactionContext.waitFor({ state: "visible", timeout: 5_000 });
  const keyboardActivation = await routePointActivationEvidence(interactionPage);
  await interactionCloseButton.click();
  await interactionContext.waitFor({ state: "detached", timeout: 5_000 });
  const focusReturn = await interactionPage.evaluate(() => ({
    tag: document.activeElement?.tagName.toLowerCase() ?? null,
    routePointId: document.activeElement?.getAttribute("data-route-point-id") ?? null,
  }));
  record("keyboard label opens context and close restores the same legal trigger", { keyboardActivation, focusReturn },
    keyboardActivation.source === "keyboard-label"
    && keyboardActivation.routePointId === labelPointId
    && focusReturn.routePointId === labelPointId);

  await clickRoutePointMarker(interactionPage, journeyId, markerPointId);
  await interactionContext.waitFor({ state: "visible", timeout: 5_000 });
  const dragTarget = await dragBlankGlobe(interactionPage);
  const dragContextId = await interactionContext.getAttribute("data-route-point-id");
  record("globe drag does not dismiss or replace the selected context", { dragTarget, dragContextId },
    dragContextId === markerPointId);
  const blankTarget = await clickBlankGlobe(interactionPage);
  await interactionContext.waitFor({ state: "detached", timeout: 5_000 });
  record("non-gesture blank globe click closes context", { blankTarget }, true);
  record("real interaction page errors", { pageErrors: interactionRun.pageErrors }, interactionRun.pageErrors.length === 0);
  await interactionPage.close();

  // Keep the long-form context/Story/return regression on its deterministic QA
  // scene. The real-scene round above exclusively proves the new product hit
  // surfaces, while this round continues to pin the photo fixture whose media
  // and Story identity the historical #291 contract asserts.
  const photoRun = await openFocusAtlas();
  const { page } = photoRun;
  const beforeFocus = await sceneFocusSnapshot(page);
  const controlsBefore = await page.locator(".living-atlas-globe__controls").count();
  await activateRoutePoint(page, 0);
  const context = page.locator("[data-route-point-context]");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  const revealFocus = await sceneFocusSnapshot(page);
  const reveal = await context.evaluate((node) => ({
    count: document.querySelectorAll("[data-route-point-context]").length,
    routePointId: node.getAttribute("data-route-point-id"),
    precision: node.getAttribute("data-location-precision"),
    text: node.textContent ?? "",
    entryCount: node.querySelectorAll(".living-atlas__route-point-context-entry").length,
    controlsCount: document.querySelectorAll(".living-atlas-globe__controls").length,
  }));
  record("photo context reveal", { reveal },
    reveal.count === 1
    && reveal.routePointId === photoPointId
    && reveal.precision === "route-point"
    && reveal.text.includes("中环码头")
    && reveal.text.includes("1 项影像")
    && reveal.entryCount === 1
    && controlsBefore === 0
    && reveal.controlsCount === 0);
  record("context reveal keeps camera focus owner", { beforeFocus, revealFocus },
    JSON.stringify(beforeFocus) === JSON.stringify(revealFocus));

  await page.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  const readyFocus = await sceneFocusSnapshot(page);
  record("late representative readiness keeps camera focus owner", { revealFocus, readyFocus },
    JSON.stringify(revealFocus) === JSON.stringify(readyFocus));

  const marker = page.locator(`.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${photoPointId}"]`);
  await marker.waitFor({ state: "attached", timeout: 5_000 });
  const markerBefore = await marker.boundingBox();
  await page.locator(".living-atlas__route-point-context-entry").click();
  const departureAperture = page.locator("[data-place-media-observation]:not([data-shared-element-clone])");
  await departureAperture.waitFor({ state: "attached", timeout: 2_000 });
  const departureRect = await departureAperture.boundingBox();
  await page.locator(".journey-story").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${photoAssetId}"][data-media-page-ready="true"]`).waitFor({
    state: "attached", timeout: 5_000,
  });
  const storyIdentity = await page.locator(`.journey-story button[data-route-point-id="${photoPointId}"]`).evaluate((node) => ({
    pressed: node.getAttribute("aria-pressed"),
    label: node.textContent?.trim() ?? "",
  }));
  record("context entry preserves Journey + Route Point Story identity", { storyIdentity },
    storyIdentity.pressed === "true" && storyIdentity.label.includes("中环码头"));
  record("Route Point departure uses live geographic marker geometry", { markerBefore, departureRect }, Boolean(
    markerBefore && departureRect
    && Math.abs(departureRect.x - (markerBefore.x + markerBefore.width + 16)) < 28
    && Math.abs((departureRect.y + departureRect.height / 2) - (markerBefore.y + markerBefore.height / 2)) < 16
  ));

  // Camera/projection movement changes the SVG marker, not a stored React x/y.
  // Returning from Story must read this new geometry.
  await departureAperture.waitFor({ state: "detached", timeout: 5_000 });
  await marker.evaluate((node) => {
    node.setAttribute("cx", "470");
    node.setAttribute("cy", "250");
  });
  const markerAfterMove = await marker.boundingBox();
  await page.getByRole("button", { name: "退出旅程故事" }).click();
  const returnAperture = page.locator("[data-place-media-observation]:not([data-shared-element-clone])");
  await returnAperture.waitFor({ state: "attached", timeout: 2_000 });
  const returnRect = await returnAperture.boundingBox();
  record("Story return remeasures the current Route Point instead of stale opening coordinates", {
    markerBefore, markerAfterMove, departureRect, returnRect,
  }, Boolean(
    markerBefore && markerAfterMove && departureRect && returnRect
    && Math.abs(returnRect.x - (markerAfterMove.x + markerAfterMove.width + 16)) < 28
    && Math.abs(returnRect.x - departureRect.x) > 120
  ));
  await page.locator("[data-route-point-context]").waitFor({ state: "visible", timeout: 5_000 });
  record("photo page errors", { pageErrors: photoRun.pageErrors }, photoRun.pageErrors.length === 0);
  await page.close();

  // Cross-point ownership: latest Story observation, not the opening context,
  // owns the return place. Also prove fullscreen/back preserves that identity.
  const crossRun = await openFocusAtlas();
  const crossPage = crossRun.page;
  await activateRoutePoint(crossPage, 0);
  await crossPage.locator(`[data-route-point-context][data-route-point-id="${photoPointId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  await crossPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  await crossPage.locator(".living-atlas__route-point-context-entry").click();
  await crossPage.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${photoAssetId}"][data-media-page-ready="true"]`).waitFor({ state: "attached", timeout: 5_000 });

  await crossPage.locator(`.journey-story button[data-route-point-id="${secondPhotoPointId}"]`).click();
  await crossPage.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${secondPhotoAssetId}"][data-media-page-ready="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await crossPage.locator(".journey-story__fullscreen-entry").click();
  await crossPage.locator(".journey-story-fullscreen:not([hidden])").waitFor({ state: "visible", timeout: 5_000 });
  await crossPage.keyboard.press("Escape");
  await crossPage.waitForFunction(() => document.querySelector(".journey-story-fullscreen")?.hasAttribute("hidden"));
  const markerB = crossPage.locator(`.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${secondPhotoPointId}"]`);
  const markerBRect = await markerB.boundingBox();
  await crossPage.locator(".journey-story__close").click();
  const returnB = crossPage.locator("[data-place-media-observation]:not([data-shared-element-clone])");
  await returnB.waitFor({ state: "attached", timeout: 2_000 });
  const returnBRect = await returnB.boundingBox();
  await crossPage.locator(`[data-route-point-context][data-route-point-id="${secondPhotoPointId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  record("A -> B + fullscreen/back returns to current Story observation B", { markerBRect, returnBRect }, Boolean(
    markerBRect && returnBRect
    && Math.abs(returnBRect.x - (markerBRect.x + markerBRect.width + 16)) < 28
  ));
  await returnB.waitFor({ state: "detached", timeout: 5_000 });

  // Rapid supersession: B may render briefly, but C must be the only return
  // owner once C becomes the latest ready Story observation.
  await activateRoutePoint(crossPage, 0);
  await crossPage.locator(`[data-route-point-context][data-route-point-id="${photoPointId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  await crossPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  await crossPage.locator(".living-atlas__route-point-context-entry").click();
  await crossPage.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${photoAssetId}"][data-media-page-ready="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await crossPage.locator(`.journey-story button[data-route-point-id="${secondPhotoPointId}"]`).click();
  await crossPage.locator(`.journey-story button[data-route-point-id="${thirdPhotoPointId}"]`).click();
  await crossPage.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${thirdPhotoAssetId}"][data-media-page-ready="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await crossPage.locator(`.journey-story button[data-route-point-id="${thirdPhotoPointId}"][aria-pressed="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await crossPage.waitForTimeout(50);
  const markerC = crossPage.locator(`.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${thirdPhotoPointId}"]`);
  const markerCRect = await markerC.boundingBox();
  await crossPage.locator(".journey-story__close").click();
  const returnC = crossPage.locator("[data-place-media-observation]:not([data-shared-element-clone])");
  await returnC.waitFor({ state: "attached", timeout: 2_000 });
  const returnCRect = await returnC.boundingBox();
  await crossPage.locator(`[data-route-point-context][data-route-point-id="${thirdPhotoPointId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  record("rapid A -> B -> C leaves C as the only return owner", { markerCRect, returnCRect }, Boolean(
    markerCRect && returnCRect
    && Math.abs(returnCRect.x - (markerCRect.x + markerCRect.width + 16)) < 28
  ));
  record("cross-point page errors", { pageErrors: crossRun.pageErrors }, crossRun.pageErrors.length === 0);
  await crossPage.close();

  // #377 / ST-081: two distinct Route Point records may share one exact
  // canonical coordinate inside the CURRENT authorized Journey. Switching the
  // content owner must preserve Atlas/camera ownership and the route-order
  // context of the selected record; repeated coordinates are not a new visit.
  const sameRun = await openFocusAtlas({
    journeysPayload: [sameCoordinateJourney],
    initialPointId: same02Id,
  });
  const samePage = sameRun.page;
  const sameFocusBefore = await sceneFocusSnapshot(samePage);
  await samePage.evaluate(() => {
    window.__st081AtlasRoot = document.querySelector(".living-atlas");
  });
  await activateRoutePointId(samePage, same02Id);
  const sameContext = samePage.locator("[data-route-point-context]");
  await sameContext.waitFor({ state: "visible", timeout: 5_000 });
  const initialSameState = await sameContext.evaluate((node) => ({
    routePointId: node.getAttribute("data-route-point-id"),
    text: node.textContent ?? "",
    switchIds: [...node.querySelectorAll("[data-route-point-context-switch]")].map((button) => ({
      id: button.getAttribute("data-route-point-context-switch"),
      pressed: button.getAttribute("aria-pressed"),
      text: button.textContent ?? "",
      height: button.getBoundingClientRect().height,
    })),
    order: node.querySelector("[data-route-point-context-order]")?.textContent ?? "",
  }));
  const marker02 = samePage.locator(`.particle-earth-route__point[data-journey-route="${sameCoordinateJourneyId}"][data-route-point-id="${same02Id}"]`);
  const marker07 = samePage.locator(`.particle-earth-route__point[data-journey-route="${sameCoordinateJourneyId}"][data-route-point-id="${same07Id}"]`);
  const [marker02Rect, marker07Rect] = await Promise.all([marker02.boundingBox(), marker07.boundingBox()]);
  record("same-coordinate entry keeps record 02 selected and exposes only exact-coordinate peers", { initialSameState },
    initialSameState.routePointId === same02Id
    && initialSameState.switchIds.length === 2
    && initialSameState.switchIds.map((entry) => entry.id).join(",") === `${same02Id},${same07Id}`
    && initialSameState.switchIds[0]?.pressed === "true"
    && initialSameState.switchIds[1]?.pressed === "false"
    && initialSameState.switchIds.every((entry) => entry.height >= 44)
    && initialSameState.text.includes("码头 · 清晨")
    && initialSameState.text.includes("清晨从这里经过。")
    && initialSameState.order.includes("上一段 · 入口")
    && initialSameState.order.includes("下一段 · 码头 · 清晨")
    && !initialSameState.switchIds.some((entry) => entry.text.includes("停靠点")));
  record("records 02 and 07 share the original geographic anchor", { marker02Rect, marker07Rect }, Boolean(
    marker02Rect && marker07Rect
    && Math.abs((marker02Rect.x + marker02Rect.width / 2) - (marker07Rect.x + marker07Rect.width / 2)) < 0.5
    && Math.abs((marker02Rect.y + marker02Rect.height / 2) - (marker07Rect.y + marker07Rect.height / 2)) < 0.5
  ));

  await samePage.locator(`[data-route-point-context-switch="${same07Id}"]`).click();
  await samePage.waitForFunction((id) => document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") === id, same07Id);
  const seventhState = await sameContext.evaluate((node) => ({
    routePointId: node.getAttribute("data-route-point-id"),
    text: node.textContent ?? "",
    pressed: node.querySelector('[data-route-point-context-switch][aria-pressed="true"]')?.getAttribute("data-route-point-context-switch") ?? null,
    order: node.querySelector("[data-route-point-context-order]")?.textContent ?? "",
  }));
  const sameFocusAt07 = await sceneFocusSnapshot(samePage);
  const sameAtlasPreservedAt07 = await samePage.evaluate(() => window.__st081AtlasRoot === document.querySelector(".living-atlas"));
  record("02 -> 07 switches Route Point context without remounting Atlas or moving camera", {
    sameFocusBefore, sameFocusAt07, seventhState, sameAtlasPreservedAt07,
  },
    seventhState.routePointId === same07Id
    && seventhState.pressed === same07Id
    && seventhState.text.includes("码头 · 夜里")
    && seventhState.text.includes("夜里又从这里经过。")
    && seventhState.order.includes("上一段 · 第六段")
    && seventhState.order.includes("下一段 · 出口")
    && sameAtlasPreservedAt07
    && JSON.stringify(sameFocusBefore) === JSON.stringify(sameFocusAt07));

  await samePage.locator(`[data-route-point-context-switch="${same02Id}"]`).click();
  await samePage.waitForFunction((id) => document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") === id, same02Id);
  const sameFocusBack02 = await sceneFocusSnapshot(samePage);
  const sameAtlasPreservedBack02 = await samePage.evaluate(() => window.__st081AtlasRoot === document.querySelector(".living-atlas"));
  record("rapid 02 -> 07 -> 02 returns content ownership only", { sameFocusBefore, sameFocusBack02, sameAtlasPreservedBack02 },
    sameAtlasPreservedBack02 && JSON.stringify(sameFocusBefore) === JSON.stringify(sameFocusBack02));
  const timeTrack = samePage.locator(".globe-time-scrubber__track");
  await timeTrack.focus();
  // Approach the partial-reveal state from the present so the already-open
  // record 02 never crosses through a future state before we grade the switcher.
  await timeTrack.press("End");
  for (let step = 0; step < 3; step += 1) await timeTrack.press("PageDown");
  await samePage.waitForFunction(() => document.querySelector(".globe-time-scrubber__track")?.getAttribute("aria-valuenow") === "70");
  const rewindVisibleState = await samePage.evaluate((futureId) => ({
    contextId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
    switcherCount: document.querySelectorAll("[data-route-point-context-switcher]").length,
    futureSwitchCount: document.querySelectorAll(`[data-route-point-context-switch="${futureId}"]`).length,
    cursor: document.querySelector(".globe-time-scrubber__track")?.getAttribute("aria-valuenow"),
  }), same07Id);
  record("rewind hides future same-coordinate switch targets without changing current record", { rewindVisibleState },
    rewindVisibleState.contextId === same02Id
    && rewindVisibleState.switcherCount === 0
    && rewindVisibleState.futureSwitchCount === 0
    && rewindVisibleState.cursor === "70");

  await timeTrack.press("End");
  for (let step = 0; step < 5; step += 1) await timeTrack.press("ArrowLeft");
  await samePage.waitForFunction(() => document.querySelector(".globe-time-scrubber__track")?.getAttribute("aria-valuenow") === "95");
  await samePage.locator(`[data-route-point-context-switch="${same07Id}"]`).click();
  await samePage.waitForFunction((id) => document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") === id, same07Id);
  const futureNeighbourState = await samePage.evaluate((futureLabel) => {
    const order = document.querySelector("[data-route-point-context-order]");
    const labels = order ? [...order.querySelectorAll("span")].map((span) => span.textContent ?? "") : [];
    return {
      contextId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
      cursor: document.querySelector(".globe-time-scrubber__track")?.getAttribute("aria-valuenow"),
      orderLabels: labels,
      futureLabelLeaked: labels.some((label) => label.includes(futureLabel)),
    };
  }, sameCoordinateRoutePoints[7].label);
  record("rewind hides a future route-order neighbour label from selected same-coordinate context", { futureNeighbourState },
    futureNeighbourState.contextId === same07Id
    && futureNeighbourState.cursor === "95"
    && futureNeighbourState.orderLabels.length === 1
    && !futureNeighbourState.futureLabelLeaked);

  await timeTrack.press("Home");
  await samePage.waitForFunction(() => document.querySelector("[data-route-point-context]") === null);
  const rewindBeforeCurrent = await samePage.evaluate(() => ({
    contextCount: document.querySelectorAll("[data-route-point-context]").length,
    cursor: document.querySelector(".globe-time-scrubber__track")?.getAttribute("aria-valuenow"),
  }));
  record("rewind releases a context once its selected Route Point becomes future", { rewindBeforeCurrent },
    rewindBeforeCurrent.contextCount === 0 && rewindBeforeCurrent.cursor === "0");

  record("same-coordinate page errors", { pageErrors: sameRun.pageErrors }, sameRun.pageErrors.length === 0);
  await samePage.close();

  const ownerRun = await openFocusAtlas({
    journeysPayload: [sameCoordinateJourney, sameCoordinateSuccessorJourney],
    initialPointId: same02Id,
  });
  const ownerPage = ownerRun.page;
  const ownerTrack = ownerPage.locator(".globe-time-scrubber__track");
  await ownerTrack.focus();
  await ownerTrack.press("Home");
  for (let step = 0; step < 7; step += 1) await ownerTrack.press("PageUp");
  await ownerPage.waitForFunction(() => document.querySelector(".globe-time-scrubber__track")?.getAttribute("aria-valuenow") === "70");
  await ownerPage.waitForFunction((journeyId) => document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route") === journeyId, sameCoordinateJourneyId);
  await activateRoutePointId(ownerPage, same02Id);
  await ownerPage.locator(`[data-route-point-context][data-route-point-id="${same02Id}"]`).waitFor({ state: "visible", timeout: 5_000 });
  const ownerBeforeAdvance = await sceneFocusSnapshot(ownerPage);
  await ownerPage.evaluate((successorJourneyId) => {
    window.__st081OwnerLeak = false;
    const observer = new MutationObserver(() => {
      const activeRoute = document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route");
      if (activeRoute === successorJourneyId && document.querySelector("[data-route-point-context]")) {
        window.__st081OwnerLeak = true;
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-active-route"] });
    window.__st081OwnerObserver = observer;
  }, sameCoordinateSuccessorJourneyId);
  await ownerTrack.press("End");
  await ownerPage.waitForFunction((journeyId) => document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route") === journeyId, sameCoordinateSuccessorJourneyId);
  await ownerPage.waitForFunction(() => document.querySelector("[data-route-point-context]") === null);
  const ownerAfterAdvance = await sceneFocusSnapshot(ownerPage);
  const ownerTransitionState = await ownerPage.evaluate(() => {
    const staleOwnerRendered = window.__st081OwnerLeak === true;
    window.__st081OwnerObserver?.disconnect();
    delete window.__st081OwnerObserver;
    delete window.__st081OwnerLeak;
    return { staleOwnerRendered };
  });
  record("time cursor Journey-owner advance releases stale same-coordinate context", {
    ownerBeforeAdvance,
    ownerAfterAdvance,
    ownerTransitionState,
    contextCount: await ownerPage.locator("[data-route-point-context]").count(),
  }, ownerBeforeAdvance.activeRoute === sameCoordinateJourneyId
    && ownerAfterAdvance.activeRoute === sameCoordinateSuccessorJourneyId
    && ownerTransitionState.staleOwnerRendered === false
    && await ownerPage.locator("[data-route-point-context]").count() === 0);
  record("same-coordinate owner-change page errors", { pageErrors: ownerRun.pageErrors }, ownerRun.pageErrors.length === 0);
  await ownerPage.close();

  const reorderedRun = await openFocusAtlas({
    journeysPayload: [reorderedSameCoordinateJourney],
    initialPointId: same07Id,
  });
  const reorderedPage = reorderedRun.page;
  await activateRoutePointId(reorderedPage, same07Id);
  const reorderedContext = reorderedPage.locator("[data-route-point-context]");
  await reorderedContext.waitFor({ state: "visible", timeout: 5_000 });
  const reorderedState = await reorderedContext.evaluate((node) => ({
    text: node.textContent ?? "",
    switches: [...node.querySelectorAll("[data-route-point-context-switch]")].map((button) => button.getAttribute("data-route-point-context-switch")),
    order: node.querySelector("[data-route-point-context-order]")?.textContent ?? "",
  }));
  record("reordered payload recomputes same-coordinate record order and neighbours", { reorderedState },
    reorderedState.text.includes("ROUTE POINT · 02/08")
    && reorderedState.switches.join(",") === `${same07Id},${same02Id}`
    && reorderedState.order.includes("上一段 · 入口")
    && reorderedState.order.includes("下一段 · 码头 · 清晨"));
  record("reordered same-coordinate page errors", { pageErrors: reorderedRun.pageErrors }, reorderedRun.pageErrors.length === 0);
  await reorderedPage.close();

  const sameReducedRun = await openFocusAtlas({
    journeysPayload: [sameCoordinateJourney],
    initialPointId: same02Id,
    reduceMotion: true,
  });
  const sameReducedPage = sameReducedRun.page;
  const sameReducedFocusBefore = await sceneFocusSnapshot(sameReducedPage);
  await activateRoutePointId(sameReducedPage, same02Id);
  await sameReducedPage.locator("[data-route-point-context]").waitFor({ state: "visible", timeout: 5_000 });
  await sameReducedPage.locator(`[data-route-point-context-switch="${same07Id}"]`).click();
  await sameReducedPage.waitForFunction((id) => document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") === id, same07Id);
  const sameReducedState = await sameReducedPage.evaluate(() => ({
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    clones: document.querySelectorAll("[data-shared-element-clone]").length,
  }));
  const sameReducedFocusAfter = await sceneFocusSnapshot(sameReducedPage);
  record("reduced motion switches same-coordinate content without spatial ownership", {
    sameReducedState, sameReducedFocusBefore, sameReducedFocusAfter,
  }, sameReducedState.reduced
    && sameReducedState.clones === 0
    && JSON.stringify(sameReducedFocusBefore) === JSON.stringify(sameReducedFocusAfter));
  record("same-coordinate reduced-motion page errors", { pageErrors: sameReducedRun.pageErrors }, sameReducedRun.pageErrors.length === 0);
  await sameReducedPage.close();

  // ST-082 / #378: adjacent note reading is transient and source-bound. The
  // same target can be read from two legitimate sources without rewriting the
  // committed Route Point context; only explicit Story escalation may commit it.
  const readingRun = await openFocusAtlas({
    journeysPayload: [crossReadingJourney],
    initialPointId: crossReadingAId,
  });
  const readingPage = readingRun.page;
  await activateRoutePointId(readingPage, crossReadingAId);
  await readingPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingAId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  await readingPage.locator(`[data-cross-point-reading-open="${crossReadingBId}"]`).click();
  const readingSurface = readingPage.locator("[data-cross-point-reading]");
  await readingSurface.waitFor({ state: "visible", timeout: 5_000 });
  const fromAState = await readingSurface.evaluate((node) => ({
    source: node.getAttribute("data-cross-point-reading-source"),
    target: node.getAttribute("data-cross-point-reading-target"),
    text: node.textContent ?? "",
    underlyingContext: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
    mediaCount: Number(node.getAttribute("data-cross-point-reading-media-count")),
  }));
  record("cross-point reading from A keeps provenance and committed source", { fromAState },
    fromAState.source === crossReadingAId
    && fromAState.target === crossReadingBId
    && fromAState.underlyingContext === crossReadingAId
    && fromAState.text.includes(crossReadingTargetNote)
    && fromAState.text.includes("跨路线点临时阅读")
    && fromAState.mediaCount === 0);

  await readingPage.keyboard.press("Escape");
  await readingPage.waitForFunction(() => document.querySelector("[data-cross-point-reading]") === null);
  record("Escape closes transient reading back to source A", {},
    await readingPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingAId}"]`).count() === 1);

  await activateRoutePointId(readingPage, crossReadingCId);
  await readingPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingCId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  await readingPage.locator(`[data-cross-point-reading-open="${crossReadingBId}"]`).click();
  await readingSurface.waitFor({ state: "visible", timeout: 5_000 });
  const fromCState = await readingSurface.evaluate((node) => ({
    source: node.getAttribute("data-cross-point-reading-source"),
    target: node.getAttribute("data-cross-point-reading-target"),
    underlyingContext: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
  }));
  record("the same note restores a distinct legitimate source C", { fromCState },
    fromCState.source === crossReadingCId
    && fromCState.target === crossReadingBId
    && fromCState.underlyingContext === crossReadingCId);
  await readingPage.locator("[data-cross-point-reading-close]").click();
  await readingPage.waitForFunction(() => document.querySelector("[data-cross-point-reading]") === null);
  record("explicit close returns to source C", {},
    await readingPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingCId}"]`).count() === 1);

  await readingPage.locator(`[data-cross-point-reading-open="${crossReadingBId}"]`).click();
  await readingSurface.waitFor({ state: "visible", timeout: 5_000 });
  await readingPage.evaluate(() => window.history.back());
  await readingPage.waitForFunction(() => document.querySelector("[data-cross-point-reading]") === null);
  record("Browser Back closes only transient reading and keeps source C", {},
    await readingPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingCId}"]`).count() === 1);

  await readingPage.locator(`[data-cross-point-reading-open="${crossReadingBId}"]`).click();
  await readingSurface.waitFor({ state: "visible", timeout: 5_000 });
  await readingPage.locator("[data-cross-point-reading-escalate]").click();
  await readingPage.locator(".journey-story").waitFor({ state: "visible", timeout: 5_000 });
  await readingPage.locator(`.journey-story button[data-route-point-id="${crossReadingBId}"][aria-pressed="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  const escalatedStory = await readingPage.locator(".journey-story").evaluate((node) => ({
    text: node.textContent ?? "",
    transientReaderCount: document.querySelectorAll("[data-cross-point-reading]").length,
  }));
  record("explicit Story escalation owns target B and leaves transient reader", { escalatedStory },
    escalatedStory.text.includes(crossReadingTargetNote)
    && escalatedStory.transientReaderCount === 0);
  await readingPage.locator(".journey-story__close").click();
  await readingPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingBId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  record("Story escalation may commit target B under the existing return contract", {},
    await readingPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingBId}"]`).count() === 1);
  record("cross-point reading page errors", { pageErrors: readingRun.pageErrors }, readingRun.pageErrors.length === 0);
  await readingPage.close();

  const readingReducedRun = await openFocusAtlas({
    journeysPayload: [crossReadingJourney],
    initialPointId: crossReadingAId,
    reduceMotion: true,
  });
  const readingReducedPage = readingReducedRun.page;
  await activateRoutePointId(readingReducedPage, crossReadingAId);
  await readingReducedPage.locator(`[data-cross-point-reading-open="${crossReadingBId}"]`).click();
  await readingReducedPage.locator("[data-cross-point-reading]").waitFor({ state: "visible", timeout: 5_000 });
  const reducedReadingState = await readingReducedPage.evaluate(() => ({
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    clones: document.querySelectorAll("[data-shared-element-clone]").length,
    source: document.querySelector("[data-cross-point-reading]")?.getAttribute("data-cross-point-reading-source") ?? null,
  }));
  await readingReducedPage.keyboard.press("Escape");
  await readingReducedPage.waitForFunction(() => document.querySelector("[data-cross-point-reading]") === null);
  record("reduced motion keeps transient reading nonspatial and returns to A", { reducedReadingState },
    reducedReadingState.reduced
    && reducedReadingState.clones === 0
    && reducedReadingState.source === crossReadingAId
    && await readingReducedPage.locator(`[data-route-point-context][data-route-point-id="${crossReadingAId}"]`).count() === 1);
  record("cross-point reduced-motion page errors", { pageErrors: readingReducedRun.pageErrors }, readingReducedRun.pageErrors.length === 0);
  await readingReducedPage.close();

  const readingMobileRun = await openFocusAtlas({
    viewport: { width: 390, height: 844 },
    compact: true,
    journeysPayload: [crossReadingJourney],
    initialPointId: crossReadingAId,
  });
  const readingMobilePage = readingMobileRun.page;
  await activateRoutePointId(readingMobilePage, crossReadingAId);
  await readingMobilePage.locator(`[data-cross-point-reading-open="${crossReadingBId}"]`).click();
  const mobileReadingSurface = readingMobilePage.locator("[data-cross-point-reading]");
  await mobileReadingSurface.waitFor({ state: "visible", timeout: 5_000 });
  const mobileReadingChromeState = await readingMobilePage.evaluate(() => {
    const layer = document.querySelector("[data-cross-point-reading-layer]");
    const header = document.querySelector(".mobile-v2__header");
    const chrome = document.querySelector(".mobile-v2__chrome");
    const close = document.querySelector("[data-cross-point-reading-close]");
    const escalate = document.querySelector("[data-cross-point-reading-escalate]");
    const hitOwner = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit instanceof Element ? hit.closest("button") : null;
    };
    return {
      layerZ: layer ? Number(getComputedStyle(layer).zIndex) : null,
      headerZ: header ? Number(getComputedStyle(header).zIndex) : null,
      chromeZ: chrome ? Number(getComputedStyle(chrome).zIndex) : null,
      closeOwnsHit: hitOwner(close) === close,
      escalateOwnsHit: hitOwner(escalate) === escalate,
    };
  });
  record("mobile transient reader stays above persistent chrome and owns pointer hits", { mobileReadingChromeState },
    mobileReadingChromeState.layerZ > mobileReadingChromeState.headerZ
    && mobileReadingChromeState.layerZ > mobileReadingChromeState.chromeZ
    && mobileReadingChromeState.closeOwnsHit
    && mobileReadingChromeState.escalateOwnsHit);
  await readingMobilePage.keyboard.press("Escape");
  await readingMobilePage.waitForFunction(() => document.querySelector("[data-cross-point-reading]") === null);
  record("cross-point mobile page errors", { pageErrors: readingMobileRun.pageErrors }, readingMobileRun.pageErrors.length === 0);
  await readingMobilePage.close();

  const guestPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const guestPageErrors = [];
  let guestOwnerRouteHits = 0;
  guestPage.on("pageerror", (error) => guestPageErrors.push(error.message));
  await guestPage.route("**/api/shared/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "private, no-store" },
    body: JSON.stringify({
      share: { expiresAt: "2036-10-10T10:30:00.000Z", journeyCount: 1 },
      journeys: [sharedSameCoordinateJourney],
    }),
  }));
  await guestPage.route("**/api/shared/assets/*/read-url", (route) => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "MEDIA_UNAVAILABLE", message: "Media unavailable" }),
  }));
  await guestPage.route("**/api/journeys**", (route) => {
    guestOwnerRouteHits += 1;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "OWNER_ROUTE_REACHED" }),
    });
  });
  await guestPage.route("**/api/home-bases**", (route) => {
    guestOwnerRouteHits += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await guestPage.goto(
    `${origin}/share?qaMode=globe-chrome&qaLite=1&qaRoutePointContext=1&qaSpatialHandoff=1#${sameCoordinateGuestToken}`,
    { waitUntil: "domcontentloaded" },
  );
  await guestPage.locator(".living-atlas").waitFor({ state: "visible", timeout: 20_000 });
  // SharedAtlasView still owns the real guest capability/data path; main.tsx
  // injects the production-globe QA wrapper only under qaRoutePointContext=1
  // so this activation seam exercises the actual shared viewer without owner reads.
  const guestTrigger = guestPage.locator(`[data-qa-globe-route-point-activate="${same02Id}"]`);
  await guestTrigger.waitFor({ state: "attached", timeout: 20_000 });
  await guestTrigger.evaluate((button) => button.click());
  const guestContext = guestPage.locator("[data-route-point-context]");
  await guestContext.waitFor({ state: "visible", timeout: 5_000 });
  const guestInitial = await guestContext.evaluate((node) => ({
    routePointId: node.getAttribute("data-route-point-id"),
    switchIds: [...node.querySelectorAll("[data-route-point-context-switch]")].map((button) => button.getAttribute("data-route-point-context-switch")),
    text: node.textContent ?? "",
  }));
  await guestPage.locator(`[data-route-point-context-switch="${same07Id}"]`).click();
  await guestPage.waitForFunction((id) => document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") === id, same07Id);
  const guestAfterSwitch = await guestContext.evaluate((node) => ({
    routePointId: node.getAttribute("data-route-point-id"),
    text: node.textContent ?? "",
    switchCount: node.querySelectorAll("[data-route-point-context-switch]").length,
  }));
  record("guest same-coordinate grouping is computed only from the authorized shared Journey", {
    guestInitial, guestAfterSwitch, guestOwnerRouteHits,
  },
    guestInitial.routePointId === same02Id
    && guestInitial.switchIds.join(",") === `${same02Id},${same07Id}`
    && guestInitial.text.includes("只分享清晨记录。")
    && guestAfterSwitch.routePointId === same07Id
    && guestAfterSwitch.switchCount === 2
    && guestAfterSwitch.text.includes("只分享夜里记录。")
    && guestOwnerRouteHits === 0);
  record("guest same-coordinate page errors", { pageErrors: guestPageErrors }, guestPageErrors.length === 0);
  await guestPage.close();

  const textRun = await openFocusAtlas();
  const textPage = textRun.page;
  const textFocusBefore = await sceneFocusSnapshot(textPage);
  await activateRoutePoint(textPage, 3);
  const textContext = textPage.locator("[data-route-point-context]");
  await textContext.waitFor({ state: "visible", timeout: 5_000 });
  const textState = await textContext.evaluate((node) => ({
    count: document.querySelectorAll("[data-route-point-context]").length,
    routePointId: node.getAttribute("data-route-point-id"),
    text: node.textContent ?? "",
    mediaCueCount: node.querySelectorAll("[data-route-point-context-media]").length,
    controlsCount: document.querySelectorAll(".living-atlas-globe__controls").length,
    readingNavigationCount: node.querySelectorAll("nav.living-atlas__route-point-context-reading-links").length,
    readingNavigationLabel: node.querySelector("nav.living-atlas__route-point-context-reading-links")?.getAttribute("aria-label") ?? null,
    permanentToolbarCount: node.querySelectorAll("[role=toolbar]").length,
  }));
  const textFocusAfter = await sceneFocusSnapshot(textPage);
  record("text-only Route Point stays truthful", { textState },
    textState.count === 1
    && textState.routePointId === textPointId
    && textState.text.includes("九龙海旁")
    && textState.text.includes("仅文字记录")
    && !textState.text.includes("正在载入")
    && textState.mediaCueCount === 0
    && textState.controlsCount === 0
    && textState.readingNavigationCount === 1
    && textState.readingNavigationLabel === "阅读相邻路线点记录"
    && textState.text.includes("读上一段")
    && textState.permanentToolbarCount === 0);
  record("text-only reveal keeps camera focus owner", { textFocusBefore, textFocusAfter },
    JSON.stringify(textFocusBefore) === JSON.stringify(textFocusAfter));

  // Review P2: the context belongs only to the planet surface. Return from
  // focus mode, activate a point again in normal Atlas, then switch to Timeline;
  // no retained context may float over that sibling view.
  await textPage.locator(".living-atlas__globe-focus-exit").click();
  await textPage.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "off");
  await activateRoutePoint(textPage, 0);
  await textPage.locator("[data-route-point-context]").waitFor({ state: "visible", timeout: 5_000 });
  await textPage.getByRole("button", { name: "时间线" }).click();
  await textPage.waitForFunction(() => document.querySelectorAll("[data-route-point-context]").length === 0);
  const timelineState = {
    contextCount: await textPage.locator("[data-route-point-context]").count(),
    timelineVisible: await textPage.locator(".journey-timeline").isVisible(),
  };
  record("timeline view releases Route Point context", { timelineState },
    timelineState.contextCount === 0 && timelineState.timelineVisible);

  record("text page errors", { pageErrors: textRun.pageErrors }, textRun.pageErrors.length === 0);
  await textPage.close();

  const reducedRun = await openFocusAtlas({ reduceMotion: true });
  const reducedPage = reducedRun.page;
  await activateRoutePoint(reducedPage, 0);
  await reducedPage.locator("[data-route-point-context]").waitFor({ state: "visible", timeout: 5_000 });
  await reducedPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  await reducedPage.locator(".living-atlas__route-point-context-entry").click();
  await reducedPage.locator(".journey-story").waitFor({ state: "visible", timeout: 5_000 });
  const reducedState = await reducedPage.evaluate((assetId) => ({
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    observations: document.querySelectorAll("[data-place-media-observation]").length,
    placeMediaClones: document.querySelectorAll('[data-shared-element-clone^="place-media-"]').length,
    currentAsset: document.querySelector('.journey-story__media [data-media-page="current"]')?.getAttribute("data-media-page-id") ?? null,
  }), photoAssetId);
  record("reduced motion keeps same Story identity without spatial travel", { reducedState },
    reducedState.reduced
    && reducedState.observations === 0
    && reducedState.placeMediaClones === 0
    && reducedState.currentAsset === photoAssetId);
  record("reduced-motion page errors", { pageErrors: reducedRun.pageErrors }, reducedRun.pageErrors.length === 0);
  await reducedPage.close();

  for (const viewport of [
    { name: "landscape-844x390", width: 844, height: 390 },
    { name: "landscape-932x430", width: 932, height: 430 },
  ]) {
    const compactRun = await openFocusAtlas({
      viewport: { width: viewport.width, height: viewport.height },
      compact: true,
    });
    const compactPage = compactRun.page;
    const compactFocusBefore = await sceneFocusSnapshot(compactPage);
    await activateRoutePoint(compactPage, 0);
    const compactContext = compactPage.locator("[data-route-point-context]");
    await compactContext.waitFor({ state: "visible", timeout: 5_000 });
    const compactFocusAfter = await sceneFocusSnapshot(compactPage);
    const compactState = await compactContext.evaluate((node) => {
      const root = node.closest(".living-atlas");
      const panel = node.getBoundingClientRect();
      const entry = node.querySelector(".living-atlas__route-point-context-entry")?.getBoundingClientRect() ?? null;
      const close = node.querySelector("[data-route-point-context-close]")?.getBoundingClientRect() ?? null;
      return {
        mobileV2: root?.getAttribute("data-mobile-v2") ?? null,
        contextCount: document.querySelectorAll("[data-route-point-context]").length,
        panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
        entry: entry ? { width: entry.width, height: entry.height } : null,
        close: close ? { width: close.width, height: close.height } : null,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    record(`${viewport.name} uses compact context posture`, { compactState },
      compactState.mobileV2 === "on"
      && compactState.contextCount === 1
      && compactState.panel.left >= 0
      && compactState.panel.top >= 0
      && compactState.panel.right <= compactState.viewport.width
      && compactState.panel.bottom <= compactState.viewport.height
      && (compactState.entry?.height ?? 0) >= 44
      && (compactState.entry?.width ?? 0) >= 44
      && (compactState.close?.height ?? 0) >= 44
      && (compactState.close?.width ?? 0) >= 44);
    record(`${viewport.name} context keeps camera focus owner`, { compactFocusBefore, compactFocusAfter },
      JSON.stringify(compactFocusBefore) === JSON.stringify(compactFocusAfter));
    if (viewport.name === "landscape-844x390") {
      await compactPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
      const compactMarker = compactPage.locator(`.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${photoPointId}"]`);
      const compactMarkerRect = await compactMarker.boundingBox();
      await compactPage.locator(".living-atlas__route-point-context-entry").click();
      const compactAperture = compactPage.locator("[data-place-media-observation]:not([data-shared-element-clone])");
      await compactAperture.waitFor({ state: "attached", timeout: 2_000 });
      const compactApertureRect = await compactAperture.boundingBox();
      await compactPage.locator(".journey-story").waitFor({ state: "visible", timeout: 5_000 });
      record(`${viewport.name} uses a bounded short spatial handoff`, { compactMarkerRect, compactApertureRect }, Boolean(
        compactMarkerRect && compactApertureRect
        && compactApertureRect.width <= 92.5
        && compactApertureRect.height <= 78.5
        && compactApertureRect.x >= 0
        && compactApertureRect.y >= 0
        && compactApertureRect.x + compactApertureRect.width <= viewport.width
        && compactApertureRect.y + compactApertureRect.height <= viewport.height
        && Math.abs((compactApertureRect.y + compactApertureRect.height / 2)
          - (compactMarkerRect.y + compactMarkerRect.height / 2)) < 20
      ));
    }
    record(`${viewport.name} page errors`, { pageErrors: compactRun.pageErrors }, compactRun.pageErrors.length === 0);
    await compactPage.close();
  }
} catch (error) {
  // The accumulated checks are this lane's only diagnostic record; a thrown
  // step must not take them down with it (#437). Print first, then rethrow so
  // the original failure and the non-zero exit are unchanged.
  console.log(JSON.stringify({ checks }, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify({ checks }, null, 2));
if (failed) process.exit(1);
