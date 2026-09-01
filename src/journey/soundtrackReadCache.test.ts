import { afterEach, describe, expect, it, vi } from "vitest";

const getPrivateMediaRead = vi.hoisted(() => vi.fn());

vi.mock("./journeyApi", () => ({
  getPrivateMediaRead,
}));

import { cachedSoundtrackRead, prefetchSoundtrackRead } from "./soundtrackReadCache";
import type { Journey } from "./types";

function makeJourney(id: string): Journey {
  return {
    id,
    atlasId: "atlas-1",
    title: "Across the island",
    startedOn: "2026-08-11",
    endedOn: null,
    note: "",
    lightColor: "#f4ce73",
    revision: 1,
    createdByUserId: "user-1",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    routePoints: [],
    media: [{
      id: `track-${id}`,
      journeyId: id,
      routePointId: null,
      storageDriver: "test",
      storageKey: `track-${id}`,
      fileName: "night.mp3",
      mimeType: "audio/mpeg",
      bytes: 64,
      sortOrder: 0,
      uploadedByUserId: "user-1",
      createdAt: "2026-08-11T00:00:00.000Z",
    }],
  };
}

afterEach(() => {
  vi.useRealTimers();
  getPrivateMediaRead.mockReset();
});

describe("soundtrackReadCache", () => {
  it("returns null before any prefetch", () => {
    expect(cachedSoundtrackRead(makeJourney("empty"))).toBeNull();
  });

  it("returns null for a journey without a soundtrack", () => {
    const silent: Journey = { ...makeJourney("silent"), media: [] };
    expect(cachedSoundtrackRead(silent)).toBeNull();
  });

  it("keeps a healthy signed read synchronous without refetching", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const journey = makeJourney("healthy");
    getPrivateMediaRead.mockResolvedValue({
      url: "https://media.example/healthy",
      expiresAt: "2026-09-01T12:02:00.000Z",
    });

    await expect(prefetchSoundtrackRead(journey)).resolves.toBe("https://media.example/healthy");
    vi.setSystemTime(new Date("2026-09-01T12:00:45.000Z"));

    expect(cachedSoundtrackRead(journey)).toEqual({ url: "https://media.example/healthy" });
    await expect(prefetchSoundtrackRead(journey)).resolves.toBe("https://media.example/healthy");
    expect(getPrivateMediaRead).toHaveBeenCalledTimes(1);
  });

  it("refreshes a cached signed read before it enters the playback startup margin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const journey = makeJourney("refresh");
    getPrivateMediaRead
      .mockResolvedValueOnce({
        url: "https://media.example/old",
        expiresAt: "2026-09-01T12:02:00.000Z",
      })
      .mockResolvedValueOnce({
        url: "https://media.example/new",
        expiresAt: "2026-09-01T12:05:00.000Z",
      });

    await prefetchSoundtrackRead(journey);
    vi.setSystemTime(new Date("2026-09-01T12:01:40.000Z"));

    expect(cachedSoundtrackRead(journey)).toBeNull();
    await expect(prefetchSoundtrackRead(journey)).resolves.toBe("https://media.example/new");
    expect(cachedSoundtrackRead(journey)).toEqual({ url: "https://media.example/new" });
    expect(getPrivateMediaRead).toHaveBeenCalledTimes(2);
  });

  it("does not expose a freshly fetched URL that is already inside the safety margin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const journey = makeJourney("too-short");
    getPrivateMediaRead.mockResolvedValue({
      url: "https://media.example/short",
      expiresAt: "2026-09-01T12:00:20.000Z",
    });

    await expect(prefetchSoundtrackRead(journey)).resolves.toBeNull();
    expect(cachedSoundtrackRead(journey)).toBeNull();
  });
});
