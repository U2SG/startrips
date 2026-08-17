import { describe, expect, it, vi } from "vitest";
import {
  createJourney,
  deleteJourney,
  deleteMedia,
  listJourneys,
  restoreJourney,
  searchLocations,
  updateJourney,
} from "./journeyApi";

const input = {
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
};

describe("journeyApi", () => {
  it("uses the credentialed tenant-scoped memory endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({ journeys: [] })) as unknown as typeof fetch;
    await expect(listJourneys(fetcher)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledWith("/api/journeys", expect.objectContaining({
      cache: "no-store",
      credentials: "include",
    }));
  });

  it("preserves structured server errors", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: "INVALID_JOURNEY", message: "Invalid journey data" },
      { status: 400 },
    )) as unknown as typeof fetch;
    const request = createJourney(input, fetcher);
    await expect(request).rejects.toMatchObject({
      status: 400,
      code: "INVALID_JOURNEY",
      message: "Invalid journey data",
    });
  });

  it("updates a tenant-scoped journey with PATCH", async () => {
    const journey = { id: "journey-1", ...input, routePoints: [], media: [] };
    const fetcher = vi.fn(async () => Response.json({ journey })) as unknown as typeof fetch;
    const updateInput = { ...input, revision: 3 };

    await expect(updateJourney("journey-1", updateInput, fetcher)).resolves.toEqual(journey);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/journeys/journey-1",
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        body: JSON.stringify(updateInput),
      }),
    );
  });

  it("deletes a tenant-scoped journey with DELETE", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(deleteJourney("journey-1", fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/journeys/journey-1",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
      }),
    );
  });

  it("deletes a private media asset with DELETE", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(deleteMedia("asset-1", fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/uploads/assets/asset-1",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
      }),
    );
  });

  it("restores a recoverable journey with POST", async () => {
    const journey = { id: "journey-1", ...input, routePoints: [], media: [] };
    const fetcher = vi.fn(async () => Response.json({ journey })) as unknown as typeof fetch;

    await expect(restoreJourney("journey-1", fetcher)).resolves.toEqual(journey);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/journeys/journey-1/restore",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
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
