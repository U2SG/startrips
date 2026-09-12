import { and, asc, eq, sql } from "drizzle-orm";
import { homeBaseDismissals, homeBasePeriods } from "../db/app-schema";
import { db } from "../db/client";
import { lockActiveAtlas } from "./journey-repository";
import {
  classifyHomeBasePeriodWrite,
  type HomeBasePeriod,
  type HomeBasePeriodConflictCode,
  type HomeBaseSource,
} from "../../src/journey/homeBase";
import type { HomeBaseDismissal } from "../../src/journey/homeBaseInference";

/**
 * #231: the write side of the Home Base timeline.
 *
 * Every invariant is decided by `classifyHomeBasePeriodWrite` in
 * `src/journey/homeBase.ts` — the same pure function its own test table
 * covers — and enforced inside one transaction that holds the Atlas row lock
 * first, exactly as `journey-repository.ts` does. That lock is the single
 * serialization point: two concurrent writers to one Atlas cannot both read a
 * history without the other's period, so a check-then-write here has no race
 * window and no database constraint has to reproduce the rule in SQL.
 */

export type HomeBasePeriodRecord = HomeBasePeriod & {
  createdAt: Date;
  updatedAt: Date;
};

export type HomeBasePeriodValues = {
  label: string;
  latitude: number;
  longitude: number;
  startedOn: string;
  endedOn: string | null;
  source: HomeBaseSource;
};

/** A correction may leave any field alone; an absent key is not a clear. */
export type HomeBasePeriodPatch = Partial<HomeBasePeriodValues>;

/**
 * An impossible history, refused. Carries the code the API answers with, so
 * `server/app.ts` `onError` maps every case to one 409 envelope instead of
 * each route re-deriving the status.
 */
export class HomeBasePeriodConflictError extends Error {
  constructor(
    readonly code: HomeBasePeriodConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "HomeBasePeriodConflictError";
  }
}

const CONFLICT_MESSAGES: Record<HomeBasePeriodConflictCode, string> = {
  HOME_BASE_PERIOD_INVALID_INTERVAL:
    "A Home Base period must end after it started",
  HOME_BASE_PERIOD_OVERLAP:
    "Another Home Base period already covers those dates",
  HOME_BASE_PERIOD_ALREADY_OPEN:
    "This Atlas already has a current Home Base period",
};

function refuse(code: HomeBasePeriodConflictCode): never {
  throw new HomeBasePeriodConflictError(code, CONFLICT_MESSAGES[code]);
}

const RECORD_COLUMNS = {
  id: homeBasePeriods.id,
  label: homeBasePeriods.label,
  latitude: homeBasePeriods.latitude,
  longitude: homeBasePeriods.longitude,
  startedOn: homeBasePeriods.startedOn,
  endedOn: homeBasePeriods.endedOn,
  source: homeBasePeriods.source,
  createdAt: homeBasePeriods.createdAt,
  updatedAt: homeBasePeriods.updatedAt,
} as const;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function asRecord(row: {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  startedOn: string;
  endedOn: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}): HomeBasePeriodRecord {
  return { ...row, source: row.source as HomeBaseSource };
}

/** Chronological, oldest first, so the current period is last. */
export async function listHomeBasePeriodsForAtlas(
  atlasId: string,
): Promise<HomeBasePeriodRecord[]> {
  const rows = await db
    .select(RECORD_COLUMNS)
    .from(homeBasePeriods)
    .where(eq(homeBasePeriods.atlasId, atlasId))
    .orderBy(asc(homeBasePeriods.startedOn), asc(homeBasePeriods.id));
  return rows.map(asRecord);
}

async function loadHistory(transaction: Transaction, atlasId: string) {
  return await transaction
    .select(RECORD_COLUMNS)
    .from(homeBasePeriods)
    .where(eq(homeBasePeriods.atlasId, atlasId))
    .orderBy(asc(homeBasePeriods.startedOn), asc(homeBasePeriods.id));
}

/**
 * Adds a period, and when the candidate is the new current Home while one is
 * already open, records the move: the previous period is closed on the day
 * the new one starts and the new one inserted in the same transaction, so no
 * reader can observe either two current Homes or none.
 *
 * Returns undefined when the Atlas is gone or being deleted, which the route
 * answers as a 404. Throws `HomeBasePeriodConflictError` for an impossible
 * history.
 */
export async function createHomeBasePeriodForAtlas(
  atlasId: string,
  values: HomeBasePeriodValues,
): Promise<HomeBasePeriodRecord | undefined> {
  return await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return undefined;

    const existing = await loadHistory(transaction, atlasId);
    const decision = classifyHomeBasePeriodWrite({
      existing,
      candidate: { startedOn: values.startedOn, endedOn: values.endedOn },
    });
    if (decision.outcome === "conflict") refuse(decision.code);

    if (decision.outcome === "move") {
      await transaction
        .update(homeBasePeriods)
        .set({ endedOn: decision.closeOn, updatedAt: new Date() })
        .where(and(
          eq(homeBasePeriods.id, decision.closePeriodId),
          eq(homeBasePeriods.atlasId, atlasId),
        ));
    }

    const [created] = await transaction
      .insert(homeBasePeriods)
      .values({ atlasId, ...values })
      .returning(RECORD_COLUMNS);
    return asRecord(created);
  });
}

/**
 * Corrects one recorded period — its place, its coordinates, or its dates.
 * Never touches another row: an amend that would leave two current Homes is
 * refused rather than silently closing the other one, because fixing a
 * mistake and recording a move are different acts.
 *
 * Returns undefined when the period does not belong to this Atlas, which the
 * route answers as a 404 without disclosing that the id exists elsewhere.
 */
export async function updateHomeBasePeriodForAtlas(
  atlasId: string,
  periodId: string,
  patch: HomeBasePeriodPatch,
): Promise<HomeBasePeriodRecord | undefined> {
  return await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return undefined;

    const existing = await loadHistory(transaction, atlasId);
    const current = existing.find((period) => period.id === periodId);
    if (!current) return undefined;

    const candidate = {
      startedOn: patch.startedOn ?? current.startedOn,
      endedOn: patch.endedOn === undefined ? current.endedOn : patch.endedOn,
    };
    const decision = classifyHomeBasePeriodWrite({
      existing,
      candidate,
      amendingId: periodId,
    });
    if (decision.outcome === "conflict") refuse(decision.code);

    const [updated] = await transaction
      .update(homeBasePeriods)
      .set({
        label: patch.label ?? current.label,
        latitude: patch.latitude ?? current.latitude,
        longitude: patch.longitude ?? current.longitude,
        startedOn: candidate.startedOn,
        endedOn: candidate.endedOn,
        source: patch.source ?? current.source,
        updatedAt: new Date(),
      })
      .where(and(
        eq(homeBasePeriods.id, periodId),
        eq(homeBasePeriods.atlasId, atlasId),
      ))
      .returning(RECORD_COLUMNS);
    // The Atlas lock above already excludes a concurrent removal of this row,
    // so an empty result is unreachable rather than merely unlikely. Answered
    // as "not found" anyway, so the read cannot become a dereference.
    return updated ? asRecord(updated) : undefined;
  });
}

/**
 * Removes one period from the history. Nothing else moves: Journeys, route
 * points and media are not referenced by this table in either direction, so
 * removing a life period is exactly a statement about where the member lived
 * and never a deletion of recorded travel.
 *
 * Takes the Atlas lock like every other write here, even though the statement
 * itself is a single scoped DELETE. Without it a removal could commit inside
 * the window an amend has already opened — between the history it loaded and
 * the row it is about to write — and the amend's own UPDATE would then match
 * nothing. Sharing one serialization point makes the two orders the only two
 * outcomes: the amend lands and the removal takes the amended row, or the
 * removal lands and the amend answers "not found".
 *
 * Returns undefined when the Atlas is gone or being deleted as well as when
 * the period is not this Atlas's, so a foreign id stays indistinguishable
 * from a missing one.
 */
export async function deleteHomeBasePeriodForAtlas(
  atlasId: string,
  periodId: string,
): Promise<{ id: string } | undefined> {
  return await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return undefined;
    const [deleted] = await transaction
      .delete(homeBasePeriods)
      .where(and(
        eq(homeBasePeriods.id, periodId),
        eq(homeBasePeriods.atlasId, atlasId),
      ))
      .returning({ id: homeBasePeriods.id });
    return deleted;
  });
}

/** Diagnostic count, used by the isolation and cascade assertions. */
export async function countHomeBasePeriodsForAtlas(
  atlasId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(homeBasePeriods)
    .where(eq(homeBasePeriods.atlasId, atlasId));
  return rows[0]?.total ?? 0;
}

/**
 * #232: the member's answer to a Home Base suggestion.
 *
 * One row per Atlas, so recording an answer is an upsert on the Atlas: the
 * surface asks about one region at a time and a later answer supersedes the
 * earlier one. The digest is stored verbatim — the inference core parses the
 * anchor and the supporting Journey ids back out of it — so this layer never
 * trims, truncates or normalises it.
 */
export async function readHomeBaseDismissalForAtlas(
  atlasId: string,
): Promise<HomeBaseDismissal | null> {
  const [row] = await db
    .select({
      kind: homeBaseDismissals.kind,
      digest: homeBaseDismissals.evidenceDigest,
      dismissedAt: homeBaseDismissals.dismissedOn,
    })
    .from(homeBaseDismissals)
    .where(eq(homeBaseDismissals.atlasId, atlasId))
    .limit(1);
  if (!row) return null;
  return { ...row, kind: row.kind as HomeBaseDismissal["kind"] };
}

export async function recordHomeBaseDismissalForAtlas(
  atlasId: string,
  values: { kind: HomeBaseDismissal["kind"]; digest: string; dismissedOn: string },
): Promise<HomeBaseDismissal | undefined> {
  return await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return undefined;
    const [row] = await transaction
      .insert(homeBaseDismissals)
      .values({
        atlasId,
        kind: values.kind,
        evidenceDigest: values.digest,
        dismissedOn: values.dismissedOn,
      })
      .onConflictDoUpdate({
        target: homeBaseDismissals.atlasId,
        set: {
          kind: values.kind,
          evidenceDigest: values.digest,
          dismissedOn: values.dismissedOn,
          updatedAt: new Date(),
        },
      })
      .returning({
        kind: homeBaseDismissals.kind,
        digest: homeBaseDismissals.evidenceDigest,
        dismissedAt: homeBaseDismissals.dismissedOn,
      });
    return { ...row, kind: row.kind as HomeBaseDismissal["kind"] };
  });
}
