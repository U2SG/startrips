import { describe, expect, it } from "vitest";
import { ROUTE_ANCHOR_RADIUS } from "./geo";
import {
  resolveRouteArcLift,
  resolveRouteArcProfile,
  ROUTE_ARC_HEIGHT_RATIO,
} from "./routeArcLift";
import type { GlobeSemanticZoom } from "./semanticZoom";

const MODE_SCALE = 1.15;
// 1280x800 desktop, 38 degree vertical fov, camera at z 5.4.
const DESKTOP = {
  pixelsPerWorldUnit: 800 / (2 * Math.tan((38 * Math.PI) / 360)) / 5.4,
  viewportMinPx: 800,
};

function liftAtZoom(
  zoom: number,
  view = DESKTOP,
  semanticZoom: GlobeSemanticZoom = "planet",
) {
  return resolveRouteArcLift({
    zoom,
    globeScale: MODE_SCALE * zoom,
    anchorRadius: ROUTE_ANCHOR_RADIUS,
    pixelsPerWorldUnit: view.pixelsPerWorldUnit,
    viewportMinPx: view.viewportMinPx,
    semanticZoom,
  });
}

describe("route arc lift (#193)", () => {
  it("keeps the cinematic geodesic arc at global view", () => {
    expect(liftAtZoom(0.72).liftScale).toBe(1);
    expect(liftAtZoom(1).liftScale).toBe(1);
    expect(liftAtZoom(1).worldLiftAtScale).toBeCloseTo(
      ROUTE_ANCHOR_RADIUS * ROUTE_ARC_HEIGHT_RATIO * MODE_SCALE,
      6,
    );
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
  });

  it("gives a phone a proportionally smaller ceiling", () => {
    const phone = { pixelsPerWorldUnit: DESKTOP.pixelsPerWorldUnit, viewportMinPx: 390 };
    expect(liftAtZoom(1.6, phone).screenLiftCapPx)
      .toBeLessThan(liftAtZoom(1.6).screenLiftCapPx);
    expect(liftAtZoom(1.6, phone).screenLiftPx)
      .toBeLessThanOrEqual(liftAtZoom(1.6).screenLiftPx);
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
