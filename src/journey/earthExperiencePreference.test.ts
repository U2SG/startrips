import { describe, expect, it } from "vitest";
import {
  DEFAULT_EARTH_EXPERIENCE,
  EARTH_EXPERIENCE_PREFERENCES,
  isEarthExperiencePreference,
} from "./earthExperiencePreference";

describe("Earth experience preference contract", () => {
  it("documents exactly the two persisted values", () => {
    expect(EARTH_EXPERIENCE_PREFERENCES).toEqual(["default", "particle-only"]);
    expect(DEFAULT_EARTH_EXPERIENCE).toBe("default");
  });

  it("accepts every documented value", () => {
    for (const value of EARTH_EXPERIENCE_PREFERENCES) {
      expect(isEarthExperiencePreference(value)).toBe(true);
    }
  });

  it("fails closed on anything else, without normalizing", () => {
    // Casing and whitespace variants are refused rather than repaired: a
    // client sending one has a bug, and guessing would let two spellings of
    // the same intent reach persistence.
    for (const value of [
      "Particle-Only",
      "PARTICLE-ONLY",
      " particle-only",
      "particle-only ",
      "particle_only",
      "particle",
      "detail",
      "",
      null,
      undefined,
      0,
      1,
      true,
      {},
      [],
      ["particle-only"],
    ]) {
      expect(isEarthExperiencePreference(value)).toBe(false);
    }
  });
});
