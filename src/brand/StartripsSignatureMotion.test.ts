import { describe, expect, it } from "vitest";
import { starPoseTransform } from "./StartripsSignatureMotion";

describe("Startrips signature star transform", () => {
  it("scales the authored i-dot star around its own center", () => {
    expect(starPoseTransform({ starX: 6, starY: -4, starScale: 0.9 })).toBe(
      "translate(6.000 -4.000) translate(417.408 -105.264) scale(0.9000) translate(-417.408 105.264)",
    );
  });
});
