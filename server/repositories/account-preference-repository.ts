import { eq, sql } from "drizzle-orm";
import { accountExperiencePreferences } from "../db/app-schema";
import { db } from "../db/client";
import {
  DEFAULT_EARTH_EXPERIENCE,
  isEarthExperiencePreference,
  type EarthExperiencePreference,
} from "../../src/journey/earthExperiencePreference";

/**
 * #387: the read and write side of one person's Earth experience preference.
 *
 * Everything here is keyed by the stable Better Auth user id the caller
 * resolved from the session. No function takes an Atlas, an Organization or a
 * share grant, and none of them reads a user id out of a request — a caller
 * that has not authenticated somebody has nothing to pass.
 *
 * `journey-repository.ts` serializes its writes on the Atlas row lock because
 * an Atlas write has to read a whole history first. Nothing here does: a
 * preference write is a single conditional upsert on one primary-key row, so
 * PostgreSQL's own row-level conflict handling is the serialization point and
 * an explicit lock would only widen the transaction for no invariant.
 */

/**
 * What the API answers with, present row or not.
 *
 * `revision` is 0 and `updatedAt` is null exactly when nothing was ever
 * stored. That is the shape a client needs to tell "this person has never
 * chosen" from "this person chose `default`", without the absence case
 * needing a different response shape or a 404.
 */
export type EarthExperiencePreferenceRecord = {
  earthExperience: EarthExperiencePreference;
  revision: number;
  updatedAt: Date | null;
};

const ABSENT: EarthExperiencePreferenceRecord = {
  earthExperience: DEFAULT_EARTH_EXPERIENCE,
  revision: 0,
  updatedAt: null,
};

/**
 * A stored value the running code does not recognise — a row written by a
 * newer deployment, or by hand. Reported as the default rather than handed to
 * the renderer, because an unknown policy must never be the thing that decides
 * whether detailed Earth resources may load.
 */
function readStoredValue(value: string): EarthExperiencePreference {
  return isEarthExperiencePreference(value) ? value : DEFAULT_EARTH_EXPERIENCE;
}

/**
 * Reads the preference for one stable user. Never writes: an absent row is
 * answered from `ABSENT`, so a read cannot create the row a later write would
 * otherwise have converged on, and reading somebody's preference leaves no
 * trace that they were looked at.
 */
export async function readEarthExperiencePreferenceForUser(
  userId: string,
): Promise<EarthExperiencePreferenceRecord> {
  const [row] = await db
    .select({
      earthExperience: accountExperiencePreferences.earthExperience,
      revision: accountExperiencePreferences.revision,
      updatedAt: accountExperiencePreferences.updatedAt,
    })
    .from(accountExperiencePreferences)
    .where(eq(accountExperiencePreferences.userId, userId));
  if (!row) return ABSENT;
  return {
    earthExperience: readStoredValue(row.earthExperience),
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

/**
 * Stores the preference for one stable user and answers with the row that is
 * now durable.
 *
 * One `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, which buys
 * three of this feature's rules at once:
 *
 * - it is atomic, so two concurrent writers cannot both insert and cannot
 *   interleave a read-then-write; whichever statement PostgreSQL applies last
 *   is the deterministic final winner, and both callers are answered with a
 *   row that really is durable at the moment they are told so. A failed
 *   statement throws, so nothing can report persistence success without a
 *   committed row;
 * - `revision` and `updated_at` advance only when the stored value actually
 *   changes, so a repeated same-value write is idempotent — one row, unmoved
 *   version truth, no ambiguous state;
 * - the `RETURNING` clause always yields a row, including on the no-op branch,
 *   so the caller never needs a follow-up read that a concurrent write could
 *   answer with somebody else's newer state.
 */
export async function writeEarthExperiencePreferenceForUser(
  userId: string,
  earthExperience: EarthExperiencePreference,
): Promise<EarthExperiencePreferenceRecord> {
  const changed = sql`${accountExperiencePreferences.earthExperience} is distinct from excluded.earth_experience`;
  const [row] = await db
    .insert(accountExperiencePreferences)
    .values({ userId, earthExperience, revision: 1 })
    .onConflictDoUpdate({
      target: accountExperiencePreferences.userId,
      set: {
        earthExperience: sql`excluded.earth_experience`,
        revision: sql`case when ${changed} then ${accountExperiencePreferences.revision} + 1 else ${accountExperiencePreferences.revision} end`,
        updatedAt: sql`case when ${changed} then now() else ${accountExperiencePreferences.updatedAt} end`,
      },
    })
    .returning({
      earthExperience: accountExperiencePreferences.earthExperience,
      revision: accountExperiencePreferences.revision,
      updatedAt: accountExperiencePreferences.updatedAt,
    });
  return {
    earthExperience: readStoredValue(row!.earthExperience),
    revision: row!.revision,
    updatedAt: row!.updatedAt,
  };
}
