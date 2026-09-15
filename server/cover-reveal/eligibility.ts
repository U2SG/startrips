/**
 * #368 (Slice 1 of #367): which Journey cover, if any, a cover-reveal
 * derivative may be generated from.
 *
 * Pure and DOM-free on purpose. Eligibility is a product decision about
 * canonical Journey state, and #368 is explicit that the SERVER makes it: a
 * worker may never choose a Journey or an asset by filename, by scraping a UI
 * or by naming an arbitrary id, so the whole decision has to be expressible
 * without a request, a session, a database handle or a storage backend. What
 * is left is a function over rows, which is also why it is unit-testable in
 * the core lane without PostgreSQL.
 *
 * The cover resolution deliberately mirrors `journeyCover()` in
 * `src/journey/journeyModel.ts`: the explicit `coverMediaAssetId` when it
 * still names a visual asset of this Journey, otherwise the first visual asset
 * by `sortOrder`. It is restated rather than imported because the client and
 * server live in separate TypeScript projects, and because the two answer
 * different questions about the same rule — the client asks what to show, this
 * asks what may be generated from. If one changes the other must follow, so
 * keep this comment with it.
 */

/** The media columns this decision needs, and nothing else. */
export type CoverRevealCandidateAsset = {
  id: string;
  /** Null for an Everyday Fragment asset, which can never be a Journey cover. */
  journeyId: string | null;
  mimeType: string;
  sortOrder: number;
  contentHash: string | null;
  /** #311: true only when the hash was derived from the durable stored bytes. */
  contentHashVerified: boolean;
};

export type CoverRevealJourneyState = {
  id: string;
  deletionStartedAt: Date | null;
  coverMediaAssetId: string | null;
  media: CoverRevealCandidateAsset[];
};

export type CoverRevealIneligibleReason =
  /** The Journey is inside its deletion grace window, or already gone. */
  | "JOURNEY_UNAVAILABLE"
  /** No visual media at all, so the Journey has no cover to derive from. */
  | "NO_COVER"
  /** The effective cover is a video or another kind nothing can read yet. */
  | "SOURCE_UNSUPPORTED"
  /** #311 never measured this object, so there is no identity to pin. */
  | "SOURCE_IDENTITY_UNVERIFIED";

export type CoverRevealEligibility =
  | { ok: true; source: CoverRevealCandidateAsset; contentHash: string }
  | { ok: false; reason: CoverRevealIneligibleReason };

/**
 * What the product treats as visual media, and therefore as a possible cover.
 *
 * Kept as broad as the client's rule so this never resolves to a DIFFERENT
 * asset than the one the member sees as the cover. A video that wins the
 * fallback is refused below as an unsupported SOURCE, which is the honest
 * answer; silently skipping past it to the next image would generate a
 * derivative of something that is not the cover.
 */
export function isVisualCoverCandidate(asset: CoverRevealCandidateAsset) {
  return asset.mimeType.startsWith("image/")
    || asset.mimeType.startsWith("video/");
}

/**
 * The raster image types a worker may be handed as a source.
 *
 * An allowlist rather than `image/*`: SVG is a document, not a photograph, and
 * handing one to a generation pipeline is handing it markup. Anything outside
 * this list is a recorded skip, exactly as #368 asks.
 */
export const SUPPORTED_COVER_REVEAL_SOURCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export function isSupportedCoverRevealSource(mimeType: string) {
  return (SUPPORTED_COVER_REVEAL_SOURCE_MIME_TYPES as readonly string[])
    .includes(mimeType);
}

/**
 * The effective cover of a Journey, by the same rule the product displays.
 *
 * Exported because completion has to re-run it: the effective cover can move
 * without `cover_media_asset_id` ever being written — reordering media changes
 * which asset wins the fallback, and the move/undo paths in
 * `server/routes/uploads.ts` null the pointer outright. Comparing the pointer
 * would therefore miss a real cover change, which is the one thing a stale
 * completion must not survive.
 */
export function resolveEffectiveCover(
  journey: Pick<CoverRevealJourneyState, "coverMediaAssetId" | "media">,
): CoverRevealCandidateAsset | null {
  const visual = journey.media.filter(isVisualCoverCandidate);
  if (journey.coverMediaAssetId) {
    const explicit = visual.find(
      (asset) => asset.id === journey.coverMediaAssetId,
    );
    if (explicit) return explicit;
  }
  return [...visual].sort((left, right) => left.sortOrder - right.sortOrder)[0]
    ?? null;
}

/**
 * The whole eligibility predicate, as one decision.
 *
 * Ownership is NOT checked here and deliberately so: an owner session and its
 * Atlas are resolved by `requireAtlasAccess` before any row reaches this
 * function, so a guest, a share grant or a worker never produces a
 * `CoverRevealJourneyState` at all. What is checked is everything that is a
 * property of the recorded state — availability, an effective cover, a source
 * kind that can be read, and a stored-byte identity that #311 verified.
 *
 * The verified hash is returned beside the asset because it is what gets
 * pinned. An unverified or absent hash fails closed rather than falling back
 * to the client-declared value: #368 forbids a second, weaker content
 * identity, and a pin that can be forged pins nothing.
 */
export function evaluateCoverRevealEligibility(
  journey: CoverRevealJourneyState,
): CoverRevealEligibility {
  if (journey.deletionStartedAt) {
    return { ok: false, reason: "JOURNEY_UNAVAILABLE" };
  }
  const cover = resolveEffectiveCover(journey);
  if (!cover) return { ok: false, reason: "NO_COVER" };
  // A fragment-owned asset has no `journeyId`, and an asset of another Journey
  // is not this Journey's cover whatever a pointer says.
  if (cover.journeyId !== journey.id) {
    return { ok: false, reason: "NO_COVER" };
  }
  if (!isSupportedCoverRevealSource(cover.mimeType)) {
    return { ok: false, reason: "SOURCE_UNSUPPORTED" };
  }
  if (!cover.contentHashVerified || !cover.contentHash) {
    return { ok: false, reason: "SOURCE_IDENTITY_UNVERIFIED" };
  }
  return { ok: true, source: cover, contentHash: cover.contentHash };
}
