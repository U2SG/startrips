import { describe, expect, it, vi } from "vitest";
import { createJourney, listJourneys } from "./journeyApi";

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
});
