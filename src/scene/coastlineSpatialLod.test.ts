import { describe, expect, it } from "vitest";
import { GEOGRAPHIC_SURFACE_RADIUS } from "./geo";
import {
  COASTLINE_SPATIAL_VERTEX_BUDGET,
  RefinementCache,
  buildRegionalCoastlinePositions,
  resolveCoastlineRefinementRegion,
  selectRegionalCoastlineRings,
} from "./coastlineSpatialLod";

describe("spatial coastline refinement foundation (#154)", () => {
  it("shares particle refinement region identity, including dateline wrapping", () => {
    expect(resolveCoastlineRefinementRegion({ lat: 22.3, lon: 114.1 }).key).toBe("24:120");
    expect(resolveCoastlineRefinementRegion({ lat: 10, lon: 181 }).key).toBe("12:-180");
  });

  it("keeps only rings relevant to the active local region", () => {
    const region = resolveCoastlineRefinementRegion({ lat: 22.3, lon: 114.1 });
    const hongKong = [[113.8, 22.1], [114.3, 22.4], [114.1, 22.6], [113.8, 22.1]];
    const norway = [[5.3, 60.3], [6.0, 61.0], [7.0, 61.2], [5.3, 60.3]];
    expect(selectRegionalCoastlineRings([hongKong, norway], region)).toEqual([hongKong]);
  });

  it("clips a continent-scale ring to local runs instead of spending near budget on the whole ring", () => {
    const region = resolveCoastlineRefinementRegion({ lat: 22.3, lon: 114.1 });
    const continent = [
      [0, -70], [113.8, 22.1], [114.3, 22.4], [-100, -70], [0, -70],
    ];
    const selected = selectRegionalCoastlineRings([continent], region, 1);
    expect(selected).toEqual([[[113.8, 22.1], [114.3, 22.4]]]);
    expect(selected.flat()).not.toContainEqual([0, -70]);
    expect(selected.flat()).not.toContainEqual([-100, -70]);
  });

  it("uses a wrapped midpoint when a local segment crosses the dateline", () => {
    const region = resolveCoastlineRefinementRegion({ lat: 10, lon: 179.5 });
    const dateline = [[170, 10], [179.8, 10], [-179.8, 10], [-170, 10]];
    const selected = selectRegionalCoastlineRings([dateline], region, 0.5);
    expect(selected.some((run) => run.some(([lon]) => lon === 179.8) && run.some(([lon]) => lon === -179.8))).toBe(true);
  });

  it("uses a bounded local vertex budget instead of scaling with global ring count", () => {
    const region = resolveCoastlineRefinementRegion({ lat: 22.3, lon: 114.1 });
    const ring = Array.from({ length: 50_000 }, (_, index) => [
      113.5 + (index % 200) * 0.005,
      21.5 + ((index * 17) % 200) * 0.005,
    ]);
    ring.push(ring[0]);
    const positions = buildRegionalCoastlinePositions({ rings: [ring], region, quality: "low" });
    expect(positions.length / 3).toBeLessThanOrEqual(COASTLINE_SPATIAL_VERTEX_BUDGET.low);
    expect(positions.length).toBeGreaterThan(0);
  });

  it("builds regional refinement on the canonical geographic surface (#237)", () => {
    const region = resolveCoastlineRefinementRegion({ lat: 22.3, lon: 114.1 });
    const ring = [[113.8, 22.1], [114.3, 22.4], [114.1, 22.6], [113.8, 22.1]];
    const positions = buildRegionalCoastlinePositions({
      rings: [ring],
      region,
      quality: "high",
    });
    expect(positions.length).toBeGreaterThan(0);
    // The default is the constant itself, not a shell that merely happens to
    // equal it today: a refinement chunk that drifted onto its own radius would
    // put the local map somewhere the Place Labels above it are not.
    let maxRadiusError = 0;
    for (let index = 0; index < positions.length; index += 3) {
      const radius = Math.hypot(
        positions[index],
        positions[index + 1],
        positions[index + 2],
      );
      maxRadiusError = Math.max(
        maxRadiusError,
        Math.abs(radius - GEOGRAPHIC_SURFACE_RADIUS),
      );
    }
    expect(maxRadiusError).toBeLessThan(1e-6);
    expect(GEOGRAPHIC_SURFACE_RADIUS).not.toBe(1.405);

    // An explicit radius is still honoured - the change removes the second
    // DEFAULT, it does not take the parameter away from a future caller.
    const explicit = buildRegionalCoastlinePositions({
      rings: [ring],
      region,
      quality: "high",
      radius: 1,
    });
    // Positions are a Float32Array, so the comparison lives at single
    // precision - about 3e-8 here - not at double.
    expect(Math.hypot(explicit[0], explicit[1], explicit[2])).toBeCloseTo(1, 6);
  });

  it("keeps a bounded LRU of recently viewed regions", () => {
    const cache = new RefinementCache<Float32Array>(2);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    expect(cache.get("a")?.[0]).toBe(1);
    cache.set("c", new Float32Array([3]));
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")?.[0]).toBe(1);
    expect(cache.get("c")?.[0]).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("promotes overwritten entries without growing the cache and retains value identity", () => {
    const cache = new RefinementCache<Float32Array>(2);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    const replacement = new Float32Array([3]);
    cache.set("a", replacement);
    expect(cache.size).toBe(2);
    cache.set("c", new Float32Array([4]));
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).toBe(replacement);
  });

  it("leaves eviction order and size unchanged on a miss", () => {
    const cache = new RefinementCache<Float32Array>(2);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    expect(cache.get("missing")).toBeNull();
    expect(cache.size).toBe(2);
    cache.set("c", new Float32Array([3]));
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")?.[0]).toBe(2);
    expect(cache.get("c")?.[0]).toBe(3);
  });

  it("clears retained values and allows the cache to be reused", () => {
    const cache = new RefinementCache<Float32Array>(2);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    const next = new Float32Array([3]);
    cache.set("c", next);
    expect(cache.get("c")).toBe(next);
    expect(cache.size).toBe(1);
  });

  it("keeps values, capacity and lifetime independent between cache instances", () => {
    const first = new RefinementCache<Float32Array>(1);
    const second = new RefinementCache<{ positions: Float32Array }>(2);
    const retained = { positions: new Float32Array([2]) };
    first.set("shared", new Float32Array([1]));
    second.set("shared", retained);
    first.set("next", new Float32Array([3]));
    expect(first.get("shared")).toBeNull();
    expect(second.get("shared")).toBe(retained);
    first.clear();
    expect(first.size).toBe(0);
    expect(second.size).toBe(1);
    expect(second.get("shared")).toBe(retained);
  });
});
