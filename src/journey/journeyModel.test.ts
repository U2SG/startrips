import { describe, expect, it } from "vitest";
import {
  groupJourneysByYear,
  sortJourneysChronologically,
  validateJourneyFiles,
  validateJourneyInput,
} from "./journeyModel";
import type { Journey, JourneyInput } from "./types";

function input(overrides: Partial<JourneyInput> = {}): JourneyInput {
  return {
    title: "Across the island",
    startedOn: "2026-08-11",
    endedOn: "2026-08-12",
    note: "",
    lightColor: "#f4ce73",
    routePoints: [
      {
        latitude: 1.3521,
        longitude: 103.8198,
        label: "",
        isStop: false,
        occurredAt: null,
      },
    ],
    ...overrides,
  };
}

function journey(id: string, startedOn: string): Journey {
  const createdAt = `${startedOn}T00:00:00Z`;
  return {
    id,
    atlasId: "atlas-1",
    title: id,
    startedOn,
    endedOn: null,
    note: "",
    lightColor: "#f4ce73",
    createdByUserId: "user-1",
    createdAt,
    updatedAt: createdAt,
    routePoints: [],
    media: [],
  };
}

describe("journeyModel", () => {
  it("sorts journeys by start date without mutating input", () => {
    const journeys = [journey("later", "2026-08-11"), journey("first", "2024-01-02")];
    expect(sortJourneysChronologically(journeys).map((item) => item.id)).toEqual([
      "first",
      "later",
    ]);
    expect(journeys.map((item) => item.id)).toEqual(["later", "first"]);
    expect(groupJourneysByYear(journeys).map((group) => group.year)).toEqual([2024, 2026]);
  });

  it("accepts a single unnamed point and a multi-city route", () => {
    expect(validateJourneyInput(input()).accepted).toBe(true);
    expect(validateJourneyInput(input({
      routePoints: [
        { latitude: 31.2304, longitude: 121.4737, label: "上海", isStop: true, occurredAt: "2026-08-11T01:00:00Z" },
        { latitude: 30.2741, longitude: 120.1551, label: "", isStop: false, occurredAt: "2026-08-11T05:00:00Z" },
        { latitude: 29.8683, longitude: 121.544, label: "宁波", isStop: true, occurredAt: "2026-08-11T09:00:00Z" },
      ],
    }))).toEqual({ accepted: true, errors: [] });
  });

  it("rejects invalid ranges, unlabeled stops, and reversed point times", () => {
    const result = validateJourneyInput(input({
      endedOn: "2026-08-10",
      routePoints: [
        { latitude: 1, longitude: 1, label: "", isStop: true, occurredAt: "2026-08-11T10:00:00Z" },
        { latitude: 2, longitude: 2, label: "", isStop: false, occurredAt: "2026-08-11T09:00:00Z" },
      ],
    }));
    expect(result.accepted).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  it("rejects excessive, empty, oversized, and unsupported media", () => {
    const excessive = Array.from({ length: 13 }, (_, index) => ({
      name: `${index}.jpg`,
      type: "image/jpeg",
      size: 10,
    }));
    expect(validateJourneyFiles(excessive).accepted).toBe(false);
    const invalid = validateJourneyFiles([
      { name: "empty.jpg", type: "image/jpeg", size: 0 },
      { name: "notes.txt", type: "text/plain", size: 20 },
      { name: "huge.mp4", type: "video/mp4", size: 2_000_000_001 },
    ]);
    expect(invalid.errors).toHaveLength(3);
  });
});
