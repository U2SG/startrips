import { describe, expect, it, vi } from "vitest";
import { createJourney, listJourneys, searchLocations } from "./journeyApi";

describe("journeyApi", () => {
  it("uses the credentialed tenant-scoped memory endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({ journeys: [] })) as unknown as typeof fetch;
    await expect(listJourneys(fetcher)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledWith("/api/journeys", expect.objectContaining({
      credentials: "include",
    }));
  });

  it("preserves structured server errors", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: "INVALID_JOURNEY", message: "Invalid journey data" },
      { status: 400 },
    )) as unknown as typeof fetch;
    const request = createJourney({
      title: "A",
      startedOn: "2026-08-11",
      endedOn: null,
      note: "",
      lightColor: "#f4ce73",
      routePoints: [{
        latitude: 1.3521,
        longitude: 103.8198,
        label: "",
        isStop: false,
        occurredAt: null,
      }],
    }, fetcher);
    await expect(request).rejects.toMatchObject({
      status: 400,
      code: "INVALID_JOURNEY",
      message: "Invalid journey data",
    });
  });

  it("preserves precise location results and provider attribution", async () => {
    const response = {
      results: [{
        id: "node:456",
        label: "National Gallery Singapore",
        context: "St Andrew's Road, Singapore",
        countryCode: "SG",
        latitude: 1.2905434,
        longitude: 103.8515221,
      }],
      attribution: {
        label: "© OpenStreetMap contributors",
        url: "https://www.openstreetmap.org/copyright",
      },
    };
    const fetcher = vi.fn(async () => Response.json(response)) as unknown as typeof fetch;

    await expect(searchLocations("National Gallery Singapore", fetcher)).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/locations/search?q=National%20Gallery%20Singapore",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
