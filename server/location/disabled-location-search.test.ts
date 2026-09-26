import { describe, expect, it } from "vitest";
import { DisabledLocationSearch } from "./disabled-location-search";
import { LocationSearchUnavailableError } from "./location-search";

describe("DisabledLocationSearch", () => {
  it("stays truthfully unavailable with or without a search focus", async () => {
    const search = new DisabledLocationSearch();

    await expect(search.search("Palace", { limit: 8 })).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
    await expect(search.search("Palace", {
      limit: 8,
      focus: { latitude: 39.9, longitude: 116.41 },
    })).rejects.toBeInstanceOf(LocationSearchUnavailableError);
  });
});
