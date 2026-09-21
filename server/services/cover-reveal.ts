import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  coverRevealDerivatives,
  coverRevealWrites,
  journeys,
  mediaAssets,
} from "../db/app-schema";
import { db } from "../db/client";
import {
  evaluateCoverRevealEligibility,
  type CoverRevealCandidateAsset,
  type CoverRevealIneligibleReason,
} from "../cover-reveal/eligibility";
import {
  generateCoverRevealLeaseToken,
  hashCoverRevealLeaseToken,
} from "../cover-reveal/worker-credential";
import {
  JPEG_HEADER_WINDOW_BYTES,
  readJpegPixelSize,
} from "../media/preview-image";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  reconcileDerivedObjectNamespace,
  retireDerivedObjectWrites,
  type DerivedObjectCleanup,
} from "../storage/derived-object-cleanup";
import {
  getMultipartStorage,
  hasConfiguredStorageBackends,
} from "../storage/storage-registry";

/**
 * #368 (Slice 1 of #367): the whole cover-reveal derivative protocol, kept out
 * of the routes so the object storage and the database it touches are one
 * injectable seam.
 *
 * The routes above it decide WHO is calling — an Atlas owner for the enqueue,
 * the machine credential for everything a worker does — and this decides what
 * may happen to the job. Nothing here reads a session, and nothing here trusts
 * a caller-supplied Journey, media asset or storage key: a worker names a job
 * id and the lease token it was handed, and every object it touches is one
 * this module chose.
 */
export type CoverRevealDependencies = {
  storageForBackend: (backendId: string) => MultipartStorage;
  /**
   * The backend whose derivative namespace the prefix sweep enumerates: the
   * one this deployment writes to now. Separate from `storageForBackend` for
   * the same reason `MediaPreviewDependencies` separates them — the sweep is
   * not asking about a known key, it is asking a whole backend what it holds.
   */
  configuredStorage: () => MultipartStorage;
};

const defaultDependencies: CoverRevealDependencies = {
  storageForBackend: getMultipartStorage,
  configuredStorage: () => getMultipartStorage(),
};

/**
 * Every generated derivative lives directly under this one prefix, flat and
 * global, for exactly the reason `PREVIEW_KEY_PREFIX` is: a namespace that
 * encodes the Atlas or the Journey cannot be swept for the objects whose
 * Atlas or Journey no longer exists.
 *
 * It is deliberately NOT under `previews/`. `reconcilePreviewNamespace()`
 * deletes every object under that prefix that no `media_assets` row
 * references, and a derivative is referenced by
 * `cover_reveal_derivatives.output_storage_key` instead — so a derivative
 * written there would be swept away by the preview reconciler on its next
 * pass. The two namespaces are disjoint and each has its own sweep.
 */
export const COVER_REVEAL_KEY_PREFIX = "cover-reveals/";

/**
 * What this contract generates, and the version of the contract itself.
 *
 * A kind and a number, never a prompt: #368 is explicit that no executable
 * blob is persisted, and a worker built against an older contract has to be
 * recognisable rather than silently accepted.
 */
export const COVER_REVEAL_GENERATION_KIND = "ink-wash-poster";
export const COVER_REVEAL_GENERATION_VERSION = 1;
export const COVER_REVEAL_DEFAULT_PRESET_ID = "reveal-flow-ink-wash-v1";

/**
 * The derivative is always a JPEG.
 *
 * It is not a format preference. Completion establishes the output's encoded
 * pixel size from the stored bytes with `readJpegPixelSize`, so a type whose
 * frame this server cannot read could only ever be accepted on the worker's
 * word — which is the client-asserted identity #368 forbids. One readable
 * type keeps "the server validated the stored object" literally true.
 */
export const COVER_REVEAL_OUTPUT_MIME_TYPE = "image/jpeg";

export type CoverRevealCeilings = {
  maxBytes: number;
  maxEdgePixels: number;
};

type CoverRevealDerivative = typeof coverRevealDerivatives.$inferSelect;

/** Exactly the columns the atomic claim statement returns. */
type ClaimedRow = Pick<
  CoverRevealDerivative,
  | "id"
  | "journeyId"
  | "sourceMediaAssetId"
  | "sourceContentHash"
  | "generationKind"
  | "generationVersion"
  | "presetId"
  | "seed"
  | "state"
  | "attempts"
  | "lastErrorCode"
  | "outputStorageDriver"
  | "outputStorageKey"
>;

export type CoverRevealSettings = CoverRevealCeilings & {
  leaseSeconds: number;
  sourceReadExpiresInSeconds: number;
  uploadExpiresInSeconds: number;
  maxAttempts: number;
};

export type CoverRevealErrorCode =
  | CoverRevealIneligibleReason
  | "COVER_REVEAL_NOT_CLAIMED"
  | "COVER_REVEAL_NOT_LEASED"
  | "COVER_REVEAL_SOURCE_CHANGED"
  | "COVER_REVEAL_OUTPUT_MISSING"
  | "COVER_REVEAL_OUTPUT_TOO_LARGE"
  | "COVER_REVEAL_OUTPUT_PIXELS_TOO_LARGE"
  | "COVER_REVEAL_OUTPUT_UNREADABLE";

export type CoverRevealFailure = {
  ok: false;
  error: CoverRevealErrorCode;
  status: 404 | 409;
};

/** The public shape of a job. It carries no URL and no token, ever. */
export type CoverRevealJobView = {
  id: string;
  journeyId: string;
  state: string;
  generationKind: string;
  generationVersion: number;
  presetId: string;
  seed: string;
  sourceMediaAssetId: string;
  sourceContentHash: string;
  attempts: number;
  lastErrorCode: string | null;
};

function jobView(job: ClaimedRow): CoverRevealJobView {
  return {
    id: job.id,
    journeyId: job.journeyId,
    state: job.state,
    generationKind: job.generationKind,
    generationVersion: job.generationVersion,
    presetId: job.presetId,
    seed: job.seed,
    sourceMediaAssetId: job.sourceMediaAssetId,
    sourceContentHash: job.sourceContentHash,
    attempts: job.attempts,
    lastErrorCode: job.lastErrorCode,
  };
}

/**
 * #386 (the Backend read slice of #367): what the ordinary authenticated
 * browser is told about a derivative it may display.
 *
 * Deliberately NOT `CoverRevealJobView`. That view is the PROCESSING view: it
 * carries `seed`, `attempts` and `lastErrorCode`, which describe how the
 * object was produced and how the queue has been behaving — worker internals a
 * display client has no use for and #386 forbids on this surface. What is left
 * here is exactly what a client needs to prove the derivative belongs to the
 * cover it is about to paint over (`sourceMediaAssetId` plus the verified
 * stored-byte identity), to pick the approved deterministic renderer
 * (`generationKind` / `generationVersion` / `presetId`), and to lay the image
 * out before it loads (`mimeType`, `width`, `height`).
 *
 * There is no storage key, no lease hash, no signed source URL and no upload
 * target, and there is no `state` either: this type exists only for a `ready`
 * row, so a lifecycle field could only ever say `ready` and would invite a
 * client to branch on a value that is not a promise about the future.
 */
export type CoverRevealDisplayView = {
  id: string;
  journeyId: string;
  generationKind: string;
  generationVersion: number;
  presetId: string;
  sourceMediaAssetId: string;
  sourceContentHash: string;
  mimeType: string;
  width: number;
  height: number;
};

/** The short-lived capability for exactly one published derivative object. */
export type CoverRevealDisplayRead = {
  url: string;
  expiresAt: Date;
};

/**
 * Why an authorized Journey has nothing to display right now.
 *
 * Every value is a plain fact about canonical Journey state that the owner can
 * already see for themselves, so naming it leaks nothing: the eligibility
 * reasons say the cover itself cannot be a source, and `NO_READY_DERIVATIVE`
 * covers every lifecycle that is not `ready` for the current cover revision —
 * `queued`, `leased`, `failed`, `superseded`, a derivative pinned to a cover
 * that has moved, and simply never having asked. They are one reason rather
 * than five because the difference between them is queue state, and a client
 * that branched on it would be reimplementing the retry policy this server
 * owns. All of them mean the same thing to the client: paint the canonical
 * original.
 */
export type CoverRevealNotDisplayableReason =
  | CoverRevealIneligibleReason
  | "NO_READY_DERIVATIVE";

export type CoverRevealDisplayResult =
  | {
    ok: true;
    derivative: CoverRevealDisplayView;
    display: CoverRevealDisplayRead;
  }
  | { ok: true; derivative: null; reason: CoverRevealNotDisplayableReason }
  | CoverRevealFailure;

/**
 * Drop a generated object once no job references it any more. Best-effort at
 * the call sites that already hold a correct row, exactly like
 * `discardPreviewObject`: a storage hiccup costs an unreferenced object rather
 * than a wrong answer, and the namespace sweep finds it later.
 */
async function discardDerivativeObject(
  storageDriver: string | null,
  storageKey: string | null,
  dependencies: CoverRevealDependencies,
) {
  if (!storageDriver || !storageKey) return true;
  try {
    await dependencies.storageForBackend(storageDriver).deleteObject({
      key: storageKey,
    });
    return true;
  } catch (error) {
    console.error(
      "Cover-reveal derivative cleanup failed",
      storageKey,
      error instanceof Error ? error.message : "unknown error",
    );
    return false;
  }
}

/**
 * The canonical Journey state eligibility is decided from, loaded in the
 * Atlas the caller actually has.
 *
 * The Atlas is a parameter rather than something this reads from a request:
 * `requireAtlasAccess` derives it from `session.session.activeOrganizationId`
 * and nothing else may. A worker never reaches this function at all — its
 * routes take a job id, and the job already names its Journey.
 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Take the canonical state under row locks, in the repository's lock order.
 *
 * The Journey row first, then its media rows, which is the order every other
 * write path here acquires them in (`lockActiveAtlas` -> Journey -> the rows
 * below it), so this cannot deadlock against one. Locking BOTH is the point: a
 * cover change writes `journeys`, but a reorder or a replacement writes only
 * `media_assets`, and the effective cover moves with either.
 *
 * The residual is an INSERT of a brand-new asset, which no row lock can
 * exclude. A new asset can only win the fallback, never displace an explicit
 * pointer, and the invalidation pass supersedes the job on its next run — so
 * the outcome is a derivative that is retired rather than one attached to the
 * wrong cover.
 */
async function lockJourneyState(transaction: Transaction, journeyId: string) {
  const locked = await transaction.execute<{ id: string }>(sql`
    select ${journeys.id} as id
    from ${journeys}
    where ${journeys.id} = ${journeyId}
    for update
  `);
  if (locked.rows.length === 0) return null;
  await transaction.execute(sql`
    select ${mediaAssets.id} as id
    from ${mediaAssets}
    where ${mediaAssets.journeyId} = ${journeyId}
    order by ${mediaAssets.id}
    for update
  `);
  return loadJourneyState(journeyId, null, transaction);
}

async function loadJourneyState(
  journeyId: string,
  atlasId: string | null,
  reader: Transaction | typeof db = db,
) {
  const [journey] = await reader
    .select({
      id: journeys.id,
      atlasId: journeys.atlasId,
      deletionStartedAt: journeys.deletionStartedAt,
      coverMediaAssetId: journeys.coverMediaAssetId,
    })
    .from(journeys)
    .where(
      atlasId === null
        ? eq(journeys.id, journeyId)
        : and(eq(journeys.id, journeyId), eq(journeys.atlasId, atlasId)),
    )
    .limit(1);
  if (!journey) return null;

  const media: CoverRevealCandidateAsset[] = await reader
    .select({
      id: mediaAssets.id,
      journeyId: mediaAssets.journeyId,
      mimeType: mediaAssets.mimeType,
      sortOrder: mediaAssets.sortOrder,
      contentHash: mediaAssets.contentHash,
      contentHashVerified: mediaAssets.contentHashVerified,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.journeyId, journeyId));

  return { ...journey, media };
}

/**
 * Queue a derivative for one Journey's current cover, or say why not.
 *
 * Idempotent by identity rather than by request: a Journey whose cover has not
 * moved already has the job it needs, so an unfinished or ready job pinned to
 * the same source and the same generation contract is returned as it stands. A
 * second enqueue is therefore free, which is what lets a caller ask whenever a
 * Journey is opened without keeping its own record of whether it asked before.
 *
 * A job pinned to a source that is no longer the cover is superseded here as
 * well as by the reconciler, so the state a caller is handed back is never a
 * derivative of the wrong image.
 */
export async function enqueueCoverRevealDerivative(
  journeyId: string,
  atlasId: string,
  dependencies: CoverRevealDependencies = defaultDependencies,
): Promise<{ ok: true; job: CoverRevealJobView } | CoverRevealFailure> {
  const journey = await loadJourneyState(journeyId, atlasId);
  if (!journey) return { ok: false, error: "JOURNEY_UNAVAILABLE", status: 404 };

  const eligibility = evaluateCoverRevealEligibility(journey);
  if (!eligibility.ok) {
    return { ok: false, error: eligibility.reason, status: 409 };
  }

  await supersedeStaleDerivatives(
    journeyId,
    eligibility.source.id,
    eligibility.contentHash,
    dependencies,
  );

  const existing = await db
    .select()
    .from(coverRevealDerivatives)
    .where(and(
      eq(coverRevealDerivatives.journeyId, journeyId),
      eq(coverRevealDerivatives.sourceMediaAssetId, eligibility.source.id),
      eq(coverRevealDerivatives.sourceContentHash, eligibility.contentHash),
      eq(
        coverRevealDerivatives.generationKind,
        COVER_REVEAL_GENERATION_KIND,
      ),
      eq(
        coverRevealDerivatives.generationVersion,
        COVER_REVEAL_GENERATION_VERSION,
      ),
      inArray(coverRevealDerivatives.state, ["queued", "leased", "ready"]),
    ))
    .limit(1);
  if (existing[0]) return { ok: true, job: jobView(existing[0]) };

  const [created] = await db
    .insert(coverRevealDerivatives)
    .values({
      journeyId,
      sourceMediaAssetId: eligibility.source.id,
      sourceContentHash: eligibility.contentHash,
      generationKind: COVER_REVEAL_GENERATION_KIND,
      generationVersion: COVER_REVEAL_GENERATION_VERSION,
      presetId: COVER_REVEAL_DEFAULT_PRESET_ID,
      // Deterministic for this pinned source and this contract, so the same
      // cover re-queued after a failure reproduces the same output rather than
      // a different painting of the same photograph.
      seed: `${eligibility.contentHash.slice(0, 32)}`,
      state: "queued",
    })
    // The read above is an optimisation, not the guarantee. Two owner requests
    // arriving together both see no live row, so the live-identity partial
    // unique index is what actually makes enqueue idempotent: the loser
    // conflicts, inserts nothing, and reads the winner back.
    .onConflictDoNothing()
    .returning();
  if (created) return { ok: true, job: jobView(created) };

  const [won] = await db
    .select()
    .from(coverRevealDerivatives)
    .where(and(
      eq(coverRevealDerivatives.journeyId, journeyId),
      eq(coverRevealDerivatives.sourceMediaAssetId, eligibility.source.id),
      eq(coverRevealDerivatives.sourceContentHash, eligibility.contentHash),
      eq(coverRevealDerivatives.generationKind, COVER_REVEAL_GENERATION_KIND),
      eq(
        coverRevealDerivatives.generationVersion,
        COVER_REVEAL_GENERATION_VERSION,
      ),
      inArray(coverRevealDerivatives.state, ["queued", "leased", "ready"]),
    ))
    .limit(1);
  // The winner settled the job out of the live set between the conflict and
  // this read, which only a cover change can do; the caller asks again.
  if (!won) return { ok: false, error: "JOURNEY_UNAVAILABLE", status: 409 };
  return { ok: true, job: jobView(won) };
}

/**
 * #386: what the ordinary authenticated browser may display for one Journey,
 * decided here and never asserted by the client.
 *
 * The counterpart of `enqueueCoverRevealDerivative` on the same owner surface,
 * and the mirror image of the worker's `signCoverRevealSourceRead`: a worker
 * names a job it holds a lease for and is handed a read of the SOURCE; a
 * browser names a Journey it owns and is handed a read of the OUTPUT. Neither
 * principal can reach the other's object, because neither names a key — the
 * Journey identity is the only thing this takes from the caller, and the Atlas
 * beside it came from `requireAtlasAccess`.
 *
 * "Displayable" is re-derived in full on every call rather than looked up by
 * id, which is what makes an old metadata payload worthless as authority. The
 * current cover is resolved from live rows by the same
 * `evaluateCoverRevealEligibility` completion re-runs, and the derivative has
 * to be pinned to exactly that asset AND that verified stored-byte identity,
 * so replacing the cover, reordering media, replacing the photograph behind it
 * or entering the Journey's deletion grace window stops new display URLs on
 * the very next request, with no invalidation pass in between and no field a
 * client could have cached to change the answer.
 *
 * The read writes nothing. It does not enqueue the derivative it just found
 * missing — #386 is explicit that this read has no side effect, and the owner
 * already has a verb for that — and it does not supersede the stale `ready`
 * row it declines to serve, which is `reconcileCoverRevealDerivatives`' job:
 * turning a GET into a write would race the completion transaction's Journey
 * and media row locks for no gain, since declining to serve the row is already
 * the whole protection. Nothing here takes a lock at all.
 *
 * Canonical state is read twice on purpose, and the ready rows are fetched
 * between the two. The first reading decides only whether there is anything
 * worth looking for and answers an ineligible Journey; the SECOND one, taken
 * after the rows are in hand and immediately before signing, is what chooses
 * the row. A cover that moves while those rows are being fetched is therefore
 * caught rather than served — which a single consistent snapshot of state and
 * rows together could not do, since such a snapshot would simply agree with
 * the older reading.
 *
 * What is left open is the ordinary signed-URL window every private read in
 * the product has: a cover replaced a moment AFTER this signature is minted
 * leaves one already-issued URL alive for its TTL. That is bounded by the
 * owner media-read policy and it is the owner's own capability to the owner's
 * own derivative of the owner's own cover; the next read returns none. It is a
 * different window from the one above and the only one that remains: no
 * ordering of reads can close it, because it opens after the last of them.
 */
export async function readCoverRevealDisplay(
  journeyId: string,
  atlasId: string,
  displayReadExpiresInSeconds: number,
  dependencies: CoverRevealDependencies = defaultDependencies,
): Promise<CoverRevealDisplayResult> {
  // The Atlas is part of the lookup rather than checked afterwards, exactly as
  // `findLeasedJob` folds the lease into its predicate: a Journey of another
  // Atlas and a Journey that does not exist are one answer, so this cannot be
  // used to discover that some other member has a Journey — let alone that it
  // has a derivative.
  const journey = await loadJourneyState(journeyId, atlasId);
  if (!journey) return { ok: false, error: "JOURNEY_UNAVAILABLE", status: 404 };

  const eligibility = evaluateCoverRevealEligibility(journey);
  // A Journey inside its deletion grace window, without a cover, or with a
  // cover nothing can derive from answers 200 with no derivative rather than
  // the 409 the enqueue verb gives the same state. The two are asking
  // different questions: the enqueue is refusing to start work, which is a
  // decided outcome the caller has to see, while this is a read whose whole
  // contract is "display this or fall back to the canonical original" — and
  // the fallback IS the canonical original, so there is nothing to report as
  // an error.
  if (!eligibility.ok) {
    return { ok: true, derivative: null, reason: eligibility.reason };
  }

  // Every ready row this Journey has under the approved generation contract,
  // NOT the one pinned to the reading of the cover taken above. The live
  // identity index is unique per source rather than per Journey, so a Journey
  // can hold a ready row for the old cover beside one for the new: two owner
  // enqueues arriving together across a cover change both clear
  // `supersedeStaleDerivatives` before either inserts, and their inserts carry
  // different identities, so neither conflicts. Pinning this query to a cover
  // reading and taking the first row would make the choice between them depend
  // on which reading happened to be current. The set is bounded by that same
  // index, and the current cover picks from it below.
  const readyRows = await db
    .select()
    .from(coverRevealDerivatives)
    .where(and(
      eq(coverRevealDerivatives.journeyId, journeyId),
      eq(coverRevealDerivatives.generationKind, COVER_REVEAL_GENERATION_KIND),
      eq(
        coverRevealDerivatives.generationVersion,
        COVER_REVEAL_GENERATION_VERSION,
      ),
      eq(coverRevealDerivatives.state, "ready"),
    ));

  // The last word on canonical state is read AFTER the rows and immediately
  // before the capability is minted, because #386 asks for revalidation per
  // ISSUANCE and not merely once per request. Re-running the whole
  // `loadJourneyState` + eligibility pair rather than comparing a remembered
  // field re-checks Atlas membership, the deletion grace window and the cover
  // revision together, which is exactly the set a capability must not outlive:
  // a cover replaced, a source deleted or the Journey put into its deletion
  // grace window while the rows above were being fetched all land here and
  // mint nothing.
  const current = await loadJourneyState(journeyId, atlasId);
  if (!current) return { ok: false, error: "JOURNEY_UNAVAILABLE", status: 404 };
  const currentEligibility = evaluateCoverRevealEligibility(current);
  if (!currentEligibility.ok) {
    return { ok: true, derivative: null, reason: currentEligibility.reason };
  }

  // Both halves of the pin are compared, because the asset id alone does not
  // identify a revision: replacing the photograph behind the same cover asset
  // keeps the id and moves the verified stored-byte identity.
  const ready = readyRows.find((row) => (
    row.sourceMediaAssetId === currentEligibility.source.id
    && row.sourceContentHash === currentEligibility.contentHash
  ));

  // The output columns are checked rather than assumed. `ready` is written in
  // one statement with all five of them, so a row missing any is not a state
  // this code produces — but the columns are nullable because every other
  // lifecycle clears them, and a display capability is the last place to
  // resolve that with a non-null assertion.
  if (
    !ready
    || !ready.outputStorageDriver
    || !ready.outputStorageKey
    || !ready.outputMimeType
    || ready.outputWidth === null
    || ready.outputHeight === null
  ) {
    return { ok: true, derivative: null, reason: "NO_READY_DERIVATIVE" };
  }

  // The normal private-object signing path, on the backend the derivative was
  // actually written to — the same call `signPrivateMediaRead` makes for an
  // original, over one key this function chose. A deployment with no storage
  // throws `StorageUnavailableError` here and answers 503, because a
  // derivative it cannot serve must not be reported as displayable.
  const signed = await dependencies
    .storageForBackend(ready.outputStorageDriver)
    .createPrivateReadUrl({
      key: ready.outputStorageKey,
      expiresInSeconds: displayReadExpiresInSeconds,
    });

  return {
    ok: true,
    derivative: {
      id: ready.id,
      journeyId: ready.journeyId,
      generationKind: ready.generationKind,
      generationVersion: ready.generationVersion,
      presetId: ready.presetId,
      sourceMediaAssetId: ready.sourceMediaAssetId,
      sourceContentHash: ready.sourceContentHash,
      mimeType: ready.outputMimeType,
      width: ready.outputWidth,
      height: ready.outputHeight,
    },
    display: { url: signed.url, expiresAt: signed.expiresAt },
  };
}

/**
 * Claim at most one job, atomically.
 *
 * One statement. The inner `select ... for update skip locked limit 1` picks a
 * row and locks it; concurrent claimers skip a locked row instead of queueing
 * behind it, so of two workers racing for one queued job exactly one gets it
 * and the other is told there is nothing to do. `skip locked` is also what
 * makes several scheduled worker invocations safe: they take different jobs
 * rather than serialising on the same one.
 *
 * Reclaim falls out of the same predicate. A lease that has expired makes its
 * job selectable again, and the update overwrites `lease_token_hash`, which is
 * exactly what makes the previous claimant stale: ownership is the token, not
 * the clock, so a worker that finishes a moment late still completes IF nobody
 * reclaimed, and can never complete once somebody did.
 *
 * A fresh output key is minted per claim, because a reclaim is a new
 * generation and must not be able to publish whatever the previous claimant
 * may still be uploading. The key the job stops referencing is retired by the
 * sweeps below.
 */
export async function claimCoverRevealJob(
  settings: CoverRevealSettings,
  now: Date = new Date(),
  dependencies: CoverRevealDependencies = defaultDependencies,
): Promise<
  | { ok: true; job: CoverRevealJobView; leaseToken: string; leaseExpiresAt: Date }
  | { ok: false; error: "COVER_REVEAL_NO_WORK"; status: 404 }
> {
  const leaseToken = generateCoverRevealLeaseToken();
  const leaseTokenHash = hashCoverRevealLeaseToken(leaseToken);
  const leaseExpiresAt = new Date(
    now.getTime() + settings.leaseSeconds * 1_000,
  );
  const outputStorageKey = `${COVER_REVEAL_KEY_PREFIX}${randomUUID()}`;
  const outputStorageDriver = dependencies.configuredStorage().driver;

  const claimed = await db.execute<ClaimedRow>(sql`
    update ${coverRevealDerivatives}
    set
      ${sql.identifier("state")} = 'leased',
      ${sql.identifier("lease_token_hash")} = ${leaseTokenHash},
      ${sql.identifier("lease_expires_at")} = ${leaseExpiresAt},
      ${sql.identifier("attempts")} = ${coverRevealDerivatives.attempts} + 1,
      ${sql.identifier("output_storage_driver")} = ${outputStorageDriver},
      ${sql.identifier("output_storage_key")} = ${outputStorageKey},
      ${sql.identifier("output_mime_type")} = null,
      ${sql.identifier("output_bytes")} = null,
      ${sql.identifier("output_width")} = null,
      ${sql.identifier("output_height")} = null,
      ${sql.identifier("updated_at")} = now()
    where ${coverRevealDerivatives.id} = (
      select ${coverRevealDerivatives.id}
      from ${coverRevealDerivatives}
      where (
          ${coverRevealDerivatives.state} = 'queued'
          or (
            ${coverRevealDerivatives.state} = 'leased'
            and ${coverRevealDerivatives.leaseExpiresAt} <= ${now}
          )
        )
        and ${coverRevealDerivatives.attempts} < ${settings.maxAttempts}
        and exists (
          select 1 from ${journeys}
          where ${journeys.id} = ${coverRevealDerivatives.journeyId}
            and ${journeys.deletionStartedAt} is null
        )
      order by ${coverRevealDerivatives.createdAt}
      limit 1
      for update skip locked
    )
    returning ${coverRevealDerivatives.id} as "id",
      ${coverRevealDerivatives.journeyId} as "journeyId",
      ${coverRevealDerivatives.sourceMediaAssetId} as "sourceMediaAssetId",
      ${coverRevealDerivatives.sourceContentHash} as "sourceContentHash",
      ${coverRevealDerivatives.generationKind} as "generationKind",
      ${coverRevealDerivatives.generationVersion} as "generationVersion",
      ${coverRevealDerivatives.presetId} as "presetId",
      ${coverRevealDerivatives.seed} as "seed",
      ${coverRevealDerivatives.state} as "state",
      ${coverRevealDerivatives.attempts} as "attempts",
      ${coverRevealDerivatives.lastErrorCode} as "lastErrorCode",
      ${coverRevealDerivatives.outputStorageDriver} as "outputStorageDriver",
      ${coverRevealDerivatives.outputStorageKey} as "outputStorageKey"
  `);

  const job = claimed.rows[0];
  if (!job) return { ok: false, error: "COVER_REVEAL_NO_WORK", status: 404 };
  // The key the claim just stopped referencing belongs to nobody now. Dropping
  // it is best-effort here and guaranteed by `reconcileCoverRevealNamespace`.
  await discardSupersededClaimObject(job.id, outputStorageKey, dependencies);
  return { ok: true, job: jobView(job), leaseToken, leaseExpiresAt };
}

/**
 * Retire every object previously written for this job except the one it
 * references now. A reclaim leaves the older generation's object behind, and
 * its write record is the only thing that still knows the key.
 */
async function discardSupersededClaimObject(
  derivativeId: string,
  keptStorageKey: string,
  dependencies: CoverRevealDependencies,
) {
  const stale = await db
    .select()
    .from(coverRevealWrites)
    .where(eq(coverRevealWrites.derivativeId, derivativeId));
  for (const write of stale) {
    if (write.storageKey === keptStorageKey) continue;
    const discarded = await discardDerivativeObject(
      write.storageDriver,
      write.storageKey,
      dependencies,
    );
    if (!discarded) continue;
    await db
      .delete(coverRevealWrites)
      .where(eq(coverRevealWrites.id, write.id));
  }
}

/**
 * The job this caller actually owns right now, or nothing.
 *
 * The lease token hash is part of the lookup rather than checked afterwards,
 * so a worker that names a job id it did not claim cannot tell "wrong lease"
 * from "no such job" — and cannot enumerate jobs by trying ids.
 */
async function findLeasedJob(jobId: string, leaseToken: string) {
  const [job] = await db
    .select()
    .from(coverRevealDerivatives)
    .where(and(
      eq(coverRevealDerivatives.id, jobId),
      eq(
        coverRevealDerivatives.leaseTokenHash,
        hashCoverRevealLeaseToken(leaseToken),
      ),
    ))
    .limit(1);
  return job ?? null;
}

/**
 * How long a capability issued right now may live.
 *
 * The configured window, clamped to what is left of the lease. Without the
 * clamp a request made a second before expiry would hand out a five-minute
 * read that outlives the claim, so a worker whose job was reclaimed a moment
 * later would still be reading the source — and an already-expired claimant
 * could keep minting fresh capabilities until somebody reclaimed. An expired
 * lease therefore mints nothing at all.
 */
function capabilitySeconds(
  leaseExpiresAt: Date | null,
  configuredSeconds: number,
  now: Date,
) {
  if (!leaseExpiresAt) return 0;
  const remaining = Math.floor(
    (leaseExpiresAt.valueOf() - now.valueOf()) / 1_000,
  );
  return Math.min(configuredSeconds, Math.max(remaining, 0));
}

/**
 * A short-lived read of exactly the pinned source, and of nothing else.
 *
 * The key is never a parameter: it is read from the `media_assets` row the job
 * pinned, and the pinned stored-byte identity has to still match, so a worker
 * cannot be handed a read of an object the job was not pinned to even if the
 * cover moved under it. The signature is bounded by the job's own lease, so a
 * reclaim cannot leave an older claimant holding a live read.
 */
export async function signCoverRevealSourceRead(
  jobId: string,
  leaseToken: string,
  settings: CoverRevealSettings,
  dependencies: CoverRevealDependencies = defaultDependencies,
): Promise<
  | { ok: true; url: string; expiresAt: Date; mimeType: string; bytes: number }
  | CoverRevealFailure
> {
  const job = await findLeasedJob(jobId, leaseToken);
  if (!job) return { ok: false, error: "COVER_REVEAL_NOT_CLAIMED", status: 404 };
  const expiresInSeconds = capabilitySeconds(
    job.leaseExpiresAt,
    settings.sourceReadExpiresInSeconds,
    new Date(),
  );
  if (job.state !== "leased" || expiresInSeconds <= 0) {
    return { ok: false, error: "COVER_REVEAL_NOT_LEASED", status: 409 };
  }

  const [source] = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, job.sourceMediaAssetId))
    .limit(1);
  if (
    !source
    || !source.contentHashVerified
    || source.contentHash !== job.sourceContentHash
  ) {
    return { ok: false, error: "COVER_REVEAL_SOURCE_CHANGED", status: 409 };
  }

  const signed = await dependencies
    .storageForBackend(source.storageDriver)
    .createPrivateReadUrl({ key: source.storageKey, expiresInSeconds });
  return {
    ok: true,
    url: signed.url,
    expiresAt: signed.expiresAt,
    mimeType: source.mimeType,
    bytes: source.bytes,
  };
}

/**
 * A write for exactly the object this claim owns.
 *
 * The key comes from the job, so there is no storage key on this request to
 * point somewhere else; a worker that wants a different key would have to hold
 * a different lease. The write is RECORDED before it is signed, and before any
 * caller could hold the URL, so from here on the object has an owner no
 * cascade can take away — the same ordering `beginAssetPreview` uses and for
 * the same reason.
 */
export async function signCoverRevealOutputUpload(
  jobId: string,
  leaseToken: string,
  settings: CoverRevealSettings,
  dependencies: CoverRevealDependencies = defaultDependencies,
): Promise<
  | {
    ok: true;
    url: string;
    headers: Record<string, string>;
    expiresAt: Date;
    mimeType: string;
    maxBytes: number;
    maxEdgePixels: number;
  }
  | CoverRevealFailure
> {
  const job = await findLeasedJob(jobId, leaseToken);
  if (!job) return { ok: false, error: "COVER_REVEAL_NOT_CLAIMED", status: 404 };
  const now = new Date();
  const expiresInSeconds = capabilitySeconds(
    job.leaseExpiresAt,
    settings.uploadExpiresInSeconds,
    now,
  );
  if (job.state !== "leased" || !job.outputStorageKey || expiresInSeconds <= 0) {
    return { ok: false, error: "COVER_REVEAL_NOT_LEASED", status: 409 };
  }

  const storage = dependencies.storageForBackend(
    job.outputStorageDriver ?? dependencies.configuredStorage().driver,
  );
  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1_000);
  await db
    .insert(coverRevealWrites)
    .values({
      derivativeId: job.id,
      storageDriver: storage.driver,
      storageKey: job.outputStorageKey,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: coverRevealWrites.storageKey,
      set: { expiresAt },
    });
  const signed = await storage.signObjectUpload({
    key: job.outputStorageKey,
    mimeType: COVER_REVEAL_OUTPUT_MIME_TYPE,
    expiresInSeconds,
  });
  return {
    ok: true,
    url: signed.url,
    headers: signed.headers ?? {},
    expiresAt: signed.expiresAt,
    mimeType: COVER_REVEAL_OUTPUT_MIME_TYPE,
    maxBytes: settings.maxBytes,
    maxEdgePixels: settings.maxEdgePixels,
  };
}

/**
 * One decided failure of an attempt: back to the queue while the retry budget
 * lasts, terminal once it does not. Guarded on the lease this caller holds, so
 * it can never settle an attempt somebody else now owns.
 *
 * The lease columns are left where they are. They are the record of WHICH
 * claim settled the job, which is what makes a repeated call from the same
 * claimant converge instead of being mistaken for a stranger.
 */
async function settleAttemptFailure(
  job: CoverRevealDerivative,
  code: string,
  settings: CoverRevealSettings,
) {
  const [settled] = await db
    .update(coverRevealDerivatives)
    .set({
      state: job.attempts >= settings.maxAttempts ? "failed" : "queued",
      lastErrorCode: code,
      // The attempt's object stops being referenced here, and that is what
      // retires it. Both sweeps skip a key a derivative still points at, so a
      // terminal `failed` row that kept its key would pin whatever the worker
      // PUT — before or after it reported the failure — in the bucket forever.
      // A retry mints a fresh key at its next claim, so nothing needs this one.
      outputStorageDriver: null,
      outputStorageKey: null,
      outputMimeType: null,
      outputBytes: null,
      outputWidth: null,
      outputHeight: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(coverRevealDerivatives.id, job.id),
      eq(coverRevealDerivatives.leaseTokenHash, job.leaseTokenHash as string),
      eq(coverRevealDerivatives.state, "leased"),
    ))
    .returning();
  return settled ?? null;
}

/**
 * Publish the generated object, or refuse to.
 *
 * Everything is measured rather than believed: the object is inspected for its
 * byte size and read back for its encoded pixel size, and the Journey's cover
 * is RE-RESOLVED and compared against the pinned identity. That last check is
 * the one #368 cares most about — a derivative made from an image that is no
 * longer the cover must never attach to the new one — and it is a resolution
 * rather than a pointer comparison because the effective cover moves when
 * media is reordered or when the move/undo paths in `server/routes/uploads.ts`
 * null the pointer.
 *
 * A missing object leaves the job leased, because "the upload has not landed
 * yet" is retryable and turning a retryable fault into a permanent loss is the
 * mistake #260 already names. A violated ceiling or unreadable bytes are
 * decided outcomes: the object is dropped and the attempt is settled.
 *
 * Nothing on this path writes to `journeys` or to `media_assets`. The
 * canonical cover pointer, the source row and every `sort_order` are outside
 * the statements below, which is why a successful completion cannot change
 * them.
 */
export async function completeCoverRevealJob(
  jobId: string,
  leaseToken: string,
  settings: CoverRevealSettings,
  dependencies: CoverRevealDependencies = defaultDependencies,
): Promise<{ ok: true; job: CoverRevealJobView } | CoverRevealFailure> {
  const job = await findLeasedJob(jobId, leaseToken);
  if (!job) return { ok: false, error: "COVER_REVEAL_NOT_CLAIMED", status: 404 };
  // The retry of a call that already succeeded, from the claimant that made
  // it: the same answer, and nothing is written twice.
  if (job.state === "ready") return { ok: true, job: jobView(job) };
  if (job.state !== "leased" || !job.outputStorageKey) {
    return { ok: false, error: "COVER_REVEAL_NOT_LEASED", status: 409 };
  }

  const journey = await loadJourneyState(job.journeyId, null);
  const eligibility = journey
    ? evaluateCoverRevealEligibility(journey)
    : null;
  if (
    !eligibility
    || !eligibility.ok
    || eligibility.source.id !== job.sourceMediaAssetId
    || eligibility.contentHash !== job.sourceContentHash
  ) {
    await supersedeDerivative(job, dependencies);
    return { ok: false, error: "COVER_REVEAL_SOURCE_CHANGED", status: 409 };
  }

  const storage = dependencies.storageForBackend(
    job.outputStorageDriver ?? dependencies.configuredStorage().driver,
  );
  const inspected = await storage.inspectObject({ key: job.outputStorageKey });
  if (!inspected.exists) {
    return { ok: false, error: "COVER_REVEAL_OUTPUT_MISSING", status: 409 };
  }

  const reject = async (
    error:
      | "COVER_REVEAL_OUTPUT_TOO_LARGE"
      | "COVER_REVEAL_OUTPUT_PIXELS_TOO_LARGE"
      | "COVER_REVEAL_OUTPUT_UNREADABLE",
  ): Promise<CoverRevealFailure> => {
    const settled = await settleAttemptFailure(job, error, settings);
    if (!settled) {
      return { ok: false, error: "COVER_REVEAL_NOT_LEASED", status: 409 };
    }
    await discardDerivativeObject(
      job.outputStorageDriver,
      job.outputStorageKey,
      dependencies,
    );
    return { ok: false, error, status: 409 };
  };

  if (inspected.bytes > settings.maxBytes) {
    return reject("COVER_REVEAL_OUTPUT_TOO_LARGE");
  }
  const head = await storage.readObjectHead({
    key: job.outputStorageKey,
    maxBytes: JPEG_HEADER_WINDOW_BYTES,
  });
  if (!head.exists) {
    return { ok: false, error: "COVER_REVEAL_OUTPUT_MISSING", status: 409 };
  }
  // Both the stored type and the stored pixel size come out of this one read.
  // Bytes that are not a readable JPEG are not the issued
  // `COVER_REVEAL_OUTPUT_MIME_TYPE`, whatever content type the PUT declared,
  // so a mislabelled object is refused by the same check.
  const pixels = readJpegPixelSize(head.bytes);
  if (!pixels) return reject("COVER_REVEAL_OUTPUT_UNREADABLE");
  if (
    pixels.width > settings.maxEdgePixels
    || pixels.height > settings.maxEdgePixels
  ) {
    return reject("COVER_REVEAL_OUTPUT_PIXELS_TOO_LARGE");
  }

  /**
   * The publication itself, with the cover re-checked INSIDE the transaction
   * that writes `ready`.
   *
   * The check above this line is an early exit that saves a pointless storage
   * read; it cannot be the guarantee, because the owner may change or reorder
   * the cover between it and the write, and nothing about a Journey or media
   * mutation conflicts with the derivative row. Re-resolving under the same
   * row locks the mutation would have to take closes that window, so the state
   * a completion publishes is the state the Journey is in when it commits.
   */
  const outcome = await db.transaction(async (transaction) => {
    const current = await lockJourneyState(transaction, job.journeyId);
    const revalidated = current
      ? evaluateCoverRevealEligibility(current)
      : null;
    if (
      !revalidated
      || !revalidated.ok
      || revalidated.source.id !== job.sourceMediaAssetId
      || revalidated.contentHash !== job.sourceContentHash
    ) {
      await transaction
        .update(coverRevealDerivatives)
        .set({
          state: "superseded",
          supersededAt: new Date(),
          outputStorageKey: null,
          outputStorageDriver: null,
          outputMimeType: null,
          outputBytes: null,
          outputWidth: null,
          outputHeight: null,
          updatedAt: new Date(),
        })
        .where(eq(coverRevealDerivatives.id, job.id));
      return "superseded" as const;
    }
    const [row] = await transaction
      .update(coverRevealDerivatives)
      .set({
        state: "ready",
        outputMimeType: COVER_REVEAL_OUTPUT_MIME_TYPE,
        outputBytes: inspected.bytes,
        outputWidth: pixels.width,
        outputHeight: pixels.height,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(coverRevealDerivatives.id, job.id),
        eq(coverRevealDerivatives.leaseTokenHash, job.leaseTokenHash as string),
        eq(coverRevealDerivatives.state, "leased"),
      ))
      .returning();
    return row ?? null;
  });

  if (outcome === "superseded") {
    await discardDerivativeObject(
      job.outputStorageDriver,
      job.outputStorageKey,
      dependencies,
    );
    return { ok: false, error: "COVER_REVEAL_SOURCE_CHANGED", status: 409 };
  }
  // Somebody reclaimed between the measurement and the write; the object this
  // call measured belongs to the previous generation, not to the current one.
  if (!outcome) {
    return { ok: false, error: "COVER_REVEAL_NOT_LEASED", status: 409 };
  }
  return { ok: true, job: jobView(outcome) };
}

/**
 * The worker's own report that this attempt did not produce anything.
 *
 * The reason is a bounded code chosen from this server's own list, never the
 * worker's message: a free-text field written by an external process is the
 * easiest way for a signed URL or a credential to end up in the database and
 * then in a log.
 */
export async function failCoverRevealJob(
  jobId: string,
  leaseToken: string,
  reasonCode: string,
  settings: CoverRevealSettings,
  dependencies: CoverRevealDependencies = defaultDependencies,
): Promise<{ ok: true; job: CoverRevealJobView } | CoverRevealFailure> {
  const job = await findLeasedJob(jobId, leaseToken);
  if (!job) return { ok: false, error: "COVER_REVEAL_NOT_CLAIMED", status: 404 };
  // The retry of a failure this same claimant already reported.
  if (job.state === "queued" || job.state === "failed") {
    return { ok: true, job: jobView(job) };
  }
  if (job.state !== "leased") {
    return { ok: false, error: "COVER_REVEAL_NOT_LEASED", status: 409 };
  }
  const settled = await settleAttemptFailure(job, reasonCode, settings);
  if (!settled) {
    return { ok: false, error: "COVER_REVEAL_NOT_LEASED", status: 409 };
  }
  // Prompt best-effort removal of whatever the abandoned attempt may have
  // written; the namespace sweep is the guarantee behind it.
  await discardDerivativeObject(
    job.outputStorageDriver,
    job.outputStorageKey,
    dependencies,
  );
  return { ok: true, job: jobView(settled) };
}

/**
 * The cleanup rule, in one place: a derivative whose Journey no longer
 * resolves to the identity it was pinned to is superseded, and its object is
 * removed.
 *
 * `superseded` is terminal. It is not "failed" because nothing went wrong — the
 * member changed the cover, replaced the photograph or deleted the Journey —
 * and it is not deletion of the row, because the row is what makes a late
 * completion from the old claimant recognisable and refusable.
 */
async function supersedeDerivative(
  job: Pick<
    CoverRevealDerivative,
    "id" | "outputStorageDriver" | "outputStorageKey"
  >,
  dependencies: CoverRevealDependencies,
) {
  const superseded = await db
    .update(coverRevealDerivatives)
    .set({
      state: "superseded",
      supersededAt: new Date(),
      outputStorageKey: null,
      outputStorageDriver: null,
      outputMimeType: null,
      outputBytes: null,
      outputWidth: null,
      outputHeight: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(coverRevealDerivatives.id, job.id),
      inArray(coverRevealDerivatives.state, ["queued", "leased", "ready"]),
    ))
    .returning({ id: coverRevealDerivatives.id });
  if (superseded.length === 0) return false;
  await discardDerivativeObject(
    job.outputStorageDriver,
    job.outputStorageKey,
    dependencies,
  );
  return true;
}

async function supersedeStaleDerivatives(
  journeyId: string,
  sourceMediaAssetId: string | null,
  sourceContentHash: string | null,
  dependencies: CoverRevealDependencies,
) {
  const live = await db
    .select()
    .from(coverRevealDerivatives)
    .where(and(
      eq(coverRevealDerivatives.journeyId, journeyId),
      inArray(coverRevealDerivatives.state, ["queued", "leased", "ready"]),
    ));
  let superseded = 0;
  for (const job of live) {
    if (
      job.sourceMediaAssetId === sourceMediaAssetId
      && job.sourceContentHash === sourceContentHash
    ) {
      continue;
    }
    if (await supersedeDerivative(job, dependencies)) superseded += 1;
  }
  return superseded;
}

/**
 * Sweep every live derivative whose Journey has moved on.
 *
 * The prompt half of the invalidation contract: it knows the jobs by name, so
 * a replaced cover, a deleted source or a Journey that entered its deletion
 * grace window is superseded within one pass rather than waiting for a worker
 * to complete and be refused.
 */
export async function reconcileCoverRevealDerivatives(
  dependencies: CoverRevealDependencies = defaultDependencies,
) {
  const live = await db
    .select({
      journeyId: coverRevealDerivatives.journeyId,
    })
    .from(coverRevealDerivatives)
    .where(inArray(coverRevealDerivatives.state, ["queued", "leased", "ready"]))
    .groupBy(coverRevealDerivatives.journeyId);

  let superseded = 0;
  for (const { journeyId } of live) {
    const journey = await loadJourneyState(journeyId, null);
    const eligibility = journey
      ? evaluateCoverRevealEligibility(journey)
      : null;
    superseded += await supersedeStaleDerivatives(
      journeyId,
      eligibility?.ok ? eligibility.source.id : null,
      eligibility?.ok ? eligibility.contentHash : null,
      dependencies,
    );
  }
  return { examined: live.length, superseded };
}

/**
 * How long after a derivative write's own expiry its record is retired. The
 * margin only makes the window a closed one; nothing here concludes that a PUT
 * has finished, for the same reason `PREVIEW_WRITE_GRACE_MS` does not.
 */
const COVER_REVEAL_WRITE_GRACE_MS = 5 * 60 * 1_000;
const COVER_REVEAL_RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;
const COVER_REVEAL_WRITE_BATCH_SIZE = 50;
const COVER_REVEAL_NAMESPACE_PAGES_PER_PASS = 10;

function derivativeCleanup(dependencies: CoverRevealDependencies): DerivedObjectCleanup {
  return {
    findReferencedKeys: async (keys) => db
      .select({ key: coverRevealDerivatives.outputStorageKey })
      .from(coverRevealDerivatives)
      .where(inArray(coverRevealDerivatives.outputStorageKey, keys)),
    discardObject: (driver, key) => discardDerivativeObject(driver, key, dependencies),
  };
}

/** Retire the record of every derivative write whose signature has closed. */
export async function reconcileCoverRevealWrites(
  now = new Date(),
  dependencies: CoverRevealDependencies = defaultDependencies,
) {
  const cutoff = new Date(now.getTime() - COVER_REVEAL_WRITE_GRACE_MS);
  const writes = await db
    .select()
    .from(coverRevealWrites)
    .where(lt(coverRevealWrites.expiresAt, cutoff))
    .orderBy(coverRevealWrites.expiresAt)
    .limit(COVER_REVEAL_WRITE_BATCH_SIZE);

  return retireDerivedObjectWrites(writes, derivativeCleanup(dependencies), async (id) => db
    .delete(coverRevealWrites)
    .where(eq(coverRevealWrites.id, id)));
}

/**
 * Delete every object in the derivative namespace that no job references.
 *
 * The half that needs no records and no clock, and the reason a write record
 * may be forgotten freely. A key under this prefix was minted by a claim and
 * claimed before any producer held a URL for it, so "nothing references this"
 * can only become more true, never less.
 */
export async function reconcileCoverRevealNamespace(
  continuationToken?: string,
  dependencies: CoverRevealDependencies = defaultDependencies,
) {
  return reconcileDerivedObjectNamespace(
    dependencies.configuredStorage(),
    COVER_REVEAL_KEY_PREFIX,
    COVER_REVEAL_NAMESPACE_PAGES_PER_PASS,
    continuationToken,
    derivativeCleanup(dependencies),
  );
}

export function startCoverRevealReconciler() {
  if (!hasConfiguredStorageBackends()) return;
  let running = false;
  let namespaceCursor: string | undefined;
  const run = async () => {
    if (running) return;
    running = true;
    for (
      const [label, pass] of [
        [
          "Cover-reveal invalidation pass failed",
          async () => {
            await reconcileCoverRevealDerivatives();
          },
        ],
        [
          "Cover-reveal write reconciliation pass failed",
          async () => {
            await reconcileCoverRevealWrites();
          },
        ],
        [
          "Cover-reveal namespace reconciliation pass failed",
          async () => {
            namespaceCursor = (
              await reconcileCoverRevealNamespace(namespaceCursor)
            ).continuationToken;
          },
        ],
      ] as const
    ) {
      try {
        await pass();
      } catch (error) {
        console.error(
          label,
          error instanceof Error ? error.message : "unknown error",
        );
      }
    }
    running = false;
  };
  void run();
  const interval = setInterval(run, COVER_REVEAL_RECONCILE_INTERVAL_MS);
  interval.unref();
}
