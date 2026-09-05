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
  COASTLINE_DEPTH_BIAS_CHUNK,
  COASTLINE_DEPTH_POLICY,
  SURFACE_TESSELLATION_SAGITTA,
  applyCoastlineDepthBias,
  createCoastlineMaterial,
  GLOBE_TILT_LIMIT_RADIANS,
  GLOBE_UPRIGHT_ROTATION_X,
  GLOBE_ZOOM_MAX,
  GLOBE_ZOOM_MIN,
  MAX_RENDERED_JOURNEYS,
  MAX_RENDERED_MOBILE_ROUTE_LABELS,
  MAX_RENDERED_ROUTE_LABELS,
  MAX_RENDERED_ROUTE_LINE_VERTICES,
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
  buildRouteArcLegSamples,
  buildRouteArcSamples,
  GEOGRAPHIC_SURFACE_RADIUS,
  ROUTE_ANCHOR_RADIUS,
  routeArcVertexCount,
  routePointAnchor,
} from "./geo";
import { disposeSceneGraph } from "./useThreeScene";

describe("ParticleEarthScene contracts", () => {
  it("uses one geographic surface anchor for map semantics", () => {
    // #224 already unified place labels, the focus signal and route geometry
    // behind ROUTE_ANCHOR_RADIUS. #196 is the remaining half: that one anchor
    // is the real map surface, so there is no second shell left to drift.
    expect(GLOBE_SURFACE_RADIUS).toBe(GEOGRAPHIC_SURFACE_RADIUS);
    expect(ROUTE_ANCHOR_RADIUS).toBe(GEOGRAPHIC_SURFACE_RADIUS);
  });

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
    const anchor = routePointAnchor(0, -90);
    // A leg that runs from the camera-facing surface anchor around the globe
    // until the far vertices fall behind the limb.
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: -90 }, { lat: 0, lon: 80 }],
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

  // #196: a Route Point now sits ON the occluding surface instead of a shell
  // above it, so the straight chord between two zero-lift vertices is a secant
  // that dips inside the globe. These two cases pin the clip walk to the arc
  // the route actually occupies.
  describe("#196 horizon clipping of surface-level route geometry", () => {
    const camera = new Vector3(0, 0, 5.4);
    // Where the surface turns away from the camera. Everything at a greater
    // polar angle than this is behind the limb.
    const limbAngle = Math.acos(GLOBE_SURFACE_RADIUS / camera.z);
    // Screen units per world unit. buildProjectedRoutePath rounds path
    // coordinates to 0.1, so the probe has to be projected large enough for
    // that rounding not to swallow the effect being measured.
    const scale = 1000;

    /**
     * One flat segment in the y = 0 plane, from `startAngle` to `endAngle`
     * measured from the camera axis. The projection is deliberately the
     * identity on (x, z) so a path coordinate can be read straight back as a
     * world position and its radius and polar angle recovered.
     */
    function clipFlatSegment(startAngle: number, endAngle: number) {
      const samples = {
        directions: new Float32Array([
          Math.sin(startAngle), 0, Math.cos(startAngle),
          Math.sin(endAngle), 0, Math.cos(endAngle),
        ]),
        lifts: new Float32Array([0, 0]),
      };
      const path = buildProjectedRoutePath(
        samples,
        (x, y, z, target) => {
          if (!isSphericalPointVisible(camera, new Vector3(x, y, z))) return false;
          target.x = x * scale;
          target.y = z * scale;
          return true;
        },
        { radius: ROUTE_ANCHOR_RADIUS, liftScale: 1 },
      );
      const points = [...path.d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(
        ([, x, z]) => ({ x: Number(x) / scale, z: Number(z) / scale }),
      );
      return { path, points };
    }

    it("ends the clipped line on the surface at the limb, not inside the globe", () => {
      const { path, points } = clipFlatSegment(limbAngle - 0.25, limbAngle + 0.25);
      expect(path.d).not.toBe("");
      const crossing = points[points.length - 1];
      // On the chord the crossing landed at radius ~1.347 and ~0.47 degrees
      // past the limb, i.e. the line was drawn into the globe's silhouette.
      expect(Math.hypot(crossing.x, crossing.z)).toBeCloseTo(ROUTE_ANCHOR_RADIUS, 3);
      expect(Math.atan2(crossing.x, crossing.z)).toBeLessThanOrEqual(limbAngle + 1e-6);
    });

    it("still draws a segment whose visible part is a fraction of a percent", () => {
      // Visible for ~0.2% of its length: below the 2^-8 the previous eight
      // bisection steps could resolve, so the whole segment used to vanish.
      const startAngle = limbAngle - 0.0004;
      const { path, points } = clipFlatSegment(startAngle, limbAngle + 0.2);
      expect(path.d).not.toBe("");
      // Path coordinates are rounded to 0.1 screen units, i.e. 1e-4 of a world
      // unit at this scale, so the endpoint is pinned no tighter than that.
      expect(points[0].x).toBeCloseTo(ROUTE_ANCHOR_RADIUS * Math.sin(startAngle), 3);
      expect(points[0].z).toBeCloseTo(ROUTE_ANCHOR_RADIUS * Math.cos(startAngle), 3);
    });
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

  it("keeps the coastline above the surface with depth, not with radius (#237)", () => {
    // The coastline shares the surface radius now, so what makes it READ above
    // the particle body has to be a render policy. It is drawn after the
    // particles and before every journey signal...
    expect(GLOBE_RENDER_ORDER.particle).toBeLessThan(GLOBE_RENDER_ORDER.coastline);
    expect(GLOBE_RENDER_ORDER.coastline).toBeLessThan(GLOBE_RENDER_ORDER.signal);

    // ...and it still depth-tests against the surface sphere, so the far side of
    // the planet stays hidden. It never WRITES depth, which is why no bias
    // magnitude can let it occlude a route line or a marker.
    const material = createCoastlineMaterial();
    expect(material.depthTest).toBe(COASTLINE_DEPTH_POLICY.depthTest);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(COASTLINE_DEPTH_POLICY.depthWrite);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    // Cloning drops onBeforeCompile, so every LOD must be built by the factory.
    expect(material.onBeforeCompile).toBe(applyCoastlineDepthBias);
    const cloned = material.clone();
    expect(cloned.onBeforeCompile).not.toBe(applyCoastlineDepthBias);
    const source = readFileSync(
      new URL("./ParticleEarthScene.tsx", import.meta.url),
      "utf8",
    );
    expect(source.match(/createCoastlineMaterial\(\)/g)).toHaveLength(4);
    expect(source).not.toMatch(/coastlineMaterial\.clone\(\)/);

    // The bias clears the worst gap between the analytic sphere the coastline
    // sits on and the inscribed mesh that occludes it, with margin.
    expect(SURFACE_TESSELLATION_SAGITTA).toBeGreaterThan(0);
    expect(SURFACE_TESSELLATION_SAGITTA).toBeLessThan(0.003);
    expect(COASTLINE_DEPTH_POLICY.ndcDepthBias).toBeGreaterThan(0);
    expect(COASTLINE_DEPTH_POLICY.ndcDepthBias).toBeLessThan(0.01);

    // The patch may move clip Z and nothing else: the projected screen position
    // of a coastline vertex has to stay the position the shared frame computes
    // for the same latitude/longitude.
    expect(COASTLINE_DEPTH_BIAS_CHUNK).toContain("gl_Position.z -=");
    expect(COASTLINE_DEPTH_BIAS_CHUNK).not.toMatch(/gl_Position\.(x|y|w)\s*[-+*\/]?=/);
    expect(COASTLINE_DEPTH_BIAS_CHUNK).toContain("coastlineFacing");
    const shader = { vertexShader: "void main() { #include <fog_vertex> }" };
    applyCoastlineDepthBias(shader);
    expect(shader.vertexShader).toContain("#include <fog_vertex>");
    expect(shader.vertexShader).toContain(COASTLINE_DEPTH_BIAS_CHUNK);
  });

  it("keeps every coastline path on the geographic surface radius (#237)", () => {
    const source = readFileSync(
      new URL("./ParticleEarthScene.tsx", import.meta.url),
      "utf8",
    );
    // The two surviving 1.405 literals are the decorative archive shell and its
    // cluster jitter - nothing reads a latitude/longitude off either, so they
    // are not geographic reference layers and deliberately keep their radii.
    const shells = source.match(/\b1\.405\b/g) ?? [];
    expect(shells).toHaveLength(2);
    expect(source).toMatch(/shellPositions\[index\] \*= 1\.405;/);
    expect(source).toMatch(/const radius = 1\.405 \+ \(\(index \* 31\) % 17\) \* 0\.002;/);
    // Every buildSphericalRingSegments call in the module - the far, mid and
    // near builders plus the detailed loader - names the constant.
    const ringBuilds = source.match(/buildSphericalRingSegments\(/g) ?? [];
    expect(ringBuilds).toHaveLength(4);
    expect(
      source.match(/buildSphericalRingSegments\(\s*[A-Za-z.]+,\s*GEOGRAPHIC_SURFACE_RADIUS,/g),
    ).toHaveLength(4);

    // The decorative layers named out of scope by #237 keep their own scales.
    expect(source).toMatch(/wire\.scale\.setScalar\(1\.006\);/);
    expect(source).toMatch(/reliefSupport\.scale\.setScalar\(1\.0015\);/);

    // One projection authority: the only surviving direct camera projection is
    // the globe interaction centre, which is drag math rather than a
    // geographic anchor.
    const projections = source.match(/\.project\(camera\)/g) ?? [];
    expect(projections).toHaveLength(1);
    expect(source).toMatch(/interactionWorldCenter\.copy\(globe\.position\)\.project\(camera\);/);
  });
});

// #242: the sawtooth is an INTERIOR defect. Exact endpoints and a shared
// projection say nothing about whether the curve between two Route Points is
// drawn faithfully, so these cases grade the interior: one evaluator behind
// both consumers, and a bounded screen-space error against the curve the
// geometry stands for.
describe("#242 route curve fidelity", () => {
  const camera = new Vector3(0, 0, 5.4);
  const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
  const SEGMENT_ANGLE = Math.PI / 96;
  const scale = 900;

  /**
   * A synthetic evenly spaced chain of ~0.5 degree legs - the local multi-stop
   * shape the issue reports as a row of steep takeoffs. Every fixture here
   * sits on the camera-facing hemisphere so a path is one unbroken fragment;
   * occlusion has its own case at the end.
   */
  const shortLegRoute = Array.from({ length: 7 }, (_, index) => ({
    lat: 34 + index * 0.3,
    lon: -118 + index * 0.4,
  }));
  /** Short, regional and intercontinental legs in one route. */
  const mixedRoute = [
    { lat: 34.0522, lon: -118.2437 },
    { lat: 37.8651, lon: -119.5383 },
    { lat: 36.1699, lon: -115.1398 },
    { lat: 19.4326, lon: -99.1332 },
    { lat: -12.0464, lon: -77.0428 },
  ];

  /** The projector both the drawn path and its reference are measured through. */
  function project(x: number, y: number, z: number, target: { x: number; y: number }) {
    if (!isSphericalPointVisible(camera, new Vector3(x, y, z))) return false;
    target.x = 640 + x * scale;
    target.y = 400 - y * scale;
    return true;
  }

  /** Screen points of each drawn fragment of a path, fragment by fragment. */
  function readFragments(d: string) {
    const fragments: Array<Array<{ x: number; y: number }>> = [];
    for (const command of d.match(/[ML]-?[\d.]+ -?[\d.]+/g) ?? []) {
      const [x, y] = command.slice(1).split(" ").map(Number);
      if (command.startsWith("M") || fragments.length === 0) fragments.push([]);
      fragments[fragments.length - 1].push({ x, y });
    }
    return fragments;
  }

  function distanceToSegment(
    point: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = (dx * dx) + (dy * dy);
    if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.min(1, Math.max(
      0,
      (((point.x - a.x) * dx) + ((point.y - a.y) * dy)) / lengthSquared,
    ));
    return Math.hypot(point.x - a.x - (t * dx), point.y - a.y - (t * dy));
  }

  function drawPath(points: typeof mixedRoute, segmentAngle: number, budget: number, liftScale: number) {
    return buildProjectedRoutePath(
      buildRouteArcSamples(points, segmentAngle, budget, arc),
      project,
      { radius: ROUTE_ANCHOR_RADIUS, liftScale },
    );
  }

  /**
   * Worst screen distance from a high-resolution sampling of the SAME lifted
   * curve to the polyline actually drawn. The reference comes from the same
   * builder at a far finer segment angle, so it is that curve at a density the
   * drawn path is graded against, not a second model of it. Both are in curve
   * order, so the search walks forward with a window instead of comparing
   * every reference sample against every drawn segment.
   */
  function referenceErrorPx(points: typeof mixedRoute, liftScale: number) {
    const drawn = readFragments(drawPath(
      points,
      SEGMENT_ANGLE,
      MAX_RENDERED_ROUTE_LINE_VERTICES,
      liftScale,
    ).d);
    const reference = readFragments(drawPath(
      points,
      Math.PI / 4000,
      1_000_000,
      liftScale,
    ).d);
    // Both fixtures are fully visible, so each is a single fragment; a broken
    // one would make this metric meaningless rather than merely lenient.
    expect(drawn).toHaveLength(1);
    expect(reference).toHaveLength(1);
    const polyline = drawn[0];
    expect(polyline.length).toBeGreaterThan(2);

    let worst = 0;
    let cursor = 1;
    for (const sample of reference[0]) {
      let nearest = Number.POSITIVE_INFINITY;
      let nearestIndex = cursor;
      const from = Math.max(1, cursor - 8);
      const to = Math.min(polyline.length - 1, cursor + 8);
      for (let index = from; index <= to; index += 1) {
        const distance = distanceToSegment(
          sample,
          polyline[index - 1],
          polyline[index],
        );
        if (distance < nearest) {
          nearest = distance;
          nearestIndex = index;
        }
      }
      cursor = nearestIndex;
      worst = Math.max(worst, nearest);
    }
    return worst;
  }

  it("draws the whole route and its rewind legs from one evaluator", () => {
    for (const points of [shortLegRoute, mixedRoute]) {
      const whole = buildRouteArcSamples(
        points,
        SEGMENT_ANGLE,
        MAX_RENDERED_ROUTE_LINE_VERTICES,
        arc,
      );
      const legs = buildRouteArcLegSamples(
        points,
        SEGMENT_ANGLE,
        MAX_RENDERED_ROUTE_LINE_VERTICES,
        arc,
      );
      expect(legs).toHaveLength(points.length - 1);
      expect(routeArcVertexCount(whole))
        .toBeLessThanOrEqual(MAX_RENDERED_ROUTE_LINE_VERTICES);

      // Each leg is the corresponding SPAN of the whole-route samples, vertex
      // for vertex. Before #242 the two carried different vertex budgets from
      // the same points, so the static stroke and the leg that redraws it
      // could disagree and double a bright peak where they did.
      let offset = 0;
      let legVertices = 0;
      for (const leg of legs) {
        const count = routeArcVertexCount(leg);
        legVertices += count;
        for (let vertex = 0; vertex < count; vertex += 1) {
          expect(leg.lifts[vertex]).toBeCloseTo(whole.lifts[offset + vertex], 6);
          for (let axis = 0; axis < 3; axis += 1) {
            expect(leg.directions[(vertex * 3) + axis]).toBeCloseTo(
              whole.directions[((offset + vertex) * 3) + axis],
              6,
            );
          }
        }
        offset += count;
      }
      expect(legVertices).toBe(routeArcVertexCount(whole));
      expect(legVertices).toBeLessThanOrEqual(MAX_RENDERED_ROUTE_LINE_VERTICES);
    }
  });

  it("stays within a CSS pixel of the curve it stands for", () => {
    for (const liftScale of [1, 0.25]) {
      expect(referenceErrorPx(shortLegRoute, liftScale)).toBeLessThanOrEqual(1);
      expect(referenceErrorPx(mixedRoute, liftScale)).toBeLessThanOrEqual(1);
    }
  });

  it("holds that tolerance for a dense route inside the vertex budget", () => {
    // 60 Route Points around a small circle: many more legs than a front-to-
    // back build could pay for, so the old build returned early and dropped
    // the tail of the route - and with it the Route Points on it.
    const dense = Array.from({ length: 60 }, (_, index) => ({
      lat: 10 + (6 * Math.sin((index / 60) * Math.PI * 2)),
      lon: -90 + (6 * Math.cos((index / 60) * Math.PI * 2)),
    }));
    const samples = buildRouteArcSamples(
      dense,
      SEGMENT_ANGLE,
      MAX_RENDERED_ROUTE_LINE_VERTICES,
      arc,
    );
    expect(routeArcVertexCount(samples))
      .toBeLessThanOrEqual(MAX_RENDERED_ROUTE_LINE_VERTICES);
    // Every stored Route Point still appears in the sampled route.
    for (const point of dense) {
      const anchor = routePointAnchor(point.lat, point.lon);
      let nearest = Number.POSITIVE_INFINITY;
      for (let vertex = 0; vertex < routeArcVertexCount(samples); vertex += 1) {
        const offset = vertex * 3;
        const lift = 1 + samples.lifts[vertex];
        nearest = Math.min(nearest, anchor.distanceTo(new Vector3(
          samples.directions[offset] * ROUTE_ANCHOR_RADIUS * lift,
          samples.directions[offset + 1] * ROUTE_ANCHOR_RADIUS * lift,
          samples.directions[offset + 2] * ROUTE_ANCHOR_RADIUS * lift,
        )));
      }
      expect(nearest).toBeLessThan(1e-5);
    }
    expect(referenceErrorPx(dense, 1)).toBeLessThanOrEqual(1);
  });

  it("never bridges two visible fragments across an occluded span", () => {
    // A route whose middle runs behind the globe.
    const aroundTheGlobe = [
      { lat: 0, lon: -80 },
      { lat: 0, lon: -20 },
      { lat: 10, lon: 100 },
      { lat: 0, lon: 175 },
      { lat: 0, lon: -100 },
    ];
    const fragments = readFragments(drawPath(
      aroundTheGlobe,
      SEGMENT_ANGLE,
      MAX_RENDERED_ROUTE_LINE_VERTICES,
      1,
    ).d);
    expect(fragments.length).toBeGreaterThan(1);
    // Within one fragment every step is a real step of the sampled curve, so
    // no single line joins two spans separated by hidden geometry. The globe
    // spans 2 * ROUTE_ANCHOR_RADIUS * scale pixels; a bridged span would be a
    // sizeable fraction of that, while a sampled step is far smaller.
    const globeWidthPx = 2 * ROUTE_ANCHOR_RADIUS * scale;
    for (const fragment of fragments) {
      for (let index = 1; index < fragment.length; index += 1) {
        expect(Math.hypot(
          fragment[index].x - fragment[index - 1].x,
          fragment[index].y - fragment[index - 1].y,
        )).toBeLessThan(globeWidthPx / 10);
      }
    }
  });
});
