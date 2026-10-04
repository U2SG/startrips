import { describe, expect, it } from "vitest";
import {
  earthDiveSpatialRevealProgress,
  formatEarthDiveRevealStyle,
  resolveEarthDiveRevealGeometry,
  writeChangedEarthDiveRevealStyle,
} from "./earthDiveReveal";

const local = (localProgress: number) => ({
  level: "local" as const,
  zoom: 3,
  localProgress,
});

describe("earthDiveSpatialRevealProgress", () => {
  it("uses semantic local progress instead of a second clock", () => {
    expect(earthDiveSpatialRevealProgress("particle", local(1))).toBe(0);
    expect(earthDiveSpatialRevealProgress("prewarm", local(1))).toBe(0);
    expect(earthDiveSpatialRevealProgress("blending", local(0.45))).toBe(0);
    expect(earthDiveSpatialRevealProgress("blending", local(0.55))).toBeCloseTo(0.5);
    expect(earthDiveSpatialRevealProgress("blending", local(0.65))).toBe(1);
    expect(earthDiveSpatialRevealProgress("detail", local(0.2))).toBe(1);
  });

  it("keeps the keyboard/fallback command on the existing full-frame blend", () => {
    expect(earthDiveSpatialRevealProgress("blending", {
      level: "planet", zoom: 1, localProgress: 0,
    })).toBeNull();
    expect(resolveEarthDiveRevealGeometry(
      { anchor: { lat: 0, lon: 0 }, screen: { x: 50, y: 50 }, pxPerDegreeLat: 10 },
      { left: 0, top: 0, width: 100, height: 100 },
      "blending",
      { level: "planet", zoom: 1, localProgress: 0 },
    )).toBeNull();
  });
});

describe("resolveEarthDiveRevealGeometry", () => {
  it("converts the viewport anchor into layer-local geometry", () => {
    const geometry = resolveEarthDiveRevealGeometry(
      { anchor: { lat: 22.3, lon: 114.2 }, screen: { x: 420, y: 310 }, pxPerDegreeLat: 10 },
      { left: 100, top: 60, width: 800, height: 600 },
      "blending",
      local(0.55),
    );
    expect(geometry?.anchorX).toBe(320);
    expect(geometry?.anchorY).toBe(250);
    expect(geometry?.progress).toBeCloseTo(0.5);
    expect(geometry?.edgeRadius).toBeGreaterThan(geometry?.coreRadius ?? Infinity);
  });

  it("fully covers every corner at committed progress", () => {
    const bounds = { left: 0, top: 0, width: 1000, height: 700 };
    const geometry = resolveEarthDiveRevealGeometry(
      { anchor: { lat: 0, lon: 0 }, screen: { x: 180, y: 220 }, pxPerDegreeLat: 10 },
      bounds,
      "detail",
      local(1),
    );
    expect(geometry).not.toBeNull();
    const farthestCorner = Math.max(
      Math.hypot(180, 220),
      Math.hypot(820, 220),
      Math.hypot(180, 480),
      Math.hypot(820, 480),
    );
    expect(geometry?.coreRadius).toBeCloseTo(farthestCorner);
    expect(geometry?.edgeRadius).toBeGreaterThan(farthestCorner);
  });

  it("refuses invalid frames and preserves offscreen anchor direction", () => {
    expect(resolveEarthDiveRevealGeometry(null, { left: 0, top: 0, width: 10, height: 10 }, "blending", local(.5)))
      .toBeNull();
    const geometry = resolveEarthDiveRevealGeometry(
      { anchor: { lat: 0, lon: 0 }, screen: { x: -20, y: 80 }, pxPerDegreeLat: 10 },
      { left: 0, top: 0, width: 100, height: 100 },
      "blending",
      local(.55),
    );
    expect(geometry?.anchorX).toBe(-20);
    expect(geometry?.anchorY).toBe(80);
  });
});

describe("writeChangedEarthDiveRevealStyle", () => {
  const stubStyle = () => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    return {
      values,
      writes,
      getPropertyValue: (name: string) => values.get(name) ?? "",
      setProperty: (name: string, value: string | null) => {
        writes.push(name);
        values.set(name, value ?? "");
      },
    };
  };
  const geometry = { anchorX: 120.004, anchorY: 80, coreRadius: 300.5, edgeRadius: 384.5, progress: 0.5 };

  it("serialises geometry at the precision the mask consumes", () => {
    expect(formatEarthDiveRevealStyle(geometry)).toEqual([
      ["--earth-dive-reveal-x", "120.00px"],
      ["--earth-dive-reveal-y", "80.00px"],
      ["--earth-dive-reveal-core-radius", "300.50px"],
      ["--earth-dive-reveal-edge-radius", "384.50px"],
      ["--earth-dive-reveal-progress", "0.500"],
    ]);
  });

  it("writes every property once, then only the ones whose value changed", () => {
    const style = stubStyle();
    expect(writeChangedEarthDiveRevealStyle(style, formatEarthDiveRevealStyle(geometry))).toBe(5);
    expect(writeChangedEarthDiveRevealStyle(style, formatEarthDiveRevealStyle({ ...geometry, anchorX: 120.001 }))).toBe(0);
    style.writes.length = 0;
    expect(writeChangedEarthDiveRevealStyle(style, formatEarthDiveRevealStyle({ ...geometry, progress: 0.75 }))).toBe(1);
    expect(style.writes).toEqual(["--earth-dive-reveal-progress"]);
    expect(style.values.get("--earth-dive-reveal-progress")).toBe("0.750");
  });

  it("rewrites a property another branch removed", () => {
    const style = stubStyle();
    writeChangedEarthDiveRevealStyle(style, formatEarthDiveRevealStyle(geometry));
    style.values.delete("--earth-dive-reveal-progress");
    style.writes.length = 0;
    expect(writeChangedEarthDiveRevealStyle(style, formatEarthDiveRevealStyle(geometry))).toBe(1);
    expect(style.writes).toEqual(["--earth-dive-reveal-progress"]);
  });
});
