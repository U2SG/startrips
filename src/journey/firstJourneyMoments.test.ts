import { describe, expect, it } from "vitest";
import { createArrivalBloomScope, isFirstJourneyArrival, isFirstJourneyMedia } from "./firstJourneyMoments";

describe("isFirstJourneyArrival", () => {
  it("is true only for an arrival into an empty Atlas", () => {
    expect(isFirstJourneyArrival({ journeyCountBeforeSave: 0, arrivalJourneyId: "j1" })).toBe(true);
  });

  it("is false when the Atlas already had a Journey", () => {
    expect(isFirstJourneyArrival({ journeyCountBeforeSave: 1, arrivalJourneyId: "j2" })).toBe(false);
  });

  it("is false without an arrival handoff (edit, media retry)", () => {
    expect(isFirstJourneyArrival({ journeyCountBeforeSave: 0, arrivalJourneyId: null })).toBe(false);
  });
});

describe("isFirstJourneyMedia", () => {
  it("is true when an empty Journey receives its first uploaded media", () => {
    expect(isFirstJourneyMedia({ mediaCountBeforeUpload: 0, uploadedCount: 2, retry: false })).toBe(true);
  });

  it("is false when the Journey already had media", () => {
    expect(isFirstJourneyMedia({ mediaCountBeforeUpload: 3, uploadedCount: 1, retry: false })).toBe(false);
  });

  it("is false when nothing was uploaded", () => {
    expect(isFirstJourneyMedia({ mediaCountBeforeUpload: 0, uploadedCount: 0, retry: false })).toBe(false);
  });

  it("is false for a retry", () => {
    expect(isFirstJourneyMedia({ mediaCountBeforeUpload: 0, uploadedCount: 1, retry: true })).toBe(false);
  });
});

describe("createArrivalBloomScope", () => {
  it("gives every Atlas owner mount its own scope", () => {
    expect(createArrivalBloomScope()).not.toBe(createArrivalBloomScope());
  });
});
