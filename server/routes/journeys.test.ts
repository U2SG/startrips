import { describe, expect, it } from "vitest";
import { parseJourneyInput } from "./journeys";

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
});
