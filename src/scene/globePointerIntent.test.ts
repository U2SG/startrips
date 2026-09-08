import { describe, expect, it } from "vitest";
import {
  GLOBE_DRAG_THRESHOLD_PX,
  GLOBE_ZOOM_MAX,
  GLOBE_ZOOM_MIN,
  canTrackGlobePointer,
  clampGlobeZoom,
  getGlobeInertiaSpeedLimit,
  isGlobeDrag,
  isPrimaryPointerActivation,
  isReliablePinchAnchor,
  projectedRadiusRotationDelta,
  rebaseGlobeDragSample,
  shouldRememberUntrackedPointerStart,
  shouldRetainGlobeInertia,
  shouldSuppressUntrackedPointerActivation,
} from "./globePointerIntent";

describe("globe pointer intent", () => {
  it("uses the deliberate drag threshold", () => {
    expect(isGlobeDrag(GLOBE_DRAG_THRESHOLD_PX - 0.01)).toBe(false);
    expect(isGlobeDrag(GLOBE_DRAG_THRESHOLD_PX)).toBe(true);
  });

  it("clamps zoom to the globe interaction range", () => {
    expect(clampGlobeZoom(GLOBE_ZOOM_MIN - 1)).toBe(GLOBE_ZOOM_MIN);
    expect(clampGlobeZoom(GLOBE_ZOOM_MAX + 1)).toBe(GLOBE_ZOOM_MAX);
    expect(clampGlobeZoom(1.2)).toBe(1.2);
  });

  it("accepts only the primary activation pointer", () => {
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

  it("maps the same screen drag to radius-relative angular motion", () => {
    const wholeEarthDelta = projectedRadiusRotationDelta(
      { x: 195, y: 422 },
      { x: 225, y: 422 },
      400,
    );
    const closeDelta = projectedRadiusRotationDelta(
      { x: 195, y: 422 },
      { x: 225, y: 422 },
      1_200,
    );

    expect(Math.abs(closeDelta.rotationY)).toBeCloseTo(
      Math.abs(wholeEarthDelta.rotationY) / 3,
    );
    expect(400 * wholeEarthDelta.angularDelta).toBeCloseTo(30);
    expect(1_200 * closeDelta.angularDelta).toBeCloseTo(30);
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

  it("falls back when a pinch centroid is outside the reliable silhouette", () => {
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
  });

  it("bounds the gesture controller to the two pointers its pinch math supports", () => {
    expect(canTrackGlobePointer(0)).toBe(true);
    expect(canTrackGlobePointer(1)).toBe(true);
    expect(canTrackGlobePointer(2)).toBe(false);
    expect(canTrackGlobePointer(3)).toBe(false);
  });

  it("remembers sibling contacts after another globe pointer is tracked", () => {
    expect(shouldRememberUntrackedPointerStart(0)).toBe(false);
    expect(shouldRememberUntrackedPointerStart(1)).toBe(true);
    expect(shouldRememberUntrackedPointerStart(2)).toBe(true);
  });

  it("suppresses activation for rejected or overlapping untracked pointers", () => {
    expect(shouldSuppressUntrackedPointerActivation(true, 0)).toBe(true);
    expect(shouldSuppressUntrackedPointerActivation(true, 2)).toBe(true);
    expect(shouldSuppressUntrackedPointerActivation(false, 1)).toBe(true);
    expect(shouldSuppressUntrackedPointerActivation(false, 0)).toBe(false);
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
});
