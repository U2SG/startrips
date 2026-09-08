import { and, asc, eq, sql } from "drizzle-orm";
import { everydayFragments, homeBasePeriods } from "../db/app-schema";
import { db } from "../db/client";
import { lockActiveAtlas } from "./journey-repository";
import { homeBasePeriodCoversDate } from "../../src/journey/homeBase";
import type { EverydayFragmentValues } from "../../src/journey/everydayFragment";

/**
 * #234: the write side of Everyday Fragments.
 *
 * Atlas-scoped like every other record here, and every write takes the Atlas
 * row lock first, exactly as `journey-repository.ts` and
 * `home-base-repository.ts` do. The lock is what makes the Home Base
 * ownership check below a decision rather than a guess: a period cannot be
 * removed between the moment it is verified and the moment the fragment
 * referencing it is inserted.
 *
 * A fragment has no route and no revision, so there is no ordered child
 * collection to write atomically and no concurrent-edit guard to raise — a
 * fragment is one row, which is the point of the record type.
 */

export type EverydayFragmentRecord = {
  id: string;
  occurredOn: string;
  latitude: number;
  longitude: number;
  placeLabel: string | null;
  note: string | null;
  homeBasePeriodId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A write outcome, rather than one nullable record plus a comment about what
 * a null means. Each case is a different answer at the HTTP level, and the
 * route maps them without re-deriving anything: a missing Atlas, a fragment
 * this Atlas does not own, and a Home Base period this Atlas does not own are
 * three separate 404s, and a period that does not cover the fragment's own
 * date is a 409 about the recorded timeline rather than about the document.
 */
export type EverydayFragmentWriteResult =
  | { outcome: "ok"; fragment: EverydayFragmentRecord }
  | { outcome: "atlas-missing" }
  | { outcome: "fragment-missing" }
  | { outcome: "home-base-missing" }
  | { outcome: "home-base-not-covering" };

const RECORD_COLUMNS = {
  id: everydayFragments.id,
  occurredOn: everydayFragments.occurredOn,
  latitude: everydayFragments.latitude,
  longitude: everydayFragments.longitude,
  placeLabel: everydayFragments.placeLabel,
  note: everydayFragments.note,
  homeBasePeriodId: everydayFragments.homeBasePeriodId,
  createdByUserId: everydayFragments.createdByUserId,
  createdAt: everydayFragments.createdAt,
  updatedAt: everydayFragments.updatedAt,
} as const;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A fragment may name the life period it belongs to, but only one of this
 * Atlas's, and only one that actually held on the day the fragment happened.
 *
 * Ownership alone is not enough on either count. The foreign key would accept
 * another Atlas's period id and make it observable through the fragment it was
 * attached to — the same tenant leak `atlas-access.ts` exists to prevent one
 * level up. And a same-Atlas period whose interval does not contain
 * `occurredOn` would persist an association that disagrees with what
 * `resolveHomeBaseForDate` answers for that date, so a stored grouping and a
 * derived grouping would show the fragment in two different chapters of the
 * member's life. Coverage is decided by `homeBasePeriodCoversDate`, #231's own
 * half-open rule, so no second interval semantics is defined here.
 */
async function classifyHomeBaseAssociation(
  transaction: Transaction,
  atlasId: string,
  periodId: string,
  occurredOn: string,
): Promise<"ok" | "home-base-missing" | "home-base-not-covering"> {
  const [period] = await transaction
    .select({
      id: homeBasePeriods.id,
      startedOn: homeBasePeriods.startedOn,
      endedOn: homeBasePeriods.endedOn,
    })
    .from(homeBasePeriods)
    .where(and(
      eq(homeBasePeriods.id, periodId),
      eq(homeBasePeriods.atlasId, atlasId),
    ))
    .limit(1);
  if (!period) return "home-base-missing";
  return homeBasePeriodCoversDate(period, occurredOn)
    ? "ok"
    : "home-base-not-covering";
}

/**
 * Chronological, most recent first, then by id so the order is total. A
 * fragment list is read as "what happened lately", the opposite of the
 * oldest-first Home Base history it is grouped under.
 */
export async function listEverydayFragmentsForAtlas(
  atlasId: string,
): Promise<EverydayFragmentRecord[]> {
  return await db
    .select(RECORD_COLUMNS)
    .from(everydayFragments)
    .where(eq(everydayFragments.atlasId, atlasId))
    .orderBy(
      sql`${everydayFragments.occurredOn} desc`,
      asc(everydayFragments.id),
    );
}

export async function createEverydayFragmentForAtlas(
  atlasId: string,
  createdByUserId: string,
  values: EverydayFragmentValues,
): Promise<EverydayFragmentWriteResult> {
  return await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) {
      return { outcome: "atlas-missing" };
    }
    if (values.homeBasePeriodId !== null) {
      const association = await classifyHomeBaseAssociation(
        transaction,
        atlasId,
        values.homeBasePeriodId,
        values.occurredOn,
      );
      if (association !== "ok") return { outcome: association };
    }
    const [created] = await transaction
      .insert(everydayFragments)
      .values({ atlasId, createdByUserId, ...values })
      .returning(RECORD_COLUMNS);
    return { outcome: "ok", fragment: created };
  });
}

/**
 * A correction replaces every field of one fragment, because the route
 * validates a whole document rather than a patch: an everyday record has six
 * fields and no revision, so resending it is cheaper for a client than
 * reasoning about which keys clear a value.
 *
 * `createdByUserId` is deliberately not among them. Who recorded a fragment
 * is a fact about the past that correcting the note does not change.
 */
export async function updateEverydayFragmentForAtlas(
  atlasId: string,
  fragmentId: string,
  values: EverydayFragmentValues,
): Promise<EverydayFragmentWriteResult> {
  return await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) {
      return { outcome: "atlas-missing" };
    }
    if (values.homeBasePeriodId !== null) {
      const association = await classifyHomeBaseAssociation(
        transaction,
        atlasId,
        values.homeBasePeriodId,
        values.occurredOn,
      );
      if (association !== "ok") return { outcome: association };
    }
    const [updated] = await transaction
      .update(everydayFragments)
      .set({ ...values, updatedAt: new Date() })
      .where(and(
        eq(everydayFragments.id, fragmentId),
        eq(everydayFragments.atlasId, atlasId),
      ))
      .returning(RECORD_COLUMNS);
    return updated
      ? { outcome: "ok", fragment: updated }
      : { outcome: "fragment-missing" };
  });
}

/**
 * Removes one fragment. Its own media rows cascade with it, and nothing else
 * moves: a fragment is referenced by no Journey, route point or Home Base
 * period, so removing an ordinary evening cannot touch recorded travel. That
 * is asserted directly in `server/tests/everyday-fragments.integration.test.ts`
 * rather than trusted.
 *
 * Immediate, not the 7-day soft delete `journeys` carries. A fragment has no
 * route, no story and no share grant to withdraw, so there is nothing for a
 * grace window to protect.
 */
export async function deleteEverydayFragmentForAtlas(
  atlasId: string,
  fragmentId: string,
): Promise<{ id: string } | undefined> {
  return await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return undefined;
    const [deleted] = await transaction
      .delete(everydayFragments)
      .where(and(
        eq(everydayFragments.id, fragmentId),
        eq(everydayFragments.atlasId, atlasId),
      ))
      .returning({ id: everydayFragments.id });
    return deleted;
  });
}

/** Diagnostic count, used by the isolation and cascade assertions. */
export async function countEverydayFragmentsForAtlas(
  atlasId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(everydayFragments)
    .where(eq(everydayFragments.atlasId, atlasId));
  return rows[0]?.total ?? 0;
}
