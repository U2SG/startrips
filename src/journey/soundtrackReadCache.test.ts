import { describe, expect, it, vi } from "vitest";
import { cachedSoundtrackRead } from "./soundtrackReadCache";
import type { Journey } from "./types";

const journey: Journey = {
  id: "journey-1",
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
    id: "track-1",
    journeyId: "journey-1",
    routePointId: null,
    storageDriver: "test",
    storageKey: "track-1",
    fileName: "night.mp3",
    mimeType: "audio/mpeg",
    bytes: 64,
    sortOrder: 0,
    uploadedByUserId: "user-1",
    createdAt: "2026-08-11T00:00:00.000Z",
  }],
};

// The cache module reads via getPrivateMediaRead and a module-level Map; in
// the node test environment the cache starts empty, so cachedSoundtrackRead
// returns null without network. This pins the "no prefetch yet" contract that
// the overlay depends on before the click gesture.
describe("soundtrackReadCache (review P1)", () => {
  it("returns null before any prefetch", () => {
    expect(cachedSoundtrackRead(journey)).toBeNull();
  });

  it("returns null for a journey without a soundtrack", () => {
    const silent: Journey = { ...journey, media: [] };
    expect(cachedSoundtrackRead(silent)).toBeNull();
  });
});
