import { describe, expect, it } from "vitest";
import {
  evaluateCoverRevealEligibility,
  isSupportedCoverRevealSource,
  resolveEffectiveCover,
  SUPPORTED_COVER_REVEAL_SOURCE_MIME_TYPES,
  type CoverRevealCandidateAsset,
  type CoverRevealJourneyState,
} from "./eligibility";

const JOURNEY_ID = "11111111-1111-4111-8111-111111111111";

function asset(
  overrides: Partial<CoverRevealCandidateAsset> = {},
): CoverRevealCandidateAsset {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    journeyId: JOURNEY_ID,
    mimeType: "image/jpeg",
    sortOrder: 0,
    contentHash: "a".repeat(64),
    contentHashVerified: true,
    ...overrides,
  };
}

function journey(
  overrides: Partial<CoverRevealJourneyState> = {},
): CoverRevealJourneyState {
  return {
    id: JOURNEY_ID,
    deletionStartedAt: null,
    coverMediaAssetId: null,
    media: [asset()],
    ...overrides,
  };
}

describe("#368 cover-reveal eligibility", () => {
  it("accepts an owner Journey whose cover is a verified image", () => {
    const result = evaluateCoverRevealEligibility(journey());
    expect(result).toEqual({
      ok: true,
      source: expect.objectContaining({ id: asset().id }),
      contentHash: "a".repeat(64),
    });
  });

  it("refuses a Journey inside its deletion grace window", () => {
    const result = evaluateCoverRevealEligibility(
      journey({ deletionStartedAt: new Date("2026-09-15T00:00:00Z") }),
    );
    expect(result).toEqual({ ok: false, reason: "JOURNEY_UNAVAILABLE" });
  });

  it("refuses a Journey with no visual media at all", () => {
    const result = evaluateCoverRevealEligibility(
      journey({ media: [asset({ mimeType: "audio/mpeg" })] }),
    );
    expect(result).toEqual({ ok: false, reason: "NO_COVER" });
  });

  /**
   * The honest answer, and the reason the visual set is as broad as the
   * client's: skipping past a video that IS the cover to the next image would
   * generate a derivative of something the member does not see as the cover.
   */
  it("refuses rather than skips when the effective cover is a video", () => {
    const result = evaluateCoverRevealEligibility(journey({
      media: [
        asset({ id: "video", mimeType: "video/mp4", sortOrder: 0 }),
        asset({ id: "photo", mimeType: "image/jpeg", sortOrder: 1 }),
      ],
    }));
    expect(result).toEqual({ ok: false, reason: "SOURCE_UNSUPPORTED" });
  });

  it("refuses an SVG cover, which is markup rather than a photograph", () => {
    const result = evaluateCoverRevealEligibility(
      journey({ media: [asset({ mimeType: "image/svg+xml" })] }),
    );
    expect(result).toEqual({ ok: false, reason: "SOURCE_UNSUPPORTED" });
    expect(isSupportedCoverRevealSource("image/svg+xml")).toBe(false);
    for (const mimeType of SUPPORTED_COVER_REVEAL_SOURCE_MIME_TYPES) {
      expect(isSupportedCoverRevealSource(mimeType)).toBe(true);
    }
  });

  /**
   * #311: the pinned identity has to be the one measured from the durable
   * stored bytes. A client-declared hash is exactly the second, weaker
   * identity #368 forbids, so an unverified source fails closed instead of
   * falling back to it.
   */
  it("refuses a source whose stored-byte identity was never verified", () => {
    expect(evaluateCoverRevealEligibility(
      journey({ media: [asset({ contentHashVerified: false })] }),
    )).toEqual({ ok: false, reason: "SOURCE_IDENTITY_UNVERIFIED" });
    expect(evaluateCoverRevealEligibility(
      journey({ media: [asset({ contentHash: null })] }),
    )).toEqual({ ok: false, reason: "SOURCE_IDENTITY_UNVERIFIED" });
  });

  it("refuses an asset that belongs to some other owner", () => {
    const result = evaluateCoverRevealEligibility(journey({
      media: [asset({ journeyId: null })],
    }));
    expect(result).toEqual({ ok: false, reason: "NO_COVER" });
  });

  describe("effective cover resolution", () => {
    it("prefers the explicit cover pointer over media order", () => {
      const resolved = resolveEffectiveCover({
        coverMediaAssetId: "second",
        media: [
          asset({ id: "first", sortOrder: 0 }),
          asset({ id: "second", sortOrder: 1 }),
        ],
      });
      expect(resolved?.id).toBe("second");
    });

    it("falls back to the first visual asset by sortOrder", () => {
      const resolved = resolveEffectiveCover({
        coverMediaAssetId: null,
        media: [
          asset({ id: "later", sortOrder: 5 }),
          asset({ id: "earliest", sortOrder: 1 }),
        ],
      });
      expect(resolved?.id).toBe("earliest");
    });

    /**
     * The whole reason completion re-resolves instead of comparing
     * `cover_media_asset_id`: reordering moves the effective cover without
     * writing the pointer at all.
     */
    it("moves with media order when no pointer is set", () => {
      const media = [
        asset({ id: "a", sortOrder: 0 }),
        asset({ id: "b", sortOrder: 1 }),
      ];
      expect(resolveEffectiveCover({ coverMediaAssetId: null, media })?.id)
        .toBe("a");
      const reordered = [
        asset({ id: "a", sortOrder: 1 }),
        asset({ id: "b", sortOrder: 0 }),
      ];
      expect(
        resolveEffectiveCover({ coverMediaAssetId: null, media: reordered })?.id,
      ).toBe("b");
    });

    it("ignores a pointer that no longer names media of this Journey", () => {
      const resolved = resolveEffectiveCover({
        coverMediaAssetId: "deleted",
        media: [asset({ id: "surviving", sortOrder: 3 })],
      });
      expect(resolved?.id).toBe("surviving");
    });
  });
});
