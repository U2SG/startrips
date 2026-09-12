import { describe, expect, it, vi } from "vitest";
import {
  createHomeBasePeriod,
  createJourney,
  deleteJourney,
  deleteMedia,
  listHomeBasePeriods,
  listJourneys,
  moveJourneyMedia,
  moveMediaBetweenJourneys,
  undoMediaMove,
  undoJourneyMediaMove,
  readHomeBaseDismissal,
  recordHomeBaseDismissal,
  reorderJourneyMedia,
  restoreJourney,
  reverseGeocode,
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

  it("reads owner-private Home Base periods from the existing credentialed endpoint", async () => {
    const periods = [{
      id: "home-1", startedOn: "2020-01-01", endedOn: null, label: "深圳", latitude: 22.5431, longitude: 114.0579, source: "manual",
    }];
    const fetcher = vi.fn(async () => Response.json({ periods })) as unknown as typeof fetch;
    await expect(listHomeBasePeriods(fetcher)).resolves.toEqual(periods);
    expect(fetcher).toHaveBeenCalledWith("/api/home-bases", expect.objectContaining({
      cache: "no-store", credentials: "include",
    }));
  });

  it("confirms a first Home Base suggestion by creating a period", async () => {
    const period = {
      id: "home-1", label: "深圳", latitude: 22.5431, longitude: 114.0579,
      startedOn: "2026-01-04", endedOn: null, source: "suggested-confirmed",
    };
    const fetcher = vi.fn(async () => Response.json({ period })) as unknown as typeof fetch;
    const draft = {
      label: "深圳",
      latitude: 22.5431,
      longitude: 114.0579,
      startedOn: "2026-01-04",
      endedOn: null,
      source: "suggested-confirmed",
    } as const;
    await expect(createHomeBasePeriod(draft, fetcher)).resolves.toEqual(period);
    expect(fetcher).toHaveBeenCalledWith("/api/home-bases", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify(draft),
    }));
  });

  it("confirms a move by sending the inferred onset as the new period start", async () => {
    // The previous period is closed by #231's own write path at exactly this
    // date; the client never patches or deletes the period it replaces.
    const fetcher = vi.fn(async () => Response.json({
      period: { id: "home-2", startedOn: "2026-05-02", endedOn: null },
    })) as unknown as typeof fetch;
    await createHomeBasePeriod({
      label: "东京",
      latitude: 35.689487,
      longitude: 139.691711,
      startedOn: "2026-05-02",
      endedOn: null,
      source: "suggested-confirmed",
    }, fetcher);
    const [, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(JSON.parse(String(init.body))).toMatchObject({
      startedOn: "2026-05-02",
      endedOn: null,
    });
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it("reads and records the Home Base dismissal without naming an atlas", async () => {
    const dismissal = { kind: "soft", digest: "hbv1:1:2:3", dismissedAt: "2026-04-02" };
    const reader = vi.fn(async () => Response.json({ dismissal })) as unknown as typeof fetch;
    await expect(readHomeBaseDismissal(reader)).resolves.toEqual(dismissal);
    expect(reader).toHaveBeenCalledWith("/api/home-bases/dismissal", expect.objectContaining({
      cache: "no-store", credentials: "include",
    }));

    const writer = vi.fn(async () => Response.json({ dismissal })) as unknown as typeof fetch;
    await expect(recordHomeBaseDismissal({
      kind: "soft", evidenceDigest: "hbv1:1:2:3", dismissedOn: "2026-04-02",
    }, writer)).resolves.toEqual(dismissal);
    const [, init] = (writer as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "soft", evidenceDigest: "hbv1:1:2:3", dismissedOn: "2026-04-02",
    });
    expect(Object.keys(body)).not.toContain("atlasId");
    expect(Object.keys(body)).not.toContain("organizationId");
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

  it("reorders the complete journey media list with POST", async () => {
    const journey = { id: "journey-1", media: [] };
    const fetcher = vi.fn(async () => Response.json({ journey })) as unknown as typeof fetch;

    await expect(reorderJourneyMedia("journey-1", ["asset-2", "asset-1"], fetcher))
      .resolves.toEqual(journey);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/uploads/assets/reorder",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          journeyId: "journey-1",
          assetIds: ["asset-2", "asset-1"],
        }),
      }),
    );
  });

  it("moves a batch of media onto a route point with POST", async () => {
    const journey = { id: "journey-1", media: [] };
    const fetcher = vi.fn(async () => Response.json({ journey })) as unknown as typeof fetch;

    await expect(moveJourneyMedia("journey-1", ["asset-1", "asset-2"], "point-1", fetcher))
      .resolves.toEqual(journey);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/uploads/assets/move",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          journeyId: "journey-1",
          assetIds: ["asset-1", "asset-2"],
          routePointId: "point-1",
        }),
      }),
    );
  });

  it("moves a batch of media back to the whole journey with a null route point", async () => {
    const journey = { id: "journey-1", media: [] };
    const fetcher = vi.fn(async () => Response.json({ journey })) as unknown as typeof fetch;

    await expect(moveJourneyMedia("journey-1", ["asset-1"], null, fetcher))
      .resolves.toEqual(journey);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/uploads/assets/move",
      expect.objectContaining({
        body: JSON.stringify({
          journeyId: "journey-1",
          assetIds: ["asset-1"],
          routePointId: null,
        }),
      }),
    );
  });

  it("moves media between journeys and returns canonical source/destination plus undo", async () => {
    const sourceJourney = { id: "journey-a", media: [] };
    const destinationJourney = { id: "journey-b", media: [] };
    const undo = {
      sourceJourneyId: "journey-a",
      targetJourneyId: "journey-b",
      assetIds: ["asset-1"],
      targetRoutePointId: "point-b",
      sourceOrder: ["asset-1", "asset-2"],
      targetOrder: ["asset-existing", "asset-1"],
      sourceCoverMediaAssetId: "asset-1",
      placements: [{ assetId: "asset-1", routePointId: null }],
    };
    const fetcher = vi.fn(async () => Response.json({ sourceJourney, destinationJourney, undo })) as unknown as typeof fetch;

    await expect(moveMediaBetweenJourneys(
      "journey-a",
      "journey-b",
      ["asset-1"],
      "point-b",
      fetcher,
    )).resolves.toEqual({ sourceJourney, destinationJourney, undo });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/uploads/assets/move",
      expect.objectContaining({
        body: JSON.stringify({
          journeyId: "journey-a",
          targetJourneyId: "journey-b",
          assetIds: ["asset-1"],
          routePointId: "point-b",
        }),
      }),
    );
  });

  it("posts the server-generated descriptor to undo a cross-journey move", async () => {
    const undo = {
      sourceJourneyId: "journey-a",
      targetJourneyId: "journey-b",
      assetIds: ["asset-1"],
      targetRoutePointId: "point-b",
      sourceOrder: ["asset-1", "asset-2"],
      targetOrder: ["asset-existing", "asset-1"],
      sourceCoverMediaAssetId: "asset-1",
      placements: [{ assetId: "asset-1", routePointId: null }],
    };
    const payload = {
      sourceJourney: { id: "journey-a", media: [] },
      destinationJourney: { id: "journey-b", media: [] },
    };
    const fetcher = vi.fn(async () => Response.json(payload)) as unknown as typeof fetch;

    await expect(undoMediaMove(undo, fetcher)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/uploads/assets/move/undo",
      expect.objectContaining({ body: JSON.stringify(undo) }),
    );
  });

  it("undoes a media move with previous assignments and canonical order", async () => {
    const journey = { id: "journey-1", media: [] };
    const fetcher = vi.fn(async () => Response.json({ journey })) as unknown as typeof fetch;
    const undo = {
      journeyId: "journey-1",
      expectedRoutePointId: "point-2",
      assignments: [
        { assetId: "asset-1", routePointId: null },
        { assetId: "asset-2", routePointId: "point-1" },
      ],
      assetOrder: ["asset-1", "asset-3", "asset-2"],
    };

    await expect(undoJourneyMediaMove(undo, fetcher)).resolves.toEqual(journey);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/uploads/assets/move/undo",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify(undo),
      }),
    );
  });

  it("resolves a coordinate to a named place with attribution", async () => {
    const response = {
      result: {
        id: "R:123",
        label: "Shenzhen",
        context: "Guangdong, China",
        countryCode: "CN",
        latitude: 22.5445741,
        longitude: 114.0545429,
      },
      attribution: {
        label: "© OpenStreetMap contributors",
        url: "https://www.openstreetmap.org/copyright",
      },
    };
    const fetcher = vi.fn(async () => Response.json(response)) as unknown as typeof fetch;

    await expect(reverseGeocode(22.5445741, 114.0545429, fetcher)).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/locations/reverse?latitude=22.5445741&longitude=114.0545429",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("bounds reverse geocode so lookup degradation cannot block the composer", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    )) as unknown as typeof fetch;

    await expect(reverseGeocode(22.5, 114, fetcher, 5)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/locations/reverse?latitude=22.5&longitude=114",
      expect.objectContaining({
        credentials: "include",
        signal: expect.any(AbortSignal),
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
