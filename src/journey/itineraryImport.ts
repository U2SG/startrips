/**
 * #512: turning an itinerary a member already holds — a shared plan link, a
 * screenshot, or pasted text — into a reviewable Route draft.
 *
 * Three rules shape everything below.
 *
 * - **The source is evidence, not truth.** Every entry keeps the name exactly
 *   as it was read, the day it was listed under, its order inside that day and
 *   where it came from. Nothing here rewrites a name, infers a missing year,
 *   invents a venue behind a truncation, or drops a day the source left empty.
 *   What cannot be read stays unread and becomes a confirmation reason.
 * - **Counting is never reconciled.** `sourceReportedPlaceCount` (what the
 *   page claimed), the recognised entry count, the pending-confirmation count
 *   and the Route Points actually added are four separate numbers. They are
 *   allowed to disagree, and a draft that disagrees is `partial` or
 *   `needs-review` rather than padded until the numbers match.
 * - **A plan is not a recording.** The output is a draft of Route Point values
 *   for the Composer to review and save through the existing authorized path.
 *   It carries no captured media, produces no recorded-track sample and is no
 *   evidence that anybody was ever there.
 *
 * Region context and role live on the import draft, not inside the
 * `RouteDraftPoint` it produces. A Route Point is what `routeDraftToInput`
 * sends to the server and that contract is fixed; the reading context #514
 * wants preserved travels beside the point, where it can be shown and grouped
 * without ever widening the wire document.
 */

import type { RouteDraftPoint } from "./routeDraft";
import type { RoutePointInput } from "./types";

/** Which entry point produced a draft. All three share one contract. */
export type ItinerarySourceKind = "link" | "image" | "text";

/**
 * What an entry is doing in the plan. `pure-transit` is a position the plan
 * passes through without stopping. Its endpoints shape the Route; a flight
 * number itself is not a place to geocode.
 */
export type ItineraryEntryRole =
  | "accommodation"
  | "attraction"
  | "transport"
  | "pure-transit"
  | "activity";

/**
 * A readable fact about one entry that the member has to resolve. Every flag
 * is something observed in the source, never a judgement about the real world:
 * `source-invalid` says the page marked it invalid, not that a venue closed.
 */
export type ItineraryEntryFlag =
  | "source-invalid"
  | "truncated"
  | "year-unconfirmed"
  | "unresolved-position"
  | "possible-repeat-visit";

/** A whole-draft observation that belongs to no single entry. */
export type ItineraryDraftNotice =
  | "source-day-count-mismatch"
  | "source-place-count-mismatch"
  | "empty-day-preserved"
  | "year-unconfirmed";

export type ItineraryDraftState = "complete" | "partial" | "needs-review";

/**
 * One candidate exactly as a recogniser reported it: the pasted-text reader in
 * `itineraryText.ts`, or the server-side recognition adapter. Deliberately
 * flat and versioned — a recogniser proposes readings, and every rule about
 * ordering, flags and counting is applied here, on data the recogniser cannot
 * influence beyond what it literally read.
 */
export type ItineraryRecognitionEntry = {
  sourceEntryId: string | null;
  dayNumber: number;
  orderInDay: number;
  /** The name as printed. Never normalised, translated or completed. */
  name: string;
  /** Confirmable aliases only; an alias never replaces `name`. */
  aliases?: string[];
  /** Search hint only; the geocoder must still supply the actual position. */
  countryCode?: string | null;
  searchArea?: string | null;
  /** The region heading this entry was listed under, if the source had one. */
  regionContext?: string | null;
  role: ItineraryEntryRole;
  /** A transport leg's two endpoints as printed, kept unmerged. */
  transitEndpoints?: { from: string; to: string } | null;
  truncated?: boolean;
  sourceInvalid?: boolean;
  latitude?: number | null;
  longitude?: number | null;
};

export type ItineraryRecognitionDay = {
  dayNumber: number;
  /** The day heading as printed, kept even when it disagrees with the dates. */
  sourceDayTitle: string | null;
  /** `YYYY-MM-DD`, present only when the source stated a year. */
  calendarDate: string | null;
  /** `MM-DD` when the source stated no year. The year stays unconfirmed. */
  partialDate: string | null;
  regionContext?: string | null;
};

export type ItineraryRecognition = {
  /** The recogniser contract version, so an old reading stays interpretable. */
  contractVersion: 1;
  sourceKind: ItinerarySourceKind;
  /** Which reader produced this, e.g. `text-itinerary/1` or a model version. */
  recognizerVersion: string;
  sourceTitle: string | null;
  /** What the page claimed, for comparison only. Never a target to reach. */
  sourceReportedDayCount: number | null;
  sourceReportedPlaceCount: number | null;
  days: ItineraryRecognitionDay[];
  entries: ItineraryRecognitionEntry[];
};

export type ItineraryEntryDraft = {
  /** Stable inside one import job, so re-applying the job is detectable. */
  entryId: string;
  sourceEntryId: string | null;
  dayNumber: number;
  orderInDay: number;
  name: string;
  aliases: string[];
  countryCode: string | null;
  searchArea: string | null;
  regionContext: string | null;
  role: ItineraryEntryRole;
  transitEndpoints: { from: string; to: string } | null;
  latitude: number | null;
  longitude: number | null;
  flags: ItineraryEntryFlag[];
  needsConfirmation: boolean;
  /**
   * An earlier entry carrying the same printed name. A hint for the member,
   * never a merge: a multi-day stay, a one-day multi-region sequence and an
   * A to B back to A revisit all keep one entry per visit.
   */
  suggestedMergeWithEntryId: string | null;
};

export type ItineraryDayDraft = {
  dayNumber: number;
  sourceDayTitle: string | null;
  calendarDate: string | null;
  partialDate: string | null;
  yearConfirmed: boolean;
  regionContext: string | null;
  entries: ItineraryEntryDraft[];
};

/**
 * Four counts that are never reconciled with each other.
 * `addedRoutePointCount` stays 0 until a selection really becomes Route Points.
 */
export type ItineraryImportCounts = {
  sourceReportedPlaceCount: number | null;
  recognizedEntryCount: number;
  pendingConfirmationCount: number;
  addedRoutePointCount: number;
};

export type ItineraryImportDraft = {
  jobKey: string;
  sourceKind: ItinerarySourceKind;
  recognizerVersion: string;
  sourceTitle: string | null;
  sourceReportedDayCount: number | null;
  days: ItineraryDayDraft[];
  counts: ItineraryImportCounts;
  notices: ItineraryDraftNotice[];
  state: ItineraryDraftState;
};

/**
 * A Route Point the member may add, with the reading context #514 asks to
 * preserve travelling beside it rather than inside it.
 */
export type ItineraryRoutePointDraft = {
  entryId: string;
  point: RouteDraftPoint;
  regionContext: string | null;
  role: ItineraryEntryRole;
};

function stableEntryId(
  jobKey: string,
  entry: ItineraryRecognitionEntry,
  index: number,
) {
  const source = entry.sourceEntryId?.trim();
  return source
    ? `${jobKey}:${source}`
    : `${jobKey}:d${entry.dayNumber}-${entry.orderInDay}-${index}`;
}

/**
 * Transport and pure pass-through positions shape a Route without becoming
 * Stops. A venue-free activity is source context, not a Route Point.
 */
function isStopRole(role: ItineraryEntryRole) {
  return role !== "pure-transit" && role !== "transport" && role !== "activity";
}

function isNonPlaceRole(role: ItineraryEntryRole) {
  return role === "activity";
}

/** An endpoint-only leg is travel between places, not a separate waypoint. */
export function isEndpointOnlyLeg(entry: ItineraryRecognitionEntry) {
  return (entry.role === "pure-transit" || entry.role === "transport")
    && entry.transitEndpoints != null && !hasPosition(entry);
}

function needsEntryConfirmation(flags: readonly ItineraryEntryFlag[]) {
  return flags.some((flag) => flag !== "possible-repeat-visit" && flag !== "year-unconfirmed");
}

function hasPosition(entry: ItineraryRecognitionEntry) {
  return typeof entry.latitude === "number"
    && typeof entry.longitude === "number"
    && Number.isFinite(entry.latitude)
    && Number.isFinite(entry.longitude);
}

function repeatKey(name: string) {
  return name.trim().normalize("NFKC").toLocaleLowerCase();
}

/**
 * The identity of one import job.
 *
 * It is derived from what was submitted and nothing else, so the same link,
 * the same pasted text or the same image bytes submitted twice — a retry, a
 * lost response, a second click — produce the same key and therefore the same
 * imported draft ids, which is what makes the apply step a replay instead of a
 * second copy. Not a security value and never used as one.
 */
export function itineraryImportJobKey(
  sourceKind: ItinerarySourceKind,
  submitted: string,
): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < submitted.length; index += 1) {
    hash ^= submitted.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${sourceKind}-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Attach a position a member confirmed from the existing place search.
 *
 * Extraction and positioning are two steps on purpose: a recogniser reports
 * what a plan printed, and only the place service and the member decide where
 * that is. The printed name is never replaced — a confirmed rendering joins
 * `aliases` beside it.
 */
export function resolveItineraryEntryPosition(
  draft: ItineraryImportDraft,
  entryId: string,
  position: { latitude: number; longitude: number; alias?: string },
): ItineraryImportDraft {
  let changed = false;
  const days = draft.days.map((day) => ({
    ...day,
    entries: day.entries.map((entry) => {
      if (entry.entryId !== entryId) return entry;
      changed = true;
      const flags = entry.flags.filter((flag) => flag !== "unresolved-position");
      return {
        ...entry,
        latitude: position.latitude,
        longitude: position.longitude,
        aliases: position.alias && !entry.aliases.includes(position.alias)
          ? [...entry.aliases, position.alias]
          : entry.aliases,
        flags,
        needsConfirmation: needsEntryConfirmation(flags),
      };
    }),
  }));
  if (!changed) return draft;

  const pendingConfirmationCount = days
    .flatMap((day) => day.entries)
    .filter((entry) => entry.needsConfirmation)
    .length;
  return {
    ...draft,
    days,
    counts: { ...draft.counts, pendingConfirmationCount },
    state: draftState(
      draft.notices,
      pendingConfirmationCount,
      draft.counts.recognizedEntryCount,
    ),
  };
}

/**
 * Build the reviewable draft.
 *
 * Source order is preserved exactly: days keep the order the recogniser
 * reported and entries keep `orderInDay`, so a source whose day title
 * disagrees with its listed dates produces a notice rather than a reordering.
 */
export function buildItineraryImportDraft(
  recognition: ItineraryRecognition,
  jobKey: string,
): ItineraryImportDraft {
  const notices: ItineraryDraftNotice[] = [];
  const seenNames = new Map<string, string>();

  const drafts: ItineraryEntryDraft[] = recognition.entries.map((entry, index) => {
    const entryId = stableEntryId(jobKey, entry, index);
    const flags: ItineraryEntryFlag[] = [];
    if (entry.sourceInvalid) flags.push("source-invalid");
    if (entry.truncated) flags.push("truncated");
    if (!isEndpointOnlyLeg(entry) && !isNonPlaceRole(entry.role) && !hasPosition(entry)) {
      flags.push("unresolved-position");
    }

    // The same printed name seen before — adjacent or not — is a hint and
    // nothing more. Both visits survive; only the member decides they are one.
    const key = repeatKey(entry.name);
    const earlier = key ? seenNames.get(key) ?? null : null;
    if (earlier) flags.push("possible-repeat-visit");
    if (key && !earlier) seenNames.set(key, entryId);

    return {
      entryId,
      sourceEntryId: entry.sourceEntryId ?? null,
      dayNumber: entry.dayNumber,
      orderInDay: entry.orderInDay,
      name: entry.name,
      aliases: entry.aliases ? [...entry.aliases] : [],
      countryCode: entry.countryCode ?? null,
      searchArea: entry.searchArea ?? null,
      regionContext: entry.regionContext ?? null,
      role: entry.role,
      transitEndpoints: entry.transitEndpoints ?? null,
      latitude: hasPosition(entry) ? entry.latitude ?? null : null,
      longitude: hasPosition(entry) ? entry.longitude ?? null : null,
      flags,
      // A repeat hint alone is not a question: the plan really does list it
      // twice, and importing both is the correct default.
      needsConfirmation: needsEntryConfirmation(flags),
      suggestedMergeWithEntryId: earlier,
    };
  });

  const days: ItineraryDayDraft[] = recognition.days.map((day) => {
    const yearConfirmed = day.calendarDate !== null;
    if (!yearConfirmed) notices.push("year-unconfirmed");
    const entries = drafts
      .filter((entry) => entry.dayNumber === day.dayNumber)
      .sort((left, right) => left.orderInDay - right.orderInDay)
      .map((entry) => (
        yearConfirmed
          ? entry
          : {
            ...entry,
            flags: [...entry.flags, "year-unconfirmed" as const],
            needsConfirmation: entry.needsConfirmation,
          }
      ));
    if (entries.length === 0) notices.push("empty-day-preserved");
    return {
      dayNumber: day.dayNumber,
      sourceDayTitle: day.sourceDayTitle,
      calendarDate: day.calendarDate,
      partialDate: day.partialDate,
      yearConfirmed,
      regionContext: day.regionContext ?? null,
      entries,
    };
  });

  if (
    recognition.sourceReportedDayCount !== null
    && recognition.sourceReportedDayCount !== days.length
  ) {
    notices.push("source-day-count-mismatch");
  }
  if (
    recognition.sourceReportedPlaceCount !== null
    && recognition.sourceReportedPlaceCount !== drafts.length
  ) {
    notices.push("source-place-count-mismatch");
  }

  const pendingConfirmationCount = days
    .flatMap((day) => day.entries)
    .filter((entry) => entry.needsConfirmation)
    .length;

  return {
    jobKey,
    sourceKind: recognition.sourceKind,
    recognizerVersion: recognition.recognizerVersion,
    sourceTitle: recognition.sourceTitle,
    sourceReportedDayCount: recognition.sourceReportedDayCount,
    days,
    counts: {
      sourceReportedPlaceCount: recognition.sourceReportedPlaceCount,
      recognizedEntryCount: drafts.length,
      pendingConfirmationCount,
      addedRoutePointCount: 0,
    },
    notices: [...new Set(notices)],
    state: draftState(notices, pendingConfirmationCount, drafts.length),
  };
}

function draftState(
  notices: readonly ItineraryDraftNotice[],
  pendingConfirmationCount: number,
  recognizedEntryCount: number,
): ItineraryDraftState {
  if (recognizedEntryCount === 0) return "needs-review";
  if (pendingConfirmationCount > 0) return "needs-review";
  if (
    notices.includes("source-place-count-mismatch")
    || notices.includes("source-day-count-mismatch")
  ) {
    return "partial";
  }
  return "complete";
}

export function itineraryDraftEntries(
  draft: ItineraryImportDraft,
): ItineraryEntryDraft[] {
  return draft.days.flatMap((day) => day.entries);
}

/**
 * The entries a member gets by default: everything the source listed as a real
 * plan item and that has a position to put on the Route. An entry the source
 * marked invalid, or one whose position never resolved, waits for an explicit
 * confirmation instead of arriving silently.
 */
export function defaultItinerarySelection(
  draft: ItineraryImportDraft,
): string[] {
  return itineraryDraftEntries(draft)
    .filter((entry) => (
      !entry.flags.includes("source-invalid")
      && !entry.flags.includes("unresolved-position")
      && !isEndpointOnlyLeg(entry)
      && !isNonPlaceRole(entry.role)
    ))
    .map((entry) => entry.entryId);
}

/**
 * Turn the reviewed selection into Route Point drafts, in plan order.
 *
 * `occurredAt` is set only from a day whose year the source actually stated.
 * An unconfirmed year yields a Route Point with no date rather than one dated
 * from today's year, because a wrong date is indistinguishable from a recorded
 * one once it is saved.
 */
export function itineraryDraftToRoutePoints(
  draft: ItineraryImportDraft,
  selectedEntryIds: readonly string[],
): ItineraryRoutePointDraft[] {
  const selected = new Set(selectedEntryIds);
  return draft.days.flatMap((day) =>
    day.entries
      .filter((entry) => selected.has(entry.entryId))
      .filter((entry) => !isNonPlaceRole(entry.role))
      .filter((entry) => entry.latitude !== null && entry.longitude !== null)
      .map((entry) => ({
        entryId: entry.entryId,
        regionContext: entry.regionContext ?? day.regionContext,
        role: entry.role,
        point: {
          draftId: `imported-${entry.entryId}`,
          latitude: entry.latitude as number,
          longitude: entry.longitude as number,
          label: entry.name,
          isStop: isStopRole(entry.role),
          occurredAt: day.yearConfirmed ? day.calendarDate : null,
          note: null,
          // #514: preserve source-backed stay/role evidence on the canonical
          // Route Point draft. These hints affect presentation only; they do
          // not create a city node or change Stop/route identity.
          regionContext: entry.regionContext ?? day.regionContext,
          placeRole: entry.role,
          overviewVisibility: null,
        },
      })),
  );
}

export type ItineraryApplyResult = {
  routePoints: RouteDraftPoint[];
  addedRoutePointCount: number;
  /** True when this job's points were already there, so nothing moved. */
  replayed: boolean;
};

/**
 * Add an import to a Route draft without touching what is already there.
 *
 * Without `insertAtIndex` the points are appended; with one they go in at that
 * position, which is how an explicit "insert after this stop" choice reaches
 * the draft. Either way nothing already in the draft moves relative to
 * anything else.
 *
 * Existing points keep their ids, order, labels, notes and any unsaved manual
 * edit. Re-applying the same job — a retry, a lost response, a double click —
 * is a replay: every imported point carries a draft id derived from the job
 * key and its entry, so a point already present is recognised rather than
 * added a second time.
 */
/**
 * Where the member said this import should land.
 *
 * `null` is the default and means the end of the draft: an import appends,
 * because appending cannot disturb an order somebody already arranged. When
 * the member picks an existing point to insert after, the new points go
 * directly behind it. A point that is no longer in the draft - deleted while
 * the review panel was open - falls back to appending rather than guessing a
 * position, so an import never lands somewhere nobody chose.
 */
export function resolveInsertAtIndex(
  existing: readonly RouteDraftPoint[],
  insertAfterDraftId: string | null,
): number | undefined {
  if (!insertAfterDraftId) return undefined;
  const index = existing.findIndex(
    (point) => point.draftId === insertAfterDraftId,
  );
  return index === -1 ? undefined : index + 1;
}

export function applyItineraryImport(
  existing: readonly RouteDraftPoint[],
  imported: readonly ItineraryRoutePointDraft[],
  options: { insertAtIndex?: number } = {},
): ItineraryApplyResult {
  const present = new Set(existing.map((point) => point.draftId));
  const additions = imported
    .map((item) => item.point)
    .filter((point) => !present.has(point.draftId));

  if (additions.length === 0) {
    return {
      routePoints: [...existing],
      addedRoutePointCount: 0,
      replayed: imported.length > 0,
    };
  }

  const at = options.insertAtIndex ?? existing.length;
  const index = Math.max(0, Math.min(at, existing.length));
  return {
    routePoints: [
      ...existing.slice(0, index),
      ...additions,
      ...existing.slice(index),
    ],
    addedRoutePointCount: additions.length,
    replayed: false,
  };
}

export function withAddedRoutePointCount(
  draft: ItineraryImportDraft,
  addedRoutePointCount: number,
): ItineraryImportDraft {
  return {
    ...draft,
    counts: { ...draft.counts, addedRoutePointCount },
  };
}

/** The Route Point fields an import may ever write. Nothing else is invented. */
export const IMPORTED_ROUTE_POINT_FIELDS: ReadonlyArray<keyof RoutePointInput> = [
  "latitude",
  "longitude",
  "label",
  "isStop",
  "occurredAt",
  "note",
  "regionContext",
  "placeRole",
  "overviewVisibility",
];
