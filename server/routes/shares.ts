import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import {
  evaluateShareGrant,
  generateShareToken,
  hashShareToken,
  MAX_SHARE_LIFETIME_MS,
  requireActiveShareGrant,
  shareUnavailable,
  type ShareGrantStatus,
} from "../authorization/share-access";
import { serverConfig } from "../config";
import { journeys, shareGrantJourneys, shareGrants } from "../db/app-schema";
import { db } from "../db/client";
import { lockActiveAtlas } from "../repositories/journey-repository";
import { loadSharedJourneyView } from "../repositories/shared-journey-repository";
import {
  capShareMediaTtlSeconds,
  resolveSharedMediaRead,
  type ShareMediaTtlLimits,
  type SharedMediaRead,
} from "../repositories/shared-media-repository";
import type { MultipartStorage } from "../storage/multipart-storage";
import { getMultipartStorage } from "../storage/storage-registry";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One link may carry a whole Atlas worth of journeys, but not an unbounded insert. */
export const MAX_SHARE_JOURNEYS = 64;

/**
 * A share response carries a bearer capability (the raw token) or the owner's
 * private link inventory. Neither may ever sit in a shared cache.
 */
export const SHARE_CACHE_CONTROL = "private, no-store";

type ShareInput = {
  journeyIds?: unknown;
  expiresAt?: unknown;
};

export type ShareValues = {
  journeyIds: string[];
  expiresAt: Date;
};

/**
 * Body validation only: shape, uniqueness, and an expiry the server clock
 * accepts. Whether those journeys belong to this Atlas is a database question
 * answered by the route. Malformed UUIDs are rejected here so no malformed
 * value ever reaches Postgres as a `uuid` comparison.
 *
 * The parsed body is `unknown` because a well-formed JSON document is not
 * necessarily an object: `null`, a number and a bare string all parse without
 * a `SyntaxError`, so only this guard keeps a property read off a non-object.
 * A body that is not valid JSON at all never reaches here; `readShareInput`
 * catches that `SyntaxError` and answers with the same `null`.
 */
export function parseShareInput(
  parsed: unknown,
  now: Date = new Date(),
): ShareValues | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as ShareInput;
  const journeyIds = body.journeyIds;
  if (
    !Array.isArray(journeyIds)
    || journeyIds.length < 1
    || journeyIds.length > MAX_SHARE_JOURNEYS
    || journeyIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || new Set(journeyIds as string[]).size !== journeyIds.length
  ) {
    return null;
  }
  if (typeof body.expiresAt !== "string") return null;
  const expiresAt = new Date(body.expiresAt);
  if (
    Number.isNaN(expiresAt.valueOf())
    || expiresAt.valueOf() <= now.valueOf()
    || expiresAt.valueOf() - now.valueOf() > MAX_SHARE_LIFETIME_MS
  ) {
    return null;
  }
  return { journeyIds: journeyIds as string[], expiresAt };
}

/**
 * Reads and validates the create body in one step. A syntactically malformed
 * document makes the read throw a `SyntaxError`, which the global `onError`
 * would otherwise turn into a generic `INVALID_JSON` 400 from outside the
 * route. Catching it here means every unusable body — malformed, non-object,
 * or well-shaped but invalid — leaves by the route's own `INVALID_SHARE`
 * envelope, telling a client nothing about which of the three it sent.
 *
 * The read is a thunk rather than a `Request` so the route keeps using Hono's
 * cached `context.req.json()` behind the body-limit middleware, while the test
 * can hand in a plain `Request`.
 */
export async function readShareInput(
  read: () => Promise<unknown>,
  now?: Date,
): Promise<ShareValues | null> {
  let parsed: unknown;
  try {
    parsed = await read();
  } catch {
    return null;
  }
  return parseShareInput(parsed, now);
}

/** Byte-order text comparison, matching how Postgres ordered these columns. */
function compareText(first: string, second: string): number {
  if (first < second) return -1;
  return first > second ? 1 : 0;
}

/**
 * The owner-facing status. `requireAtlasAccess` already refuses a deleting
 * Atlas, so the guest-only `atlas-unavailable` branch cannot appear here.
 */
function ownerStatus(
  grant: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): ShareGrantStatus {
  return evaluateShareGrant({ ...grant, atlasDeletionStartedAt: null }, now);
}

export const shareRoutes = new Hono();

/**
 * Creating a share is `create`, matching the journey it exposes. Revoking is
 * `update`, not `delete`: `delete` is owner-only in `permissions.ts`, which
 * would let a member create a link they could never withdraw. Create and
 * revoke must stay available to the same set of people.
 */
shareRoutes.post("/", async (context) => {
  const { atlas, session } = await requireAtlasAccess(context.req.raw, "create");
  const input = await readShareInput(() => context.req.json());
  if (!input) {
    return context.json(
      { error: "INVALID_SHARE", message: "Invalid share selection or expiry" },
      400,
    );
  }

  const rawToken = generateShareToken();
  // Selecting the journeys outside the transaction would authorize a state
  // that no longer holds by the time the rows are written: an Atlas or a
  // Journey marked deleting in between yields either a token
  // `requireActiveShareGrant()` rejects on sight, or a foreign-key 500 once
  // the row is gone. Both the Atlas row lock and the Journey rows are taken
  // inside the transaction, so the grant is written against exactly the state
  // it was authorized against. Lock order is Atlas first, then the Journey
  // rows by ascending id, matching every other Atlas-scoped write.
  const outcome = await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlas.id)) {
      return { error: "ATLAS_NOT_FOUND" } as const;
    }

    // The Journey rows are locked in ascending id order, the order every
    // other multi-Journey write in `uploads.ts` sorts its ids into, so two
    // writers holding an overlapping selection can never take the same two
    // rows in opposite orders and deadlock.
    const locked = await transaction
      .select({
        id: journeys.id,
        startedOn: journeys.startedOn,
        createdAt: journeys.createdAt,
      })
      .from(journeys)
      .where(and(
        eq(journeys.atlasId, atlas.id),
        inArray(journeys.id, input.journeyIds),
        isNull(journeys.deletionStartedAt),
      ))
      .orderBy(asc(journeys.id))
      .for("update");
    if (locked.length !== input.journeyIds.length) {
      return { error: "JOURNEY_NOT_FOUND" } as const;
    }

    // Lock order is an implementation detail; the stored sortOrder is not.
    // Canonical Journey chronology is the one deterministic order #200 asks
    // for, so the locked rows are re-ordered here and the recorded order
    // never depends on how the client listed the ids. `startedOn` is a
    // fixed-width ISO `date` string, so comparing it as text reproduces the
    // Postgres ordering, and the id breaks the tie the SQL ordering left
    // open.
    const selected = [...locked].sort((first, second) =>
      compareText(first.startedOn, second.startedOn)
      || first.createdAt.valueOf() - second.createdAt.valueOf()
      || compareText(first.id, second.id));

    const [created] = await transaction
      .insert(shareGrants)
      .values({
        atlasId: atlas.id,
        createdByUserId: session.user.id,
        tokenHash: hashShareToken(rawToken),
        expiresAt: input.expiresAt,
      })
      .returning({
        id: shareGrants.id,
        expiresAt: shareGrants.expiresAt,
        createdAt: shareGrants.createdAt,
      });
    await transaction.insert(shareGrantJourneys).values(
      selected.map((journey, index) => ({
        shareGrantId: created.id,
        journeyId: journey.id,
        sortOrder: index,
      })),
    );
    return { share: created, journeyCount: selected.length } as const;
  });
  if ("error" in outcome) return context.json({ error: outcome.error }, 404);
  const share = outcome.share;

  context.header("Cache-Control", SHARE_CACHE_CONTROL);
  // The only time the raw token exists outside the recipient's browser. It is
  // not stored, not logged, and `GET /api/shares` can never return it.
  return context.json(
    {
      share: {
        id: share.id,
        expiresAt: share.expiresAt,
        journeyCount: outcome.journeyCount,
        createdAt: share.createdAt,
      },
      token: rawToken,
    },
    201,
  );
});

shareRoutes.get("/", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  const rows = await db
    .select({
      id: shareGrants.id,
      createdAt: shareGrants.createdAt,
      expiresAt: shareGrants.expiresAt,
      revokedAt: shareGrants.revokedAt,
      lastAccessedAt: shareGrants.lastAccessedAt,
      journeyId: shareGrantJourneys.journeyId,
      journeyTitle: journeys.title,
    })
    .from(shareGrants)
    .leftJoin(
      shareGrantJourneys,
      eq(shareGrantJourneys.shareGrantId, shareGrants.id),
    )
    .leftJoin(journeys, eq(journeys.id, shareGrantJourneys.journeyId))
    .where(eq(shareGrants.atlasId, atlas.id))
    .orderBy(desc(shareGrants.createdAt), asc(shareGrantJourneys.sortOrder));

  const now = new Date();
  const shares: Array<{
    id: string;
    createdAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    lastAccessedAt: Date | null;
    status: ShareGrantStatus;
    journeyCount: number;
    journeys: Array<{ id: string; title: string }>;
  }> = [];
  const byId = new Map<string, (typeof shares)[number]>();
  for (const row of rows) {
    let share = byId.get(row.id);
    if (!share) {
      share = {
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        lastAccessedAt: row.lastAccessedAt,
        status: ownerStatus(row, now),
        journeyCount: 0,
        journeys: [],
      };
      byId.set(row.id, share);
      shares.push(share);
    }
    if (row.journeyId) {
      share.journeyCount += 1;
      share.journeys.push({
        id: row.journeyId,
        title: row.journeyTitle ?? "",
      });
    }
  }

  context.header("Cache-Control", SHARE_CACHE_CONTROL);
  return context.json({ shares });
});

shareRoutes.post("/:id/revoke", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const id = context.req.param("id");
  if (!UUID_PATTERN.test(id)) {
    return context.json({ error: "SHARE_NOT_FOUND" }, 404);
  }
  // Idempotent by `coalesce`: a second revoke keeps the first timestamp
  // instead of moving it, and never needs a read-then-write race window.
  const [revoked] = await db
    .update(shareGrants)
    .set({ revokedAt: sql`coalesce(${shareGrants.revokedAt}, now())` })
    .where(and(eq(shareGrants.id, id), eq(shareGrants.atlasId, atlas.id)))
    .returning({
      id: shareGrants.id,
      createdAt: shareGrants.createdAt,
      expiresAt: shareGrants.expiresAt,
      revokedAt: shareGrants.revokedAt,
    });
  if (!revoked) return context.json({ error: "SHARE_NOT_FOUND" }, 404);

  context.header("Cache-Control", SHARE_CACHE_CONTROL);
  return context.json({
    share: { ...revoked, status: ownerStatus(revoked, new Date()) },
  });
});

export const sharedRoutes = new Hono();

/**
 * Every guest response, including the generic unavailable 404 that
 * `requireActiveShareGrant` throws, carries the headers private shared content
 * needs. Set before the handler runs so Hono applies them to the response the
 * global `onError` builds on this same context, not only to the happy path.
 *
 * `Referrer-Policy` here is defence in depth rather than the fix: the token
 * lives in the fragment of the `/share#<token>` document, so the surface that
 * can leak it through `Referer` is that HTML document and the requests it
 * makes to third parties. Sending the policy on the API response costs nothing
 * and closes nothing on its own; the document-level policy and the `noindex`
 * meta tag belong to the guest viewer in phase D.
 */
sharedRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", SHARE_CACHE_CONTROL);
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Robots-Tag", "noindex, nofollow");
  return next();
});

/** An access record for the owner's audit column, not per-request telemetry. */
async function recordShareAccess(shareGrantId: string): Promise<void> {
  await db
    .update(shareGrants)
    .set({ lastAccessedAt: new Date() })
    .where(eq(shareGrants.id, shareGrantId));
}

/**
 * The guest read of the grant itself. Phase A exposes nothing about the
 * journeys — no ids, no titles, no counts of what was *not* shared — only the
 * two facts a viewer shell needs. Its `journeyCount` is grant membership, so
 * it still counts a granted journey that has started deleting; the phase B
 * read below reports the live readable set instead and is what the viewer
 * should trust.
 */
sharedRoutes.get("/grant", async (context) => {
  const grant = await requireActiveShareGrant(context.req.raw);
  await recordShareAccess(grant.id);
  const [selected] = await db
    .select({ value: count() })
    .from(shareGrantJourneys)
    .where(eq(shareGrantJourneys.shareGrantId, grant.id));

  return context.json({
    expiresAt: grant.expiresAt,
    journeyCount: selected.value,
  });
});

/**
 * #200 phase B: the whole guest payload — the granted journeys, their routes
 * and their media, and nothing else.
 *
 * There is no journey id, atlas id or token in the path or the query string:
 * the capability arrives only as `Authorization: Bearer`, and the scope comes
 * from the grant it resolves to. A guest therefore has nothing to enumerate.
 *
 * An active grant whose journeys have all been deleted answers 200 with an
 * empty set rather than the unavailable 404, because those are two different
 * product states: the link still works and its content is gone, which is what
 * `这些旅程目前不可查看` says, while the 404 is `这条分享链接已失效`.
 */
sharedRoutes.get("/journeys", async (context) => {
  const grant = await requireActiveShareGrant(context.req.raw);
  await recordShareAccess(grant.id);
  return context.json(await loadSharedJourneyView(grant));
});

/**
 * Turn a resolved asset into a signed URL that cannot outlive its grant.
 *
 * The lifetime is derived here rather than by the resolver because it has to
 * be measured from the clock the signature is about to be stamped with. A
 * duration computed before the authorization transaction ran would be a
 * promise about a moment already in the past: a request that waited on a
 * saturated connection pool would take the remaining lifetime it saw at entry
 * and start counting it from a later instant, so the URL would still be valid
 * for that long *after* the grant expired. `now` defaults here, one statement
 * before the presign, and nowhere earlier.
 *
 * The post-condition is checked rather than argued. `expiresInSeconds` is a
 * duration and the adapter stamps its own signing time, so the interface alone
 * cannot express "not past this instant"; comparing what came back against the
 * deadline is what makes the guarantee hold for any adapter, including one
 * that rounds its own expiry up. It refuses rather than returning a URL it
 * cannot stand behind.
 *
 * `resolveStorage` is injectable for tests only; the route always uses the
 * real registry.
 */
export async function signSharedMediaRead(
  resolved: SharedMediaRead,
  limits: ShareMediaTtlLimits,
  now: Date = new Date(),
  resolveStorage: (driver: string) => MultipartStorage = getMultipartStorage,
): Promise<{ url: string; expiresAt: string }> {
  const expiresInSeconds = capShareMediaTtlSeconds(
    limits,
    resolved.grantExpiresAt,
    now,
  );
  // The grant is still active but has under a second left. There is no honest
  // URL to issue: any signature would outlive the grant it came from.
  if (expiresInSeconds < 1) throw shareUnavailable();

  const signed = await resolveStorage(resolved.storageDriver)
    .createPrivateReadUrl({ key: resolved.storageKey, expiresInSeconds });
  if (signed.expiresAt.valueOf() > resolved.grantExpiresAt.valueOf()) {
    throw shareUnavailable();
  }
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

/**
 * #200 phase C: one short-lived signed storage URL for one asset of one
 * active grant.
 *
 * Media stays private in object storage, so the guest `<img>` and `<video>`
 * carry a presigned storage URL and never the share token. The path carries no
 * token either — the capability is the bearer header — so nothing here is
 * loggable at the edge, and the response body holds the signed URL, which no
 * log line touches.
 *
 * There are deliberately TWO unavailable shapes, and the distinction is about
 * what a guest is allowed to learn, not about disclosure:
 *
 * - grant-side causes — unknown token, revoked, expired, atlas deleting, and
 *   a grant with under a second left — all raise the same byte-identical
 *   `SHARE_UNAVAILABLE` 404 as every other guest route, so a token probe still
 *   cannot tell them apart. That is the link being dead.
 * - asset-side causes — malformed id, unknown id, an asset in an unshared
 *   journey of the same atlas, an asset in another atlas, an asset whose
 *   journey started deleting — all answer the same `MEDIA_UNAVAILABLE` 404, so
 *   they cannot be told apart either and existence is never disclosed. That is
 *   one picture being gone while the link still works, which is a different
 *   product state: a viewer must not tear down a whole session because the
 *   owner moved one photo.
 *
 * `lastAccessedAt` is not written here. #200 lists it as optional and the
 * journeys read already records the visit; a media read happens once per
 * asset, so recording it would turn a prefetching gallery into a burst of
 * writes on one row for no owner-visible gain.
 */
sharedRoutes.get("/assets/:assetId/read-url", async (context) => {
  const grant = await requireActiveShareGrant(context.req.raw);
  const assetId = context.req.param("assetId");
  // Not defensive: without this an unparseable id reaches a `uuid` comparison,
  // Postgres raises 22P02, and the generic 500 from `onError` would tell a
  // guest that its id was malformed rather than simply unavailable.
  const resolved = UUID_PATTERN.test(assetId)
    ? await resolveSharedMediaRead(grant, assetId)
    : null;
  if (!resolved) {
    return context.json(
      { error: "MEDIA_UNAVAILABLE", message: "Media unavailable" },
      404,
    );
  }
  return context.json(await signSharedMediaRead(resolved, {
    shareTtlSeconds: serverConfig.shareMediaReadUrlExpiresInSeconds,
    ownerTtlSeconds: serverConfig.mediaReadUrlExpiresInSeconds,
  }));
});
