// #291 - Route Point activation must reveal one truthful Atlas context surface
// before Story, without becoming a camera owner or inventing media locations.
import { launchQaBrowser } from "./qa-browser.mjs";
import { hasPublishedDiveReveal, nextDiveFixtureInput } from "./qa-earth-dive-input.mjs";

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
const mapStylePattern = /\/api\/mapstyle\?path=styles(?:%2F|\/)fiord(?:$|&)/i;
const paintedDetailStyle = {
  version: 8,
  name: "QA painted detailed-earth style",
  sources: {},
  layers: [{
    id: "qa-paint-surface",
    type: "background",
    paint: { "background-color": "#173d43", "background-opacity": 1 },
  }],
};

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

// #514 first slice: the repeated A is a second record, while the pure detour
// remains route geometry without becoming an overview destination. A non-stop
// with a note or media is still a readable record.
const projectionPointIds = {
  firstA: "qa-projection-a-first",
  detour: "qa-projection-detour",
  b: "qa-projection-b",
  note: "qa-projection-note",
  media: "qa-projection-media",
  returnA: "qa-projection-a-return",
};
const projectionRoutePoints = [
  [projectionPointIds.firstA, 34.0522, -118.2437, "洛杉矶 · 去程", true, ""],
  [projectionPointIds.detour, 35.5, -116.5, "绕行转折", false, ""],
  [projectionPointIds.b, 36.1699, -115.1398, "拉斯维加斯", true, ""],
  [projectionPointIds.note, 34.065, -118.22, "途中的文字", false, "这段途经留下了一句话。"],
  [projectionPointIds.media, 34.057, -118.233, "途中的照片", false, ""],
  [projectionPointIds.returnA, 34.0522, -118.2437, "洛杉矶 · 返程", true, ""],
].map(([id, latitude, longitude, label, isStop, note], sortOrder) => ({
  id, journeyId, sortOrder, latitude, longitude, label, isStop, note,
  occurredAt: `2026-04-06T${String(9 + sortOrder).padStart(2, "0")}:00:00.000Z`,
  createdAt: "2026-04-06T00:00:00.000Z",
}));
const projectionJourney = {
  ...journey,
  title: "洛杉矶到拉斯维加斯再返回",
  // Its points span 09:00-14:00 on one day. An open Journey reports whole-route
  // progress as complete, even while the time cursor is narrating the detour.
  endedOn: null,
  routePoints: projectionRoutePoints,
  media: [{ ...journey.media[0], routePointId: projectionPointIds.media }],
};
const hiddenFinalPointJourney = {
  ...projectionJourney,
  title: "终段只记录路线形状",
  routePoints: projectionRoutePoints.map((point) => point.id === projectionPointIds.returnA
    ? { ...point, isStop: false, note: "" }
    : point),
};
const geometryOnlyJourney = {
  ...projectionJourney,
  title: "只有路线形状的旧旅程",
  coverMediaAssetId: null,
  routePoints: projectionRoutePoints.map((point) => ({ ...point, isStop: false, note: "" })),
  media: [],
};

// #514 final acceptance: one semantic stay can contain several canonical Route
// Points, but ordinary Atlas overview exposes only one real anchor. The child
// records become hit/marker/detail surfaces only after an explicit stay-detail
// intent; route geometry, media identity and Journey playback remain canonical.
const staySummaryPointIds = {
  hotel: "qa-stay-chengdu-hotel",
  museum: "qa-stay-chengdu-museum",
  transit: "qa-stay-chengdu-transit",
  chongqing: "qa-stay-chongqing",
};
const staySummaryRoutePoints = [
  { id: staySummaryPointIds.hotel, latitude: 30.657, longitude: 104.066, label: "成都住处", isStop: true, regionContext: "成都", placeRole: "accommodation" },
  { id: staySummaryPointIds.museum, latitude: 30.663, longitude: 104.075, label: "成都博物馆", isStop: true, regionContext: "成都", placeRole: "attraction" },
  { id: staySummaryPointIds.transit, latitude: 30.69, longitude: 104.11, label: "途中转折", isStop: false, regionContext: "成都", placeRole: "pure-transit" },
  { id: staySummaryPointIds.chongqing, latitude: 29.563, longitude: 106.551, label: "重庆", isStop: true, regionContext: "重庆", placeRole: "attraction" },
].map((point, sortOrder) => ({
  ...point,
  journeyId,
  sortOrder,
  note: "",
  occurredAt: `2026-04-07T${String(9 + sortOrder).padStart(2, "0")}:00:00.000Z`,
  createdAt: "2026-04-07T00:00:00.000Z",
}));
const staySummaryJourney = {
  ...journey,
  title: "成都与重庆",
  routePoints: staySummaryRoutePoints,
  media: [
    { ...journey.media[0], id: photoAssetId, routePointId: staySummaryPointIds.museum, sortOrder: 0 },
    { ...journey.media[1], id: secondPhotoAssetId, routePointId: staySummaryPointIds.hotel, sortOrder: 1 },
  ],
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
  focusMode = true,
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
  if (realScene && !focusMode) {
    await page.route(mapStylePattern, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(paintedDetailStyle),
    }));
  }
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
    if (focusMode) {
      await page.locator(".living-atlas__globe-focus").click();
      await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
    }
  } else {
    await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") === "on");
  }
  if (realScene) {
    // This round grades the Route Point pointer surface, so wait on that exact
    // interaction contract rather than the broader land-mask/coastline build.
    // A marker must be genuinely projected and visible before the pointer round
    // starts; if route projection never becomes usable this still fails closed.
    const realRoutePoint = page.locator(
      `.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id][data-temporal-visible="true"]:visible`,
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

async function routeMarkerClickState(page, pointId, target) {
  return page.evaluate(({ pointId, target }) => {
    const marker = document.querySelector(`.particle-earth-route__point[data-route-point-id="${pointId}"]`);
    const scene = document.querySelector(".particle-earth-scene");
    const markerRect = marker?.getBoundingClientRect();
    const hit = document.elementFromPoint(target.x, target.y);
    return {
      contextId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
      activationId: scene?.getAttribute("data-route-point-activation-id") ?? null,
      activationSource: scene?.getAttribute("data-route-point-activation-source") ?? null,
      activationEventTarget: scene?.getAttribute("data-route-point-activation-event-target") ?? null,
      hitElement: hit instanceof Element ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : null,
      markerRect: markerRect ? [markerRect.left, markerRect.top, markerRect.width, markerRect.height] : null,
      temporalVisible: marker?.getAttribute("data-temporal-visible") ?? null,
      focusRevision: scene?.getAttribute("data-focus-revision") ?? null,
      focusSettleCount: scene?.getAttribute("data-focus-settle-count") ?? null,
      routePointCount: scene?.getAttribute("data-journey-route-point-count") ?? null,
      projectionReady: window.__particleEarthDebug?.().journeyRouteProjectionReady ?? null,
      scrubberValue: document.querySelector(".globe-time-scrubber__track")?.getAttribute("aria-valuenow") ?? null,
    };
  }, { pointId, target });
}

async function clickRoutePointLabel(page, routeId, pointId) {
  const label = page.locator(`.particle-earth-route__label[data-journey-route="${routeId}"][data-route-point-id="${pointId}"]`);
  await label.waitFor({ state: "visible", timeout: 5_000 });
  const hitTarget = label.locator(".particle-earth-route__label-hit");
  const box = await hitTarget.boundingBox();
  if (!box) throw new Error(`Route Point ${pointId} has no visible label hit geometry`);
  // A label's 44px touch target may legitimately overlap a neighbouring 6px
  // Route Point marker. The visible marker owns its own pixels; grade the label
  // through a real browser-hit pixel that belongs to this label and is not
  // physically occupied by any marker. If no such pixel exists, the product
  // label is effectively unclickable and this still fails closed.
  const target = await label.evaluate((node) => {
    const hit = node.querySelector(".particle-earth-route__label-hit");
    if (!(hit instanceof SVGGraphicsElement)) return null;
    const rect = hit.getBoundingClientRect();
    const markerRects = [...document.querySelectorAll(".particle-earth-route__point")]
      .filter((marker) => marker instanceof SVGGraphicsElement && marker.style.display !== "none")
      .map((marker) => marker.getBoundingClientRect());
    for (let y = rect.top + 4; y <= rect.bottom - 4; y += 4) {
      for (let x = rect.left + 4; x <= rect.right - 4; x += 4) {
        if (markerRects.some((marker) => Math.hypot(
          x - (marker.left + marker.width / 2),
          y - (marker.top + marker.height / 2),
        ) <= 22)) continue;
        const hitElement = document.elementFromPoint(x, y);
        if (hitElement?.closest(".particle-earth-route__label") === node) return { x, y };
      }
    }
    return null;
  });
  if (!target) throw new Error(`Route Point ${pointId} has no unambiguous label-owned hit pixel`);
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

async function detailWheelTarget(page) {
  const target = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const rect = canvas.getBoundingClientRect();
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    for (let radius = 0; radius <= 200; radius += 20) {
      for (let arm = 0; arm < 8; arm += 1) {
        const angle = (arm * Math.PI) / 4;
        const x = center.x + Math.cos(angle) * radius;
        const y = center.y + Math.sin(angle) * radius;
        if (x < 8 || y < 8 || x >= innerWidth - 8 || y >= innerHeight - 8) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit === canvas || (hit instanceof Element && hit.closest(".detailed-earth-map"))) return { x, y };
      }
    }
    return null;
  });
  if (!target) throw new Error("Detail dive has no pointer-reachable wheel surface");
  return target;
}

async function enterRealDetail(page) {
  for (let step = 0; step < 90; step += 1) {
    const state = await page.evaluate(() => ({
      stage: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive") ?? null,
      owner: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner") ?? null,
      semanticZoom: document.querySelector(".particle-earth-scene")?.getAttribute("data-semantic-zoom") ?? null,
      localProgress: Number(document.querySelector(".particle-earth-scene")?.getAttribute("data-local-progress")),
    }));
    if (state.stage === "detail" && state.owner === "detail") return state;
    if (state.stage === "blending" && state.localProgress >= 0.999) {
      await page.waitForFunction(() => (
        document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive") === "detail"
        && document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner") === "detail"
      ), null, { timeout: 5_000 });
      return { ...state, stage: "detail", owner: "detail" };
    }
    if (state.stage === "blending" && state.localProgress >= 0.6) {
      await page.waitForFunction(hasPublishedDiveReveal, null, { timeout: 5_000 });
    }
    const requestedDelta = state.semanticZoom === "global" ? -120 : -10;
    const input = nextDiveFixtureInput(state, requestedDelta, -10);
    const point = await detailWheelTarget(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, input.deltaY);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  const state = await page.locator(".living-atlas-globe").evaluate((node) => ({
    stage: node.getAttribute("data-earth-dive"),
    owner: node.getAttribute("data-earth-dive-owner"),
    semanticZoom: document.querySelector(".particle-earth-scene")?.getAttribute("data-semantic-zoom"),
    localProgress: document.querySelector(".particle-earth-scene")?.getAttribute("data-local-progress"),
    mapReadiness: document.querySelector(".detailed-earth-map")?.getAttribute("data-map-readiness"),
  }));
  throw new Error(`real Detail dive did not commit: ${JSON.stringify(state)}`);
}

async function detailedExistingRoutePointTarget(page, route, routePointId = null) {
  return page.evaluate(({ candidateRoute, targetPointId }) => {
    for (const point of candidateRoute.routePoints) {
      if (targetPointId && point.id !== targetPointId) continue;
      const projected = window.__detailedEarthMapProject?.(point.longitude, point.latitude);
      if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
      const samples = [{ x: projected.x, y: projected.y }];
      for (const radius of [8, 14, 20]) {
        for (let arm = 0; arm < 8; arm += 1) {
          const angle = arm * Math.PI / 4;
          samples.push({ x: projected.x + Math.cos(angle) * radius, y: projected.y + Math.sin(angle) * radius });
        }
      }
      for (const sample of samples) {
        if (sample.x < 0 || sample.y < 0 || sample.x >= innerWidth || sample.y >= innerHeight) continue;
        const hitElement = document.elementFromPoint(sample.x, sample.y);
        const markerHit = window.__detailedEarthJourneyRoutePointHit?.(sample.x, sample.y);
        if (hitElement instanceof Element && hitElement.closest(".detailed-earth-map")
          && markerHit?.journeyId === candidateRoute.id && markerHit.routePointId === point.id) {
          return { ...sample, journeyId: candidateRoute.id, routePointId: point.id, latitude: point.latitude, longitude: point.longitude };
        }
      }
    }
    return null;
  }, { candidateRoute: route, targetPointId: routePointId });
}

async function findBlankDetailPoint(page, drag = false) {
  const target = await page.evaluate((forDrag) => {
    const canvas = document.querySelector(".detailed-earth-map canvas.maplibregl-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const rect = canvas.getBoundingClientRect();
    for (let y = rect.top + 72; y < rect.bottom - 72; y += 48) {
      for (let x = rect.left + 72; x < rect.right - 72; x += 48) {
        const samples = forDrag ? [{ x, y }, { x: x + 36, y: y + 18 }] : [{ x, y }];
        if (samples.every((sample) => document.elementFromPoint(sample.x, sample.y) === canvas
          && !window.__detailedEarthJourneyRoutePointHit?.(sample.x, sample.y))) {
          return { x, y };
        }
      }
    }
    return null;
  }, drag);
  if (!target) throw new Error("Detail map has no pointer-reachable blank canvas point");
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
  const visibleMarkers = interactionPage.locator(
    `.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id][data-temporal-visible="true"]:visible`,
  );
  await visibleMarkers.first().waitFor({ state: "visible", timeout: 5_000 });
  // The old round clicked route-order `first()`. At the edge of a framed
  // Journey that SVG bead can still be visually present while its independent
  // spherical point hit area is tangent to the pointer ray. That made this QA
  // intermittently grade projection ordering instead of the actual hit
  // contract. Pick exactly one already-visible marker nearest the real canvas
  // centre: no retries, camera steering or force-click, and the pointer still
  // travels through the production canvas raycast path.
  const markerPointId = await visibleMarkers.evaluateAll((markers) => {
    const canvas = document.querySelector(".particle-earth-scene canvas");
    const canvasRect = canvas?.getBoundingClientRect();
    if (!canvasRect) return null;
    const canvasX = canvasRect.left + canvasRect.width / 2;
    const canvasY = canvasRect.top + canvasRect.height / 2;
    return markers
      .map((marker) => {
        const rect = marker.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return {
          id: marker.getAttribute("data-route-point-id"),
          insideCanvas: x >= canvasRect.left && x <= canvasRect.right
            && y >= canvasRect.top && y <= canvasRect.bottom,
          distance: Math.hypot(x - canvasX, y - canvasY),
        };
      })
      .filter((candidate) => candidate.id && candidate.insideCanvas)
      .sort((left, right) => left.distance - right.distance)[0]?.id ?? null;
  });
  if (!markerPointId) throw new Error("visible active-Journey Route Point marker has no stable in-canvas id");
  const markerClick = await clickRoutePointMarker(interactionPage, journeyId, markerPointId);
  const interactionContext = interactionPage.locator("[data-route-point-context]");
  await interactionContext.waitFor({ state: "visible", timeout: 5_000 });
  const selectedMarker = interactionPage.locator(
    `.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${markerPointId}"][data-attention-role="selected"]`,
  );
  // The card and renderer-owned SVG update in separate React/effect phases.
  // Wait on the exact semantic state, not elapsed time, so a missing persistent
  // selection still fails while a normal one-frame propagation is not a race.
  await selectedMarker.waitFor({ state: "attached", timeout: 5_000 });
  const markerActivation = await routePointActivationEvidence(interactionPage);
  const selectedMarkerRole = await selectedMarker.getAttribute("data-attention-role");
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

  // A marker activation may legitimately leave the real globe in a different
  // visual composition after its context closes. Label hit-testing is an
  // independent #508 contract, so grade it from a fresh real-scene composition
  // rather than requiring the marker-selected composition to expose another
  // unobscured label. This still uses the production SVG pointer path: no
  // camera steering, force-click, retry, or direct reveal helper.
  const labelRun = await openFocusAtlas({
    realScene: true,
    reduceMotion: true,
    journeysPayload: [siblingJourney, interactionJourney],
  });
  const labelPage = labelRun.page;
  const labelContext = labelPage.locator("[data-route-point-context]");
  const visibleLabels = labelPage.locator(
    `.particle-earth-route__label[data-journey-route="${journeyId}"][data-route-point-id]:visible`,
  );
  await visibleLabels.first().waitFor({ state: "visible", timeout: 5_000 });
  let labelPointId = null;
  let labelClick = null;
  for (let index = 0; index < await visibleLabels.count(); index += 1) {
    const candidatePointId = await visibleLabels.nth(index).getAttribute("data-route-point-id");
    if (!candidatePointId) continue;
    try {
      labelClick = await clickRoutePointLabel(labelPage, journeyId, candidatePointId);
      labelPointId = candidatePointId;
      break;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no unambiguous label-owned hit pixel")) throw error;
    }
  }
  if (!labelPointId || !labelClick) {
    throw new Error("active Journey has no visible Route Point label with a real label-owned hit pixel");
  }
  await labelContext.waitFor({ state: "visible", timeout: 5_000 });
  const labelActivation = await routePointActivationEvidence(labelPage);
  record("actual label hit preserves stable Route Point identity", { labelPointId, labelClick, labelActivation },
    labelActivation.source === "label"
    && labelActivation.journeyId === journeyId
    && labelActivation.routePointId === labelPointId);
  const focusModeBeforeEscape = await labelPage.locator(".living-atlas").getAttribute("data-globe-focus");
  await labelPage.keyboard.press("Escape");
  await labelContext.waitFor({ state: "detached", timeout: 5_000 });
  const focusModeAfterEscape = await labelPage.locator(".living-atlas").getAttribute("data-globe-focus");
  record("Escape closes context without exiting globe focus", { focusModeBeforeEscape, focusModeAfterEscape },
    focusModeBeforeEscape === focusModeAfterEscape);

  const labelTrigger = labelPage.locator(
    `.particle-earth-route__label[data-journey-route="${journeyId}"][data-route-point-id="${labelPointId}"]`,
  );
  await labelTrigger.focus();
  await labelTrigger.press("Enter");
  await labelContext.waitFor({ state: "visible", timeout: 5_000 });
  const keyboardActivation = await routePointActivationEvidence(labelPage);
  const labelCloseButton = labelContext.locator("[data-route-point-context-close]");
  await labelCloseButton.click();
  await labelContext.waitFor({ state: "detached", timeout: 5_000 });
  const focusReturn = await labelPage.evaluate(() => ({
    tag: document.activeElement?.tagName.toLowerCase() ?? null,
    routePointId: document.activeElement?.getAttribute("data-route-point-id") ?? null,
  }));
  record("keyboard label opens context and close restores the same legal trigger", { keyboardActivation, focusReturn },
    keyboardActivation.source === "keyboard-label"
    && keyboardActivation.routePointId === labelPointId
    && focusReturn.routePointId === labelPointId);
  record("real label interaction page errors", { pageErrors: labelRun.pageErrors }, labelRun.pageErrors.length === 0);
  await labelPage.close();

  // The production renderer, rather than the deterministic QA SVG below,
  // owns selected-marker presentation. Exercise the same A -> no-media B ->
  // close path through a real marker hit and grade the marker actually returned.
  await clickRoutePointMarker(interactionPage, journeyId, photoPointId);
  await interactionPage.locator(`[data-route-point-context][data-route-point-id="${photoPointId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  await interactionPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  await interactionPage.locator(".living-atlas__route-point-context-entry").click();
  await interactionPage.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${photoAssetId}"][data-media-page-ready="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await interactionPage.locator(`.journey-story button[data-route-point-id="${textPointId}"]`).click();
  await interactionPage.locator(`.journey-story button[data-route-point-id="${textPointId}"][aria-pressed="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await interactionPage.locator('.journey-story[data-has-media="false"]').waitFor({ state: "visible", timeout: 5_000 });
  await interactionPage.locator(".journey-story__close").click();
  await interactionPage.locator(`[data-route-point-context][data-route-point-id="${textPointId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  const realReturnMarker = interactionPage.locator(`.particle-earth-route__point[data-journey-route="${journeyId}"][data-route-point-id="${textPointId}"][data-attention-role="selected"]`);
  await realReturnMarker.waitFor({ state: "visible", timeout: 5_000 });
  const realReturnMarkerRect = await realReturnMarker.boundingBox();
  const realReturnState = await interactionPage.evaluate(() => ({
    contextId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
    selectedIds: [...document.querySelectorAll('.particle-earth-route__point[data-attention-role="selected"]')]
      .map((node) => node.getAttribute("data-route-point-id")),
    activeRoute: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route") ?? null,
    viewport: { width: innerWidth, height: innerHeight },
  }));
  record("real A -> no-media B return highlights B at its visible map position", {
    realReturnState, realReturnMarkerRect,
  },
    realReturnState.contextId === textPointId
    && realReturnState.selectedIds.includes(textPointId)
    && !realReturnState.selectedIds.includes(photoPointId)
    && realReturnState.activeRoute === journeyId
    && Boolean(realReturnMarkerRect && realReturnMarkerRect.x >= 0 && realReturnMarkerRect.y >= 0
      && realReturnMarkerRect.x + realReturnMarkerRect.width <= realReturnState.viewport.width
      && realReturnMarkerRect.y + realReturnMarkerRect.height <= realReturnState.viewport.height));

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

  // #514: grade the final stay-summary disclosure contract on the real Particle
  // Earth. Resize and ordinary context opening keep child points unmounted;
  // only the explicit stay-detail control may disclose them. Escape backs out
  // of that detail layer while leaving the selected stay summary open.
  const stayRun = await openFocusAtlas({
    realScene: true,
    focusMode: false,
    reduceMotion: true,
    journeysPayload: [staySummaryJourney],
    initialPointId: staySummaryPointIds.museum,
  });
  const stayPage = stayRun.page;
  await stayPage.waitForFunction((ids) => {
    const route = document.querySelector(`[data-journey-route="${ids.journey}"]`);
    const markerIds = [...(route?.querySelectorAll(".particle-earth-route__point[data-route-point-id]") ?? [])]
      .map((marker) => marker.getAttribute("data-route-point-id"));
    return markerIds.length === 2
      && markerIds.includes(ids.museum)
      && markerIds.includes(ids.chongqing)
      && !markerIds.includes(ids.hotel)
      && !markerIds.includes(ids.transit);
  }, { ...staySummaryPointIds, journey: journeyId });
  const stayOverviewBefore = await stayPage.evaluate((ids) => ({
    markerIds: [...document.querySelectorAll(`[data-journey-route="${ids.journey}"] .particle-earth-route__point[data-route-point-id]`)]
      .map((marker) => marker.getAttribute("data-route-point-id")),
    routeLegCount: document.querySelectorAll(`[data-journey-route="${ids.journey}"] .particle-earth-route__leg`).length,
    raycastPointCount: document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count"),
  }), { ...staySummaryPointIds, journey: journeyId });
  record("stay overview keeps one Chengdu summary anchor while preserving full route geometry", { stayOverviewBefore },
    stayOverviewBefore.markerIds.join(",") === [staySummaryPointIds.museum, staySummaryPointIds.chongqing].join(",")
    && stayOverviewBefore.routeLegCount === staySummaryRoutePoints.length - 1
    && stayOverviewBefore.raycastPointCount === "2");

  await clickRoutePointMarker(stayPage, journeyId, staySummaryPointIds.museum);
  const stayContext = stayPage.locator(`[data-route-point-context][data-route-point-id="${staySummaryPointIds.museum}"]`);
  await stayContext.waitFor({ state: "visible", timeout: 5_000 });
  const staySummarySurface = stayContext.locator("[data-stay-summary]");
  await staySummarySurface.waitFor({ state: "visible", timeout: 5_000 });
  let staySummaryState = await staySummarySurface.evaluate((node) => ({
    detailOpen: node.getAttribute("data-stay-detail-open"),
    childGroupCount: node.querySelectorAll("[data-stay-detail]").length,
    text: node.textContent ?? "",
  }));
  record("opening the stay summary does not implicitly mount child detail", { staySummaryState },
    staySummaryState.detailOpen === "false"
    && staySummaryState.childGroupCount === 0
    && staySummaryState.text.includes("成都")
    && staySummaryState.text.includes("2 个地点")
    && staySummaryState.text.includes("2 项影像"));

  await stayPage.setViewportSize({ width: 1281, height: 720 });
  await stayPage.setViewportSize({ width: 1280, height: 720 });
  const afterResize = await stayPage.evaluate((hotelId) => ({
    hotelMarkers: document.querySelectorAll(`.particle-earth-route__point[data-route-point-id="${hotelId}"]`).length,
    detailGroups: document.querySelectorAll("[data-stay-detail]").length,
  }), staySummaryPointIds.hotel);
  record("viewport resize does not disclose stay children", { afterResize },
    afterResize.hotelMarkers === 0 && afterResize.detailGroups === 0);

  const openStayDetail = stayContext.locator(`button[data-stay-detail-open]`);
  await openStayDetail.focus();
  await openStayDetail.press("Enter");
  await stayPage.locator(`.particle-earth-route__point[data-route-point-id="${staySummaryPointIds.hotel}"]`)
    .waitFor({ state: "attached", timeout: 5_000 });
  const explicitStayDetail = await staySummarySurface.evaluate((node) => ({
    detailOpen: node.getAttribute("data-stay-detail-open"),
    childIds: [...node.querySelectorAll("[data-stay-route-point]")]
      .map((button) => button.getAttribute("data-stay-route-point")),
  }));
  record("keyboard activation explicitly opens only the selected stay children", { explicitStayDetail },
    explicitStayDetail.detailOpen === "true"
    && explicitStayDetail.childIds.join(",") === [staySummaryPointIds.hotel, staySummaryPointIds.museum].join(","));

  await stayPage.keyboard.press("Escape");
  await stayPage.locator(`.particle-earth-route__point[data-route-point-id="${staySummaryPointIds.hotel}"]`)
    .waitFor({ state: "detached", timeout: 5_000 });
  staySummaryState = await staySummarySurface.evaluate((node) => ({
    detailOpen: node.getAttribute("data-stay-detail-open"),
    contextAttached: Boolean(node.closest("[data-route-point-context]")),
  }));
  record("Escape closes stay detail before Route Point context", { staySummaryState },
    staySummaryState.detailOpen === "false" && staySummaryState.contextAttached);
  record("stay-summary reduced-motion page errors", { pageErrors: stayRun.pageErrors }, stayRun.pageErrors.length === 0);
  await stayPage.close();

  const compactStayRun = await openFocusAtlas({
    compact: true,
    reduceMotion: true,
    journeysPayload: [staySummaryJourney],
    initialPointId: staySummaryPointIds.museum,
  });
  const compactStayPage = compactStayRun.page;
  await activateRoutePointId(compactStayPage, staySummaryPointIds.museum);
  const compactStayContext = compactStayPage.locator(`[data-route-point-context][data-route-point-id="${staySummaryPointIds.museum}"]`);
  await compactStayContext.waitFor({ state: "visible", timeout: 5_000 });
  const compactSummary = compactStayContext.locator("[data-stay-summary]");
  const compactBefore = await compactSummary.evaluate((node) => ({
    detailOpen: node.getAttribute("data-stay-detail-open"),
    childGroups: node.querySelectorAll("[data-stay-detail]").length,
  }));
  await compactSummary.locator("button[data-stay-detail-open]").click();
  const compactAfter = await compactSummary.evaluate((node) => ({
    detailOpen: node.getAttribute("data-stay-detail-open"),
    childIds: [...node.querySelectorAll("[data-stay-route-point]")]
      .map((button) => button.getAttribute("data-stay-route-point")),
  }));
  record("compact mobile keeps stay detail explicitly gated", { compactBefore, compactAfter },
    compactBefore.detailOpen === "false"
    && compactBefore.childGroups === 0
    && compactAfter.detailOpen === "true"
    && compactAfter.childIds.join(",") === [staySummaryPointIds.hotel, staySummaryPointIds.museum].join(","));
  record("compact stay-summary page errors", { pageErrors: compactStayRun.pageErrors }, compactStayRun.pageErrors.length === 0);
  await compactStayPage.close();

  const projectionRun = await openFocusAtlas({
    realScene: true,
    reduceMotion: true,
    journeysPayload: [projectionJourney],
    initialPointId: projectionPointIds.firstA,
  });
  const projectionPage = projectionRun.page;
  await projectionPage.waitForFunction(() => (
    document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count") === "5"
  ));
  const projectionBefore = await projectionPage.evaluate((ids) => {
    const route = document.querySelector(`.particle-earth-route[data-journey-route="${ids.journey}"]`);
    return {
      markerIds: [...(route?.querySelectorAll(".particle-earth-route__point[data-route-point-id]") ?? [])]
        .map((node) => node.getAttribute("data-route-point-id")),
      labelIds: [...(route?.querySelectorAll(".particle-earth-route__label[data-route-point-id]") ?? [])]
        .map((node) => node.getAttribute("data-route-point-id")),
      legCount: route?.querySelectorAll(".particle-earth-route__leg").length ?? 0,
      raycastPointCount: document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count"),
    };
  }, { ...projectionPointIds, journey: journeyId });
  record("A -> B -> A keeps every route leg while pure detour has no Particle marker, label or raycast slot", {
    projectionBefore,
  },
    projectionBefore.legCount === projectionRoutePoints.length - 1
    && projectionBefore.raycastPointCount === "5"
    && projectionBefore.markerIds.join(",") === [
      projectionPointIds.firstA, projectionPointIds.b, projectionPointIds.note,
      projectionPointIds.media, projectionPointIds.returnA,
    ].join(",")
    && !projectionBefore.labelIds.includes(projectionPointIds.detour));

  const projectedBClick = await clickRoutePointMarker(projectionPage, journeyId, projectionPointIds.b);
  await projectionPage.locator(`[data-route-point-context][data-route-point-id="${projectionPointIds.b}"]`)
    .waitFor({ state: "visible", timeout: 5_000 });
  const projectedBActivation = await routePointActivationEvidence(projectionPage);
  record("sparse Particle overview still opens B through its real marker hit", {
    projectedBClick, projectedBActivation,
  }, projectedBActivation.source === "marker"
    && projectedBActivation.journeyId === journeyId
    && projectedBActivation.routePointId === projectionPointIds.b);
  await projectionPage.locator("[data-route-point-context-close]").click();
  await projectionPage.locator("[data-route-point-context]").waitFor({ state: "detached", timeout: 5_000 });

  // Rewind's current point can be a pure route vertex even on an open same-day
  // Journey. Seek with the real slider between its 10:00 timestamp and B at
  // 11:00, then require its native marker hit.
  const projectionTrack = projectionPage.locator(".globe-time-scrubber__track");
  const projectionTrackBox = await projectionTrack.boundingBox();
  if (!projectionTrackBox) throw new Error("projection Journey has no pointer-reachable time axis");
  await projectionPage.mouse.click(
    projectionTrackBox.x + projectionTrackBox.width * (9.5 / 14),
    projectionTrackBox.y + projectionTrackBox.height / 2,
  );
  await projectionPage.waitForFunction((ids) => (
    document.querySelector(`.particle-earth-route__point[data-route-point-id="${ids.firstA}"]`)
      ?.getAttribute("data-attention-role") === "narrative-current"
    && document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-point") === "34.0522,-118.2437"
    && !document.querySelector(`.particle-earth-route__point[data-route-point-id="${ids.detour}"]`)
    && document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count") === "5"
  ), projectionPointIds);
  const sameDayA = await sceneFocusSnapshot(projectionPage);
  record("same-day open Journey scrub begins at A without prematurely exposing the detour", {
    sameDayA,
  }, sameDayA.focusPoint === "34.0522,-118.2437");
  await projectionPage.mouse.click(
    projectionTrackBox.x + projectionTrackBox.width * (10.5 / 14),
    projectionTrackBox.y + projectionTrackBox.height / 2,
  );
  await projectionPage.waitForFunction((detourId) => (
    document.querySelector(`.particle-earth-route__point[data-route-point-id="${detourId}"]`)
      ?.getAttribute("data-attention-role") === "narrative-current"
    && document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-point") === "35.5,-116.5"
    && document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count") === "6"
  ), projectionPointIds.detour);
  // The narrative owner updates before the camera arrives. Click only once
  // the renderer has drawn the target at its settled, pointer-hit position.
  await projectionPage.waitForFunction(() => {
    const scene = document.querySelector(".particle-earth-scene");
    const focus = document.querySelector("[data-qa-route-point-context-focus]");
    return scene?.getAttribute("data-focus-revision") === focus?.getAttribute("data-focus-revision")
      && scene?.getAttribute("data-focus-target-lat") === "35.5"
      && scene?.getAttribute("data-focus-target-lon") === "-116.5"
      && Number(scene?.getAttribute("data-focus-settle-count") ?? 0) > 0
      && window.__particleEarthDebug?.().journeyRouteProjectionReady === true;
  });
  const detourFocus = await sceneFocusSnapshot(projectionPage);
  const detourMarker = projectionPage.locator(`.particle-earth-route__point[data-route-point-id="${projectionPointIds.detour}"]`);
  const detourMarkerBox = await detourMarker.boundingBox();
  if (!detourMarkerBox) throw new Error("settled detour has no marker geometry");
  const detourBeforeClick = await routeMarkerClickState(projectionPage, projectionPointIds.detour, {
    x: detourMarkerBox.x + detourMarkerBox.width / 2,
    y: detourMarkerBox.y + detourMarkerBox.height / 2,
  });
  const detourClick = await clickRoutePointMarker(projectionPage, journeyId, projectionPointIds.detour);
  const detourImmediatelyAfterClick = await routeMarkerClickState(projectionPage, projectionPointIds.detour, detourClick.target);
  try {
    await projectionPage.locator(`[data-route-point-context][data-route-point-id="${projectionPointIds.detour}"]`)
      .waitFor({ state: "visible", timeout: 5_000 });
  } catch (error) {
    const detourAfterFailedClick = await routeMarkerClickState(projectionPage, projectionPointIds.detour, detourClick.target);
    throw new Error(`settled detour marker did not open its context: ${JSON.stringify({
      detourFocus, detourBeforeClick, detourClick, detourImmediatelyAfterClick, detourAfterFailedClick,
    })}`, { cause: error });
  }
  const detourActivation = await routePointActivationEvidence(projectionPage);
  record("same-day open Journey rewind publishes the pure detour as current focus and real marker hit", {
    detourFocus, detourBeforeClick, detourClick, detourImmediatelyAfterClick, detourActivation,
  }, detourFocus.focusPoint === "35.5,-116.5"
    && detourActivation.source === "marker"
    && detourActivation.journeyId === journeyId
    && detourActivation.routePointId === projectionPointIds.detour);
  await projectionPage.locator("[data-route-point-context-close]").click();
  await projectionPage.locator("[data-route-point-context]").waitFor({ state: "detached", timeout: 5_000 });
  await projectionPage.mouse.click(
    projectionTrackBox.x + projectionTrackBox.width * (11.5 / 14),
    projectionTrackBox.y + projectionTrackBox.height / 2,
  );
  await projectionPage.waitForFunction((ids) => (
    document.querySelector(`.particle-earth-route__point[data-route-point-id="${ids.b}"]`)
      ?.getAttribute("data-attention-role") === "narrative-current"
    && document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-point") === "36.1699,-115.1398"
    && !document.querySelector(`.particle-earth-route__point[data-route-point-id="${ids.detour}"]`)
    && document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count") === "5"
  ), projectionPointIds);
  const afterDetourFocus = await projectionPage.evaluate((ids) => ({
    focusPoint: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-point"),
    detourMarkerCount: document.querySelectorAll(`.particle-earth-route__point[data-route-point-id="${ids.detour}"]`).length,
    raycastPointCount: document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count"),
  }), projectionPointIds);
  record("moving rewind focus to B removes the old detour marker and hit slot", {
    afterDetourFocus,
  }, afterDetourFocus.focusPoint === "36.1699,-115.1398"
    && afterDetourFocus.detourMarkerCount === 0
    && afterDetourFocus.raycastPointCount === "5");
  await projectionTrack.focus();
  await projectionTrack.press("End");
  await projectionPage.waitForFunction(() => document.querySelector(".globe-time-scrubber__track")
    ?.getAttribute("aria-valuenow") === "100");

  // An explicit context may select a pure detour from a non-marker route entry.
  // Its temporary marker exists only while that exact context remains open.
  await activateRoutePointId(projectionPage, projectionPointIds.detour);
  await projectionPage.locator(`[data-route-point-context][data-route-point-id="${projectionPointIds.detour}"]`)
    .waitFor({ state: "visible", timeout: 5_000 });
  const selectedDetour = projectionPage.locator(
    `.particle-earth-route__point[data-route-point-id="${projectionPointIds.detour}"][data-attention-role="selected"]`,
  );
  await selectedDetour.waitFor({ state: "attached", timeout: 5_000 });
  record("explicitly selected pure detour keeps its exact identity", {},
    await projectionPage.locator(".particle-earth-scene").getAttribute("data-journey-route-point-count") === "6");
  await projectionPage.locator("[data-route-point-context-close]").click();
  await selectedDetour.waitFor({ state: "detached", timeout: 5_000 });
  record("closing detour removes its marker and hit slot again", {},
    await projectionPage.locator(".particle-earth-scene").getAttribute("data-journey-route-point-count") === "5");

  await activateRoutePointId(projectionPage, projectionPointIds.media);
  await projectionPage.locator(`[data-route-point-context][data-route-point-id="${projectionPointIds.media}"]`)
    .waitFor({ state: "visible", timeout: 5_000 });
  await projectionPage.locator(".living-atlas__route-point-context-entry").click();
  await projectionPage.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${photoAssetId}"][data-media-page-ready="true"]`)
    .waitFor({ state: "attached", timeout: 5_000 });
  const storyPointIds = await projectionPage.locator(".journey-story").evaluate((node) => (
    [...node.querySelectorAll("button[data-route-point-id]")]
      .map((button) => button.getAttribute("data-route-point-id"))
  ));
  record("overview projection preserves full Story point order and media-only non-stop content", {
    storyPointIds,
  }, storyPointIds.join(",") === projectionRoutePoints.map((point) => point.id).join(","));

  await projectionPage.locator(".journey-story__close").click();
  await projectionPage.locator(".journey-story").waitFor({ state: "detached", timeout: 5_000 });
  await projectionPage.locator("[data-route-point-context-close]").click();
  await projectionPage.locator("[data-route-point-context]").waitFor({ state: "detached", timeout: 5_000 });
  await projectionPage.locator(".living-atlas__globe-focus-exit").click();
  await projectionPage.waitForFunction(() => document.querySelector(".living-atlas")
    ?.getAttribute("data-globe-focus") === "off");
  await projectionPage.locator(".living-atlas__active-play").click();
  await projectionPage.locator('.living-atlas__playback-mode-menu [data-playback-mode-option="full"]').click();
  const projectionPlayback = projectionPage.locator('.journey-playback[data-playback-mode="full"]');
  await projectionPlayback.waitFor({ state: "visible", timeout: 5_000 });
  const projectedFullSteps = Number(await projectionPlayback.getAttribute("data-playback-steps"));
  record("Full Playback retains every route point and the owned media chapter", {
    projectedFullSteps,
  }, projectedFullSteps === 2 * projectionRoutePoints.length + 2);
  const pausePlayback = projectionPage.locator('.journey-playback__controls button[aria-label="暂停播放"]');
  if (await pausePlayback.count()) await pausePlayback.click();
  const playbackProgress = projectionPage.locator('.journey-playback__progress input[type="range"]');
  const detourSeekTarget = await playbackProgress.evaluate((range) => {
    const tick = document.querySelectorAll(".journey-playback__progress-chapters i")[1];
    if (!(tick instanceof HTMLElement)) throw new Error("detour Playback chapter tick is missing");
    const fraction = Number.parseFloat(tick.style.left) / 100 + 0.004;
    const rect = range.getBoundingClientRect();
    const inset = 8;
    return { x: rect.left + inset + (rect.width - inset * 2) * fraction,
      y: rect.top + rect.height / 2 };
  });
  await projectionPage.mouse.click(detourSeekTarget.x, detourSeekTarget.y);
  await projectionPage.waitForFunction((detourId) => {
    const playback = document.querySelector(".journey-playback");
    const marker = document.querySelector(`.particle-earth-route__point[data-route-point-id="${detourId}"]`);
    return playback?.getAttribute("data-playback-step") === "3"
      && playback.getAttribute("data-playback-phase") === "stop"
      && document.querySelector('.journey-playback__chapter[data-chapter-point="1"]')
      && marker?.getAttribute("data-attention-role") === "narrative-current"
      && marker.getBoundingClientRect().width > 0
      && document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count") === "6";
  }, projectionPointIds.detour);
  const playbackDetourState = await projectionPage.evaluate(() => ({
    step: document.querySelector(".journey-playback")?.getAttribute("data-playback-step"),
    chapter: document.querySelector(".journey-playback__chapter")?.getAttribute("data-chapter-point"),
    camera: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-point"),
    contextCount: document.querySelectorAll("[data-route-point-context]").length,
  }));
  record("Full Playback's pure detour owns the displayed chapter, camera and marker", {
    detourSeekTarget, playbackDetourState,
  }, playbackDetourState.step === "3"
    && playbackDetourState.chapter === "1"
    && playbackDetourState.camera === "35.5,-116.5"
    && playbackDetourState.contextCount === 0);
  const followedDetourFocus = await sceneFocusSnapshot(projectionPage);
  const playbackDrag = await findBlankGlobePoint(projectionPage);
  const playbackDragEnd = await projectionPage.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    for (const [dx, dy] of [[90, 35], [-90, 35], [90, -35], [-90, -35]]) {
      if (document.elementFromPoint(x + dx, y + dy) === canvas) return { x: x + dx, y: y + dy };
    }
    return null;
  }, playbackDrag);
  if (!playbackDragEnd) throw new Error("Playback has no native canvas drag path");
  await projectionPage.mouse.move(playbackDrag.x, playbackDrag.y);
  await projectionPage.mouse.down();
  await projectionPage.mouse.move(playbackDragEnd.x, playbackDragEnd.y, { steps: 6 });
  await projectionPage.mouse.up();
  await projectionPage.waitForFunction((detourId) => {
    const playback = document.querySelector(".journey-playback");
    const marker = document.querySelector(`.particle-earth-route__point[data-route-point-id="${detourId}"]`);
    return playback?.getAttribute("data-camera-follow") === "free"
      && playback.getAttribute("data-playback-step") === "3"
      && playback.getAttribute("data-map-interactive") === "true"
      && marker?.getAttribute("data-attention-role") === "narrative-current"
      && marker.getBoundingClientRect().width > 0;
  }, projectionPointIds.detour);
  const freeDetourFocus = await sceneFocusSnapshot(projectionPage);
  record("native map drag frees only the camera while pure-detour chapter and marker remain", {
    playbackDrag, playbackDragEnd, followedDetourFocus, freeDetourFocus,
  }, freeDetourFocus.focusRevision === followedDetourFocus.focusRevision
    && await projectionPlayback.getAttribute("data-camera-follow") === "free"
    && await projectionPlayback.locator('.journey-playback__chapter[data-chapter-point="1"]').count() === 1);
  await projectionPage.locator('.journey-playback__controls button[aria-label="继续播放"]').click();
  await projectionPage.waitForFunction((ids) => {
    const playback = document.querySelector(".journey-playback");
    const b = document.querySelector(`.particle-earth-route__point[data-route-point-id="${ids.b}"]`);
    return playback?.getAttribute("data-camera-follow") === "free"
      && playback.getAttribute("data-playback-step") === "4"
      && playback.getAttribute("data-playback-phase") === "travel"
      && b?.getAttribute("data-attention-role") === "narrative-current"
      && !document.querySelector(`.particle-earth-route__point[data-route-point-id="${ids.detour}"]`)
      && document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count") === "5";
  }, projectionPointIds);
  const freeAdvanceFocus = await sceneFocusSnapshot(projectionPage);
  record("automatic Playback advance changes the narrated point without recapturing free camera", {
    freeAdvanceFocus,
  }, freeAdvanceFocus.focusRevision === followedDetourFocus.focusRevision
    && await projectionPlayback.getAttribute("data-camera-follow") === "free");
  await projectionPage.locator(".journey-playback__close").click();
  record("projection page errors", { pageErrors: projectionRun.pageErrors }, projectionRun.pageErrors.length === 0);
  await projectionPage.close();

  const hiddenFinalRun = await openFocusAtlas({
    journeysPayload: [hiddenFinalPointJourney],
    initialPointId: projectionPointIds.firstA,
    focusMode: false,
  });
  const hiddenFinalFocus = await sceneFocusSnapshot(hiddenFinalRun.page);
  record("default overview fits the Journey when its final route vertex has no marker", {
    hiddenFinalFocus,
  }, hiddenFinalFocus.focusPoint === ""
    && hiddenFinalFocus.focusRoute === journeyId
    && hiddenFinalFocus.activeRoute === journeyId);
  record("hidden-final overview page errors", { pageErrors: hiddenFinalRun.pageErrors },
    hiddenFinalRun.pageErrors.length === 0);
  await hiddenFinalRun.page.close();

  const projectionDetailRun = await openFocusAtlas({
    realScene: true,
    focusMode: false,
    reduceMotion: true,
    viewport: { width: 1440, height: 1024 },
    journeysPayload: [projectionJourney],
    initialPointId: projectionPointIds.firstA,
  });
  const projectionDetailPage = projectionDetailRun.page;
  await enterRealDetail(projectionDetailPage);
  await projectionDetailPage.waitForFunction((expectedJourneyId) => {
    const map = document.querySelector(".detailed-earth-map");
    return map?.getAttribute("data-journey-overlay-ready") === "true"
      && map.getAttribute("data-journey-overlay-journey-id") === expectedJourneyId;
  }, journeyId, { timeout: 10_000 });
  const projectionDetailState = await projectionDetailPage.evaluate((fixture) => {
    const map = document.querySelector(".detailed-earth-map");
    const hitAt = (pointId) => {
      const point = fixture.routePoints.find((candidate) => candidate.id === pointId);
      const projected = point && window.__detailedEarthMapProject?.(point.longitude, point.latitude);
      return projected
        ? window.__detailedEarthJourneyRoutePointHit?.(projected.x, projected.y) ?? null
        : null;
    };
    return {
      owner: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner"),
      pointCount: map?.getAttribute("data-journey-overlay-point-count"),
      featureCount: map?.getAttribute("data-journey-overlay-feature-count"),
      hiddenHit: hitAt(fixture.detourId),
      noteHit: hitAt(fixture.noteId),
      mediaHit: hitAt(fixture.mediaId),
    };
  }, {
    routePoints: projectionRoutePoints,
    detourId: projectionPointIds.detour,
    noteId: projectionPointIds.note,
    mediaId: projectionPointIds.media,
  });
  record("Detail keeps all route legs, hides pure detour hit and retains contentful non-stop hits", {
    projectionDetailState,
  },
    projectionDetailState.owner === "detail"
    && projectionDetailState.pointCount === "6"
    && projectionDetailState.featureCount === "11"
    && projectionDetailState.hiddenHit === null
    && projectionDetailState.noteHit?.routePointId === projectionPointIds.note
    && projectionDetailState.mediaHit?.routePointId === projectionPointIds.media);
  let projectedDetailB = await detailedExistingRoutePointTarget(
    projectionDetailPage, projectionJourney, projectionPointIds.b,
  );
  if (!projectedDetailB) {
    // Detail may enter near one end of a long route. The Journey rail is its
    // real route-framing control; use it before grading B's native hit target.
    const focusProbe = projectionDetailPage.locator("[data-qa-route-point-context-focus]");
    const previousRevision = Number(await focusProbe.getAttribute("data-focus-revision") ?? 0);
    await projectionDetailPage.locator(".living-atlas__journey-rail button", {
      hasText: projectionJourney.title,
    }).first().click();
    await projectionDetailPage.waitForFunction((revision) => Number(
      document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-revision") ?? 0,
    ) > revision, previousRevision, { timeout: 5_000 });
    await projectionDetailPage.waitForFunction((point) => {
      const projected = window.__detailedEarthMapProject?.(point.longitude, point.latitude);
      return Boolean(projected
        && window.__detailedEarthJourneyRoutePointHit?.(projected.x, projected.y)?.routePointId === point.id);
    }, projectionRoutePoints[2], { timeout: 5_000 });
    projectedDetailB = await detailedExistingRoutePointTarget(
      projectionDetailPage, projectionJourney, projectionPointIds.b,
    );
  }
  if (!projectedDetailB) throw new Error("sparse Detail route has no pointer-reachable B marker");
  await projectionDetailPage.mouse.click(projectedDetailB.x, projectedDetailB.y);
  await projectionDetailPage.locator(`[data-route-point-context][data-route-point-id="${projectionPointIds.b}"]`)
    .waitFor({ state: "visible", timeout: 5_000 });
  const projectedDetailOpen = await projectionDetailPage.evaluate(() => ({
    routePointId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id"),
    journeyId: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route"),
    owner: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner"),
  }));
  record("sparse Detail opens B through its native map marker hit", {
    projectedDetailB, projectedDetailOpen,
  }, projectedDetailOpen.routePointId === projectionPointIds.b
    && projectedDetailOpen.journeyId === journeyId
    && projectedDetailOpen.owner === "detail");
  await projectionDetailPage.locator("[data-route-point-context-close]").click();
  await projectionDetailPage.locator("[data-route-point-context]").waitFor({ state: "detached", timeout: 5_000 });
  const hiddenDetourClick = await projectionDetailPage.evaluate((point) => {
    const projected = window.__detailedEarthMapProject?.(point.longitude, point.latitude);
    if (!projected) return null;
    const hit = document.elementFromPoint(projected.x, projected.y);
    return hit instanceof Element && hit.closest(".detailed-earth-map")
      && !window.__detailedEarthJourneyRoutePointHit?.(projected.x, projected.y)
      ? { x: projected.x, y: projected.y }
      : null;
  }, projectionRoutePoints[1]);
  if (!hiddenDetourClick) throw new Error("pure detour has no pointer-reachable Detail map coordinate");
  await projectionDetailPage.mouse.click(hiddenDetourClick.x, hiddenDetourClick.y);
  const hiddenDetourAfterClick = await projectionDetailPage.evaluate(() => ({
    contextCount: document.querySelectorAll("[data-route-point-context]").length,
    owner: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner"),
    activeRoute: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route"),
  }));
  record("native Detail click on the pure detour stays blank without changing Journey owner", {
    hiddenDetourClick, hiddenDetourAfterClick,
  }, hiddenDetourAfterClick.contextCount === 0
    && hiddenDetourAfterClick.owner === "detail"
    && hiddenDetourAfterClick.activeRoute === journeyId);
  record("projection Detail page errors", { pageErrors: projectionDetailRun.pageErrors },
    projectionDetailRun.pageErrors.length === 0);
  await projectionDetailPage.close();

  const geometryOnlyRun = await openFocusAtlas({
    realScene: true,
    reduceMotion: true,
    journeysPayload: [geometryOnlyJourney],
    initialPointId: projectionPointIds.firstA,
  });
  const geometryOnlyPage = geometryOnlyRun.page;
  await geometryOnlyPage.waitForFunction(() => (
    document.querySelector(".particle-earth-scene")?.getAttribute("data-journey-route-point-count") === "2"
  ));
  const geometryOnlyState = await geometryOnlyPage.evaluate((targetJourneyId) => {
    const route = document.querySelector(`.particle-earth-route[data-journey-route="${targetJourneyId}"]`);
    return {
      markerIds: [...(route?.querySelectorAll(".particle-earth-route__point[data-route-point-id]") ?? [])]
        .map((node) => node.getAttribute("data-route-point-id")),
      legCount: route?.querySelectorAll(".particle-earth-route__leg").length ?? 0,
    };
  }, journeyId);
  record("geometry-only old Journey retains canonical endpoint anchors and every route leg", {
    geometryOnlyState,
  },
    geometryOnlyState.markerIds.join(",") === [
      projectionPointIds.firstA, projectionPointIds.returnA,
    ].join(",")
    && geometryOnlyState.legCount === geometryOnlyJourney.routePoints.length - 1);
  record("geometry-only page errors", { pageErrors: geometryOnlyRun.pageErrors },
    geometryOnlyRun.pageErrors.length === 0);
  await geometryOnlyPage.close();

  // #515's Detailed Earth owns its own DOM capture and MapLibre click paths.
  // Once the Composer asks for a globe point, an existing Journey marker must
  // deliver the coordinate to that request, not reopen Route Point context.
  const detailPickRun = await openFocusAtlas({
    realScene: true,
    focusMode: false,
    reduceMotion: true,
    viewport: { width: 1440, height: 1024 },
    journeysPayload: [siblingJourney, interactionJourney],
  });
  const detailPickPage = detailPickRun.page;
  const enteredDetail = await enterRealDetail(detailPickPage);
  await detailPickPage.waitForFunction((expectedJourneyId) => {
    const map = document.querySelector(".detailed-earth-map");
    return map?.getAttribute("data-journey-overlay-ready") === "true"
      && map.getAttribute("data-journey-overlay-journey-id") === expectedJourneyId;
  }, journeyId, { timeout: 5_000 });
  let existingDetailPoint = await detailedExistingRoutePointTarget(detailPickPage, interactionJourney);
  if (!existingDetailPoint) {
    // Manual zoom may leave the Journey off-screen. Re-selecting its real rail
    // card is the product's supported camera focus intent in Detail as well.
    const focusProbe = detailPickPage.locator("[data-qa-route-point-context-focus]");
    const previousRevision = Number(await focusProbe.getAttribute("data-focus-revision") ?? 0);
    await detailPickPage.locator(".living-atlas__journey-rail button", { hasText: interactionJourney.title }).first().click();
    await detailPickPage.waitForFunction((revision) => (
      Number(document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-revision") ?? 0) > revision
    ), previousRevision, { timeout: 5_000 });
    await detailPickPage.waitForFunction((route) => route.routePoints.some((point) => {
      const projected = window.__detailedEarthMapProject?.(point.longitude, point.latitude);
      return projected && projected.x >= 22 && projected.y >= 22
        && projected.x < innerWidth - 22 && projected.y < innerHeight - 22;
    }), interactionJourney, { timeout: 5_000 });
    existingDetailPoint = await detailedExistingRoutePointTarget(detailPickPage, interactionJourney);
  }
  if (!existingDetailPoint) throw new Error("Detail Journey Route Point has no pointer-reachable existing-marker sample");

  await detailPickPage.mouse.click(existingDetailPoint.x, existingDetailPoint.y);
  const detailContext = detailPickPage.locator("[data-route-point-context]");
  await detailContext.waitFor({ state: "visible", timeout: 5_000 });
  const detailOpenState = await detailPickPage.evaluate(() => ({
    routePointId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
    activeRoute: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route") ?? null,
    overlayJourneyId: document.querySelector(".detailed-earth-map")?.getAttribute("data-journey-overlay-journey-id") ?? null,
    owner: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner") ?? null,
  }));
  record("native Detail marker opens the matching Route Point context", { existingDetailPoint, detailOpenState },
    detailOpenState.routePointId === existingDetailPoint.routePointId
    && detailOpenState.activeRoute === journeyId
    && detailOpenState.overlayJourneyId === journeyId
    && detailOpenState.owner === "detail");

  const detailDragTarget = await findBlankDetailPoint(detailPickPage, true);
  await detailPickPage.mouse.move(detailDragTarget.x, detailDragTarget.y);
  await detailPickPage.mouse.down();
  await detailPickPage.mouse.move(detailDragTarget.x + 36, detailDragTarget.y + 18, { steps: 4 });
  await detailPickPage.mouse.up();
  const detailAfterDrag = await detailPickPage.evaluate(() => ({
    routePointId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
    activeRoute: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route") ?? null,
    owner: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner") ?? null,
  }));
  record("native Detail drag keeps the selected context and Journey owner", { detailDragTarget, detailAfterDrag },
    detailAfterDrag.routePointId === existingDetailPoint.routePointId
    && detailAfterDrag.activeRoute === journeyId
    && detailAfterDrag.owner === "detail");

  const detailBlankTarget = await findBlankDetailPoint(detailPickPage);
  await detailPickPage.mouse.click(detailBlankTarget.x, detailBlankTarget.y);
  await detailContext.waitFor({ state: "detached", timeout: 5_000 });
  const detailAfterBlank = await detailPickPage.evaluate(() => ({
    contextCount: document.querySelectorAll("[data-route-point-context]").length,
    activeRoute: document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-active-route") ?? null,
    overlayJourneyId: document.querySelector(".detailed-earth-map")?.getAttribute("data-journey-overlay-journey-id") ?? null,
    owner: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive-owner") ?? null,
  }));
  record("native Detail blank click closes only context", { detailBlankTarget, detailAfterBlank },
    detailAfterBlank.contextCount === 0
    && detailAfterBlank.activeRoute === journeyId
    && detailAfterBlank.overlayJourneyId === journeyId
    && detailAfterBlank.owner === "detail");

  await detailPickPage.locator(".living-atlas__create").click();
  await detailPickPage.locator(".journey-composer").waitFor({ state: "visible", timeout: 5_000 });
  const detailPickTrigger = detailPickPage.getByRole("button", { name: /直接在地球上取点/ });
  await detailPickTrigger.scrollIntoViewIfNeeded();
  await detailPickTrigger.click();
  await detailPickPage.locator('.living-atlas.is-globe-picking .detailed-earth-map[data-point-pick="true"]').waitFor({ state: "visible", timeout: 5_000 });
  const pickTarget = await detailedExistingRoutePointTarget(detailPickPage, interactionJourney);
  if (!pickTarget) throw new Error("Detail existing Route Point stopped being pointer-reachable during globe pick");
  await detailPickPage.mouse.click(pickTarget.x, pickTarget.y);
  await detailPickPage.waitForFunction(() => (
    !document.querySelector(".living-atlas")?.classList.contains("is-globe-picking")
    && document.querySelectorAll(".journey-route-draft > li:not(.is-empty)").length === 1
  ), null, { timeout: 5_000 });
  const detailPickOutcome = await detailPickPage.evaluate(() => ({
    draftLatitude: document.querySelector(".journey-route-draft > li:not(.is-empty)")?.getAttribute("data-route-point-latitude") ?? null,
    draftLongitude: document.querySelector(".journey-route-draft > li:not(.is-empty)")?.getAttribute("data-route-point-longitude") ?? null,
    contextCount: document.querySelectorAll("[data-route-point-context]").length,
    storyCount: document.querySelectorAll(".journey-story").length,
    pickActive: document.querySelector(".living-atlas")?.classList.contains("is-globe-picking") ?? null,
    diveStage: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive") ?? null,
  }));
  const draftLatitude = Number(detailPickOutcome.draftLatitude);
  const draftLongitude = Number(detailPickOutcome.draftLongitude);
  record("Detail existing Route Point click completes Composer pick without reopening detail", {
    enteredDetail, existingDetailPoint, pickTarget, detailPickOutcome,
  },
    enteredDetail.stage === "detail"
    && pickTarget.journeyId === journeyId
    && interactionJourney.routePoints.some((point) => point.id === pickTarget.routePointId)
    && detailPickOutcome.contextCount === 0
    && detailPickOutcome.storyCount === 0
    && detailPickOutcome.pickActive === false
    && detailPickOutcome.draftLatitude !== null && detailPickOutcome.draftLongitude !== null
    && Number.isFinite(draftLatitude) && Number.isFinite(draftLongitude)
    && Math.abs(draftLatitude - pickTarget.latitude) < 0.2
    && Math.abs(draftLongitude - pickTarget.longitude) < 0.2);
  record("real Detail pick page errors", { pageErrors: detailPickRun.pageErrors }, detailPickRun.pageErrors.length === 0);
  await detailPickPage.close();

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

  // A Story scope with no media still owns the latest Route Point observation.
  // Closing it cannot fall back to A merely because B has no shared media
  // element to fly back to the map.
  const textReturnRun = await openFocusAtlas();
  const textReturnPage = textReturnRun.page;
  await activateRoutePoint(textReturnPage, 0);
  await textReturnPage.locator(`[data-route-point-context][data-route-point-id="${photoPointId}"]`).waitFor({ state: "visible", timeout: 5_000 });
  await textReturnPage.waitForFunction(() => document.querySelector("[data-route-point-context-media]")?.getAttribute("data-route-point-context-media") === "ready");
  await textReturnPage.locator(".living-atlas__route-point-context-entry").click();
  await textReturnPage.locator(`.journey-story__media [data-media-page="current"][data-media-page-id="${photoAssetId}"][data-media-page-ready="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await textReturnPage.locator(`.journey-story button[data-route-point-id="${textPointId}"]`).click();
  await textReturnPage.locator(`.journey-story button[data-route-point-id="${textPointId}"][aria-pressed="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  await textReturnPage.locator('.journey-story[data-has-media="false"]').waitFor({ state: "visible", timeout: 5_000 });
  const emptyStoryState = await textReturnPage.locator(".journey-story").evaluate((node) => ({
    selected: node.querySelector('button[data-route-point-id][aria-pressed="true"]')?.getAttribute("data-route-point-id") ?? null,
    mediaPageCount: node.querySelectorAll('.journey-story__media [data-media-page-id]').length,
    text: node.textContent ?? "",
  }));
  await textReturnPage.locator(".journey-story__close").click();
  const returnedTextContext = textReturnPage.locator(`[data-route-point-context][data-route-point-id="${textPointId}"]`);
  await returnedTextContext.waitFor({ state: "visible", timeout: 5_000 });
  const textReturnState = await textReturnPage.evaluate((pointId) => ({
    contextId: document.querySelector("[data-route-point-context]")?.getAttribute("data-route-point-id") ?? null,
    contextText: document.querySelector("[data-route-point-context]")?.textContent ?? "",
    staleApertures: document.querySelectorAll('[data-place-media-observation], [data-shared-element-clone^="place-media-"]').length,
    markerVisible: document.querySelector(`.particle-earth-route__point[data-route-point-id="${pointId}"]`)?.getBoundingClientRect().width > 0,
  }), textPointId);
  record("A -> no-media B closes to B's detail without a stale A aperture", {
    emptyStoryState, textReturnState,
  },
    emptyStoryState.selected === textPointId
    && emptyStoryState.mediaPageCount === 0
    && emptyStoryState.text.includes("这一站只留下了一句话")
    && textReturnState.contextId === textPointId
    && textReturnState.contextText.includes("九龙海旁")
    && textReturnState.staleApertures === 0
    && textReturnState.markerVisible);
  await returnedTextContext.locator(".living-atlas__route-point-context-entry").click();
  await textReturnPage.locator(`.journey-story button[data-route-point-id="${textPointId}"][aria-pressed="true"]`).waitFor({ state: "attached", timeout: 5_000 });
  record("returned B detail reopens the same no-media Story scope", {},
    await textReturnPage.locator('.journey-story[data-has-media="false"]').count() === 1);
  record("no-media return page errors", { pageErrors: textReturnRun.pageErrors }, textReturnRun.pageErrors.length === 0);
  await textReturnPage.close();

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
