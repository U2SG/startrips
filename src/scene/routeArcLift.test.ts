import { describe, expect, it } from "vitest";
import { ROUTE_ANCHOR_RADIUS } from "./geo";
import {
  resolveRouteArcLift,
  resolveRouteArcProfile,
  routeArcPixelsPerWorldUnit,
  ROUTE_ARC_HEIGHT_RATIO,
} from "./routeArcLift";
import type { GlobeSemanticZoom } from "./semanticZoom";

const MODE_SCALE = 1.15;
const CAMERA_DISTANCE = 5.4;
const focalLengthPx = (viewportHeightPx: number) =>
  viewportHeightPx / (2 * Math.tan((38 * Math.PI) / 360));
// 1280x800 desktop and a 390x844 phone, 38 degree vertical fov, camera at 5.4.
const DESKTOP = { viewportHeightPx: 800, viewportMinPx: 800 };
const PHONE = { viewportHeightPx: 844, viewportMinPx: 390 };

function liftAtZoom(
  zoom: number,
  view = DESKTOP,
  semanticZoom: GlobeSemanticZoom = "planet",
) {
  const globeScale = MODE_SCALE * zoom;
  return resolveRouteArcLift({
    zoom,
    globeScale,
    anchorRadius: ROUTE_ANCHOR_RADIUS,
    pixelsPerWorldUnit: routeArcPixelsPerWorldUnit({
      focalLengthPx: focalLengthPx(view.viewportHeightPx),
      cameraDistance: CAMERA_DISTANCE,
      anchorRadius: ROUTE_ANCHOR_RADIUS,
      globeScale,
    }),
    viewportMinPx: view.viewportMinPx,
    semanticZoom,
  });
}

describe("route arc lift (#193)", () => {
  it("keeps the cinematic geodesic arc at global view", () => {
    expect(liftAtZoom(0.72).liftScale).toBe(1);
    expect(liftAtZoom(0.72).worldLiftAtScale).toBeCloseTo(
      ROUTE_ANCHOR_RADIUS * ROUTE_ARC_HEIGHT_RATIO * MODE_SCALE * 0.72,
      6,
    );
    // At 1x the screen ceiling already trims the hump, but the route still
    // reads as an elevated geodesic arc rather than a flat thread.
    expect(liftAtZoom(1).liftScale).toBeGreaterThan(0.7);
  });

  it("measures magnification at the arc's own depth, not the globe centre", () => {
    const centreDepth = routeArcPixelsPerWorldUnit({
      focalLengthPx: focalLengthPx(800),
      cameraDistance: CAMERA_DISTANCE,
      anchorRadius: 0,
      globeScale: 1,
    });
    const arcDepth = routeArcPixelsPerWorldUnit({
      focalLengthPx: focalLengthPx(800),
      cameraDistance: CAMERA_DISTANCE,
      anchorRadius: ROUTE_ANCHOR_RADIUS,
      globeScale: MODE_SCALE * 2,
    });
    // A camera-facing vertex at 2x sits far closer than the globe centre.
    expect(arcDepth).toBeGreaterThan(centreDepth * 2);
    // The near plane can never produce a division blow-up.
    expect(Number.isFinite(routeArcPixelsPerWorldUnit({
      focalLengthPx: focalLengthPx(800),
      cameraDistance: CAMERA_DISTANCE,
      anchorRadius: ROUTE_ANCHOR_RADIUS,
      globeScale: 100,
    }))).toBe(true);
  });

  it("attenuates toward geographic as zoom approaches max", () => {
    const global = liftAtZoom(1).liftScale;
    const regional = liftAtZoom(1.7).liftScale;
    const near = liftAtZoom(2.3).liftScale;
    const max = liftAtZoom(3).liftScale;
    expect(regional).toBeLessThan(global);
    expect(near).toBeLessThan(regional);
    expect(max).toBeLessThan(near);
    // Max zoom is effectively geographic: the route sits on the anchor shell.
    expect(max).toBe(0);
  });

  it("never rises with zoom and never jumps while wheel-zooming", () => {
    let previous = liftAtZoom(0.72).liftScale;
    for (let zoom = 0.73; zoom <= 3.0001; zoom += 0.01) {
      const current = liftAtZoom(zoom).liftScale;
      expect(current).toBeLessThanOrEqual(previous + 1e-9);
      // Continuous: no tier boundary can pop the route shape.
      expect(Math.abs(current - previous)).toBeLessThan(0.03);
      previous = current;
    }
  });

  it("caps decorative altitude in screen space", () => {
    for (let zoom = 0.72; zoom <= 3.0001; zoom += 0.05) {
      const lift = liftAtZoom(zoom);
      expect(lift.screenLiftPx).toBeLessThanOrEqual(lift.screenLiftCapPx + 1e-6);
    }
    // A high-density view where the unattenuated arc would span the screen.
    const dense = resolveRouteArcLift({
      zoom: 1.6,
      globeScale: MODE_SCALE * 1.6,
      anchorRadius: ROUTE_ANCHOR_RADIUS,
      pixelsPerWorldUnit: 4000,
      viewportMinPx: 800,
      semanticZoom: "macro",
    });
    expect(dense.liftScale).toBeLessThan(0.1);
    expect(dense.screenLiftPx).toBeLessThanOrEqual(dense.screenLiftCapPx + 1e-6);
    // Zooming in never buys more projected altitude than the global view had.
    expect(liftAtZoom(2).screenLiftPx)
      .toBeLessThanOrEqual(liftAtZoom(1).screenLiftPx + 1e-6);
  });

  it("gives a phone a proportionally smaller ceiling", () => {
    expect(liftAtZoom(1.6, PHONE).screenLiftCapPx)
      .toBeLessThan(liftAtZoom(1.6).screenLiftCapPx);
    expect(liftAtZoom(1.6, PHONE).liftScale)
      .toBeLessThan(liftAtZoom(1.6).liftScale);
  });

  it("keeps every lifted vertex inside the near-plane budget", () => {
    for (let zoom = 0.72; zoom <= 3.0001; zoom += 0.02) {
      const globeScale = MODE_SCALE * zoom;
      const lift = liftAtZoom(zoom);
      const extent = ROUTE_ANCHOR_RADIUS * globeScale
        + lift.worldLiftAtScale;
      // The label shell itself reaches ~5.10 at max zoom; nothing this feature
      // adds may push route geometry past that documented ceiling.
      expect(extent).toBeLessThanOrEqual(5.11);
    }
  });

  it("reports a descriptive profile without feeding it into the geometry", () => {
    expect(resolveRouteArcProfile("planet")).toBe("global");
    expect(resolveRouteArcProfile("macro")).toBe("global");
    expect(resolveRouteArcProfile("regional")).toBe("regional");
    expect(resolveRouteArcProfile("local")).toBe("near");
    // The label follows the hysteretic semantic state; the number does not.
    expect(liftAtZoom(1.8, DESKTOP, "regional").liftScale)
      .toBe(liftAtZoom(1.8, DESKTOP, "local").liftScale);
  });

  it("degrades to no lift on a degenerate view", () => {
    expect(liftAtZoom(Number.NaN).liftScale).toBe(0);
    expect(resolveRouteArcLift({
      zoom: 1,
      globeScale: 0,
      anchorRadius: ROUTE_ANCHOR_RADIUS,
      pixelsPerWorldUnit: 200,
      viewportMinPx: 800,
      semanticZoom: "planet",
    }).liftScale).toBe(0);
  });
});
