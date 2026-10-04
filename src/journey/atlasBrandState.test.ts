import { describe, expect, it } from "vitest";
import { motionTokens } from "../motion/tokens";
import { atlasBrandMomentDuration, resolveAtlasBrandState } from "./atlasBrandState";

describe("Atlas wordmark brand state", () => {
  it("rests by default", () => {
    expect(resolveAtlasBrandState({ reduceMotion: false, pending: false, moment: null })).toBe("rest");
  });

  it("plays a one-shot moment once nothing is pending", () => {
    expect(resolveAtlasBrandState({ reduceMotion: false, pending: false, moment: "travel" })).toBe("travel");
    expect(resolveAtlasBrandState({ reduceMotion: false, pending: false, moment: "arrived" })).toBe("arrived");
  });

  it("breathes while a Journey mutation is in flight, holding any moment back", () => {
    expect(resolveAtlasBrandState({ reduceMotion: false, pending: true, moment: null })).toBe("waiting");
    expect(resolveAtlasBrandState({ reduceMotion: false, pending: true, moment: "arrived" })).toBe("waiting");
  });

  it("stays at rest under reduced motion", () => {
    expect(resolveAtlasBrandState({ reduceMotion: true, pending: true, moment: "travel" })).toBe("rest");
    expect(resolveAtlasBrandState({ reduceMotion: true, pending: false, moment: "arrived" })).toBe("rest");
  });

  it("matches the brand-mark.css keyframe durations", () => {
    expect(atlasBrandMomentDuration("travel")).toBe(motionTokens.tiers.content * 1.9);
    expect(atlasBrandMomentDuration("arrived")).toBe(motionTokens.tiers.content * 1.25);
  });
});
