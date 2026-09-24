// #339 / ST-118. Grade the real Atlas globe and Full Playback together in GitHub CI.
import assert from "node:assert/strict";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const journeyId = "qa-playback-camera-journey";
const imageId = "qa-playback-camera-image";
const videoId = "qa-playback-camera-video";
const points = [
  { id: "qa-camera-hong-kong", latitude: 22.2855, longitude: 114.1577, label: "香港" },
  { id: "qa-camera-seoul", latitude: 37.5665, longitude: 126.9780, label: "首尔" },
  { id: "qa-camera-osaka", latitude: 34.6937, longitude: 135.5023, label: "大阪" },
];
const journey = {
  id: journeyId, atlasId: "qa-atlas", title: "镜头与旅程的交接", startedOn: "2026-04-06",
  endedOn: null, note: "", lightColor: "#77c8c2", lightEffect: null,
  coverMediaAssetId: null, revision: 1, createdByUserId: "qa-user",
  createdAt: "2026-04-06T00:00:00.000Z", updatedAt: "2026-04-06T00:00:00.000Z",
  routePoints: points.map((point, index) => ({
    ...point, journeyId, sortOrder: index, isStop: true, occurredAt: null, note: null,
    createdAt: `2026-04-0${index + 6}T00:00:00.000Z`,
  })),
  media: [
    { id: imageId, routePointId: points[1].id, fileName: "seoul.svg", mimeType: "image/svg+xml" },
    { id: videoId, routePointId: points[2].id, fileName: "osaka.webm", mimeType: "video/webm" },
  ].map((asset, index) => ({
    ...asset, journeyId, storageDriver: "qa", storageKey: asset.id, bytes: 128,
    sortOrder: index, uploadedByUserId: "qa-user", createdAt: "2026-04-07T00:00:00.000Z",
  })),
};
const mapStyle = {
  version: 8, name: "QA visible detail surface", sources: {},
  layers: [{ id: "qa-map-background", type: "background", paint: { "background-color": "#173d43" } }],
};
const mapStylePattern = /\/api\/mapstyle\?path=styles(?:%2F|\/)fiord(?:$|&)/i;
const imageUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='%2367b5a7'/%3E%3C/svg%3E";
const browser = await launchQaBrowser({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const reports = [];

async function open({ mobile = false, reduced = false, holdImage = false } = {}) {
  const page = await browser.newPage({
    // Start through the real desktop Playback chooser, then cross the compact
    // boundary on this same page; the mobile sheet has no Playback action.
    viewport: { width: 1280, height: 800 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: reduced ? "reduce" : "no-preference",
  });
  const errors = [];
  let markImageRequested = () => undefined;
  let releaseImage = () => undefined;
  let imageRequested = Promise.resolve();
  let imageGate = Promise.resolve();
  if (holdImage) {
    imageRequested = new Promise((resolve) => { markImageRequested = resolve; });
    imageGate = new Promise((resolve) => { releaseImage = resolve; });
  }
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ journeys: [journey] }),
  }));
  await page.route(mapStylePattern, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(mapStyle),
  }));
  await page.route("**/api/uploads/assets/*/read-url", async (route) => {
    const isImage = route.request().url().includes(imageId);
    if (isImage && holdImage) {
      markImageRequested();
      await imageGate;
    }
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        url: route.request().url().includes(videoId) ? `${origin}/demo-media/east-star-orbit.webm` : imageUrl,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
  });
  await page.goto(`${origin}/?qaState=living-atlas&qaMode=globe-chrome&qaRealRoutePointScene=1&qaRoutePointContext=1`,
    { waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator('[data-scene-ready="true"]').waitFor({ timeout: 25_000 });
  await page.locator(".living-atlas__active-play").waitFor({ state: "visible" });
  await page.locator(".living-atlas__journey-rail button", { hasText: journey.title }).first().click();
  return { page, errors, imageRequested, releaseImage };
}

function snapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".journey-playback");
    const map = document.querySelector(".detailed-earth-map");
    const focus = document.querySelector("[data-qa-route-point-context-focus]");
    const particle = window.__particleEarthDebug?.();
    const center = map?.dataset.mapCameraObservation?.split(",").map(Number) ?? [];
    return {
      step: Number(root?.dataset.playbackStep), phase: root?.dataset.playbackPhase ?? null,
      following: root?.dataset.cameraFollow ?? null, mapInteractive: root?.dataset.mapInteractive ?? null,
      mapOwner: map?.dataset.diveOwner ?? null, mapCenter: center,
      mapZoom: Number(map?.dataset.handoffZoom ?? NaN),
      focusRevision: Number(focus?.dataset.focusRevision ?? NaN),
      focusPoint: focus?.dataset.focusPoint ?? null,
      rotationX: particle?.rotationX ?? null, rotationY: particle?.rotationY ?? null,
      manualFocusOwner: particle?.manualFocusOwner ?? null,
      presented: root?.querySelector("[data-presented-asset]")?.getAttribute("data-presented-asset") ?? null,
    };
  });
}

async function visibleImage(page, assetId) {
  const result = await page.evaluate((id) => {
    const stage = document.querySelector(`[data-presented-asset="${id}"]`);
    const image = stage?.querySelector('[data-media-asset][aria-hidden="false"] img');
    const rect = image?.getBoundingClientRect();
    const samples = rect ? [0.3, 0.5, 0.7].flatMap((fx) => [0.3, 0.5, 0.7].map((fy) => {
      const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
      return Boolean(hit && stage.contains(hit));
    })) : [];
    return { loaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      width: rect?.width ?? 0, height: rect?.height ?? 0, visibleHits: samples.filter(Boolean).length };
  }, assetId);
  assert.ok(result.loaded && result.width > 40 && result.height > 40 && result.visibleHits >= 1,
    `presented image is not visibly reachable: ${JSON.stringify(result)}`);
  return result;
}

async function steeringPoint(page, detail, requireEnd = true) {
  const point = await page.evaluate(({ expectDetail, requireEnd }) => {
    const canvas = document.querySelector(expectDetail ? ".maplibregl-canvas" : 'canvas[data-three-scene="particle-earth"]');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const rect = canvas.getBoundingClientRect();
    for (const offsetY of [0, -70, 70, -130, 130]) for (const offsetX of [0, -70, 70, -140, 140]) {
      const x = Math.round(rect.left + rect.width / 2 + offsetX);
      const y = Math.round(rect.top + rect.height / 2 + offsetY);
      const endX = x + (x < innerWidth / 2 ? 90 : -90);
      const endY = y + (y < innerHeight / 2 ? 35 : -35);
      if ([x, endX].some((value) => value < 8 || value > innerWidth - 8)
          || [y, endY].some((value) => value < 8 || value > innerHeight - 8)) continue;
      const hit = document.elementFromPoint(x, y);
      const endHit = document.elementFromPoint(endX, endY);
      const owns = (element) => element === canvas;
      if (owns(hit) && (!requireEnd || owns(endHit))) return { x, y, endX, endY, hit: hit?.className ?? "" };
    }
    return null;
  }, { expectDetail: detail, requireEnd });
  assert.ok(point, `no real ${detail ? "detail map" : "particle globe"} hit target at the current surface`);
  return point;
}

async function stopBlankPoint(page) {
  const point = await page.evaluate(() => {
    const stop = document.querySelector(".journey-playback__stop");
    const canvas = document.querySelector(".maplibregl-canvas");
    if (!(stop instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return null;
    const rect = stop.getBoundingClientRect();
    const stageHeight = document.querySelector(".journey-playback__stage")?.getBoundingClientRect().height ?? 0;
    const chapterDensity = document.querySelector(".journey-playback")?.dataset.playbackChapterDensity ?? null;
    for (const fy of [0.3, 0.6, 0.8]) for (const fx of [0.16, 0.84, 0.25, 0.75]) {
      const x = Math.round(rect.left + rect.width * fx);
      const y = Math.round(rect.top + rect.height * fy);
      const endX = x + (fx < 0.5 ? 60 : -60);
      const endY = y + (fy < 0.5 ? 18 : -18);
      if (x < 8 || y < 8 || endX < 8 || endY < 8
          || x >= innerWidth - 8 || y >= innerHeight - 8
          || endX >= innerWidth - 8 || endY >= innerHeight - 8) continue;
      if (document.elementFromPoint(x, y) === canvas && document.elementFromPoint(endX, endY) === canvas) {
        return { x, y, endX, endY, stageHeight, chapterDensity,
          stopRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }
    }
    return null;
  });
  if (!point) {
    const diagnostic = await page.evaluate(() => {
      const root = document.querySelector(".journey-playback");
      const stop = root?.querySelector(".journey-playback__stop");
      const heading = stop?.querySelector("h3");
      const canvas = document.querySelector(".maplibregl-canvas");
      const describe = (element) => element instanceof Element
        ? `${element.tagName.toLowerCase()}.${typeof element.className === "string" ? element.className : ""}` : null;
      const rect = stop?.getBoundingClientRect();
      const headingRect = heading?.getBoundingClientRect();
      const style = stop instanceof HTMLElement ? getComputedStyle(stop) : null;
      const samples = rect ? [0.3, 0.6, 0.8].flatMap((fy) => [0.16, 0.84].map((fx) => {
        const x = Math.round(rect.left + rect.width * fx);
        const y = Math.round(rect.top + rect.height * fy);
        return { x, y, hit: describe(document.elementFromPoint(x, y)) };
      })) : [];
      return {
        phase: root?.dataset.playbackPhase, step: root?.dataset.playbackStep,
        arrivalGate: root?.dataset.arrivalGate, mapInteractive: root?.dataset.mapInteractive,
        chapterDensity: root?.dataset.playbackChapterDensity,
        mapOwner: document.querySelector(".detailed-earth-map")?.getAttribute("data-dive-owner"),
        canvas: describe(canvas), stop: describe(stop),
        stopRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        stopStyle: style ? { display: style.display, visibility: style.visibility,
          opacity: style.opacity, pointerEvents: style.pointerEvents } : null,
        headingRect: headingRect ? { x: headingRect.x, y: headingRect.y,
          width: headingRect.width, height: headingRect.height } : null,
        headingHit: headingRect ? describe(document.elementFromPoint(
          headingRect.left + headingRect.width / 2, headingRect.top + headingRect.height / 2)) : null,
        samples,
      };
    });
    assert.fail(`Stop caption's visible blank area must pass real pointer input to Detail Map: ${JSON.stringify(diagnostic)}`);
  }
  return point;
}

async function waitForVisibleStop(page, step) {
  await page.waitForFunction((expectedStep) => {
    const root = document.querySelector(".journey-playback");
    if (root?.dataset.playbackPhase !== "stop" || root.dataset.playbackStep !== String(expectedStep)
      || root.dataset.arrivalGate === "pending") return false;
    const heading = root.querySelector(".journey-playback__stop h3");
    if (!(heading instanceof HTMLElement)) return false;
    const rect = heading.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === heading || heading.contains(hit);
  }, step, { timeout: 8_000 });
}

async function armPauseAtStop(page, step) {
  await page.evaluate((expectedStep) => {
    const root = document.querySelector(".journey-playback");
    if (!(root instanceof HTMLElement)) throw new Error("Playback root missing before Stop capture");
    const state = () => ({
      phase: root.dataset.playbackPhase, step: root.dataset.playbackStep,
      paused: root.classList.contains("is-paused"), arrivalGate: root.dataset.arrivalGate,
      following: root.dataset.cameraFollow,
    });
    const capture = { armed: state(), transitions: [], triggered: null };
    window.__qaPlaybackCameraStopCapture = capture;
    let lastTransition = "";
    const onTransition = () => {
      const current = state();
      const key = `${current.step}:${current.phase}:${current.paused}`;
      if (key !== lastTransition && capture.transitions.length < 16) {
        capture.transitions.push(current);
        lastTransition = key;
      }
      if (current.phase !== "stop" || current.step !== String(expectedStep)) return;
      observer.disconnect();
      const button = root.querySelector('.journey-playback__controls button[aria-label="暂停播放"]');
      capture.triggered = { ...current, buttonFound: button instanceof HTMLButtonElement,
        buttonDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
        headingPresent: Boolean(root.querySelector(".journey-playback__stop h3")),
        clicked: false };
      if (current.paused) return;
      if (button instanceof HTMLButtonElement && !button.disabled) {
        // Pause the brief beat through its own control before QA crosses the process boundary.
        button.click();
        capture.triggered.clicked = true;
      }
    };
    const observer = new MutationObserver(onTransition);
    observer.observe(root, { attributes: true,
      attributeFilter: ["data-playback-phase", "data-playback-step"] });
    onTransition();
  }, step);
}

async function waitForCapturedStop(page, step) {
  try {
    await page.waitForFunction((expectedStep) => {
      const root = document.querySelector(".journey-playback");
      return root?.dataset.playbackPhase === "stop" && root.dataset.playbackStep === String(expectedStep)
        && root.classList.contains("is-paused")
        && window.__qaPlaybackCameraStopCapture?.triggered?.clicked;
    }, step, { timeout: 40_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      capture: window.__qaPlaybackCameraStopCapture ?? null,
      current: (() => {
        const root = document.querySelector(".journey-playback");
        return root ? { phase: root.dataset.playbackPhase, step: root.dataset.playbackStep,
          paused: root.classList.contains("is-paused"), arrivalGate: root.dataset.arrivalGate,
          following: root.dataset.cameraFollow,
          pauseControl: Boolean(root.querySelector('.journey-playback__controls button[aria-label="暂停播放"]')) } : null;
      })(),
    }));
    throw new Error(`Stop was not captured and paused: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  return page.evaluate(() => window.__qaPlaybackCameraStopCapture);
}

async function dragSurface(page, detail) {
  const point = await steeringPoint(page, detail);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.endX, point.endY, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.cameraFollow === "free", null,
    { timeout: 5_000 });
  return point;
}

async function touchDragParticle(page) {
  const point = await steeringPoint(page, false);
  await page.evaluate(() => {
    window.__qaPlaybackCameraTouch = [];
    window.__qaPlaybackCameraTouchDown = [];
    const describe = (element) => element instanceof Element ? {
      tag: element.tagName.toLowerCase(),
      className: element.getAttribute("class") || "",
      id: element.id || null,
      threeScene: element.getAttribute("data-three-scene"),
      routePoint: element.getAttribute("data-route-point-id"),
    } : null;
    window.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      const root = document.querySelector(".journey-playback");
      const globe = document.querySelector(".living-atlas-globe");
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      window.__qaPlaybackCameraTouchDown.push({
        trusted: event.isTrusted, pointerId: event.pointerId,
        x: event.clientX, y: event.clientY,
        target: describe(event.target),
        atPoint: describe(document.elementFromPoint(event.clientX, event.clientY)),
        composedPath: event.composedPath().filter((node) => node instanceof Element).slice(0, 10).map(describe),
        canvas: describe(canvas),
        canvasPointerEvents: canvas instanceof Element ? getComputedStyle(canvas).pointerEvents : null,
        phase: root?.dataset.playbackPhase, step: root?.dataset.playbackStep,
        cameraFollow: root?.dataset.cameraFollow, mapInteractive: root?.dataset.mapInteractive,
        arrivalGate: root?.dataset.arrivalGate,
        overlayPointerEvents: root instanceof Element ? getComputedStyle(root).pointerEvents : null,
        earthDiveOwner: globe?.getAttribute("data-earth-dive-owner"),
        detailOwner: document.querySelector(".detailed-earth-map")?.getAttribute("data-dive-owner"),
      });
    }, { capture: true });
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      document.addEventListener(type, (event) => {
        if (event.target instanceof Element && event.target.matches('canvas[data-three-scene="particle-earth"]')) {
          window.__qaPlaybackCameraTouch.push({ type, pointerType: event.pointerType, trusted: event.isTrusted });
        }
      }, { capture: true });
    }
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
        x: point.x + (point.endX - point.x) * step / 6,
        y: point.y + (point.endY - point.y) * step / 6,
      }] });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
  await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.cameraFollow === "free", null,
    { timeout: 5_000 });
  const { events, downEvents } = await page.evaluate(() => ({
    events: window.__qaPlaybackCameraTouch,
    downEvents: window.__qaPlaybackCameraTouchDown,
  }));
  assert.ok(events.some((event) => event.type === "pointerdown" && event.pointerType === "touch" && event.trusted),
    `trusted touch did not reach particle canvas: ${JSON.stringify({ point, events, downEvents })}`);
  assert.ok(events.some((event) => event.type === "pointermove" && event.pointerType === "touch" && event.trusted),
    `trusted touch move did not reach particle canvas: ${JSON.stringify({ point, events, downEvents })}`);
  assert.ok(events.every((event) => event.pointerType === "touch"),
    `mouse pointer contaminated mobile gesture: ${JSON.stringify({ point, events, downEvents })}`);
  return { point, events, downEvents };
}

async function enterDetail(page) {
  // Ordinary Atlas exposes the semantic Dive control while its background
  // particle canvas does not own pointer input. Use that user entry, then grade
  // real map wheel/drag/keyboard input after Full Playback gives it ownership.
  const intent = page.locator('[data-earth-dive-intent="true"]');
  assert.equal(await intent.count(), 1, "one semantic Dive control");
  await intent.focus();
  assert.ok(await intent.evaluate((button) => document.activeElement === button), "Dive control is keyboard reachable");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".living-atlas-globe")?.dataset.earthDive === "detail"
    && document.querySelector(".living-atlas-globe")?.dataset.earthDiveOwner === "detail",
  null, { timeout: 25_000 });
}

async function startPlayback(page) {
  const play = page.locator(".living-atlas__active-play");
  await play.click();
  const menu = page.locator('.living-atlas__playback-mode-menu [data-playback-mode-option="full"]');
  await menu.waitFor({ state: "visible" });
  await menu.click();
  if (await page.locator(".journey-playback").count() === 0) {
    await page.waitForFunction(() => {
      const button = document.querySelector(".living-atlas__active-play");
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await play.click();
  }
  await page.locator('.journey-playback[data-playback-mode="full"]').waitFor({ state: "visible" });
  await page.locator(".journey-playback__tempo select").selectOption("immersive");
}

async function recordArrivalProjection(page) {
  await page.evaluate(({ longitude, latitude }) => {
    const root = document.querySelector(".journey-playback");
    if (!root) throw new Error("Playback root missing before arrival recording");
    window.__qaPlaybackCameraArrival = [];
    const capture = () => {
      if (root.dataset.playbackPhase !== "stop" || root.dataset.playbackStep !== "6"
          || window.__qaPlaybackCameraArrival.length) return;
      const heading = root.querySelector(".journey-playback__stop h3");
      const headingRect = heading?.getBoundingClientRect();
      if (!(heading instanceof HTMLElement) || !headingRect?.width || !headingRect.height) return;
      const hit = document.elementFromPoint(headingRect.left + headingRect.width / 2,
        headingRect.top + headingRect.height / 2);
      if (root.dataset.arrivalGate === "pending" || (hit !== heading && !heading.contains(hit))) return;
      const map = document.querySelector(".detailed-earth-map");
      const rect = map?.getBoundingClientRect();
      const point = window.__detailedEarthMapProject?.(longitude, latitude) ?? null;
      const center = map?.dataset.mapCameraObservation?.split(",").map(Number) ?? [];
      window.__qaPlaybackCameraArrival.push({
        following: root.dataset.cameraFollow, mapOwner: map?.dataset.diveOwner ?? null,
        center, point, mapCenter: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
        visible: true,
      });
    };
    const observer = new MutationObserver(capture);
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    capture();
  }, points[2]);
}

try {
  // Detail map: real keyboard pan and drag claim the camera; the director keeps
  // advancing content, then Return and Back restore the latest explicit location.
  {
    const { page, errors } = await open();
    try {
      await enterDetail(page);
      await startPlayback(page);
      await page.waitForFunction(() => document.querySelector(".detailed-earth-map")?.dataset.mapCameraObservation?.split(",").length === 2,
        null, { timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.playbackPhase === "stop"
        && document.querySelector(".journey-playback")?.dataset.playbackStep === "1", null, { timeout: 40_000 });
      await page.locator('.journey-playback__controls button[aria-label="暂停播放"]').click();
      await page.locator(".journey-playback.is-paused").waitFor();
      const wheelPoint = await stopBlankPoint(page);
      const scaleBeforeWheel = await page.evaluate(({ longitude, latitude }) => {
        const a = window.__detailedEarthMapProject?.(longitude, latitude);
        const b = window.__detailedEarthMapProject?.(longitude + 1, latitude);
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
      }, points[0]);
      assert.ok(scaleBeforeWheel && scaleBeforeWheel > 0, "detail map must publish real projection before wheel");
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await page.evaluate(() => {
        window.__qaPlaybackCameraWheelEvents = [];
        document.addEventListener("wheel", (event) => {
          const canvas = document.querySelector(".maplibregl-canvas");
          window.__qaPlaybackCameraWheelEvents.push({
            trusted: event.isTrusted, deltaY: event.deltaY, targetIsCanvas: event.target === canvas,
            target: event.target instanceof Element ? event.target.className : null,
          });
        }, { capture: true, once: true });
      });
      await page.mouse.wheel(0, -120);
      try {
        await page.waitForFunction(({ longitude, latitude, baseline }) => {
          const a = window.__detailedEarthMapProject?.(longitude, latitude);
          const b = window.__detailedEarthMapProject?.(longitude + 1, latitude);
          return document.querySelector(".journey-playback")?.dataset.cameraFollow === "free"
            && a && b && Math.hypot(a.x - b.x, a.y - b.y) > baseline * 1.05;
        }, { ...points[0], baseline: scaleBeforeWheel }, { timeout: 8_000 });
      } catch (error) {
        const wheelDebug = await page.evaluate(({ longitude, latitude, baseline, x, y }) => {
          const root = document.querySelector(".journey-playback");
          const map = document.querySelector(".detailed-earth-map");
          const canvas = document.querySelector(".maplibregl-canvas");
          const hit = document.elementFromPoint(x, y);
          const a = window.__detailedEarthMapProject?.(longitude, latitude);
          const b = window.__detailedEarthMapProject?.(longitude + 1, latitude);
          const scale = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
          return {
            phase: root?.dataset.playbackPhase, step: root?.dataset.playbackStep,
            following: root?.dataset.cameraFollow, mapOwner: map?.dataset.diveOwner,
            mapCenter: map?.dataset.mapCameraObservation, mapZoom: map?.dataset.handoffZoom,
            baseline, scale, scaleRatio: scale === null ? null : scale / baseline,
            canvasTabIndex: canvas?.tabIndex, hitIsCanvas: hit === canvas,
            hit: hit instanceof Element ? hit.className : null,
            wheelEvents: window.__qaPlaybackCameraWheelEvents ?? [],
          };
        }, { ...points[0], baseline: scaleBeforeWheel, x: wheelPoint.x, y: wheelPoint.y });
        throw new Error(`First Detail Map wheel did not release follow and zoom: ${JSON.stringify(wheelDebug)}`, { cause: error });
      }
      const canvas = page.locator(".maplibregl-canvas");
      assert.equal(await canvas.evaluate((node) => node.tabIndex), 0, "detail map canvas must be keyboard reachable");
      await canvas.focus();
      assert.ok(await canvas.evaluate((node) => document.activeElement === node), "detail map canvas did not take focus");
      const beforeKey = await snapshot(page);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction((before) => {
        const root = document.querySelector(".journey-playback");
        const center = document.querySelector(".detailed-earth-map")?.dataset.mapCameraObservation?.split(",").map(Number);
        return root?.dataset.cameraFollow === "free" && center?.length === 2
          && Math.hypot(center[0] - before[0], center[1] - before[1]) > 0.0001;
      }, beforeKey.mapCenter, { timeout: 8_000 });
      assert.equal(await page.locator(".journey-playback").getAttribute("aria-modal"), "false");
      const beforeStopDrag = await snapshot(page);
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await page.mouse.down();
      await page.mouse.move(wheelPoint.endX, wheelPoint.endY, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction((before) => {
        const root = document.querySelector(".journey-playback");
        const center = document.querySelector(".detailed-earth-map")?.dataset.mapCameraObservation?.split(",").map(Number);
        return root?.dataset.playbackPhase === "stop" && root.dataset.cameraFollow === "free"
          && center?.length === 2 && Math.hypot(center[0] - before[0], center[1] - before[1]) > 0.0001;
      }, beforeStopDrag.mapCenter, { timeout: 8_000 });
      await armPauseAtStop(page, 3);
      await page.locator('.journey-playback__controls button[aria-label="继续播放"]').click();
      await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.playbackPhase === "travel"
        && document.querySelector(".journey-playback")?.dataset.playbackStep === "2", null, { timeout: 40_000 });
      const beforeDrag = await snapshot(page);
      const drag = await dragSurface(page, true);
      await page.waitForFunction((before) => {
        const center = document.querySelector(".detailed-earth-map")?.dataset.mapCameraObservation?.split(",").map(Number);
        return center?.length === 2 && Math.hypot(center[0] - before[0], center[1] - before[1]) > 0.0001;
      }, beforeDrag.mapCenter, { timeout: 8_000 });
      const free = await snapshot(page);
      const stopCapture = await waitForCapturedStop(page, 3);
      await waitForVisibleStop(page, 3);
      const populatedStop = await stopBlankPoint(page);
      assert.equal(populatedStop.chapterDensity, "single", "Seoul image chapter must use populated stop layout");
      assert.ok(populatedStop.stageHeight > 0
        && populatedStop.stopRect.height / populatedStop.stageHeight > 0.3
        && populatedStop.stopRect.height / populatedStop.stageHeight < 0.42,
      `populated stop must occupy the 36% stage row: ${JSON.stringify(populatedStop)}`);
      const beforePopulatedDrag = await snapshot(page);
      await page.mouse.move(populatedStop.x, populatedStop.y);
      await page.mouse.down();
      await page.mouse.move(populatedStop.endX, populatedStop.endY, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction((before) => {
        const root = document.querySelector(".journey-playback");
        const center = document.querySelector(".detailed-earth-map")?.dataset.mapCameraObservation?.split(",").map(Number);
        return root?.dataset.playbackPhase === "stop" && root.dataset.playbackStep === "3"
          && root.dataset.cameraFollow === "free" && center?.length === 2
          && Math.hypot(center[0] - before[0], center[1] - before[1]) > 0.0001;
      }, beforePopulatedDrag.mapCenter, { timeout: 8_000 });
      await page.locator('.journey-playback__controls button[aria-label="继续播放"]').click();
      await page.waitForFunction((asset) => document.querySelector(`[data-presented-asset="${asset}"]`)
        ?.getAttribute("data-media-presentation") === "settled", imageId, { timeout: 60_000 });
      const media = await snapshot(page);
      assert.equal(media.following, "free", "media presentation cannot retake the camera");
      assert.equal(media.focusRevision, free.focusRevision, "automatic chapter advance cannot issue focus commands");
      const image = await visibleImage(page, imageId);
      assert.deepEqual(errors, []);
      reports.push({ mode: "detail", input: "stop blank wheel and drag, keyboard, travel drag",
        stopBlank: wheelPoint, populatedStop, drag, free, media, image, stopCapture });
      await page.locator(".journey-playback__return-location").click();
      await page.waitForFunction((revision) => document.querySelector(".journey-playback")?.dataset.cameraFollow === "follow"
        && Number(document.querySelector("[data-qa-route-point-context-focus]")?.getAttribute("data-focus-revision")) > revision,
      free.focusRevision, { timeout: 5_000 });
      const returned = await snapshot(page);
      assert.ok(returned.focusPoint?.includes(`${points[1].latitude},${points[1].longitude}`),
        `Return should focus current Route Point: ${JSON.stringify(returned)}`);
      await page.waitForFunction(({ latitude, longitude }) => {
        const map = document.querySelector(".detailed-earth-map");
        const center = map?.dataset.mapCameraObservation?.split(",").map(Number);
        const point = window.__detailedEarthMapProject?.(longitude, latitude);
        const rect = map?.getBoundingClientRect();
        return center?.length === 2 && Math.hypot(center[0] - longitude, center[1] - latitude) < 0.01
          && point && rect && Math.hypot(point.x - (rect.left + rect.width / 2),
            point.y - (rect.top + rect.height / 2)) < 20;
      }, points[1], { timeout: 10_000 });
      await recordArrivalProjection(page);
      await page.locator(".journey-playback__tempo select").selectOption("fast");
      await page.waitForFunction(() => window.__qaPlaybackCameraArrival?.length > 0,
        null, { timeout: 60_000 });
      await page.locator('.journey-playback__controls button[aria-label="暂停播放"]').click();
      const arrival = await page.evaluate(() => window.__qaPlaybackCameraArrival[0]);
      assert.equal(arrival.following, "follow");
      assert.equal(arrival.mapOwner, "detail");
      assert.ok(arrival.visible && arrival.point && arrival.mapCenter,
        `arrival must have a projected destination: ${JSON.stringify(arrival)}`);
      assert.ok(Math.hypot(arrival.center[0] - points[2].longitude,
        arrival.center[1] - points[2].latitude) < 0.05,
      `fast long-haul arrival preceded camera settlement: ${JSON.stringify(arrival)}`);
      assert.ok(Math.hypot(arrival.point.x - arrival.mapCenter.x,
        arrival.point.y - arrival.mapCenter.y) < 30,
      `fast long-haul arrival projected away from destination: ${JSON.stringify(arrival)}`);
      reports.push({ mode: "detail-fast-long-haul", arrival });
      await page.locator('.journey-playback__controls button[aria-label="上一个章节"]').click();
      await page.waitForFunction((asset) => document.querySelector(".journey-playback")?.dataset.playbackStep === "4"
        && document.querySelector(`[data-presented-asset="${asset}"]`)?.getAttribute("data-media-presentation") === "settled"
        && document.querySelector(".journey-playback")?.dataset.playbackPresentationHold === "none",
      imageId, { timeout: 15_000 });
      await page.locator('.journey-playback__close').click();
      await page.locator(".journey-playback").waitFor({ state: "detached" });
      await page.waitForFunction((asset) => Boolean(document.querySelector(
        `.journey-story [data-media-page="current"][data-media-page-id="${asset}"]`)), imageId,
      { timeout: 8_000 });
      reports.push({ mode: "detail", returnAndBack: returned, storyAsset: imageId });
    } finally { await page.close(); }
  }

  // A manual chapter choice at the same Route Point reclaims a released Detail
  // camera; the automatic stop -> media transition above must keep it free.
  {
    const { page, errors } = await open();
    try {
      await enterDetail(page);
      await startPlayback(page);
      await armPauseAtStop(page, 3);
      const stopCapture = await waitForCapturedStop(page, 3);
      await waitForVisibleStop(page, 3);
      const wheelPoint = await stopBlankPoint(page);
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await page.mouse.wheel(0, -120);
      await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.cameraFollow === "free",
        null, { timeout: 8_000 });
      const beforeDrag = await snapshot(page);
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await page.mouse.down();
      await page.mouse.move(wheelPoint.endX, wheelPoint.endY, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction((before) => {
        const center = document.querySelector(".detailed-earth-map")?.dataset.mapCameraObservation?.split(",").map(Number);
        return center?.length === 2 && Math.hypot(center[0] - before[0], center[1] - before[1]) > 0.01;
      }, beforeDrag.mapCenter, { timeout: 8_000 });
      const free = await snapshot(page);
      assert.equal(free.following, "free");
      await page.mouse.move(16, 16);
      await page.locator('.journey-playback__controls button[aria-label="下一个章节"]').click();
      await page.waitForFunction((revision) => {
        const root = document.querySelector(".journey-playback");
        const focus = document.querySelector("[data-qa-route-point-context-focus]");
        return root?.dataset.playbackStep === "4" && root.dataset.playbackPhase === "media"
          && root.dataset.cameraFollow === "follow" && Number(focus?.dataset.focusRevision) > revision;
      }, free.focusRevision, { timeout: 10_000 });
      await page.waitForFunction(({ longitude, latitude }) => {
        const map = document.querySelector(".detailed-earth-map");
        const center = map?.dataset.mapCameraObservation?.split(",").map(Number);
        const point = window.__detailedEarthMapProject?.(longitude, latitude);
        const rect = map?.getBoundingClientRect();
        return center?.length === 2 && Math.hypot(center[0] - longitude, center[1] - latitude) < 0.01
          && point && rect && Math.hypot(point.x - (rect.left + rect.width / 2),
            point.y - (rect.top + rect.height / 2)) < 20;
      }, points[1], { timeout: 10_000 });
      const returned = await snapshot(page);
      assert.ok(returned.focusPoint?.includes(`${points[1].latitude},${points[1].longitude}`),
        `explicit same-point Next focused another location: ${JSON.stringify(returned)}`);
      assert.deepEqual(errors, []);
      reports.push({ mode: "detail-explicit-same-point-next", wheelPoint, free, returned, stopCapture });
    } finally { await page.close(); }
  }

  // Reduced Motion on a phone starts with the particle renderer. Its trusted
  // gesture must still release follow and expose a reachable 44px Return target.
  {
    const { page, errors, imageRequested, releaseImage } = await open({ mobile: true, reduced: true, holdImage: true });
    try {
      await startPlayback(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector(".living-atlas")?.dataset.mobileV2 === "on");
      await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.playbackPhase === "travel"
        && document.querySelector(".journey-playback")?.dataset.playbackStep === "2", null, { timeout: 40_000 });
      const before = await snapshot(page);
      const drag = await touchDragParticle(page);
      await page.waitForFunction((previous) => {
        const current = window.__particleEarthDebug?.();
        return current?.manualFocusOwner && Math.hypot(current.rotationX - previous.rotationX,
          current.rotationY - previous.rotationY) > 0.001;
      }, before, { timeout: 5_000 });
      const free = await snapshot(page);
      let deadline;
      try {
        await Promise.race([
          imageRequested,
          new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("image read was never requested")), 30_000);
          }),
        ]);
      } finally { clearTimeout(deadline); }
      assert.equal((await snapshot(page)).following, "free", "slow media read cannot recapture the camera");
      releaseImage();
      await page.waitForFunction((asset) => document.querySelector(`[data-presented-asset="${asset}"]`)
        ?.getAttribute("data-media-presentation") === "settled", imageId, { timeout: 60_000 });
      const media = await snapshot(page);
      assert.equal(media.following, "free");
      assert.equal(media.focusRevision, free.focusRevision);
      const image = await visibleImage(page, imageId);
      const returnButton = page.locator(".journey-playback__return-location");
      const target = await returnButton.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { x: box.left + box.width / 2, y: box.top + box.height / 2,
          width: box.width, height: box.height, hit: hit === button || button.contains(hit) };
      });
      assert.ok(target.width >= 44 && target.height >= 44 && target.hit, `mobile Return target: ${JSON.stringify(target)}`);
      await page.touchscreen.tap(target.x, target.y);
      await page.waitForFunction(() => document.querySelector(".journey-playback")?.dataset.cameraFollow === "follow");
      assert.deepEqual(errors, []);
      reports.push({ mode: "particle-mobile-reduced", drag, free, media, image, returnTarget: target });
    } finally { releaseImage(); await page.close(); }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ lane: "qa-playback-manual-camera", reports }, null, 2));
