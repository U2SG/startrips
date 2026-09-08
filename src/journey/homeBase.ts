/**
 * #231: Home Base as a timeline of dated life periods.
 *
 * Every rule that decides which Home Base applied to a date, and whether a
 * proposed period is a coherent addition to a history, lives here as a pure
 * function over ISO `YYYY-MM-DD` strings. `server/repositories/home-base-repository.ts`
 * imports the same predicates it is validated by, so the invariant a test
 * pins and the invariant the database write enforces cannot drift apart.
 *
 * Dates are compared as strings on purpose. A `date` column arrives as a
 * fixed-width ISO string, so byte order is chronological order — the same
 * reasoning `server/routes/shares.ts` documents on `compareText`. No `Date`
 * is constructed, so no local time zone can move a boundary by a day.
 *
 * Scope: this module is domain logic only. Quiet inference and confirmation
 * (#232), Atlas visual presence (#233), everyday fragments (#234) and the
 * Playback prelude (#235) are separate issues, and deriving a start date from
 * the first Journey belongs to #232 — never to this file.
 */

/** How the member came to confirm this period. */
export type HomeBaseSource = "manual" | "suggested-confirmed";

/**
 * The effective interval of one Home Base period, `startedOn <= date < endedOn`.
 * `endedOn === null` is the current period and has no upper bound.
 */
export type HomeBasePeriodInterval = {
  id: string;
  startedOn: string;
  endedOn: string | null;
};

/** The full period as it is stored and served. */
export type HomeBasePeriod = HomeBasePeriodInterval & {
  label: string;
  latitude: number;
  longitude: number;
  source: HomeBaseSource;
};

export const HOME_BASE_SOURCES: readonly HomeBaseSource[] = [
  "manual",
  "suggested-confirmed",
];

export function isHomeBaseSource(value: unknown): value is HomeBaseSource {
  return typeof value === "string"
    && (HOME_BASE_SOURCES as readonly string[]).includes(value);
}

/**
 * Half-open containment: the day a member moved belongs to the period that
 * started that day, not to the one that ended on it. That single asymmetry is
 * what makes a move day resolve to exactly one period.
 */
export function homeBasePeriodCoversDate(
  period: Pick<HomeBasePeriodInterval, "startedOn" | "endedOn">,
  date: string,
): boolean {
  if (date < period.startedOn) return false;
  return period.endedOn === null || date < period.endedOn;
}

/**
 * The Home Base that applied on `date`, or null when the history says nothing
 * about it — an Atlas with no periods, or a date before the earliest one. An
 * unknown start is never an infinite past: a period only ever answers for
 * dates at or after its own `startedOn`.
 *
 * A well-formed history has at most one covering period, so the sort only
 * matters for a history that is already inconsistent; the most recently
 * started period wins there, and the id breaks a remaining tie, so resolution
 * stays deterministic instead of depending on row order.
 */
export function resolveHomeBaseForDate<T extends HomeBasePeriodInterval>(
  periods: readonly T[],
  date: string,
): T | null {
  let resolved: T | null = null;
  for (const period of periods) {
    if (!homeBasePeriodCoversDate(period, date)) continue;
    if (
      resolved === null
      || period.startedOn > resolved.startedOn
      || (period.startedOn === resolved.startedOn && period.id > resolved.id)
    ) {
      resolved = period;
    }
  }
  return resolved;
}

/** Chronological order, with the id as the final tiebreak. */
export function sortHomeBasePeriods<T extends HomeBasePeriodInterval>(
  periods: readonly T[],
): T[] {
  return [...periods].sort((first, second) =>
    (first.startedOn < second.startedOn ? -1 : first.startedOn > second.startedOn ? 1 : 0)
    || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
}

export type HomeBasePeriodConflictCode =
  /** `endedOn` is not after `startedOn`, so the period answers for no date. */
  | "HOME_BASE_PERIOD_INVALID_INTERVAL"
  /** Two confirmed primary periods would claim the same day. */
  | "HOME_BASE_PERIOD_OVERLAP"
  /** A second open-ended current Home that is not expressible as a move. */
  | "HOME_BASE_PERIOD_ALREADY_OPEN";

export type HomeBasePeriodWriteDecision =
  | { outcome: "insert" }
  /** Close `closePeriodId` at `closeOn`, then write the candidate, atomically. */
  | { outcome: "move"; closePeriodId: string; closeOn: string }
  | { outcome: "conflict"; code: HomeBasePeriodConflictCode };

/** Half-open overlap, `null` read as an unbounded upper edge. */
function intervalsOverlap(
  first: Pick<HomeBasePeriodInterval, "startedOn" | "endedOn">,
  second: Pick<HomeBasePeriodInterval, "startedOn" | "endedOn">,
): boolean {
  const firstEndsBefore = first.endedOn !== null && first.endedOn <= second.startedOn;
  const secondEndsBefore = second.endedOn !== null && second.endedOn <= first.startedOn;
  return !firstEndsBefore && !secondEndsBefore;
}

/**
 * What a write should do with a proposed period, given the periods already
 * recorded for the Atlas.
 *
 * A create whose candidate is open-ended while an open period already exists
 * is the move: the open period closes on the day the new one starts, and both
 * writes land in one transaction. That is the north star as a code path rather
 * than as a warning — moving house adds a chapter, it does not overwrite the
 * one before it, and the earlier period keeps every date it already answered
 * for below the move day.
 *
 * `amendingId` marks a correction to one existing period. A correction never
 * reaches for a different row, so it is never a move: an amend that would
 * leave two open-ended periods is refused instead of quietly closing someone
 * else's period. The amended row is excluded from its own overlap check.
 */
export function classifyHomeBasePeriodWrite(input: {
  existing: readonly HomeBasePeriodInterval[];
  candidate: Pick<HomeBasePeriodInterval, "startedOn" | "endedOn">;
  amendingId?: string | null;
}): HomeBasePeriodWriteDecision {
  const { candidate, amendingId = null } = input;
  if (candidate.endedOn !== null && candidate.endedOn <= candidate.startedOn) {
    return { outcome: "conflict", code: "HOME_BASE_PERIOD_INVALID_INTERVAL" };
  }

  const others = input.existing.filter((period) => period.id !== amendingId);
  const openPeriods = others.filter((period) => period.endedOn === null);

  if (candidate.endedOn === null && openPeriods.length > 0) {
    // Only a single open period can be closed by a move, and only by a
    // candidate that starts strictly after it. Anything else — two open
    // periods already recorded, a candidate starting on or before the open
    // period's own start, or an amend — is a second current Home.
    const [open] = openPeriods;
    if (
      amendingId !== null
      || openPeriods.length > 1
      || candidate.startedOn <= open.startedOn
    ) {
      return { outcome: "conflict", code: "HOME_BASE_PERIOD_ALREADY_OPEN" };
    }
    const closed = { ...open, endedOn: candidate.startedOn };
    const remaining = others.filter((period) => period.id !== open.id);
    if (
      remaining.some((period) => intervalsOverlap(period, candidate))
      || remaining.some((period) => intervalsOverlap(period, closed))
    ) {
      return { outcome: "conflict", code: "HOME_BASE_PERIOD_OVERLAP" };
    }
    return { outcome: "move", closePeriodId: open.id, closeOn: candidate.startedOn };
  }

  if (others.some((period) => intervalsOverlap(period, candidate))) {
    return { outcome: "conflict", code: "HOME_BASE_PERIOD_OVERLAP" };
  }
  return { outcome: "insert" };
}
