import { describe, expect, it, vi } from "vitest";
import {
  importJourneyRecordedTrack,
  JourneyRecordedTrackApiError,
  listJourneyRecordedTracks,
  withdrawJourneyRecordedTrack,
} from "./journeyRecordedTracksApi";

const operation = {
  journeyId: "journey-1",
  operationKey: "opaque-operation-key",
  source: "imported-file",
  provenance: "gpx",
  segments: [{
    id: "segment-1",
    segmentOrder: 0,
    sampleCount: 2,
    samples: [
      { id: "sample-1", latitude: 22.5, longitude: 114, recordedAt: "2026-09-21T08:00:00.000Z" },
      { id: "sample-2", latitude: 22.6, longitude: 114.1, recordedAt: "2026-09-21T08:05:00.000Z" },
    ],
  }],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("journeyRecordedTracksApi", () => {
  it.each([
    [201, false],
    [200, true],
  ] as const)("preserves %s import semantics and collapses precise samples", async (status, replayed) => {
    const fetchMock = vi.fn(async () => jsonResponse({
      imported: { format: "gpx", replayed, recordedTrack: operation },
    }, status));
    const fetcher = fetchMock as unknown as typeof fetch;

    const result = await importJourneyRecordedTrack("journey 1", "<gpx />", { fetcher });

    expect(result).toEqual({
      status,
      replayed,
      format: "gpx",
      recordedTrack: {
        journeyId: "journey-1",
        operationKey: "opaque-operation-key",
        source: "imported-file",
        provenance: "gpx",
        segmentCount: 1,
        sampleCount: 2,
        startedAt: "2026-09-21T08:00:00.000Z",
        endedAt: "2026-09-21T08:05:00.000Z",
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/journey-recorded-tracks/journey%201/imports");
    expect(JSON.parse(String(init.body))).toEqual({ format: "gpx", document: "<gpx />" });
    expect(url).not.toContain("opaque-operation-key");
    expect(url).not.toContain("%3Cgpx");
  });

  it("keeps an uncertain outcome retryable with the same bytes and accepts the server replay", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network interrupted after request dispatch"))
      .mockResolvedValueOnce(jsonResponse({
        imported: { format: "gpx", replayed: true, recordedTrack: operation },
      }, 200));
    const fetcher = fetchMock as unknown as typeof fetch;

    await expect(importJourneyRecordedTrack("journey-1", "same bytes", { fetcher }))
      .rejects.toThrow("network interrupted after request dispatch");
    await expect(importJourneyRecordedTrack("journey-1", "same bytes", { fetcher }))
      .resolves.toMatchObject({ status: 200, replayed: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body)
      .toBe((fetchMock.mock.calls[1]?.[1] as RequestInit).body);
  });

  it("reads batches without exposing precise coordinates in the returned model", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ recordedTracks: [operation] })) as unknown as typeof fetch;

    const result = await listJourneyRecordedTracks("journey-1", { fetcher });

    expect(result[0]).toMatchObject({ segmentCount: 1, sampleCount: 2 });
    expect(JSON.stringify(result)).not.toContain("22.5");
    expect(JSON.stringify(result)).not.toContain("114");
  });

  it("summarizes unsorted segments while preserving declared counts and wire-string time order", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ recordedTracks: [{
      ...operation,
      segments: [
        { sampleCount: 9, samples: [
          { recordedAt: "2026-09-21T10:00:00+03:00" },
          { recordedAt: null },
          { recordedAt: "" },
        ] },
        { samples: [
          { recordedAt: "2026-09-21T08:00:00Z" },
          { recordedAt: "2026-09-21T10:00:00+03:00" },
        ] },
        { sampleCount: 0, samples: [{ recordedAt: "2026-09-21T09:00:00Z" }] },
        { sampleCount: 3 },
        {},
      ],
    }] })) as unknown as typeof fetch;

    expect(await listJourneyRecordedTracks("journey-1", { fetcher })).toEqual([{
      journeyId: operation.journeyId,
      operationKey: operation.operationKey,
      source: operation.source,
      provenance: operation.provenance,
      segmentCount: 5,
      sampleCount: 14,
      startedAt: "2026-09-21T08:00:00Z",
      endedAt: "2026-09-21T10:00:00+03:00",
    }]);
  });

  it.each([
    { name: "no segments", segments: [], sampleCount: 0 },
    { name: "declared count without samples", segments: [{ sampleCount: 4 }], sampleCount: 4 },
    { name: "untimed samples", segments: [{ samples: [
      {}, { recordedAt: null }, { recordedAt: "" },
    ] }], sampleCount: 3 },
  ])("keeps unknown time coverage null for $name", async ({ segments, sampleCount }) => {
    const fetcher = vi.fn(async () => jsonResponse({
      recordedTracks: [{ ...operation, segments }],
    })) as unknown as typeof fetch;

    expect(await listJourneyRecordedTracks("journey-1", { fetcher })).toEqual([{
      journeyId: operation.journeyId,
      operationKey: operation.operationKey,
      source: operation.source,
      provenance: operation.provenance,
      segmentCount: segments.length,
      sampleCount,
      startedAt: null,
      endedAt: null,
    }]);
  });

  it("sends withdrawal operationKey only in the DELETE JSON body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ deleted: true }));
    const fetcher = fetchMock as unknown as typeof fetch;

    await withdrawJourneyRecordedTrack("journey-1", "opaque-operation-key", { fetcher });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/journey-recorded-tracks/journey-1");
    expect(url).not.toContain("opaque-operation-key");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ operationKey: "opaque-operation-key" });
  });

  it.each([
    [400, "UNSUPPORTED_FORMAT"],
    [400, "MALFORMED_FILE"],
    [413, "FILE_TOO_LARGE"],
    [409, "RECORDED_TRACK_CONFLICT"],
    [404, "JOURNEY_NOT_FOUND"],
  ])("preserves server refusal %s/%s instead of inventing client semantics", async (status, code) => {
    const fetcher = vi.fn(async () => jsonResponse({ error: code }, status)) as unknown as typeof fetch;

    const failure = importJourneyRecordedTrack("journey-1", "document", { fetcher });
    await expect(failure).rejects.toMatchObject({ status, code } satisfies Partial<JourneyRecordedTrackApiError>);
  });
});
