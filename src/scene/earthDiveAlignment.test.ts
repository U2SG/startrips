import { describe, expect, it } from "vitest";
import {
  particleAnchorFrameMatchesSemanticZoom,
  resolveEarthDiveAlignment,
} from "./earthDiveAlignment";

const frame = (x: number, y: number, scale: number) => ({
  screen: { x, y },
  pxPerDegreeLat: scale,
});

describe("resolveEarthDiveAlignment", () => {
  it("accepts the shared #252 anchor/scale tolerances", () => {
    expect(resolveEarthDiveAlignment(frame(100, 100, 120), frame(101, 100.5, 122))?.aligned).toBe(true);
  });

  it("holds ownership when either anchor or scale has not caught up", () => {
    expect(resolveEarthDiveAlignment(frame(100, 100, 120), frame(103, 100, 120))?.aligned).toBe(false);
    expect(resolveEarthDiveAlignment(frame(100, 100, 120), frame(100, 100, 124))?.aligned).toBe(false);
  });

  it("returns null for an unavailable published frame so callers can preserve the unfocused fallback", () => {
    expect(resolveEarthDiveAlignment(null, frame(100, 100, 120))).toBeNull();
    expect(resolveEarthDiveAlignment(frame(100, 100, 0), frame(100, 100, 120))).toBeNull();
  });
});


describe("particleAnchorFrameMatchesSemanticZoom", () => {
  it("rejects an older anchor frame paired with a newer semantic zoom snapshot", () => {
    const particle = {
      anchor: { lat: 22, lon: 114 }, screen: { x: 100, y: 100 },
      pxPerDegreeLat: 120, zoom: 2.7,
    };
    expect(particleAnchorFrameMatchesSemanticZoom(particle, {
      level: "local", zoom: 2.7, localProgress: .33,
    })).toBe(true);
    expect(particleAnchorFrameMatchesSemanticZoom(particle, {
      level: "local", zoom: 2.74, localProgress: .42,
    })).toBe(false);
    expect(particleAnchorFrameMatchesSemanticZoom({ ...particle, zoom: undefined }, {
      level: "local", zoom: 2.7, localProgress: .33,
    })).toBe(false);
  });
});
