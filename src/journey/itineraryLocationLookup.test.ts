import { describe, expect, it } from "vitest";
import { buildItineraryImportDraft, itineraryDraftEntries } from "./itineraryImport";
import { itineraryLocationQueries, itineraryLocationSuggestion } from "./itineraryLocationLookup";
import type { LocationSearchResult } from "./types";

function entry(
  name: string,
  aliases: string[],
  countryCode: string | null = "US",
  searchArea: string | null = "Cupertino, California",
) {
  const draft = buildItineraryImportDraft({
    contractVersion: 1,
    sourceKind: "link",
    recognizerVersion: "model-test",
    sourceTitle: null,
    sourceReportedDayCount: 1,
    sourceReportedPlaceCount: 1,
    days: [{ dayNumber: 1, sourceDayTitle: null, calendarDate: null, partialDate: "02-11" }],
    entries: [{
      sourceEntryId: null, dayNumber: 1, orderInDay: 1, name, aliases,
      countryCode, searchArea, role: "attraction",
    }],
  }, "test");
  return itineraryDraftEntries(draft)[0];
}

function result(label: string, countryCode: string, latitude: number): LocationSearchResult {
  return {
    id: `${label}:${countryCode}:${latitude}`,
    label, countryCode, latitude, longitude: -122,
    context: countryCode === "US" ? "Cupertino, California, United States" : "Gauteng, South Africa",
  };
}

describe("itinerary location lookup", () => {
  it("tries a known English endonym before the Chinese printed name", () => {
    expect(itineraryLocationQueries(entry("苹果公司总部", ["Apple Park"])))
      .toEqual(["Apple Park Cupertino", "Apple Park", "苹果公司总部"]);
  });

  it("refuses a same-name answer in the wrong country", () => {
    const place = entry("苹果公司总部", ["Apple Park"]);
    expect(itineraryLocationSuggestion(place, [result("Apple Park", "ZA", -26.1)]))
      .toBeNull();
    expect(itineraryLocationSuggestion(place, [
      result("Apple Park", "ZA", -26.1),
      result("Apple Park", "US", 37.33),
    ])?.countryCode).toBe("US");
  });

  it("leaves multiple distant same-name branches for a manual choice", () => {
    const place = entry("Erewhon", [], "US", "Los Angeles, California");
    expect(itineraryLocationSuggestion(place, [
      { ...result("Erewhon", "US", 34.0), context: "Los Angeles, California" },
      { ...result("Erewhon", "US", 34.2), context: "Los Angeles, California" },
    ])).toBeNull();
  });

  it("requires a source country hint before suggesting a bulk confirmation", () => {
    expect(itineraryLocationSuggestion(entry("Apple Park", [], null), [
      result("Apple Park", "US", 37.33),
    ])).toBeNull();
  });

  it("accepts a Hong Kong airport with the provider's CN parent code", () => {
    const airport = entry("香港国际机场", ["Hong Kong International Airport"], "HK", "Hong Kong");
    expect(itineraryLocationSuggestion(airport, [{
      ...result("Hong Kong International Airport", "CN", 22.31),
      context: "香港 Hong Kong, 中国",
    }])?.latitude).toBe(22.31);
  });

  it("refuses the right name and country in the wrong city", () => {
    const square = entry("联合广场", ["Union Square"], "US", "San Francisco, California");
    expect(itineraryLocationSuggestion(square, [{
      ...result("Union Square", "US", 40.7), context: "Manhattan, New York, United States",
    }])).toBeNull();
    expect(itineraryLocationSuggestion(square, [{
      ...result("Union Square", "US", 37.78), context: "San Francisco, California, United States",
    }])?.latitude).toBe(37.78);
  });

  it("does not read North Las Vegas as Las Vegas for a generic place name", () => {
    const strip = entry("拉斯维加斯大道", ["The Strip"], "US", "Las Vegas, Nevada");
    expect(itineraryLocationSuggestion(strip, [{
      ...result("The Strip", "US", 36.3),
      context: "North Las Vegas, Clark, Nevada, United States",
    }])).toBeNull();
  });
});
