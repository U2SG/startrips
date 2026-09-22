/**
 * #512: the pasted-text entry point, and the deterministic reader every test
 * in CI uses.
 *
 * It reads the shape a day-structured plan already has — a title, day
 * headings, and lines under them — in Chinese, English or a mix of both, and
 * emits the same versioned `ItineraryRecognition` a server-side recognition
 * adapter emits. That is the point of the split: the draft rules in
 * `itineraryImport.ts` are exercised in CI against this reader, with no paid
 * model and no network, and the adapter only has to produce the same document.
 *
 * What it refuses to do is as load-bearing as what it does:
 *
 * - A space is never a separator. `Chengdu Museum of Natural History` is one
 *   name; only an explicit arrow orders two entries on one line.
 * - A trailing ellipsis means the name was cut off. The readable part is kept
 *   and marked `truncated`; nothing completes it.
 * - A day heading with no year stays without one. The weekday is read as
 *   printed and never used to pick a year, and today's date is never consulted.
 * - A heading with a date and nothing under it is an empty day, not a failure.
 * - A transport leg keeps both endpoints as printed and never collapses
 *   `A — B` into one place.
 */

import type {
  ItineraryEntryRole,
  ItineraryRecognition,
  ItineraryRecognitionDay,
  ItineraryRecognitionEntry,
} from "./itineraryImport";

export const TEXT_ITINERARY_RECOGNIZER_VERSION = "text-itinerary/1";

/**
 * Role markers.
 *
 * A Latin marker must be followed by a colon, because `Hotel Indigo` and
 * `Seeing the harbour` are names that start with a marker word and a bare
 * prefix match would eat the first word of both. A CJK marker may stand alone
 * — `住宿 成都尼依格罗酒店` is how these plans are actually written, and no
 * venue name begins with one. A line with no marker is an attraction: that is
 * what an unannotated plan line is, and review can change it.
 */
const ROLE_MARKERS: ReadonlyArray<[string, ItineraryEntryRole]> = [
  ["accommodation", "accommodation"],
  ["住宿", "accommodation"],
  ["酒店", "accommodation"],
  ["hotel", "accommodation"],
  ["stay", "accommodation"],
  ["attraction", "attraction"],
  ["景点", "attraction"],
  ["游览", "attraction"],
  ["visit", "attraction"],
  ["see", "attraction"],
  ["transport", "transport"],
  ["交通", "transport"],
  ["航班", "transport"],
  ["flight", "transport"],
  ["train", "transport"],
  ["transit", "pure-transit"],
  ["途经", "pure-transit"],
  ["路过", "pure-transit"],
  ["pass", "pure-transit"],
];

const CJK_MARKER = /[㐀-鿿]/;

const INVALID_MARKERS = [
  "已失效",
  "失效",
  "invalid",
  "unavailable",
  "no longer available",
];

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const DAY_HEADING = /^(?:day|第)\s*(\d+)\s*(?:天|日)?/i;
const ARROW = /\s*(?:→|->|➔)\s*/;
// `to` needs its word boundaries: without them the split runs inside `Toronto`.
const LEG = /\s*(?:—|--|~|至|\bto\b)\s*/i;
const BULLET = /^[-*•·‣]\s*/;
const CONTINUATION = /^[↳>]\s*/;
const COORDINATE = /@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const TRUNCATION = /(?:…|\.\.\.)\s*$/;
const REPORTED_PLACES = /(\d+)\s*(?:个地点|个景点|places?|spots?|stops?)/i;
const REPORTED_DAYS = /(\d+)\s*(?:日游|天行程|days?\b|-day\b)/i;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

type ReadDate = { calendarDate: string | null; partialDate: string | null };

/**
 * Read a date out of one heading fragment.
 *
 * A year is only ever taken from the text. When the source printed none, the
 * month and day survive in `partialDate` and `calendarDate` stays null, which
 * is what keeps the year unconfirmed all the way to the saved Route Point.
 */
export function readItineraryDate(fragment: string): ReadDate | null {
  const iso = fragment.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return {
      calendarDate: `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`,
      partialDate: null,
    };
  }

  const chineseFull = fragment.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (chineseFull) {
    return {
      calendarDate: `${chineseFull[1]}-${pad(Number(chineseFull[2]))}-${pad(Number(chineseFull[3]))}`,
      partialDate: null,
    };
  }

  const chinesePartial = fragment.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (chinesePartial) {
    return {
      calendarDate: null,
      partialDate: `${pad(Number(chinesePartial[1]))}-${pad(Number(chinesePartial[2]))}`,
    };
  }

  const english = fragment.match(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,\s*(\d{4}))?/,
  );
  if (english) {
    const month = MONTHS.findIndex((name) =>
      name.startsWith(english[1].toLowerCase())
    );
    if (month >= 0) {
      const day = pad(Number(english[2]));
      return english[3]
        ? { calendarDate: `${english[3]}-${pad(month + 1)}-${day}`, partialDate: null }
        : { calendarDate: null, partialDate: `${pad(month + 1)}-${day}` };
    }
  }

  return null;
}

function splitHeading(rest: string) {
  return rest
    .split(/\s*[·|｜]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function readRole(text: string): { role: ItineraryEntryRole; rest: string } {
  const lowered = text.toLowerCase();
  for (const [marker, role] of ROLE_MARKERS) {
    if (!lowered.startsWith(marker)) continue;
    const after = text.slice(marker.length);
    const separated = /^\s*[:：]/.test(after)
      || (CJK_MARKER.test(marker) && /^\s/.test(after));
    if (!separated) continue;
    const rest = after.replace(/^\s*[:：]?\s*/, "");
    // A marker that consumed the whole line was the name, not a marker.
    if (rest) return { role, rest };
  }
  return { role: "attraction", rest: text };
}

function readInvalid(text: string) {
  const marked = text.match(/[[(【]([^\])】]*)[\])】]\s*$/);
  if (!marked) return { sourceInvalid: false, rest: text };
  const inner = marked[1].trim().toLowerCase();
  const invalid = INVALID_MARKERS.some((marker) => inner.includes(marker));
  return invalid
    ? { sourceInvalid: true, rest: text.slice(0, marked.index).trim() }
    : { sourceInvalid: false, rest: text };
}

function readCoordinate(text: string) {
  const match = text.match(COORDINATE);
  if (!match) return { latitude: null, longitude: null, rest: text };
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  const usable = latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180;
  return usable
    ? {
      latitude,
      longitude,
      rest: text.slice(0, match.index).trim(),
    }
    : { latitude: null, longitude: null, rest: text.slice(0, match.index).trim() };
}

type PendingEntry = {
  entry: ItineraryRecognitionEntry;
  /** Set while the line may still be continued by a `↳` wrap. */
  open: boolean;
};

/**
 * Read one plan out of pasted text.
 *
 * Lines before the first day heading are the source's own framing: the first
 * of them is the title, and any of them may state how many days or places the
 * source believes it has. Those counts are recorded for comparison and are
 * never used to add, drop or renumber anything.
 */
export function readTextItinerary(text: string): ItineraryRecognition {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const days: ItineraryRecognitionDay[] = [];
  const entries: ItineraryRecognitionEntry[] = [];
  const preamble: string[] = [];

  let currentDay: ItineraryRecognitionDay | null = null;
  let orderInDay = 0;
  let pending: PendingEntry | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      pending = null;
      continue;
    }

    const heading = line.match(DAY_HEADING);
    if (heading) {
      const parts = splitHeading(line.slice(heading[0].length));
      let date: ReadDate = { calendarDate: null, partialDate: null };
      let regionContext: string | null = null;
      for (const part of parts) {
        const read = readItineraryDate(part);
        if (read && !date.calendarDate && !date.partialDate) {
          date = read;
          continue;
        }
        // Whatever is not the date is the region this day was listed under.
        // It is context for the entries below, never an entry of its own.
        if (!read && !regionContext) regionContext = part;
      }
      currentDay = {
        dayNumber: Number(heading[1]),
        sourceDayTitle: line,
        calendarDate: date.calendarDate,
        partialDate: date.partialDate,
        regionContext,
      };
      days.push(currentDay);
      orderInDay = 0;
      pending = null;
      continue;
    }

    if (!currentDay) {
      preamble.push(line);
      continue;
    }

    const continued = line.match(CONTINUATION);
    if (continued && pending?.open) {
      // A name the source wrapped across two lines is one name. Joining with a
      // single space is the only edit made to any name anywhere in this reader.
      const tail = line.slice(continued[0].length).trim();
      const truncated = TRUNCATION.test(tail);
      pending.entry.name = [
        pending.entry.name,
        truncated ? tail.replace(TRUNCATION, "").trim() : tail,
      ].filter(Boolean).join(" ");
      pending.entry.truncated = truncated;
      continue;
    }

    const body = line.replace(BULLET, "").trim();
    if (!body) continue;

    const { role, rest: afterRole } = readRole(body);
    // Coordinate first: a source-invalid marker sits at the end of the printed
    // name, so it is only at the end of the line once the coordinate a member
    // pasted after it has been taken off.
    const { latitude, longitude, rest: afterCoordinate } = readCoordinate(afterRole);
    const { sourceInvalid, rest: afterInvalid } = readInvalid(afterCoordinate);

    if (role === "transport" || role === "pure-transit") {
      const legs = afterInvalid.split(LEG).map((part) => part.trim()).filter(Boolean);
      orderInDay += 1;
      const entry: ItineraryRecognitionEntry = {
        sourceEntryId: null,
        dayNumber: currentDay.dayNumber,
        orderInDay,
        name: afterInvalid.replace(TRUNCATION, "").trim(),
        regionContext: currentDay.regionContext ?? null,
        role,
        transitEndpoints: legs.length === 2
          ? { from: legs[0], to: legs[1] }
          : null,
        truncated: TRUNCATION.test(afterInvalid),
        sourceInvalid,
        latitude,
        longitude,
      };
      entries.push(entry);
      pending = { entry, open: true };
      continue;
    }

    const names = afterInvalid.split(ARROW).map((part) => part.trim()).filter(Boolean);
    let last: ItineraryRecognitionEntry | null = null;
    for (const name of names) {
      orderInDay += 1;
      const truncated = TRUNCATION.test(name);
      const entry: ItineraryRecognitionEntry = {
        sourceEntryId: null,
        dayNumber: currentDay.dayNumber,
        orderInDay,
        name: truncated ? name.replace(TRUNCATION, "").trim() : name,
        regionContext: currentDay.regionContext ?? null,
        role,
        transitEndpoints: null,
        truncated,
        sourceInvalid,
        // Only the last name on an arrow line can own the line's coordinate.
        latitude: null,
        longitude: null,
      };
      entries.push(entry);
      last = entry;
    }
    if (last && latitude !== null && longitude !== null) {
      last.latitude = latitude;
      last.longitude = longitude;
    }
    pending = last ? { entry: last, open: names.length === 1 } : null;
  }

  const framing = preamble.join(" ");
  const reportedPlaces = framing.match(REPORTED_PLACES);
  const reportedDays = framing.match(REPORTED_DAYS);

  return {
    contractVersion: 1,
    sourceKind: "text",
    recognizerVersion: TEXT_ITINERARY_RECOGNIZER_VERSION,
    sourceTitle: preamble[0] ?? null,
    sourceReportedDayCount: reportedDays ? Number(reportedDays[1]) : null,
    sourceReportedPlaceCount: reportedPlaces ? Number(reportedPlaces[1]) : null,
    days,
    entries,
  };
}
