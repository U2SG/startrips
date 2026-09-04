import { and, eq, isNull } from "drizzle-orm";
import {
  evaluateShareGrant,
  shareUnavailable,
  type ActiveShareGrant,
} from "../authorization/share-access";
import {
  atlases,
  journeys,
  mediaAssets,
  shareGrantJourneys,
  shareGrants,
} from "../db/app-schema";
import { db } from "../db/client";

/**
 * What the route needs to sign one guest media read: which backend holds the
 * object, its key, and the instant the signature may not outlive.
 *
 * `storageKey` never leaves the server — the guest payload built by
 * `shared-journey-repository.ts` deliberately omits it, and this value exists
 * only to be handed to the storage adapter.
 */
export type SharedMediaRead = {
  storageDriver: string;
  storageKey: string;
  /**
   * The grant's expiry as an absolute instant, not a duration.
   *
   * A duration computed here would be measured from whenever this resolver
   * was entered, while the signature is stamped by the storage adapter's own
   * later clock. Under a saturated connection pool those two instants can be
   * seconds apart, and the difference is time the signed URL would live past
   * the grant. Handing back the deadline instead makes the lifetime the
   * caller's arithmetic, taken immediately before it signs.
   */
  grantExpiresAt: Date;
};

/** The two configured ceilings, applied on top of the grant's own deadline. */
export type ShareMediaTtlLimits = {
  shareTtlSeconds: number;
  ownerTtlSeconds: number;
};

/**
 * The presign lifetime, as one pure decision.
 *
 * A signed object-storage URL cannot be withdrawn, so the only lever left is
 * how long it lives. #200 asks for `min(shareMediaMaxTtl, expiresAt - now)`;
 * the owner ceiling is included as well, so a guest can never be handed a
 * longer-lived credential than a member of the atlas would get.
 *
 * The remaining lifetime is floored to whole seconds because that is the unit
 * a presign takes: rounding up would issue a URL valid past `expiresAt`, which
 * is exactly the guarantee this function exists to keep. The result is
 * therefore 0 for the final sub-second of a grant; the caller refuses rather
 * than signing a URL that is already dead.
 *
 * `now` is a parameter with no default on purpose. The only correct value is
 * the clock read immediately before the signature is stamped, so the caller
 * has to say which instant it means rather than inheriting one from whenever
 * the request happened to start.
 */
export function capShareMediaTtlSeconds(
  limits: ShareMediaTtlLimits,
  expiresAt: Date,
  now: Date,
): number {
  const remainingSeconds = Math.floor(
    (expiresAt.valueOf() - now.valueOf()) / 1000,
  );
  return Math.max(
    0,
    Math.min(
      limits.shareTtlSeconds,
      limits.ownerTtlSeconds,
      remainingSeconds,
    ),
  );
}

/**
 * Resolve one asset id to a signable object for one active grant, or `null`.
 *
 * The grant does not permanently bless an asset id: nothing here reads the
 * grant snapshot's idea of what it contained. Membership is re-derived from
 * `share_grant_journeys` joined to the asset's CURRENT `journey_id` on every
 * call, so an asset moved to an unshared journey stops resolving the moment
 * that move commits, with no cache to invalidate.
 *
 * Four conditions must all hold, and each one is a column comparison rather
 * than an application-level check:
 *
 * - the asset's current journey is selected by THIS grant;
 * - that journey belongs to the atlas that issued the grant, so a grant can
 *   never reach a second atlas even if the join table were wrong;
 * - that journey has not started deleting;
 * - the grant itself still evaluates as active, atlas deletion included.
 *
 * `null` is returned for every asset-side reason — unknown id, an id in
 * another journey of the same atlas, an id in another atlas, a journey inside
 * its deletion grace window — so the route answers one shape for all of them
 * and a guest learns nothing about whether the asset exists.
 *
 * Read in one `repeatable read`, `read only` transaction whose first statement
 * re-evaluates the grant, the same shape `loadSharedJourneyView` uses: the
 * authorization decision and the ownership check then describe one instant, so
 * an owner revoking or moving media concurrently either commits before that
 * instant and is honoured, or after it and cannot be half-applied.
 *
 * This resolver deliberately computes no lifetime. It returns the grant's
 * deadline and the caller derives the TTL from it against the clock it is
 * about to sign with; `now` here decides only whether the grant is active,
 * which is a question about this snapshot rather than about the signature.
 */
export async function resolveSharedMediaRead(
  grant: ActiveShareGrant,
  assetId: string,
  now: Date = new Date(),
): Promise<SharedMediaRead | null> {
  return db.transaction(
    async (transaction) => {
      // First statement, so this is where the snapshot is taken.
      const [current] = await transaction
        .select({
          expiresAt: shareGrants.expiresAt,
          revokedAt: shareGrants.revokedAt,
          atlasDeletionStartedAt: atlases.deletionStartedAt,
        })
        .from(shareGrants)
        .innerJoin(atlases, eq(atlases.id, shareGrants.atlasId))
        .where(eq(shareGrants.id, grant.id))
        .limit(1);
      if (!current || evaluateShareGrant(current, now) !== "active") {
        throw shareUnavailable();
      }

      const [row] = await transaction
        .select({
          storageDriver: mediaAssets.storageDriver,
          storageKey: mediaAssets.storageKey,
        })
        .from(mediaAssets)
        .innerJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
        .innerJoin(
          shareGrantJourneys,
          eq(shareGrantJourneys.journeyId, journeys.id),
        )
        .where(and(
          eq(mediaAssets.id, assetId),
          eq(shareGrantJourneys.shareGrantId, grant.id),
          eq(journeys.atlasId, grant.atlasId),
          isNull(journeys.deletionStartedAt),
        ))
        .limit(1);
      if (!row) return null;

      return { ...row, grantExpiresAt: current.expiresAt };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
