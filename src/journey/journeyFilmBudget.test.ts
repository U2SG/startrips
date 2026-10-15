import { describe, expect, it } from "vitest";
import { estimateJourneyFilmOutputBytes, FILM_AUDIO_BITRATE } from "./journeyFilmBudget";
describe("complete film resource estimate", () => {
  it("scales with actual duration past two minutes without omitting scenes", () => {
    expect(estimateJourneyFilmOutputBytes(180000, false)).toBe(110097152);
    expect(estimateJourneyFilmOutputBytes(180000, true) - estimateJourneyFilmOutputBytes(180000, false))
      .toBe(180 * FILM_AUDIO_BITRATE / 8 * 1.2);
  });
  it.each([NaN, Infinity, 0, -1, Number.MAX_VALUE])("rejects invalid or unbounded estimates: %s", (duration) => {
    expect(() => estimateJourneyFilmOutputBytes(duration, true)).toThrow("journey_film_output_limit");
  });
});
