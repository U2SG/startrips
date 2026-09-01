import { describe, expect, it } from "vitest";
import {
  PARTICLE_BASE_LAND_SOURCE,
  PARTICLE_REFINEMENT_CAPS,
  PARTICLE_REFINEMENT_LAND_SOURCE,
  ParticleRefinementBuildGuard,
  buildRegionalLandSample,
  resolveParticleRefinementLod,
  resolveParticleRefinementLodForFrame,
  resolveParticleRefinementRegion,
  shouldCancelPendingRefinementRequest,
} from "./particleSpatialLod";

describe("particle spatial LOD", () => {
  it("keeps a light global source but uses a finer source for high-zoom refinement", () => {
    expect(PARTICLE_BASE_LAND_SOURCE).toEqual({
      path: "/earth/ne_110m_land.geojson",
      vectorScale: "110m",
      maskWidth: 720,
      maskHeight: 360,
      maskDegreesPerPixel: 0.5,
    });
    expect(PARTICLE_REFINEMENT_LAND_SOURCE).toEqual({
      path: "/earth/ne_50m_land.geojson",
      vectorScale: "50m",
      maskWidth: 1440,
      maskHeight: 720,
      maskDegreesPerPixel: 0.25,
    });
    expect(PARTICLE_REFINEMENT_LAND_SOURCE.maskDegreesPerPixel)
      .toBeLessThan(PARTICLE_BASE_LAND_SOURCE.maskDegreesPerPixel);
  });

  it("increases active local samples at 1x, 2x, and 3x while respecting quality caps", () => {
    const highCounts = [1, 2, 3].map(
      (zoom) => resolveParticleRefinementLod(zoom, "high").activeCount,
    );
    const lowCounts = [1, 2, 3].map(
      (zoom) => resolveParticleRefinementLod(zoom, "low").activeCount,
    );
    expect(highCounts[0]).toBe(0);
    expect(highCounts[1]).toBeGreaterThan(highCounts[0]);
    expect(highCounts[2]).toBeGreaterThan(highCounts[1]);
    expect(highCounts[2]).toBe(PARTICLE_REFINEMENT_CAPS.high);
    expect(lowCounts[2]).toBe(PARTICLE_REFINEMENT_CAPS.low);
    expect(lowCounts[2]).toBeLessThan(highCounts[2]);
  });


  it("freezes particle LOD during any focus flight and resolves after arrival", () => {
    const current = resolveParticleRefinementLod(3, "high");
    const flying = resolveParticleRefinementLodForFrame({
      zoom: 1.1,
      quality: "high",
      current,
      focusFlightActive: true,
    });
    expect(flying).toBe(current);
    expect(flying.activeCount).toBe(current.activeCount);

    const arrived = resolveParticleRefinementLodForFrame({
      zoom: 1.1,
      quality: "high",
      current,
      focusFlightActive: false,
    });
    expect(arrived).not.toBe(current);
    expect(arrived.activeCount).toBe(0);
  });

  it("cancels a different pending region when the view returns to the active region", () => {
    expect(shouldCancelPendingRefinementRequest({
      activeCacheKey: "high:A",
      requestedCacheKey: "high:B",
      targetCacheKey: "high:A",
    })).toBe(true);
    expect(shouldCancelPendingRefinementRequest({
      activeCacheKey: "high:A",
      requestedCacheKey: "high:A",
      targetCacheKey: "high:A",
    })).toBe(false);
    expect(shouldCancelPendingRefinementRequest({
      activeCacheKey: "high:A",
      requestedCacheKey: null,
      targetCacheKey: "high:A",
    })).toBe(false);
  });
  it("quantizes nearby views to a reusable bounded region", () => {
    const first = resolveParticleRefinementRegion({ lat: 1.1, lon: 103.8 });
    const nearby = resolveParticleRefinementRegion({ lat: 3.9, lon: 106.1 });
    const distant = resolveParticleRefinementRegion({ lat: 25, lon: 140 });
    expect(nearby.key).toBe(first.key);
    expect(distant.key).not.toBe(first.key);
    expect(first.radiusDegrees).toBeLessThan(50);
  });

  it("builds deterministic stable thresholds inside the spherical region", async () => {
    const region = resolveParticleRefinementRegion({ lat: 35, lon: 139 });
    const options = {
      region,
      count: 128,
      isLand: () => true,
      shouldContinue: () => true,
      yieldControl: async () => {},
    };
    const first = await buildRegionalLandSample(options);
    const second = await buildRegionalLandSample(options);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect([...first!.positions]).toEqual([...second!.positions]);
    expect([...first!.lodThresholds]).toEqual([...second!.lodThresholds]);
    expect(first!.lodThresholds[0]).toBeLessThan(first!.lodThresholds[127]);

    const centerLat = region.center.lat * Math.PI / 180;
    const centerLon = region.center.lon * Math.PI / 180;
    const center = [
      Math.cos(centerLat) * Math.cos(centerLon),
      Math.sin(centerLat),
      -Math.cos(centerLat) * Math.sin(centerLon),
    ];
    const minimumAlignment = Math.cos(region.radiusDegrees * Math.PI / 180) - 1e-6;
    for (let index = 0; index < first!.positions.length; index += 3) {
      const radius = Math.hypot(
        first!.positions[index],
        first!.positions[index + 1],
        first!.positions[index + 2],
      );
      const alignment = (
        first!.positions[index] * center[0]
        + first!.positions[index + 1] * center[1]
        + first!.positions[index + 2] * center[2]
      ) / radius;
      expect(alignment).toBeGreaterThanOrEqual(minimumAlignment);
    }
  });

  it("cooperatively cancels a regional sample when its revision becomes stale", async () => {
    let current = true;
    let yields = 0;
    const sample = await buildRegionalLandSample({
      region: resolveParticleRefinementRegion({ lat: 0, lon: 0 }),
      count: 512,
      isLand: () => false,
      shouldContinue: () => current,
      batchAttempts: 32,
      yieldControl: async () => {
        yields += 1;
        current = false;
      },
    });
    expect(sample).toBeNull();
    expect(yields).toBe(1);
  });

  it("rejects stale, hidden, and disposed build tickets", () => {
    const guard = new ParticleRefinementBuildGuard();
    const first = guard.request("region-a");
    const second = guard.request("region-b");
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);

    guard.setVisible(false);
    expect(guard.isCurrent(second)).toBe(false);
    const hidden = guard.request("region-c");
    expect(guard.isCurrent(hidden)).toBe(false);

    guard.setVisible(true);
    const visible = guard.request("region-c");
    expect(guard.isCurrent(visible)).toBe(true);
    guard.dispose();
    expect(guard.isCurrent(visible)).toBe(false);
  });
});
