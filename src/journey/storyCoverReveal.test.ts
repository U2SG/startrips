import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  coverRevealOpeningIdentity,
  planCoverRevealOpening,
  storyCoverRevealGate,
  type CoverRevealDisplayPayload,
} from "./coverRevealOpening";
import { journeyCover } from "./journeyModel";
import {
  storyActiveChapterRoutePointId,
  storyCursorForJourney,
  storyInitialCursorSelection,
  storyInitialMediaSelection,
  storyObservedAssetId,
} from "./storyMediaPolicy";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

// #555 + #379: the Cover Reveal belongs to the Journey cover presentation role.
// These cases combine Story's cursor (which entry, which open) with the reveal
// decision Atlas already uses, so Story reveals exactly where the role is.
const createdAt = "2026-08-11T00:00:00.000Z";
const COVER_HASH = "sha256-cover";

function point(id: string, sortOrder: number, note: string | null): RoutePoint {
  return {
    id, journeyId: "journey-1", sortOrder, label: id, latitude: sortOrder, longitude: sortOrder,
    occurredAt: null, note, isStop: true, createdAt,
  };
}

function asset(id: string, routePointId: string | null, sortOrder: number, extra: Partial<JourneyMediaAsset> = {}): JourneyMediaAsset {
  return {
    id, journeyId: "journey-1", routePointId, storageDriver: "test", storageKey: `journey-1/${id}`,
    fileName: `${id}.jpg`, mimeType: "image/jpeg", bytes: 128, sortOrder,
    uploadedByUserId: "user-1", createdAt, ...extra,
  };
}

function journeyWith(coverId: string, coverRoutePointId: string | null): Journey {
  return {
    id: "journey-1", atlasId: "atlas-1", title: "Cover reveal", startedOn: "2026-08-11", endedOn: null,
    note: "Journey note.", lightColor: "#f4ce73", revision: 1, createdByUserId: "user-1",
    createdAt, updatedAt: createdAt, coverMediaAssetId: coverId,
    routePoints: [point("A", 0, "A note"), point("B", 1, "B note")],
    media: [
      asset("a1", "A", 1),
      asset(coverId, coverRoutePointId, 0, { contentHash: COVER_HASH, contentHashVerified: true }),
      asset("b1", "B", 2),
    ],
  };
}

function ready(coverId: string): CoverRevealDisplayPayload {
  return {
    derivative: {
      id: "derivative-1", journeyId: "journey-1", presetId: "ink-bloom",
      sourceMediaAssetId: coverId, sourceContentHash: COVER_HASH,
      mimeType: "image/jpeg", width: 1600, height: 1200,
    },
    display: { url: "https://storage.example/derivative?sig=1", expiresAt: "2026-09-19T12:00:00.000Z" },
  };
}

/** What Story would show at this cursor entry for this open. */
function storyReveal(
  target: Journey,
  request: { routePointId: string | null; assetId: string | null; presentJourneyCoverOpening: boolean },
  entryIndex: number | "initial",
  payload: CoverRevealDisplayPayload | null,
  played: ReadonlySet<string> = new Set(),
) {
  const media = storyInitialMediaSelection(target, request.routePointId, request.assetId);
  const initial = storyInitialCursorSelection(target, media, request);
  const cursor = storyCursorForJourney(target, initial.withJourneyCoverOpening);
  const at = entryIndex === "initial" ? initial.entryIndex : entryIndex;
  const gate = storyCoverRevealGate({
    entryRole: cursor.entries[at]?.role ?? null,
    canManageMedia: true,
    cover: cursor.entries[at]?.asset ?? null,
    stageSettled: true,
  });
  if (!gate.enabled) return gate.reason;
  const decision = planCoverRevealOpening({
    journeyId: target.id,
    cover: journeyCover(target),
    payload,
    played,
    reducedMotion: false,
    supersededByIntent: false,
  });
  return decision.kind === "open" ? "reveal" : decision.reason;
}

const fresh = { routePointId: null, assetId: null, presentJourneyCoverOpening: true };

describe("Story cover reveal ownership (#555)", () => {
  for (const [label, routePointId] of [["a Route Point", "B"], ["Journey-level media", null]] as const) {
    const target = journeyWith("cover", routePointId);

    it(`reveals on the opening of a fresh whole-Journey open, cover from ${label}`, () => {
      expect(storyReveal(target, fresh, "initial", ready("cover"))).toBe("reveal");
    });

    it(`never reveals at the canonical cover entry, cover from ${label}`, () => {
      const cursor = storyCursorForJourney(target, true);
      const canonical = cursor.canonicalEntryByAssetId.get("cover")!;
      expect(cursor.entries[canonical].role).toBe("media");
      expect(storyReveal(target, fresh, canonical, ready("cover"))).toBe("not-opening");
    });

    it(`never reveals for a deep link or a Playback return, cover from ${label}`, () => {
      expect(storyReveal(target, { ...fresh, assetId: "cover", routePointId }, "initial", ready("cover")))
        .toBe("not-opening");
      expect(storyReveal(target, { ...fresh, presentJourneyCoverOpening: false }, "initial", ready("cover")))
        .toBe("not-opening");
    });

    it(`shows the plain cover for a missing, stale or spent derivative, cover from ${label}`, () => {
      expect(storyReveal(target, fresh, "initial", null)).toBe("no-derivative");
      expect(storyReveal(target, fresh, "initial", { derivative: null })).toBe("no-derivative");
      expect(storyReveal(target, fresh, "initial", {
        ...ready("cover"),
        derivative: { ...ready("cover").derivative!, sourceContentHash: "sha256-older" },
      })).toBe("stale-cover");
      expect(storyReveal(target, fresh, "initial", { ...ready("cover"), display: null }))
        .toBe("unusable-derivative");
      const spent = new Set([coverRevealOpeningIdentity("journey-1", "cover", COVER_HASH)]);
      expect(storyReveal(target, fresh, "initial", ready("cover"), spent)).toBe("already-played");
    });
  }

  it("never reveals at canonical entry 0 when the cover IS canonical entry 0", () => {
    // A Journey-level cover sorts into the intro, ahead of every Route Point.
    const target = journeyWith("cover", null);
    const cursor = storyCursorForJourney(target, true);
    expect(cursor.entries.map((entry) => `${entry.role}:${entry.asset.id}`))
      .toEqual(["journey-cover:cover", "media:cover", "media:a1", "media:b1"]);
    expect(storyReveal(target, fresh, 0, ready("cover"))).toBe("reveal");
    expect(storyReveal(target, fresh, 1, ready("cover"))).toBe("not-opening");
  });

  it("waits for a settled stage, needs the owner capability and never reveals a video cover", () => {
    const base = { entryRole: "journey-cover" as const, canManageMedia: true, cover: asset("c", null, 0), stageSettled: true };
    expect(storyCoverRevealGate(base)).toEqual({ enabled: true });
    expect(storyCoverRevealGate({ ...base, stageSettled: false })).toEqual({ enabled: false, reason: "stage-not-settled" });
    expect(storyCoverRevealGate({ ...base, canManageMedia: false })).toEqual({ enabled: false, reason: "no-capability" });
    expect(storyCoverRevealGate({ ...base, cover: asset("c", null, 0, { mimeType: "video/mp4" }) }))
      .toEqual({ enabled: false, reason: "video-cover" });
    expect(storyCoverRevealGate({ ...base, cover: null })).toEqual({ enabled: false, reason: "no-cover" });
    expect(storyCoverRevealGate({ ...base, entryRole: "media" })).toEqual({ enabled: false, reason: "not-opening" });
  });
});

describe("Journey-level cover context (#555)", () => {
  const target = journeyWith("cover", null);
  const cursor = storyCursorForJourney(target, true);

  it("keeps Journey context on both the opening and the intro media it duplicates", () => {
    expect(cursor.entries[0]).toMatchObject({ role: "journey-cover", contextOwner: "journey", routePointId: null });
    expect(cursor.entries[1]).toMatchObject({ role: "media", contextOwner: "journey", routePointId: null });
    const coverAsset = cursor.entries[1].asset;
    // Neither names a Route Point, so the whole-Journey chip stays pressed.
    expect(storyActiveChapterRoutePointId(null, coverAsset, true, null, true)).toBeNull();
    expect(storyActiveChapterRoutePointId(null, coverAsset, true, null, false)).toBeNull();
  });

  it("publishes no asset on the opening and the asset on canonical entry 0", () => {
    expect(storyObservedAssetId(cursor, cursor.pageIds[0], null)).toBeNull();
    expect(storyObservedAssetId(cursor, cursor.pageIds[1], null)).toBe("cover");
    expect(cursor.pageIds[0]).not.toBe(cursor.pageIds[1]);
  });
});

describe("the Atlas card never reveals (#555)", () => {
  it("leaves the Cover Reveal to Story's Journey cover opening alone", () => {
    // Owner decision on #555: the Atlas/planet card shows the canonical cover
    // directly. It mounts no reveal hook, no reveal stage and no derivative read.
    const withoutComments = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const app = withoutComments("LivingAtlasApp.tsx");
    expect(app).not.toContain("useCoverRevealOpening");
    expect(app).not.toContain("CoverRevealStage");
    expect(app).not.toContain("readCoverRevealDisplay");
    expect(app).not.toContain("onOpeningSettled");
    // Story is the one owner.
    const story = withoutComments("JourneyStory.tsx");
    expect(story).toContain("useCoverRevealOpening(");
    expect(story).toContain("<CoverRevealStage");
    // And anything that is not Story's opening entry has no reveal role.
    expect(storyCoverRevealGate({
      entryRole: null, canManageMedia: true, cover: { mimeType: "image/jpeg" }, stageSettled: true,
    })).toEqual({ enabled: false, reason: "not-opening" });
  });
});
