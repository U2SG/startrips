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
  QUALITY_PROFILE,
  buildJourneyConnector,
  buildJourneyConnectorPath,
  advanceGlobeIdleReleasePhase,
  buildProjectedRoutePath,
  collectJourneyDimDirections,
  focusViewportCenter,
  clampGlobeTilt,
  journeyConnectorAnchor,
  clampGlobeZoom,
  getJourneyRouteLineScale,
  getJourneyRouteVisualState,
  getGlobeIdleAlignmentRotation,
  getGlobeIdleRotationDelta,
  getGlobeInertiaSpeedLimit,
  getProjectedGlobeRadiusPx,
  getProjectedSurfaceInteractionRadiusPx,
  isFocusFlightActive,
  isIdleRotationSuppressed,
  isGlobeUpright,
  isGlobeDrag,
  isPrimaryPointerActivation,
  isSphericalPointVisible,
  isProjectedPointInsideViewport,
  isLocalPointInsideClipViewport,
  isReliablePinchAnchor,
  projectedRadiusRotationDelta,
  rebaseGlobeDragSample,
  selectRenderableJourneyRoutes,
  selectRouteLabelPointIndexes,
  shouldFocusRevisionOwnState,
  shouldRetainGlobeInertia,
  solveScreenAnchorRotation,
} from "./ParticleEarthScene";
import { disposeSceneGraph } from "./useThreeScene";

describe("ParticleEarthScene contracts", () => {
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
    const segments = new Float32Array([
      0, 0, 1, 1, 0, 1,
      1, 0, 1, -1, 0, 1,
      2, 0, 1, 3, 0, 1,
    ]);
    const path = buildProjectedRoutePath(segments, (x, y, _z, target) => {
      target.x = x * 10;
      target.y = y * 10;
      return x >= 0;
    });
    expect(path).toBe(
      "M0.0 0.0L10.0 0.0M20.0 0.0L30.0 0.0",
    );
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
