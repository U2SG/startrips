import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import {
  evaluateShareGrant,
  generateShareToken,
  hashShareToken,
  MAX_SHARE_LIFETIME_MS,
  requireActiveShareGrant,
  type ShareGrantStatus,
} from "../authorization/share-access";
import { journeys, shareGrantJourneys, shareGrants } from "../db/app-schema";
import { db } from "../db/client";
import { lockActiveAtlas } from "../repositories/journey-repository";

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
  const input = parseShareInput(await context.req.json());
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
  // it was authorized against. Lock order is Atlas then Journeys, matching
  // every other Atlas-scoped write.
  const outcome = await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlas.id)) {
      return { error: "ATLAS_NOT_FOUND" } as const;
    }

    // Canonical Journey chronology is the one deterministic order #200 asks
    // for, so the stored sortOrder does not depend on how the client listed
    // the ids — and every caller locks these rows in that same order.
    const selected = await transaction
      .select({ id: journeys.id })
      .from(journeys)
      .where(and(
        eq(journeys.atlasId, atlas.id),
        inArray(journeys.id, input.journeyIds),
        isNull(journeys.deletionStartedAt),
      ))
      .orderBy(asc(journeys.startedOn), asc(journeys.createdAt))
      .for("update");
    if (selected.length !== input.journeyIds.length) {
      return { error: "JOURNEY_NOT_FOUND" } as const;
    }

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
 * The guest read of the grant itself. Phase A exposes nothing about the
 * journeys — no ids, no titles, no counts of what was *not* shared — only the
 * two facts a viewer shell needs before Phase B supplies the data.
 */
sharedRoutes.get("/grant", async (context) => {
  const grant = await requireActiveShareGrant(context.req.raw);
  await db
    .update(shareGrants)
    .set({ lastAccessedAt: new Date() })
    .where(eq(shareGrants.id, grant.id));
  const [selected] = await db
    .select({ value: count() })
    .from(shareGrantJourneys)
    .where(eq(shareGrantJourneys.shareGrantId, grant.id));

  context.header("Cache-Control", SHARE_CACHE_CONTROL);
  context.header("X-Robots-Tag", "noindex, nofollow");
  return context.json({
    expiresAt: grant.expiresAt,
    journeyCount: selected.value,
  });
});
