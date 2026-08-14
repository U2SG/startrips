import { describe, expect, it } from "vitest";
import { JOURNEY_CACHE_CONTROL, parseJourneyInput } from "./journeys";

const validJourney = {
  title: "Shenzhen",
  startedOn: "2026-08-13",
  endedOn: null,
  note: "",
  lightColor: "#f4ce73",
  routePoints: [{
    latitude: 22.543096,
    longitude: 114.057865,
    label: "深圳",
    isStop: true,
    occurredAt: null,
  }],
};

describe("parseJourneyInput", () => {
  it("marks private journey reads as non-cacheable", () => {
    expect(JOURNEY_CACHE_CONTROL).toBe("private, no-store, max-age=0");
  });

  it("rejects missing coordinates instead of coercing them to zero", () => {
    expect(parseJourneyInput({
      ...validJourney,
      routePoints: [{
        ...validJourney.routePoints[0],
        latitude: "",
        longitude: "   ",
      }],
    })).toBeNull();
  });

  it("keeps an explicitly entered geographic zero valid", () => {
    expect(parseJourneyInput({
      ...validJourney,
      routePoints: [{
        ...validJourney.routePoints[0],
        latitude: 0,
        longitude: 0,
      }],
    })?.routePoints[0]).toMatchObject({ latitude: 0, longitude: 0 });
  });

  it("accepts inclusive coordinate boundaries and rejects values outside them", () => {
    expect(parseJourneyInput({
      ...validJourney,
      routePoints: [{
        ...validJourney.routePoints[0],
        latitude: -90,
        longitude: 180,
      }],
    })?.routePoints[0]).toMatchObject({ latitude: -90, longitude: 180 });

    expect(parseJourneyInput({
      ...validJourney,
      routePoints: [{
        ...validJourney.routePoints[0],
        latitude: 90.000001,
      }],
    })).toBeNull();
  });

  it("accepts unique persisted route point ids and rejects invalid or duplicate ids", () => {
    const pointId = "11111111-1111-4111-8111-111111111111";
    expect(parseJourneyInput({
      ...validJourney,
      routePoints: [{ ...validJourney.routePoints[0], id: pointId }],
    })?.routePoints[0].id).toBe(pointId);
    expect(parseJourneyInput({
      ...validJourney,
      routePoints: [{ ...validJourney.routePoints[0], id: "not-a-uuid" }],
    })).toBeNull();
    expect(parseJourneyInput({
      ...validJourney,
      routePoints: [
        { ...validJourney.routePoints[0], id: pointId },
        { ...validJourney.routePoints[0], id: pointId },
      ],
    })).toBeNull();
  });

  it("accepts only positive integer journey revisions", () => {
    expect(parseJourneyInput({ ...validJourney, revision: 2 })?.revision).toBe(2);
    expect(parseJourneyInput({ ...validJourney, revision: 0 })).toBeNull();
    expect(parseJourneyInput({ ...validJourney, revision: 1.5 })).toBeNull();
  });
});
