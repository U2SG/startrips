import { describe, expect, it } from "vitest";
import {
  coverRevealOpeningIdentity,
  holdCoverRevealOpeningPair,
  planCoverRevealOpening,
  type CoverRevealDisplayPayload,
  type CoverRevealOpeningInput,
} from "./coverRevealOpening";
import type { JourneyMediaAsset } from "./types";

const JOURNEY_ID = "journey-1";
const COVER_HASH = "sha256-cover-bytes";

function cover(overrides: Partial<JourneyMediaAsset> = {}): JourneyMediaAsset {
  return {
    id: "asset-cover",
    journeyId: JOURNEY_ID,
    routePointId: null,
    storageDriver: "s3",
    storageKey: "atlas/journey-1/asset-cover",
    fileName: "cover.jpg",
    mimeType: "image/jpeg",
    bytes: 2048,
    sortOrder: 0,
    uploadedByUserId: "user-1",
    contentHash: COVER_HASH,
    contentHashVerified: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function payload(
  overrides: Partial<NonNullable<CoverRevealDisplayPayload["derivative"]>> = {},
  display: CoverRevealDisplayPayload["display"] = {
    url: "https://storage.example/derivative?sig=short-lived",
    expiresAt: "2026-09-19T12:00:00.000Z",
  },
): CoverRevealDisplayPayload {
  return {
    derivative: {
      id: "derivative-1",
      journeyId: JOURNEY_ID,
      presetId: "ink-bloom",
      sourceMediaAssetId: "asset-cover",
      sourceContentHash: COVER_HASH,
      mimeType: "image/jpeg",
      width: 1600,
      height: 1200,
      ...overrides,
    },
    display,
  };
}

function input(overrides: Partial<CoverRevealOpeningInput> = {}): CoverRevealOpeningInput {
  return {
    journeyId: JOURNEY_ID,
    cover: cover(),
    payload: payload(),
    played: new Set<string>(),
    reducedMotion: false,
    supersededByIntent: false,
    ...overrides,
  };
}

describe("planCoverRevealOpening", () => {
  it("opens with the server's pinned preset and its short-lived display url", () => {
    expect(planCoverRevealOpening(input())).toEqual({
      kind: "open",
      identity: coverRevealOpeningIdentity(JOURNEY_ID, "asset-cover", COVER_HASH),
      preset: "ink-bloom",
      generatedUrl: "https://storage.example/derivative?sig=short-lived",
    });
  });

  it("never substitutes the renderer default for a preset this build cannot render", () => {
    const decision = planCoverRevealOpening(
      input({ payload: payload({ presetId: "ink-bloom-v2" }) }),
    );
    expect(decision).toEqual({ kind: "none", reason: "unusable-derivative" });
  });

  it("takes the preset the server chose rather than a fixed one", () => {
    const decision = planCoverRevealOpening(
      input({ payload: payload({ presetId: "mist-veil" }) }),
    );
    expect(decision.kind === "open" && decision.preset).toBe("mist-veil");
  });

  describe("the canonical original cover is never withheld", () => {
    it("has no opening when the read answered with no derivative", () => {
      expect(planCoverRevealOpening(input({ payload: { derivative: null, reason: "NO_READY_DERIVATIVE" } })))
        .toEqual({ kind: "none", reason: "no-derivative" });
    });

    it("has no opening when the read itself could not be made", () => {
      expect(planCoverRevealOpening(input({ payload: null })))
        .toEqual({ kind: "none", reason: "no-derivative" });
    });

    it("has no opening when the Journey has no cover at all", () => {
      expect(planCoverRevealOpening(input({ cover: null })))
        .toEqual({ kind: "none", reason: "no-cover" });
    });

    it("has no opening when the derivative carries no display capability", () => {
      expect(planCoverRevealOpening(input({ payload: payload({}, null) })))
        .toEqual({ kind: "none", reason: "unusable-derivative" });
    });

    it("has no opening when the derivative reports no usable pixels", () => {
      expect(planCoverRevealOpening(input({ payload: payload({ width: 0 }) })))
        .toEqual({ kind: "none", reason: "unusable-derivative" });
      expect(planCoverRevealOpening(input({ payload: payload({ height: Number.NaN }) })))
        .toEqual({ kind: "none", reason: "unusable-derivative" });
    });

    it("has no opening for a payload describing another Journey", () => {
      expect(planCoverRevealOpening(input({ payload: payload({ journeyId: "journey-2" }) })))
        .toEqual({ kind: "none", reason: "unusable-derivative" });
    });
  });

  describe("a late completion cannot attach to a new cover", () => {
    it("rejects a derivative pinned to the previous cover asset", () => {
      expect(planCoverRevealOpening(input({ cover: cover({ id: "asset-new-cover" }) })))
        .toEqual({ kind: "none", reason: "stale-cover" });
    });

    it("rejects a derivative pinned to the previous bytes of the same asset", () => {
      expect(planCoverRevealOpening(input({ cover: cover({ contentHash: "sha256-replaced-bytes" }) })))
        .toEqual({ kind: "none", reason: "stale-cover" });
    });

    it("rejects a cover whose stored-byte identity was never verified", () => {
      expect(planCoverRevealOpening(input({ cover: cover({ contentHashVerified: false }) })))
        .toEqual({ kind: "none", reason: "stale-cover" });
      expect(planCoverRevealOpening(input({ cover: cover({ contentHash: null }) })))
        .toEqual({ kind: "none", reason: "stale-cover" });
    });

    it("gives the replacement cover its own identity, so it is a new opportunity", () => {
      const first = planCoverRevealOpening(input());
      const replaced = planCoverRevealOpening(input({
        cover: cover({ contentHash: "sha256-replaced-bytes" }),
        payload: payload({ sourceContentHash: "sha256-replaced-bytes" }),
        played: new Set([coverRevealOpeningIdentity(JOURNEY_ID, "asset-cover", COVER_HASH)]),
      }));
      expect(first.kind).toBe("open");
      expect(replaced.kind).toBe("open");
      expect(first.kind === "open" && replaced.kind === "open"
        && first.identity === replaced.identity).toBe(false);
    });
  });

  describe("once per cover revision", () => {
    it("does not open again for an identity already spent", () => {
      const spent = new Set([coverRevealOpeningIdentity(JOURNEY_ID, "asset-cover", COVER_HASH)]);
      expect(planCoverRevealOpening(input({ played: spent })))
        .toEqual({ kind: "none", reason: "already-played" });
    });

    it("keeps a spent revision spent when a newly signed display url arrives", () => {
      const spent = new Set([coverRevealOpeningIdentity(JOURNEY_ID, "asset-cover", COVER_HASH)]);
      const refreshed = payload({}, {
        url: "https://storage.example/derivative?sig=re-signed",
        expiresAt: "2026-09-19T13:00:00.000Z",
      });
      expect(planCoverRevealOpening(input({ played: spent, payload: refreshed })))
        .toEqual({ kind: "none", reason: "already-played" });
    });

    it("keeps the identity independent of the signed url, so it survives a refresh", () => {
      const first = planCoverRevealOpening(input());
      const refreshed = planCoverRevealOpening(input({
        payload: payload({}, {
          url: "https://storage.example/derivative?sig=re-signed",
          expiresAt: "2026-09-19T13:00:00.000Z",
        }),
      }));
      expect(first.kind === "open" && refreshed.kind === "open"
        && first.identity === refreshed.identity).toBe(true);
    });
  });

  it("yields to a newer intent before anything else is considered", () => {
    expect(planCoverRevealOpening(input({ supersededByIntent: true, cover: null })))
      .toEqual({ kind: "none", reason: "newer-intent" });
  });

  it("goes directly to the canonical original cover under Reduced Motion", () => {
    expect(planCoverRevealOpening(input({ reducedMotion: true })))
      .toEqual({ kind: "none", reason: "reduced-motion" });
  });
});

describe("holdCoverRevealOpeningPair", () => {
  const opening = { identity: "journey-1 asset-cover sha256-cover-bytes", generatedUrl: "https://cdn/derivative?sig=1" };

  it("keeps the exact pair an opening started with when the original is re-signed", () => {
    // The original cover's signed read refreshes on its own timer, floored at
    // one second, so this happens several times inside one reveal.
    const first = holdCoverRevealOpeningPair(null, opening, "https://cdn/original?sig=1");
    const refreshed = holdCoverRevealOpeningPair(first, opening, "https://cdn/original?sig=2");
    expect(refreshed).toBe(first);
    expect(refreshed?.pair.originalCover).toBe("https://cdn/original?sig=1");
  });

  it("takes a fresh pair for a different cover revision", () => {
    const first = holdCoverRevealOpeningPair(null, opening, "https://cdn/original?sig=1");
    const replaced = holdCoverRevealOpeningPair(
      first,
      { identity: "journey-1 asset-cover sha256-replacement-bytes", generatedUrl: "https://cdn/derivative?sig=2" },
      "https://cdn/original-replacement?sig=1",
    );
    expect(replaced?.pair).toEqual({
      generatedFirst: "https://cdn/derivative?sig=2",
      originalCover: "https://cdn/original-replacement?sig=1",
    });
  });

  it("keeps the running pair across the loading gap of a refresh", () => {
    // Every refresh of the original read passes through `loading`, so the url
    // is briefly absent under a reveal that has already loaded both images.
    const first = holdCoverRevealOpeningPair(null, opening, "https://cdn/original?sig=1");
    expect(holdCoverRevealOpeningPair(first, opening, null)).toBe(first);
  });

  it("holds nothing before an opening has both of its images", () => {
    expect(holdCoverRevealOpeningPair(null, null, "https://cdn/original?sig=1")).toBeNull();
    expect(holdCoverRevealOpeningPair(null, opening, null)).toBeNull();
    const first = holdCoverRevealOpeningPair(null, opening, "https://cdn/original?sig=1");
    expect(holdCoverRevealOpeningPair(first, null, "https://cdn/original?sig=1")).toBeNull();
  });
});
