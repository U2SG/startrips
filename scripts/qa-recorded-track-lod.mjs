// #342: synthetic ~100k evidence through the actual owner API and both renderers.
// No qaState bypass, camera setter, extra clock, real track or private input.
import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const artifactDir = "artifacts/recorded-track-lod";
const journeyId = "qa-100k-recorded-journey";
const operationKey = "qa-100k";
const start = Date.parse("2026-09-01T00:00:00.000Z");
const atHour = (hour) => new Date(start + hour * 3_600_000).toISOString();
const points = [
  { id: "qa-lod-start", latitude: 22.2, longitude: 114.1, isStop: true, occurredAt: atHour(0) },
  { id: "qa-lod-shape", latitude: 22.35, longitude: 114.25, isStop: false, occurredAt: atHour(12) },
  { id: "qa-lod-end", latitude: 22.5, longitude: 114.4, isStop: true, occurredAt: atHour(24) },
];
const journey = {
  id: journeyId, atlasId: "qa-atlas", title: "Synthetic recorded route", revision: 1,
  startedOn: "2026-09-01", endedOn: "2026-09-02", note: "", lightColor: "#77c8c2",
  lightEffect: null, coverMediaAssetId: null, createdByUserId: "qa-user",
  createdAt: atHour(0), updatedAt: atHour(0), media: [],
  routePoints: points.map((point, index) => ({
    ...point, journeyId, sortOrder: index, label: `Synthetic point ${index + 1}`,
    note: null, ownedByStopId: null, createdAt: atHour(0),
  })),
};
const spatialSamples = (count, latitude, longitude, span) => Array.from({ length: count }, (_, index) => {
  const fraction = index / (count - 1);
  return {
    latitude: latitude + fraction * span + Math.sin(fraction * Math.PI * 40) * 0.002,
    longitude: longitude + fraction * span,
    recordedAt: null,
  };
});
const segments = [
  { id: "dense-before-gap", samples: spatialSamples(99_000, 22.2, 114.1, 0.1) },
  { id: "dense-after-gap", samples: spatialSamples(1_000, 22.4, 114.3, 0.1) },
  { id: "dated-early", samples: [
    { latitude: 22.2, longitude: 114.1, recordedAt: atHour(0) },
    { latitude: 22.35, longitude: 114.1, recordedAt: atHour(1) },
    { latitude: 22.2, longitude: 114.2, recordedAt: atHour(22) },
  ] },
  { id: "dated-late", samples: [
    { latitude: 22.4, longitude: 114.3, recordedAt: atHour(18) },
    { latitude: 22.5, longitude: 114.4, recordedAt: atHour(23) },
  ] },
  { id: "incomplete-time", samples: [
    { latitude: 22.2, longitude: 114.3, recordedAt: atHour(0) },
    { latitude: 22.35, longitude: 114.3, recordedAt: null },
    { latitude: 22.2, longitude: 114.4, recordedAt: atHour(22) },
  ] },
].map((segment, index) => ({ ...segment, segmentOrder: index, sampleCount: segment.samples.length }));
const sampleCount = segments.reduce((count, segment) => count + segment.sampleCount, 0);
const trackPayload = { recordedTracks: [{
  journeyId, operationKey, source: "synthetic-qa", provenance: "recorded-track", segments,
}] };
const paintedStyle = {
  version: 8, sources: {}, layers: [{
    id: "qa-painted-background", type: "background",
    paint: { "background-color": "#173d43", "background-opacity": 1 },
  }],
};
const browser = await launchQaBrowser({
  headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
const errors = [];
const mutations = [];
const apiReads = [];
let geometryReads = 0;
let failed = false;
const record = (name, data, condition) => {
  const result = { name, ...data, failed: !condition };
  checks.push(result);
  console.log(JSON.stringify(result));
  if (!condition) failed = true;
};
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", deviceScaleFactor: 1,
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const json = (route, payload) => route.fulfill({
  status: 200, contentType: "application/json", body: JSON.stringify(payload),
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (!path.startsWith("/api/")) return route.continue();
  apiReads.push(`${request.method()} ${path}`);
  if (request.method() !== "GET") mutations.push({ path, method: request.method() });
  if (path === "/api/auth/get-session") return json(route, {
    session: {
      id: "qa-session", userId: "qa-user", token: "synthetic-token", activeOrganizationId: "qa-org",
      expiresAt: "2027-01-01T00:00:00.000Z", createdAt: atHour(0), updatedAt: atHour(0),
    },
    user: {
      id: "qa-user", name: "Synthetic traveler", email: "qa@example.com", emailVerified: true,
      createdAt: atHour(0), updatedAt: atHour(0),
    },
  });
  if (path === "/api/auth/organization/list") return json(route, [
    { id: "qa-org", name: "Synthetic Atlas", slug: "qa-atlas", createdAt: atHour(0) },
  ]);
  if (path === "/api/atlases/current") return json(route, {
    atlas: { id: "qa-atlas", title: "Synthetic Atlas", dedication: "" }, role: "owner",
  });
  if (path === "/api/journeys") return json(route, { journeys: [journey] });
  if (path === `/api/journey-recorded-tracks/${journeyId}`) {
    geometryReads += 1;
    return json(route, trackPayload);
  }
  if (path === "/api/account-preferences/earth-experience") return json(route, {
    earthExperience: "default", revision: 0, updatedAt: null,
  });
  if (path === "/api/home-bases") return json(route, { periods: [] });
  if (path === "/api/home-bases/dismissal") return json(route, { dismissals: [] });
  if (path === "/api/mapstyle") return json(route, paintedStyle);
  if (path === "/api/account-identities/providers") return json(route, { providers: [] });
  return json(route, {});
});

const particleSnapshot = () => page.evaluate(() => ({
  debug: window.__particleEarthDebug?.(),
  tracks: [...document.querySelectorAll(".particle-earth-route__recorded-track")].map((path) => ({
    id: path.dataset.recordedTrackSegment,
    evidence: path.dataset.recordedTrackTimeEvidence,
    levels: Number(path.dataset.recordedTrackLodLevels),
    error: Number(path.dataset.recordedTrackLodErrorRad),
    source: Number(path.dataset.recordedTrackLodSourcePoints),
    rendered: Number(path.dataset.recordedTrackLodRenderedPoints),
    hasGeometry: Boolean(path.getAttribute("d")),
  })),
  pointIds: [...document.querySelectorAll(".particle-earth-route__point")].map((point) => point.dataset.routePointId),
  ownerIds: [...document.querySelectorAll(".particle-earth-route")].map((group) => group.dataset.journeyRoute),
}));
const beginFrames = () => page.evaluate(() => {
  const intervals = [];
  const start = performance.now();
  let previous = start;
  window.__qaRecordedTrackFrames = { intervals, done: false };
  const tick = (now) => {
    intervals.push(now - previous);
    previous = now;
    if (now - start < 3_000) requestAnimationFrame(tick);
    else window.__qaRecordedTrackFrames.done = true;
  };
  requestAnimationFrame(tick);
});
const endFrames = async () => {
  await page.waitForFunction(() => window.__qaRecordedTrackFrames?.done === true);
  return page.evaluate(() => {
    const values = window.__qaRecordedTrackFrames.intervals;
    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: values.length, meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      maxMs: sorted.at(-1), renderer: "Chromium SwiftShader CI; not a device FPS benchmark",
    };
  });
};
const detailSnapshot = () => page.locator(".detailed-earth-map").evaluate((host) => ({
  key: host.dataset.journeyRecordedTrackLodKey,
  rendered: Number(host.dataset.journeyRecordedTrackRenderedPoints),
  builds: Number(host.dataset.journeyRecordedTrackLodBuilds),
  pixelsPerRadian: Number(host.dataset.journeyRecordedTrackPixelsPerRadian),
  segments: JSON.parse(host.dataset.journeyRecordedTrackSegments ?? "[]"),
  owner: host.dataset.journeyOverlayJourneyId,
  points: Number(host.dataset.journeyOverlayPointCount),
  stops: Number(host.dataset.journeyOverlayStopCount),
  shaping: Number(host.dataset.journeyOverlayPassthroughCount),
  idle: Number(host.dataset.mapIdleCount ?? 0),
  zoom: Number(host.dataset.handoffZoom),
}));

try {
  await mkdir(artifactDir, { recursive: true });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__particleEarthDebug?.().journeyRouteProjectionReady
    && document.querySelectorAll(".particle-earth-route__recorded-track").length === 5,
  null, { timeout: 25_000 });
  await page.locator(".living-atlas__globe-focus").click();
  await page.waitForFunction(() => document.querySelector(".living-atlas")?.dataset.globeFocus === "on");
  const initial = await particleSnapshot();
  record("100k owner-private samples preserve independent gaps and bounded overview levels", { sampleCount, initial },
    sampleCount === 100_008 && geometryReads > 0 && initial.tracks.length === 5
    && initial.tracks.slice(0, 2).every((track) => track.levels >= 3)
    && initial.tracks.reduce((sum, track) => sum + track.source, 0) <= 2_048);

  const slider = page.getByRole("slider", { name: "时间轴", exact: true });
  await slider.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector('.globe-time-scrubber [role="slider"]')?.getAttribute("aria-valuenow") === "0");
  await page.waitForFunction(() => {
    const paths = [...document.querySelectorAll(".particle-earth-route__recorded-track")];
    return paths.find((path) => path.dataset.recordedTrackSegment.endsWith(":dated-early"))
      ?.dataset.recordedTrackLodRenderedPoints === "1"
      && paths.find((path) => path.dataset.recordedTrackSegment.endsWith(":dated-late"))
        ?.dataset.recordedTrackLodRenderedPoints === "0";
  });
  const zero = await particleSnapshot();
  const atQuarter = await slider.boundingBox();
  if (!atQuarter) throw new Error("Actual timeline slider has no input geometry");
  await page.mouse.click(atQuarter.x + atQuarter.width * 0.25, atQuarter.y + atQuarter.height / 2);
  await page.waitForFunction(() => {
    const paths = [...document.querySelectorAll(".particle-earth-route__recorded-track")];
    return paths.find((path) => path.dataset.recordedTrackSegment.endsWith(":dated-early"))
      ?.dataset.recordedTrackLodRenderedPoints === "2";
  });
  const quarter = await particleSnapshot();
  const spatial = (snapshot) => snapshot.tracks.filter((track) => track.evidence === "spatial");
  const count = (snapshot, id) => snapshot.tracks.find((track) => track.id.endsWith(`:${id}`))?.rendered;
  record("real timeline input never slices untimed or incomplete evidence by sample order", { zero, quarter },
    [zero, quarter].every((snapshot) => spatial(snapshot).length === 3
      && spatial(snapshot).every((track) => track.rendered === track.source))
    && count(zero, "dated-early") === 1 && count(zero, "dated-late") === 0
    && count(quarter, "dated-early") === 2 && count(quarter, "dated-late") === 0);
  await slider.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.querySelector('.globe-time-scrubber [role="slider"]')?.getAttribute("aria-valuenow") === "100");
  await page.waitForFunction(() => window.__particleEarthDebug?.().journeyRouteProjectionReady);
  await page.waitForFunction(() => {
    const paths = [...document.querySelectorAll(".particle-earth-route__recorded-track")];
    return paths.find((path) => path.dataset.recordedTrackSegment.endsWith(":dated-early"))
      ?.dataset.recordedTrackLodRenderedPoints === "3"
      && paths.find((path) => path.dataset.recordedTrackSegment.endsWith(":dated-late"))
        ?.dataset.recordedTrackLodRenderedPoints === "2";
  });
  const beforeZoom = await particleSnapshot();
  await beginFrames();
  const overviewZooms = [];
  for (const delta of [200, -200, 200, -200, 200, -200]) {
    const snapshot = await particleSnapshot();
    const canvas = await page.locator('canvas[data-three-scene="particle-earth"]').boundingBox();
    if (!canvas) throw new Error("Actual particle canvas is missing");
    await page.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.5);
    await page.mouse.wheel(0, delta);
    await page.waitForFunction((zoom) => Math.abs((window.__particleEarthDebug?.().zoom ?? zoom) - zoom) > 0.001,
      snapshot.debug.zoom);
    overviewZooms.push(await particleSnapshot());
  }
  const overviewFrames = await endFrames();
  record("overview repeated native zoom keeps semantic owners and precomputed cache bounded", { overviewZooms, overviewFrames },
    overviewFrames.count >= 2 && Number.isFinite(overviewFrames.p95Ms)
    && overviewZooms.every((snapshot) => snapshot.debug.recordedTrackLodBuilds === beforeZoom.debug.recordedTrackLodBuilds
      && snapshot.ownerIds.join() === beforeZoom.ownerIds.join()
      && snapshot.pointIds.join() === beforeZoom.pointIds.join()
      && snapshot.tracks.reduce((sum, track) => sum + track.source, 0) <= 2_048));
  await page.screenshot({ path: `${artifactDir}/100k-overview.png` });

  await page.locator(".living-atlas__globe-focus-exit").click();
  const dive = page.locator('[data-earth-dive-intent="true"]');
  await dive.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".living-atlas-globe")?.dataset.earthDiveOwner === "detail"
    && document.querySelector(".detailed-earth-map")?.dataset.journeyOverlayReady === "true",
  null, { timeout: 25_000 });
  const detailBefore = await detailSnapshot();
  await beginFrames();
  const detailZooms = [];
  for (const delta of [2_400, -2_400, 2_400, -2_400]) {
    const before = await detailSnapshot();
    const canvas = await page.locator(".detailed-earth-map .maplibregl-canvas").boundingBox();
    if (!canvas) throw new Error("Actual detail canvas is missing");
    await page.mouse.move(canvas.x + canvas.width * 0.65, canvas.y + canvas.height * 0.45);
    await page.mouse.wheel(0, delta);
    await page.waitForFunction((previous) => Number(document.querySelector(".detailed-earth-map")?.dataset.mapIdleCount ?? 0) > previous.idle
      && window.__detailedEarthMapScrollZoomActive?.() === false
      && Math.abs(Number(document.querySelector(".detailed-earth-map")?.dataset.handoffZoom) - previous.zoom) > 0.001,
      before);
    detailZooms.push(await detailSnapshot());
  }
  const detailFrames = await endFrames();
  const expectedSegments = segments.map((segment) => `${journeyId}:recorded:${operationKey}:${segment.id}`);
  record("detail projected-error LOD changes preserve gaps, Stops, shaping order and cache", { detailBefore, detailZooms, detailFrames },
    detailFrames.count >= 2 && Number.isFinite(detailFrames.p95Ms)
    && new Set(detailZooms.map((snapshot) => snapshot.key)).size >= 2
    && new Set(detailZooms.map((snapshot) => snapshot.rendered)).size >= 2
    && detailZooms.every((snapshot) => snapshot.builds === detailBefore.builds
      && snapshot.owner === journeyId && snapshot.points === 3 && snapshot.stops === 2 && snapshot.shaping === 1
      && snapshot.segments.map(([id]) => id).join() === expectedSegments.join()
      && snapshot.rendered <= sampleCount
      && snapshot.pixelsPerRadian > 0));
  await page.screenshot({ path: `${artifactDir}/100k-detail.png` });
  record("owner renderer evidence is read-only and error-free", { geometryReads, mutations, errors },
    geometryReads > 0 && mutations.length === 0 && errors.length === 0);
} catch (error) {
  const snapshot = await page.evaluate(() => ({
    surface: document.querySelector("main")?.className ?? null,
    text: document.body.innerText.slice(0, 400),
    debug: window.__particleEarthDebug?.() ?? null,
    routeCount: document.querySelectorAll(".particle-earth-route").length,
    trackCount: document.querySelectorAll(".particle-earth-route__recorded-track").length,
    activeJourney: document.querySelector(".living-atlas__journey-rail button.is-active")?.textContent?.trim() ?? null,
  })).catch(() => null);
  await page.screenshot({ path: `${artifactDir}/failure.png` }).catch(() => undefined);
  record("recorded-track QA exception", {
    message: String(error.stack ?? error), snapshot, geometryReads, apiReads, errors,
  }, false);
} finally {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(`${artifactDir}/results.json`, JSON.stringify({ sampleCount, checks }, null, 2));
  await browser.close();
}
if (failed) process.exitCode = 1;
