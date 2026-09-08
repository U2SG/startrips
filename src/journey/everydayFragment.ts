/**
 * #234: Everyday Fragment — one everyday experience rooted in a place.
 *
 * A fragment is deliberately smaller than a Journey: an occurrence date, one
 * position, and optionally a place label and a sentence. It requires no title
 * and no Route, and it can exist long before any Home Base is confirmed.
 *
 * This module holds every rule about that shape as pure functions, beside
 * `journeyModel.ts` rather than inside it. Journey validation is not relaxed
 * to accommodate the lighter record, and nothing here reclassifies a Journey:
 * a Journey that stays in one area is still a Journey, and the difference is
 * what the member set out to record, not how far they went.
 *
 * Refusals are typed reason codes, not prose, so the server can answer with
 * one and a caller can branch on it. Dates are compared and validated as
 * fixed-width ISO `YYYY-MM-DD` strings for the same reason `homeBase.ts`
 * documents: byte order is chronological order and no local time zone can
 * move a boundary by a day.
 *
 * Scope: the record core only. The semantic-zoom density reveal near Home,
 * the lightweight viewer and its Atlas entry point, the EXIF-driven "record it
 * as everyday" suggestion and Journey conversion are separate issues and
 * belong in no part of this file.
 */

import {
  resolveHomeBaseForDate,
  type HomeBasePeriodInterval,
} from "./homeBase";

/** The record as it is stored and served. Notably: no title, no route. */
export type EverydayFragment = {
  id: string;
  occurredOn: string;
  latitude: number;
  longitude: number;
  placeLabel: string | null;
  note: string | null;
  homeBasePeriodId: string | null;
};

/** What a caller may submit. Only the date and the coordinates are required. */
export type EverydayFragmentInput = {
  occurredOn?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  placeLabel?: unknown;
  note?: unknown;
  homeBasePeriodId?: unknown;
};

/** The normalized values a write is performed with. */
export type EverydayFragmentValues = {
  occurredOn: string;
  latitude: number;
  longitude: number;
  placeLabel: string | null;
  note: string | null;
  homeBasePeriodId: string | null;
};

export type EverydayFragmentReasonCode =
  /** `occurredOn` is absent or is not a fixed-width ISO calendar date. */
  | "EVERYDAY_FRAGMENT_INVALID_DATE"
  /** `latitude` is absent, non-finite, or outside [-90, 90]. */
  | "EVERYDAY_FRAGMENT_INVALID_LATITUDE"
  /** `longitude` is absent, non-finite, or outside [-180, 180]. */
  | "EVERYDAY_FRAGMENT_INVALID_LONGITUDE"
  /** An optional text field was sent as something other than text. */
  | "EVERYDAY_FRAGMENT_INVALID_TEXT"
  /** An optional text field exceeded its length ceiling. */
  | "EVERYDAY_FRAGMENT_TEXT_TOO_LONG"
  /** `homeBasePeriodId` was sent as something other than an identifier. */
  | "EVERYDAY_FRAGMENT_INVALID_HOME_BASE_PERIOD";

export type EverydayFragmentValidation =
  | { accepted: true; values: EverydayFragmentValues }
  | { accepted: false; reason: EverydayFragmentReasonCode };

export const MAX_EVERYDAY_FRAGMENT_PLACE_LABEL_LENGTH = 120;
export const MAX_EVERYDAY_FRAGMENT_NOTE_LENGTH = 2000;

const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fixed-width ISO calendar dates only, and a real day. `2026-6-1` would parse
 * as a date and then sort wrong against every other stored date, and
 * `2026-02-30` is not a day at all; both are refused.
 */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

function coordinate(value: unknown, limit: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= -limit && value <= limit ? value : null;
}

/**
 * An optional sentence or label. An absent key, an explicit null and a string
 * that is only whitespace all mean "not recorded" and normalize to null, so a
 * fragment never carries an empty string that renders as a blank line.
 */
function optionalText(
  value: unknown,
  maximum: number,
):
  | { ok: true; text: string | null }
  | { ok: false; reason: EverydayFragmentReasonCode }
{
  if (value === undefined || value === null) return { ok: true, text: null };
  if (typeof value !== "string") {
    return { ok: false, reason: "EVERYDAY_FRAGMENT_INVALID_TEXT" };
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum) {
    return { ok: false, reason: "EVERYDAY_FRAGMENT_TEXT_TOO_LONG" };
  }
  return { ok: true, text: trimmed || null };
}

/**
 * Validates and normalizes one submitted fragment.
 *
 * A title is not asked for and a route is not accepted, which is the whole
 * point of the record type: recording an ordinary evening must not require
 * naming it. What is required is the truth the fragment is about — the day it
 * happened and where — and each refusal names exactly which of those is wrong
 * so a client can point at one field instead of showing a paragraph.
 */
export function validateEverydayFragmentInput(
  input: EverydayFragmentInput,
): EverydayFragmentValidation {
  if (!isCalendarDate(input.occurredOn)) {
    return { accepted: false, reason: "EVERYDAY_FRAGMENT_INVALID_DATE" };
  }
  const latitude = coordinate(input.latitude, 90);
  if (latitude === null) {
    return { accepted: false, reason: "EVERYDAY_FRAGMENT_INVALID_LATITUDE" };
  }
  const longitude = coordinate(input.longitude, 180);
  if (longitude === null) {
    return { accepted: false, reason: "EVERYDAY_FRAGMENT_INVALID_LONGITUDE" };
  }
  const placeLabel = optionalText(
    input.placeLabel,
    MAX_EVERYDAY_FRAGMENT_PLACE_LABEL_LENGTH,
  );
  if (!placeLabel.ok) return { accepted: false, reason: placeLabel.reason };
  const note = optionalText(input.note, MAX_EVERYDAY_FRAGMENT_NOTE_LENGTH);
  if (!note.ok) return { accepted: false, reason: note.reason };

  const rawPeriodId = input.homeBasePeriodId;
  let homeBasePeriodId: string | null = null;
  if (rawPeriodId !== undefined && rawPeriodId !== null && rawPeriodId !== "") {
    if (typeof rawPeriodId !== "string" || !ID_PATTERN.test(rawPeriodId)) {
      return {
        accepted: false,
        reason: "EVERYDAY_FRAGMENT_INVALID_HOME_BASE_PERIOD",
      };
    }
    homeBasePeriodId = rawPeriodId;
  }

  return {
    accepted: true,
    values: {
      occurredOn: input.occurredOn,
      latitude,
      longitude,
      placeLabel: placeLabel.text,
      note: note.text,
      homeBasePeriodId,
    },
  };
}

/** One Home Base period and the fragments that fall inside its interval. */
export type EverydayFragmentGroup<
  TFragment,
  TPeriod extends HomeBasePeriodInterval,
> = {
  period: TPeriod;
  fragments: TFragment[];
};

/**
 * Fragments grouped by the life period they happened in, plus the ones no
 * period answers for.
 *
 * `ungrouped` is an explicit bucket rather than an absence: a member can
 * record an ordinary evening years before they ever confirm a Home Base, and
 * that evening is not an error and must not silently vanish from a grouping.
 */
export type EverydayFragmentGrouping<
  TFragment,
  TPeriod extends HomeBasePeriodInterval,
> = {
  groups: EverydayFragmentGroup<TFragment, TPeriod>[];
  ungrouped: TFragment[];
};

/**
 * Groups fragments under the Home Base period that held on each fragment's own
 * date, by asking `resolveHomeBaseForDate` — #231's single date-resolution
 * rule. No second resolver is defined here, so the half-open
 * `startedOn <= date < endedOn` semantics cannot drift between the two
 * features.
 *
 * Grouping is contextual and lossless. The returned fragments are the input
 * objects themselves: nothing rewrites a fragment's date or coordinates to sit
 * more neatly inside a period, and confirming a Home Base years later
 * reorganizes the view without editing a single recorded truth. `groups` is
 * ordered by the period order the caller passed in, so a chronological history
 * stays chronological here.
 */
export function groupEverydayFragmentsByHomeBase<
  TFragment extends { occurredOn: string },
  TPeriod extends HomeBasePeriodInterval,
>(
  fragments: readonly TFragment[],
  periods: readonly TPeriod[],
): EverydayFragmentGrouping<TFragment, TPeriod> {
  const groups = periods.map((period) => ({
    period,
    fragments: [] as TFragment[],
  }));
  const byPeriodId = new Map(groups.map((group) => [group.period.id, group]));
  const ungrouped: TFragment[] = [];

  for (const fragment of fragments) {
    const period = resolveHomeBaseForDate(periods, fragment.occurredOn);
    const group = period === null ? undefined : byPeriodId.get(period.id);
    if (group) group.fragments.push(fragment);
    else ungrouped.push(fragment);
  }

  return { groups, ungrouped };
}
