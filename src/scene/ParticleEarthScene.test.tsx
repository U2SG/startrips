import {
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Texture,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import type { GlobeMode } from "../experience/types";
import {
  GLOBE_MODE_CONFIG,
  GLOBE_DRAG_THRESHOLD_PX,
  GLOBE_IDLE_RESUME_DELAY_MS,
  GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND,
  GLOBE_RENDER_ORDER,
  GLOBE_TILT_LIMIT_RADIANS,
  GLOBE_ZOOM_MAX,
  GLOBE_ZOOM_MIN,
  MAX_RENDERED_JOURNEYS,
  MAX_RENDERED_MOBILE_ROUTE_LABELS,
  MAX_RENDERED_ROUTE_LABELS,
  MAX_RENDERED_ROUTE_POINTS,
  QUALITY_PROFILE,
  buildProjectedRoutePath,
  clampGlobeTilt,
  clampGlobeZoom,
  getJourneyRouteVisualState,
  getGlobeIdleRotationDelta,
  isGlobeDrag,
  isPrimaryPointerActivation,
  isSphericalPointVisible,
  selectRenderableJourneyRoutes,
  selectRouteLabelPointIndexes,
} from "./ParticleEarthScene";
import { disposeSceneGraph } from "./useThreeScene";

describe("ParticleEarthScene contracts", () => {
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

  it("uses a deliberate drag threshold and keeps vertical rotation bounded", () => {
    expect(isGlobeDrag(GLOBE_DRAG_THRESHOLD_PX - 0.01)).toBe(false);
    expect(isGlobeDrag(GLOBE_DRAG_THRESHOLD_PX)).toBe(true);
    expect(clampGlobeTilt(GLOBE_TILT_LIMIT_RADIANS + 1)).toBe(
      GLOBE_TILT_LIMIT_RADIANS,
    );
    expect(clampGlobeTilt(-GLOBE_TILT_LIMIT_RADIANS - 1)).toBe(
      -GLOBE_TILT_LIMIT_RADIANS,
    );
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

  it("auto-rotates only after idle time and outside reduced motion", () => {
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
      1,
      GLOBE_IDLE_RESUME_DELAY_MS,
      false,
      false,
    )).toBeCloseTo(GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND);
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
