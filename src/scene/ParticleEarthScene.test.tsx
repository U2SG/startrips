import {
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Texture,
  Vector3,
} from "three";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GlobeMode } from "../experience/types";
import {
  GLOBE_MODE_CONFIG,
  GLOBE_DRAG_THRESHOLD_PX,
  GLOBE_IDLE_ALIGNMENT_SPEED,
  GLOBE_IDLE_RELEASE_BLEND_MS,
  GLOBE_IDLE_RESUME_DELAY_MS,
  GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND,
  GLOBE_RENDER_ORDER,
  GLOBE_SURFACE_RADIUS,
  GLOBE_TILT_LIMIT_RADIANS,
  GLOBE_UPRIGHT_ROTATION_X,
  GLOBE_ZOOM_MAX,
  GLOBE_ZOOM_MIN,
  MAX_RENDERED_JOURNEYS,
  MAX_RENDERED_MOBILE_ROUTE_LABELS,
  MAX_RENDERED_ROUTE_LABELS,
  MAX_RENDERED_ROUTE_POINTS,
  resolveRouteLabelLimit,
  resolveRouteLabelSafeArea,
  QUALITY_PROFILE,
  buildJourneyConnector,
  buildJourneyConnectorPath,
  advanceGlobeIdleReleasePhase,
  buildProjectedRoutePath,
  collectJourneyDimDirections,
  focusSignalAnchor,
  focusViewportCenter,
  canTrackGlobePointer,
  clampGlobeTilt,
  journeyConnectorAnchor,
  clampGlobeZoom,
  createRetryableParticleResourceLoader,
  getJourneyRouteLineScale,
  getJourneyRouteVisualState,
  getGlobeIdleAlignmentRotation,
  getGlobeIdleRotationDelta,
  getGlobeInertiaSpeedLimit,
  getShortestRotationDelta,
  getProjectedGlobeRadiusPx,
  getProjectedSurfaceInteractionRadiusPx,
  isFocusFlightActive,
  isIdleRotationSuppressed,
  isGlobeUpright,
  isGlobeDrag,
  isPrimaryPointerActivation,
  shouldRememberUntrackedPointerStart,
  shouldSuppressUntrackedPointerActivation,
  isSphericalPointVisible,
  isProjectedPointInsideViewport,
  isLocalPointInsideClipViewport,
  isReliablePinchAnchor,
  projectedRadiusRotationDelta,
  nearestEquivalentRotation,
  rebaseGlobeDragSample,
  releaseFailedParticleRefinementRequest,
  selectRenderableJourneyRoutes,
  selectRouteLabelPointIndexes,
  shouldFocusRevisionOwnState,
  shouldApplyFocusIntentRevision,
  shouldRetainGlobeInertia,
  solveScreenAnchorRotation,
  resolveGlobeFocusIntent,
} from "./ParticleEarthScene";
import {
  buildRouteArcSamples,
  ROUTE_ANCHOR_RADIUS,
  routePointAnchor,
} from "./geo";
import { disposeSceneGraph } from "./useThreeScene";

describe("ParticleEarthScene contracts", () => {
  it("resolves one route intent instead of competing route and point intents", () => {
    const route = {
      id: "journey-a",
      color: "#fff",
      points: [
        { lat: 22.3, lon: 114.2, isStop: true },
        { lat: 35.7, lon: 139.7, isStop: true },
      ],
    };
    const intent = resolveGlobeFocusIntent({ lat: 31.2, lon: 121.5 }, route, 7);
    expect(intent).toMatchObject({ revision: 7, kind: "route", route });
    expect(intent?.zoom).not.toBe(1);
  });

  it("resolves route-point focus to exactly one point intent", () => {
    expect(resolveGlobeFocusIntent({ lat: 31.2, lon: 121.5 }, null, 8)).toEqual({
      revision: 8,
      kind: "point",
      point: { lat: 31.2, lon: 121.5 },
      zoom: 1,
      route: null,
    });
  });

  it("lets only a newer focus revision supersede the active owner", () => {
    expect(shouldApplyFocusIntentRevision(10, 10)).toBe(false);
    expect(shouldApplyFocusIntentRevision(10, 9)).toBe(false);
    expect(shouldApplyFocusIntentRevision(10, 11)).toBe(true);
    expect([1, 2, 3].reduce(
      (active, revision) => shouldApplyFocusIntentRevision(active, revision) ? revision : active,
      Number.NEGATIVE_INFINITY,
    )).toBe(3);
  });

  it("plans the nearest equivalent angle without changing direction at wrapping", () => {
    const current = Math.PI - 0.1;
    const equivalentTarget = -Math.PI + 0.1;
    const planned = nearestEquivalentRotation(current, equivalentTarget);
    expect(planned).toBeCloseTo(Math.PI + 0.1);
    expect(getShortestRotationDelta(current, planned)).toBeCloseTo(0.2);

    const samples = [current];
    for (let index = 0; index < 12; index += 1) {
      samples.push(samples.at(-1)! + (planned - samples.at(-1)!) * 0.35);
    }
    const deltas = samples.map((value) => getShortestRotationDelta(value, planned));
    expect(deltas.every((delta) => delta >= 0)).toBe(true);
    expect(deltas.at(-1)!).toBeLessThan(deltas[0]);
  });

  it("retries the same refinement region after source failures", async () => {
    let attempt = 0;
    let now = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return null;
      if (attempt === 2) throw new Error("transient fetch failure");
      return { source: "land-mask" };
    });
    const loadResource = createRetryableParticleResourceLoader(load, {
      retryDelayMs: 1_000,
      now: () => now,
    });
    let requestedCacheKey: string | null = null;
    const requestRegion = async (cacheKey: string) => {
      if (requestedCacheKey === cacheKey) return "deduped";
      requestedCacheKey = cacheKey;
      const source = await loadResource();
      if (!source) {
        requestedCacheKey = releaseFailedParticleRefinementRequest({
          requestedCacheKey,
          failedCacheKey: cacheKey,
          requestIsCurrent: true,
        });
        return "unavailable";
      }
      return "ready";
    };

    const cacheKey = "high:12:108";
    const unavailableRequest = requestRegion(cacheKey);
    const unavailableSource = loadResource();
    expect(loadResource()).toBe(unavailableSource);
    await expect(unavailableSource).resolves.toBeNull();
    await expect(unavailableRequest).resolves.toBe("unavailable");
    expect(load).toHaveBeenCalledTimes(1);
    expect(requestedCacheKey).toBeNull();

    for (now = 160; now < 1_000; now += 160) {
      await expect(requestRegion(cacheKey)).resolves.toBe("unavailable");
    }
    expect(load).toHaveBeenCalledTimes(1);

    now = 1_000;
    await expect(requestRegion(cacheKey)).resolves.toBe("unavailable");
    expect(load).toHaveBeenCalledTimes(2);
    expect(requestedCacheKey).toBeNull();

    now = 1_999;
    await expect(requestRegion(cacheKey)).resolves.toBe("unavailable");
    expect(load).toHaveBeenCalledTimes(2);

    now = 2_000;
    await expect(requestRegion(cacheKey)).resolves.toBe("ready");
    const recovered = loadResource();
    await expect(recovered).resolves.toEqual({ source: "land-mask" });
    expect(loadResource()).toBe(recovered);
    expect(load).toHaveBeenCalledTimes(3);

    expect(releaseFailedParticleRefinementRequest({
      requestedCacheKey: "high:24:120",
      failedCacheKey: "high:12:108",
      requestIsCurrent: false,
    })).toBe("high:24:120");
  });

  it("maps the same drag to comparable screen motion across globe zoom levels", () => {
    const viewportHeight = 844;
    const fov = (38 * Math.PI) / 180;
    const cameraDistance = 5.4;
    const wholeEarthRadius = getProjectedSurfaceInteractionRadiusPx(
      viewportHeight,
      fov,
      cameraDistance,
      GLOBE_SURFACE_RADIUS * 1.15,
    );
    const closeRadius = getProjectedSurfaceInteractionRadiusPx(
      viewportHeight,
      fov,
      cameraDistance,
      GLOBE_SURFACE_RADIUS * 1.15 * GLOBE_ZOOM_MAX,
    );
    const wholeEarthDelta = projectedRadiusRotationDelta(
      { x: 195, y: 422 },
      { x: 225, y: 422 },
      wholeEarthRadius,
    );
    const closeDelta = projectedRadiusRotationDelta(
      { x: 195, y: 422 },
      { x: 225, y: 422 },
      closeRadius,
    );

    expect(closeRadius).toBeGreaterThan(wholeEarthRadius * 3);
    expect(Math.abs(closeDelta.rotationY)).toBeLessThan(
      Math.abs(wholeEarthDelta.rotationY) / 3,
    );
    expect(wholeEarthRadius * wholeEarthDelta.angularDelta).toBeCloseTo(30, 1);
    expect(closeRadius * closeDelta.angularDelta).toBeCloseTo(30, 1);
  });

  it("keeps projected-radius drag continuous across the silhouette", () => {
    const center = { x: 200, y: 300 };
    const radius = 180;
    const inside = projectedRadiusRotationDelta(
      { x: center.x + radius * 0.96, y: center.y },
      { x: center.x + radius * 0.99, y: center.y },
      radius,
    );
    const crossing = projectedRadiusRotationDelta(
      { x: center.x + radius * 0.99, y: center.y },
      { x: center.x + radius * 1.02, y: center.y },
      radius,
    );
    const outside = projectedRadiusRotationDelta(
      { x: center.x + radius * 1.02, y: center.y },
      { x: center.x + radius * 1.05, y: center.y },
      radius,
    );

    expect(inside.rotationY).toBeGreaterThan(0);
    expect(crossing.rotationY).toBeGreaterThan(0);
    expect(outside.rotationY).toBeGreaterThan(0);
    expect(crossing.angularDelta).toBeCloseTo(inside.angularDelta);
    expect(outside.angularDelta).toBeCloseTo(inside.angularDelta);
  });

  it("solves a geographic pinch anchor to the moving gesture centroid", () => {
    const solved = solveScreenAnchorRotation(
      0,
      0,
      { x: 270, y: 170 },
      (rotationX, rotationY) => ({
        x: 210 + rotationY * 240,
        y: 220 - rotationX * 180,
      }),
    );

    expect(solved.converged).toBe(true);
    expect(solved.errorPx).toBeLessThanOrEqual(0.5);
    expect(solved.x).toBeCloseTo(50 / 180, 4);
    expect(solved.y).toBeCloseTo(60 / 240, 4);
  });

  it("falls back when a pinch centroid cannot reliably remain on the silhouette", () => {
    expect(isReliablePinchAnchor(
      { x: 250, y: 200 },
      { x: 200, y: 200 },
      100,
    )).toBe(true);
    expect(isReliablePinchAnchor(
      { x: 301, y: 200 },
      { x: 200, y: 200 },
      100,
    )).toBe(false);
    expect(getProjectedGlobeRadiusPx(844, (38 * Math.PI) / 180, 5.4, 1.6))
      .toBeGreaterThan(300);
  });

  it("rebases pinch to one-finger drag without carrying a stale sample", () => {
    expect(rebaseGlobeDragSample(
      7,
      { x: 144, y: 288 },
      1234,
      true,
    )).toEqual({
      pointerId: 7,
      lastX: 144,
      lastY: 288,
      lastTime: 1234,
      travel: GLOBE_DRAG_THRESHOLD_PX,
      started: true,
    });
  });

  it("keeps stale focus revisions from reclaiming manually owned state", () => {
    expect(shouldFocusRevisionOwnState(null, 1000)).toBe(true);
    expect(shouldFocusRevisionOwnState(1000, 1000)).toBe(false);
    expect(shouldFocusRevisionOwnState(1000, 999)).toBe(false);
    expect(shouldFocusRevisionOwnState(1000, 1001)).toBe(true);
  });

  it("caps inertia in screen space so close zoom cannot fling farther", () => {
    const wholeEarthLimit = getGlobeInertiaSpeedLimit(400);
    const closeLimit = getGlobeInertiaSpeedLimit(1_200);
    expect(closeLimit).toBeCloseTo(wholeEarthLimit / 3);
    expect(wholeEarthLimit * 400).toBeCloseTo(closeLimit * 1_200);
  });

  it("does not retain inertia after a held or near-zero release", () => {
    expect(shouldRetainGlobeInertia(1_000, 1_040, 0.01)).toBe(true);
    expect(shouldRetainGlobeInertia(1_000, 1_100, 0.01)).toBe(false);
    expect(shouldRetainGlobeInertia(1_000, 1_040, 0.0001)).toBe(false);
  });

  it("supports every globe mode without adding a second quality profile", () => {
    const modes: GlobeMode[] = [
      "particleSphere",
      "archiveBurst",
      "surfaceEarth",
      "focusPoint",
    ];
    expect(Object.keys(GLOBE_MODE_CONFIG)).toEqual(modes);
    expect(QUALITY_PROFILE.low).toEqual({ particleCount: 12_000, maxDpr: 1 });
    expect(QUALITY_PROFILE.high).toEqual({
      particleCount: 28_000,
      maxDpr: Number.POSITIVE_INFINITY,
    });
  });

  it("bounds the gesture controller to the two pointers its pinch math supports (#107)", () => {
    expect(canTrackGlobePointer(0)).toBe(true);
    expect(canTrackGlobePointer(1)).toBe(true);
    expect(canTrackGlobePointer(2)).toBe(false);
    expect(canTrackGlobePointer(3)).toBe(false);
  });


  it("remembers sibling city contacts once another globe pointer is already tracked (#115)", () => {
    expect(shouldRememberUntrackedPointerStart(0)).toBe(false);
    expect(shouldRememberUntrackedPointerStart(1)).toBe(true);
    expect(shouldRememberUntrackedPointerStart(2)).toBe(true);
    expect(shouldRememberUntrackedPointerStart(3)).toBe(true);
  });

  it("suppresses activation for capacity-rejected or gesture-overlapping untracked pointers (#107)", () => {
    expect(shouldSuppressUntrackedPointerActivation(true, 0)).toBe(true);
    expect(shouldSuppressUntrackedPointerActivation(true, 2)).toBe(true);
    expect(shouldSuppressUntrackedPointerActivation(false, 1)).toBe(true);
    expect(shouldSuppressUntrackedPointerActivation(false, 0)).toBe(false);
  });

  it("uses a deliberate drag threshold and allows full globe rotation", () => {
    expect(isGlobeDrag(GLOBE_DRAG_THRESHOLD_PX - 0.01)).toBe(false);
    expect(isGlobeDrag(GLOBE_DRAG_THRESHOLD_PX)).toBe(true);
    expect(GLOBE_TILT_LIMIT_RADIANS).toBe(Number.POSITIVE_INFINITY);
    expect(clampGlobeTilt(Math.PI * 3)).toBe(Math.PI * 3);
    expect(clampGlobeTilt(-Math.PI * 3)).toBe(-Math.PI * 3);
    expect(clampGlobeTilt(0.18)).toBe(0.18);
    expect(clampGlobeZoom(GLOBE_ZOOM_MIN - 1)).toBe(GLOBE_ZOOM_MIN);
    expect(clampGlobeZoom(GLOBE_ZOOM_MAX + 1)).toBe(GLOBE_ZOOM_MAX);
    expect(clampGlobeZoom(1.2)).toBe(1.2);
    expect(isPrimaryPointerActivation({
      button: 0,
      isPrimary: true,
      pointerType: "mouse",
    })).toBe(true);
    expect(isPrimaryPointerActivation({
      button: 2,
      isPrimary: true,
      pointerType: "mouse",
    })).toBe(false);
    expect(isPrimaryPointerActivation({
      button: 0,
      isPrimary: false,
      pointerType: "touch",
    })).toBe(false);
  });

  it("auto-rotates only after idle time and ramps into the idle rate", () => {
    expect(getGlobeIdleRotationDelta(
      1,
      GLOBE_IDLE_RESUME_DELAY_MS - 1,
      false,
      false,
    )).toBe(0);
    expect(getGlobeIdleRotationDelta(
      1,
      GLOBE_IDLE_RESUME_DELAY_MS,
      true,
      false,
    )).toBe(0);
    expect(getGlobeIdleRotationDelta(
      1,
      GLOBE_IDLE_RESUME_DELAY_MS,
      false,
      true,
    )).toBe(0);
    expect(getGlobeIdleRotationDelta(
      0.05,
      GLOBE_IDLE_RESUME_DELAY_MS,
      false,
      false,
      true,
      0,
    )).toBe(0);
    expect(getGlobeIdleRotationDelta(
      0.05,
      GLOBE_IDLE_RESUME_DELAY_MS + GLOBE_IDLE_RELEASE_BLEND_MS,
      false,
      false,
      true,
      1,
    )).toBeCloseTo(0.05 * GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND);
  });

  it("treats journey focus as a one-shot flight and releases idle rotation after arrival", () => {
    expect(isFocusFlightActive(true, false)).toBe(true);
    expect(isFocusFlightActive(false, true)).toBe(true);
    expect(isFocusFlightActive(false, false)).toBe(false);
    expect(isIdleRotationSuppressed(true, true, false)).toBe(true);
    expect(isIdleRotationSuppressed(true, false, true)).toBe(true);
    expect(isIdleRotationSuppressed(true, false, false)).toBe(false);
    expect(isIdleRotationSuppressed(false, false, false)).toBe(true);
  });

  it("holds focus, then blends upright recovery and longitude idle rotation", () => {
    expect(GLOBE_UPRIGHT_ROTATION_X).toBe(0);
    expect(GLOBE_IDLE_ALIGNMENT_SPEED).toBeCloseTo((Math.PI * 15) / 180);
    expect(GLOBE_IDLE_RELEASE_BLEND_MS).toBe(2_400);
    expect(getGlobeIdleAlignmentRotation(
      0.8,
      1 / 60,
      GLOBE_IDLE_RESUME_DELAY_MS - 1,
      false,
      false,
      0,
    )).toBe(0.8);

    const firstPhase = advanceGlobeIdleReleasePhase(
      0,
      0.05,
      GLOBE_IDLE_RESUME_DELAY_MS,
      false,
      false,
    );
    const resumedPhase = advanceGlobeIdleReleasePhase(
      firstPhase,
      5,
      GLOBE_IDLE_RESUME_DELAY_MS + 5_000,
      false,
      false,
    );
    expect(firstPhase).toBeCloseTo(50 / GLOBE_IDLE_RELEASE_BLEND_MS);
    expect(resumedPhase - firstPhase).toBeCloseTo(50 / GLOBE_IDLE_RELEASE_BLEND_MS);

    const earlyAligned = getGlobeIdleAlignmentRotation(
      0.8,
      0.05,
      GLOBE_IDLE_RESUME_DELAY_MS,
      false,
      false,
      firstPhase,
    );
    expect(earlyAligned).toBeLessThan(0.8);
    expect(earlyAligned).toBeGreaterThan(0.79);
    expect(getGlobeIdleRotationDelta(
      0.05,
      GLOBE_IDLE_RESUME_DELAY_MS,
      false,
      false,
      false,
      firstPhase,
    )).toBeGreaterThan(0);
    const lowFrameSteadyDelta = getGlobeIdleRotationDelta(
      0.15,
      GLOBE_IDLE_RESUME_DELAY_MS + GLOBE_IDLE_RELEASE_BLEND_MS,
      false,
      false,
      true,
      1,
    );
    expect(lowFrameSteadyDelta).toBeCloseTo(
      0.15 * GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND,
    );

    const fullPhaseAligned = getGlobeIdleAlignmentRotation(
      0.8,
      0.05,
      GLOBE_IDLE_RESUME_DELAY_MS + GLOBE_IDLE_RELEASE_BLEND_MS,
      false,
      false,
      1,
    );
    const fullPhaseStep = 0.8 - fullPhaseAligned;
    expect(fullPhaseStep).toBeCloseTo(GLOBE_IDLE_ALIGNMENT_SPEED * 0.05);
    expect(isGlobeUpright(fullPhaseAligned)).toBe(false);
    expect(isGlobeUpright(0)).toBe(true);
    expect(isGlobeUpright(Math.PI * 2)).toBe(true);
  });

  it("anchors the journey connector to the card edge the layout uses", () => {
    const card = { left: 900, top: 200, right: 1200, bottom: 500 };
    expect(journeyConnectorAnchor(card, false)).toEqual({ x: 900, y: 350 });
    expect(journeyConnectorAnchor(card, true)).toEqual({ x: 1050, y: 200 });
  });

  it("draws an elbow that starts at the card and ends on the projected point", () => {
    const desktop = buildJourneyConnectorPath(
      { x: 900, y: 350 },
      { x: 500, y: 260 },
      false,
    );
    expect(desktop).toBe("M900 350H720V260H500");
    const compact = buildJourneyConnectorPath(
      { x: 200, y: 600 },
      { x: 320, y: 300 },
      true,
    );
    expect(compact).toBe("M200 600V465H320V300");
    // A nearly aligned pair would kink, so it stays a straight line.
    expect(buildJourneyConnectorPath({ x: 900, y: 350 }, { x: 500, y: 356 }, false))
      .toBe("M900 350L500 356");
  });

  it("shows no connector unless it can truthfully reach the point", () => {
    const scene = { width: 1440, height: 900 };
    const card = { left: 900, top: 200, right: 1200, bottom: 500 };
    expect(buildJourneyConnector({
      card,
      point: { x: 500, y: 260 },
      scene,
      compact: false,
    })).toBe("M900 350H720V260H500");
    // No card, no focus point, an off-scene projection, and a point that lands
    // inside the card all resolve to nothing rather than a stub.
    expect(buildJourneyConnector({ card: null, point: { x: 500, y: 260 }, scene, compact: false }))
      .toBe("");
    expect(buildJourneyConnector({ card, point: null, scene, compact: false }))
      .toBe("");
    expect(buildJourneyConnector({ card, point: { x: -4, y: 260 }, scene, compact: false }))
      .toBe("");
    expect(buildJourneyConnector({ card, point: { x: 500, y: 1200 }, scene, compact: false }))
      .toBe("");
    expect(buildJourneyConnector({ card, point: { x: 1000, y: 300 }, scene, compact: false }))
      .toBe("");
    expect(buildJourneyConnector({ card, point: { x: 896, y: 300 }, scene, compact: false }))
      .toBe("");
    expect(buildJourneyConnector({
      card,
      point: { x: Number.NaN, y: 260 },
      scene,
      compact: false,
    })).toBe("");
  });

  it("computes the real visible center from measured chrome instead of a magic offset", () => {
    expect(focusViewportCenter({ width: 1200, height: 800 })).toEqual({ x: 600, y: 400 });
    expect(focusViewportCenter(
      { width: 1200, height: 800 },
      {
        left: { left: 20, top: 140, right: 300, bottom: 700 },
        right: { left: 930, top: 180, right: 1180, bottom: 680 },
      },
    )).toEqual({ x: 615, y: 400 });
    expect(focusViewportCenter(
      { width: 390, height: 844 },
      {
        top: { left: 0, top: 0, right: 390, bottom: 62 },
        bottom: { left: 0, top: 650, right: 390, bottom: 844 },
      },
    )).toEqual({ x: 195, y: 356 });
  });

  it("samples lit-journey dim anchors fairly across routes and deduplicates places", () => {
    const routes = [
      {
        id: "journey-a",
        color: "#f4ce73",
        points: [
          { lat: 0, lon: 0, isStop: true },
          { lat: 10, lon: 10, isStop: true },
        ],
      },
      {
        id: "journey-b",
        color: "#76e3d0",
        points: [
          { lat: 20, lon: 20, isStop: true },
          { lat: 0, lon: 0, isStop: true },
        ],
      },
    ];
    const directions = collectJourneyDimDirections(routes, 3);
    expect(directions).toHaveLength(3);
    expect(directions.every((direction) => Math.abs(direction.length() - 1) < 0.00001)).toBe(true);
    // Round-robin means each journey contributes before route A's second stop.
    expect(directions[0].equals(directions[1])).toBe(false);
    expect(directions[2].equals(directions[0])).toBe(false);
    expect(collectJourneyDimDirections(routes, 1)).toHaveLength(1);
  });

  it("does not let future Rewind points dim ambient particles before reveal", () => {
    const routes = [{
      id: "journey-rewind",
      color: "#76e3d0",
      points: [
        { lat: 22, lon: 114, isStop: true },
        { lat: 31, lon: 121, isStop: true },
      ],
    }];
    const hiddenFuture = collectJourneyDimDirections(routes, 8, {
      points: new Map([
        ["journey-rewind:0", 1],
        ["journey-rewind:1", 0],
      ]),
    });
    expect(hiddenFuture).toHaveLength(1);
    expect(hiddenFuture[0].length()).toBeCloseTo(1);

    const partiallyRevealed = collectJourneyDimDirections(routes, 8, {
      points: new Map([
        ["journey-rewind:0", 1],
        ["journey-rewind:1", 0.4],
      ]),
    });
    expect(partiallyRevealed).toHaveLength(2);
    expect(partiallyRevealed[1].length()).toBeCloseTo(0.4);
  });

  it("holds the focused arrival for twenty seconds before release starts", () => {
    expect(GLOBE_IDLE_RESUME_DELAY_MS).toBe(20_000);
    expect(advanceGlobeIdleReleasePhase(0, 0.05, 19_999, false, false)).toBe(0);
    expect(advanceGlobeIdleReleasePhase(0, 0.05, 20_000, false, false)).toBeGreaterThan(0);
    expect(getGlobeIdleRotationDelta(0.05, 20_000, false, false, true, 0)).toBe(0);
  });

  it("keeps geographic context behind journey and personal signals", () => {
    expect(GLOBE_RENDER_ORDER.relief).toBeLessThan(GLOBE_RENDER_ORDER.particle);
    expect(GLOBE_RENDER_ORDER.particle).toBeLessThan(GLOBE_RENDER_ORDER.coastline);
    expect(GLOBE_RENDER_ORDER.coastline).toBeLessThan(GLOBE_RENDER_ORDER.signal);
    expect(GLOBE_RENDER_ORDER.signal).toBeLessThan(GLOBE_RENDER_ORDER.routeLine);
    expect(GLOBE_RENDER_ORDER.routeLine).toBeLessThan(GLOBE_RENDER_ORDER.routePoint);
    expect(GLOBE_RENDER_ORDER.routePoint).toBeLessThan(
      GLOBE_RENDER_ORDER.personalPoint,
    );
    expect(GLOBE_MODE_CONFIG.focusPoint.clusterOpacity).toBe(0);
    expect(GLOBE_MODE_CONFIG.archiveBurst.clusterOpacity).toBeGreaterThan(0);
  });

  it("only persists city anchors that remain inside the projected viewport", () => {
    expect(isProjectedPointInsideViewport(0, 0, 390, 844)).toBe(true);
    expect(isProjectedPointInsideViewport(390, 844, 390, 844)).toBe(true);
    expect(isProjectedPointInsideViewport(-0.1, 200, 390, 844)).toBe(false);
    expect(isProjectedPointInsideViewport(390.1, 200, 390, 844)).toBe(false);
    expect(isProjectedPointInsideViewport(100, 844.1, 390, 844)).toBe(false);
    expect(isProjectedPointInsideViewport(Number.NaN, 100, 390, 844)).toBe(false);
  });

  it("matches full camera projection with a precomputed local clip viewport", () => {
    const camera = new PerspectiveCamera(38, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 5.4);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const globe = new Group();
    globe.position.set(0.18, -0.12, 0);
    globe.rotation.set(0.2, -0.7, 0);
    globe.scale.setScalar(2.4);
    globe.updateWorldMatrix(true, false);

    const clip = new Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(globe.matrixWorld);
    const samples = [
      new Vector3(0, 0, 1.46),
      new Vector3(1.46, 0, 0),
      new Vector3(-1.46, 0, 0),
      new Vector3(0, 1.46, 0),
      new Vector3(0, -1.46, 0),
      new Vector3(0, 0, -1.46),
    ];

    for (const point of samples) {
      const projected = point.clone().applyMatrix4(globe.matrixWorld).project(camera);
      const expected = Number.isFinite(projected.x)
        && Number.isFinite(projected.y)
        && Number.isFinite(projected.z)
        && projected.x >= -1
        && projected.x <= 1
        && projected.y >= -1
        && projected.y <= 1
        && projected.z >= -1
        && projected.z <= 1;
      expect(isLocalPointInsideClipViewport(
        clip.elements,
        point.x,
        point.y,
        point.z,
      )).toBe(expected);
    }
  });

  it("scales route lines with globe zoom while keeping a readable floor and ceiling", () => {
    expect(getJourneyRouteLineScale(0.72)).toBe(0.72);
    expect(getJourneyRouteLineScale(1.15)).toBe(1);
    expect(getJourneyRouteLineScale(1.15 * 3)).toBe(2.4);
  });

  it("keeps every journey neutral until one route is selected", () => {
    expect(getJourneyRouteVisualState("journey-a", null)).toBe("is-idle");
    expect(getJourneyRouteVisualState("journey-a", "journey-a")).toBe("is-active");
    expect(getJourneyRouteVisualState("journey-b", "journey-a")).toBe("is-muted");
  });

  it("hides vector route geometry occluded by the globe", () => {
    const camera = new Vector3(0, 0, 5.4);
    expect(isSphericalPointVisible(camera, new Vector3(0, 0, 1.445))).toBe(true);
    expect(isSphericalPointVisible(camera, new Vector3(0, 0, -1.445))).toBe(false);
  });

  it("projects connected route segments and breaks paths across hidden spans", () => {
    const samples = {
      directions: new Float32Array([
        0, 0, 1, 1, 0, 0,
        1, 0, 0, -1, 0, 0,
        0, 1, 0, 0, 0, -1,
      ]),
      lifts: new Float32Array([0, 0, 0, 0, 0, 0]),
    };
    const path = buildProjectedRoutePath(
      samples,
      (x, y, _z, target) => {
        target.x = x * 10;
        target.y = y * 10;
        return x >= 0 && y >= 0;
      },
      { radius: 1, liftScale: 0 },
    );
    // The middle segment leaves the visible half, so it is clipped at the
    // crossing instead of joining the two visible spans.
    expect(path.d.startsWith("M0.0 0.0L10.0 0.0")).toBe(true);
    expect(path.d.endsWith("M0.0 10.0L0.0 0.0")).toBe(true);
    expect(path.start).toEqual({ x: 0, y: 0 });
    expect(path.end).toEqual({ x: 0, y: 0 });
  });

  it("resolves stored lift with the frame's lift strength (#193)", () => {
    const samples = {
      directions: new Float32Array([0, 0, 1, 0, 0, 1]),
      lifts: new Float32Array([0, 0.25]),
    };
    const radii: number[] = [];
    const project = (world: { radius: number; liftScale: number }) => {
      buildProjectedRoutePath(
        samples,
        (x, y, z, target) => {
          radii.push(Math.hypot(x, y, z));
          target.x = 0;
          target.y = 0;
          return true;
        },
        world,
      );
    };
    project({ radius: 1.46, liftScale: 1 });
    project({ radius: 1.46, liftScale: 0 });
    // Endpoint radius never moves; only the lifted interior vertex responds.
    expect(radii[0]).toBeCloseTo(1.46, 6);
    expect(radii[1]).toBeCloseTo(1.46 * 1.25, 6);
    expect(radii[2]).toBeCloseTo(1.46, 6);
    expect(radii[3]).toBeCloseTo(1.46, 6);
  });

  it("clips a route into the horizon instead of dropping the endpoint (#193)", () => {
    const camera = new Vector3(0, 0, 5.4);
    const anchor = routePointAnchor(0, 0);
    // A leg that runs from the visible anchor around the globe until the far
    // vertices fall behind the limb.
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 170 }],
      Math.PI / 96,
      8192,
      { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 },
    );
    const project = (x: number, y: number, z: number, target: { x: number; y: number }) => {
      if (!isSphericalPointVisible(camera, new Vector3(x, y, z))) return false;
      target.x = 400 + x * 100;
      target.y = 400 - y * 100;
      return true;
    };
    const path = buildProjectedRoutePath(
      samples,
      project,
      { radius: ROUTE_ANCHOR_RADIUS, liftScale: 1 },
    );
    const marker = { x: 0, y: 0 };
    expect(project(anchor.x, anchor.y, anchor.z, marker)).toBe(true);
    // The visible Route Point keeps its line: the path starts on the marker.
    expect(path.start).not.toBe(null);
    expect(
      Math.hypot(path.start!.x - marker.x, path.start!.y - marker.y),
    ).toBeLessThan(0.01);
    // The far end is behind the globe, so the line stops at the horizon.
    expect(path.end).toBe(null);
    expect(path.d.startsWith(`M${marker.x.toFixed(1)} ${marker.y.toFixed(1)}`)).toBe(true);
  });

  it("keeps route labels bounded while preserving the first and last stops", () => {
    const stops = Array.from({ length: 10 }, (_, index) => ({
      isStop: true,
      label: `Stop ${index}`,
    }));
    expect(selectRouteLabelPointIndexes(stops)).toEqual([0, 2, 4, 5, 7, 9]);
    expect(selectRouteLabelPointIndexes(stops, MAX_RENDERED_MOBILE_ROUTE_LABELS))
      .toEqual([0, 5, 9]);
    expect(selectRouteLabelPointIndexes([
      { isStop: false, label: "Single place" },
    ])).toEqual([0]);
    expect(selectRouteLabelPointIndexes([
      { isStop: true, label: "" },
    ])).toEqual([]);
    expect(MAX_RENDERED_ROUTE_LABELS).toBe(6);
  });

  it("disposes geometry, material, and mapped textures", () => {
    const root = new Group();
    const geometry = new BufferGeometry();
    const texture = new Texture();
    const material = new MeshBasicMaterial({ map: texture });
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");
    const textureDispose = vi.spyOn(texture, "dispose");
    root.add(new Mesh(geometry, material));

    disposeSceneGraph(root);

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });

  it("keeps complete recent routes inside the route and point budgets", () => {
    const routes = Array.from(
      { length: MAX_RENDERED_JOURNEYS + 2 },
      (_, index) => ({
        id: String(index),
        color: "#f4ce73",
        points: Array.from({ length: 8 }, (_, pointIndex) => ({
          lat: pointIndex,
          lon: pointIndex,
          isStop: pointIndex === 0,
        })),
      }),
    );
    const visible = selectRenderableJourneyRoutes(routes);
    expect(visible.length).toBeLessThanOrEqual(MAX_RENDERED_JOURNEYS);
    expect(
      visible.reduce((total, route) => total + route.points.length, 0),
    ).toBeLessThanOrEqual(MAX_RENDERED_ROUTE_POINTS);
    expect(visible.at(-1)?.id).toBe(String(routes.length - 1));
    expect(QUALITY_PROFILE.low.maxDpr).toBe(1);
  });
});

describe("#194 compact mobile layout is injected, never inferred", () => {
  // The globe overlays used to read `window.innerWidth <= 760` themselves, so a
  // 932x430 coarse-pointer phone was Mobile V2 in the shell and desktop in the
  // scene. These cases pin the two layout helpers to the injected boolean and
  // set a desktop-width global to prove the global is not consulted.
  const desktopViewport = <T,>(run: () => T) => {
    const original = globalThis.innerWidth;
    Object.defineProperty(globalThis, "innerWidth", {
      configurable: true,
      value: 1440,
      writable: true,
    });
    try {
      return run();
    } finally {
      Object.defineProperty(globalThis, "innerWidth", {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  };

  const host = { width: 932, height: 430 };

  it("caps route labels from the injected flag while the viewport reads desktop", () => {
    expect(desktopViewport(() => resolveRouteLabelLimit(true)))
      .toBe(MAX_RENDERED_MOBILE_ROUTE_LABELS);
    expect(desktopViewport(() => resolveRouteLabelLimit(false)))
      .toBe(MAX_RENDERED_ROUTE_LABELS);
  });

  it("takes the compact header inset from the injected flag, not the viewport", () => {
    const compact = desktopViewport(() => resolveRouteLabelSafeArea({
      host,
      headerBottom: null,
      card: null,
      compactMobileLayout: true,
    }));
    const roomy = desktopViewport(() => resolveRouteLabelSafeArea({
      host,
      headerBottom: null,
      card: null,
      compactMobileLayout: false,
    }));
    expect(compact.top).toBe(62);
    expect(roomy.top).toBe(74);
    expect(compact.right).toBe(host.width - 16);
    expect(compact.bottom).toBe(host.height - 18);
  });

  it("measures the header when one is present, in host-relative pixels", () => {
    const safeArea = resolveRouteLabelSafeArea({
      host,
      headerBottom: 90,
      card: null,
      compactMobileLayout: true,
    });
    expect(safeArea.top).toBe(100);
    expect(resolveRouteLabelSafeArea({
      host,
      headerBottom: -40,
      card: null,
      compactMobileLayout: false,
    }).top).toBe(16);
  });

  it("yields the bottom edge to the active card when compact", () => {
    const safeArea = desktopViewport(() => resolveRouteLabelSafeArea({
      host,
      headerBottom: null,
      card: { left: 0, top: 260, right: host.width, bottom: host.height },
      compactMobileLayout: true,
    }));
    expect(safeArea.bottom).toBe(244);
    expect(safeArea.right).toBe(host.width - 16);
  });

  it("yields the right edge to the active card when not compact", () => {
    const safeArea = resolveRouteLabelSafeArea({
      host,
      headerBottom: null,
      card: { left: 600, top: 0, right: host.width, bottom: host.height },
      compactMobileLayout: false,
    });
    expect(safeArea.right).toBe(582);
    expect(safeArea.bottom).toBe(host.height - 18);
  });

  it("keeps the full host box when the card does not overlap it", () => {
    const safeArea = resolveRouteLabelSafeArea({
      host,
      headerBottom: null,
      card: { left: host.width + 20, top: 40, right: host.width + 300, bottom: 200 },
      compactMobileLayout: true,
    });
    expect(safeArea.bottom).toBe(host.height - 18);
    expect(safeArea.right).toBe(host.width - 16);
  });
});

describe("#219 the focus signal shares the Route Point anchor", () => {
  // qa-p-17 of the qa-route-southwest fixture in src/main.tsx: the Route Point
  // scripts/qa-route-anchoring.mjs frames the focus signal on.
  const lasVegas = { lat: 36.1699, lon: -115.1398 };
  const fallback = { lat: 34.0522, lon: -118.2437 };

  it("places a focused Route Point on ROUTE_ANCHOR_RADIUS, not a radius of its own", () => {
    const focus = focusSignalAnchor(lasVegas, fallback);
    expect(focus.length()).toBeCloseTo(ROUTE_ANCHOR_RADIUS, 12);
    // The focus layer and the route layer resolve the same Route Point to the
    // same world position, so one geographic object is drawn once, not twice.
    expect(focus.distanceTo(routePointAnchor(lasVegas.lat, lasVegas.lon))).toBe(0);
  });

  it("puts the fallback on the same anchor when no Route Point is focused", () => {
    for (const point of [null, undefined]) {
      const focus = focusSignalAnchor(point, fallback);
      expect(focus.length()).toBeCloseTo(ROUTE_ANCHOR_RADIUS, 12);
      expect(focus.distanceTo(routePointAnchor(fallback.lat, fallback.lon))).toBe(0);
    }
  });

  it("leaves no focus radius literal behind in the scene", () => {
    // focusSignalAnchor cannot cover the pointRadius parameter defaults of
    // projectFocusPointForRotation and solveFocusRotationForViewport, so the
    // superseded 1.45 is asserted gone from the whole module instead.
    const source = readFileSync(
      new URL("./ParticleEarthScene.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\b1\.45\b/);
    // Place labels agreed with the route layer only because they repeated the
    // same number; they now name the constant, so no Route Point radius in the
    // module is a literal that could silently drift from ROUTE_ANCHOR_RADIUS.
    expect(source).not.toMatch(/\b1\.46\b/);
    expect(source.match(/pointRadius = ROUTE_ANCHOR_RADIUS,/g)).toHaveLength(2);
  });
});
