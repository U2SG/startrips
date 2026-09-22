/**
 * #512: the recognition adapter, chosen at deployment time like every other
 * external provider in this app.
 *
 * What a recogniser is allowed to be is narrow on purpose. It receives one
 * document the member submitted and returns versioned structured candidates —
 * never executable code, never a tool call, never a URL for the server to
 * follow. Every decision that matters afterwards is made by ordinary code:
 * date validity, schema, coordinate range, ownership, revision, idempotency
 * and the write itself. A model proposes readings; it does not get to act.
 *
 * Unset is a real state and reports itself truthfully. `disabled` never
 * invents a reading, exactly as `STORAGE_DRIVER=disabled` never invents
 * persistence and `LOCATION_SEARCH_DRIVER=disabled` never invents a result;
 * the pasted-text entry point keeps working without any of this configured.
 */

/** The three stages a link or image import passes through, reported apart. */
export type ItineraryImportStage =
  | "source-access"
  | "content-read"
  | "ai-extraction";

/**
 * A refusal that names the stage it happened in.
 *
 * Collapsing these into one message is the specific failure #512 calls out: a
 * transport fault, a page this deployment cannot render yet and a recogniser
 * that could not read a plan are three different things, and none of them is
 * "the link is invalid".
 */
export class ItineraryImportStageError extends Error {
  readonly stage: ItineraryImportStage;
  readonly code: string;
  readonly status: number;

  constructor(
    stage: ItineraryImportStage,
    code: string,
    message: string,
    status = 502,
  ) {
    super(message);
    this.name = "ItineraryImportStageError";
    this.stage = stage;
    this.code = code;
    this.status = status;
  }
}

/** Not configured. A 503 the same way storage and place search answer one. */
export class ItineraryRecognitionUnavailableError extends ItineraryImportStageError {
  constructor(message = "Itinerary recognition is not configured") {
    super("ai-extraction", "ITINERARY_RECOGNITION_UNAVAILABLE", message, 503);
    this.name = "ItineraryRecognitionUnavailableError";
  }
}

/**
 * The one envelope a staged refusal leaves by, so the stage a client reads is
 * the stage the failure actually carried. `server/app.ts` answers with this,
 * and nothing composes a second shape for the same error.
 */
export function itineraryImportStageFailure(error: ItineraryImportStageError) {
  return {
    status: error.status,
    body: { error: error.code, stage: error.stage, message: error.message },
  };
}

/** The document handed to a recogniser. Nothing else about the member travels. */
export type ItineraryRecognitionRequest =
  | { kind: "text"; text: string }
  | { kind: "page"; url: string; text: string }
  | { kind: "image"; mimeType: string; base64: string };

export type ItineraryRecognitionCandidateEntry = {
  sourceEntryId: string | null;
  dayNumber: number;
  orderInDay: number;
  name: string;
  aliases?: string[];
  regionContext?: string | null;
  role: "accommodation" | "attraction" | "transport" | "pure-transit";
  transitEndpoints?: { from: string; to: string } | null;
  truncated?: boolean;
  sourceInvalid?: boolean;
};

export type ItineraryRecognitionCandidateDay = {
  dayNumber: number;
  sourceDayTitle: string | null;
  calendarDate: string | null;
  partialDate: string | null;
  regionContext?: string | null;
};

/**
 * What a recogniser returns. Deliberately position-free: a name and a region
 * are what a plan prints, and where that is on Earth is resolved afterwards by
 * the existing place search and confirmed by the member. A model's recalled
 * coordinate would be indistinguishable from a looked-up one once saved, so
 * this contract has nowhere to put one.
 */
export type ItineraryRecognitionCandidates = {
  contractVersion: 1;
  /** The exact provider and model build that produced this reading. */
  recognizerVersion: string;
  sourceTitle: string | null;
  sourceReportedDayCount: number | null;
  sourceReportedPlaceCount: number | null;
  days: ItineraryRecognitionCandidateDay[];
  entries: ItineraryRecognitionCandidateEntry[];
};

export interface ItineraryRecognizer {
  readonly driver: string;
  /** Recorded on every reading so an old draft stays attributable. */
  readonly recognizerVersion: string;
  recognize(
    request: ItineraryRecognitionRequest,
    options: { signal?: AbortSignal },
  ): Promise<ItineraryRecognitionCandidates>;
}

const ROLES = new Set([
  "accommodation",
  "attraction",
  "transport",
  "pure-transit",
]);

const MAX_DAYS = 120;
const MAX_ENTRIES = 600;
const MAX_NAME_LENGTH = 300;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARTIAL_DATE = /^\d{2}-\d{2}$/;

function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ItineraryImportStageError(
      "ai-extraction",
      "ITINERARY_RECOGNITION_MALFORMED",
      "A reported count is not a whole number",
    );
  }
  return value;
}

function text(value: unknown, field: string, required: boolean): string | null {
  if (value === null || value === undefined) {
    if (!required) return null;
    throw new ItineraryImportStageError(
      "ai-extraction",
      "ITINERARY_RECOGNITION_MALFORMED",
      `${field} is missing`,
    );
  }
  if (typeof value !== "string" || value.length > MAX_NAME_LENGTH) {
    throw new ItineraryImportStageError(
      "ai-extraction",
      "ITINERARY_RECOGNITION_MALFORMED",
      `${field} is not usable text`,
    );
  }
  return value;
}

/**
 * Validate a reading before anything downstream sees it.
 *
 * A rejection here is always `ITINERARY_RECOGNITION_MALFORMED` at the
 * extraction stage: the member's plan is fine, the reading of it is not, and
 * re-submitting the same document to a fixed adapter is the right next step.
 * Nothing is repaired or defaulted on the way through — a reading that does
 * not satisfy the contract is refused whole.
 */
export function parseRecognitionCandidates(
  value: unknown,
  recognizerVersion: string,
): ItineraryRecognitionCandidates {
  const reject = (message: string) => {
    throw new ItineraryImportStageError(
      "ai-extraction",
      "ITINERARY_RECOGNITION_MALFORMED",
      message,
    );
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("The reading is not an object");
  }
  const document = value as Record<string, unknown>;
  if (document.contractVersion !== 1) reject("Unsupported reading contract");
  if (!Array.isArray(document.days) || !Array.isArray(document.entries)) {
    reject("The reading carries no days or no entries");
  }
  const rawDays = document.days as unknown[];
  const rawEntries = document.entries as unknown[];
  if (rawDays.length > MAX_DAYS) reject("The reading declares too many days");
  if (rawEntries.length > MAX_ENTRIES) {
    reject("The reading declares too many entries");
  }

  const days = rawDays.map((raw) => {
    const day = raw as Record<string, unknown>;
    if (!Number.isInteger(day.dayNumber) || (day.dayNumber as number) < 1) {
      reject("A day has no usable day number");
    }
    const calendarDate = text(day.calendarDate ?? null, "calendarDate", false);
    const partialDate = text(day.partialDate ?? null, "partialDate", false);
    if (calendarDate !== null && !CALENDAR_DATE.test(calendarDate)) {
      reject("A day date is not a calendar date");
    }
    if (partialDate !== null && !PARTIAL_DATE.test(partialDate)) {
      reject("A partial day date is not a month and day");
    }
    return {
      dayNumber: day.dayNumber as number,
      sourceDayTitle: text(day.sourceDayTitle ?? null, "sourceDayTitle", false),
      calendarDate,
      partialDate,
      regionContext: text(day.regionContext ?? null, "regionContext", false),
    };
  });

  const dayNumbers = new Set(days.map((day) => day.dayNumber));
  const entries = rawEntries.map((raw) => {
    const entry = raw as Record<string, unknown>;
    if (!dayNumbers.has(entry.dayNumber as number)) {
      reject("An entry belongs to a day the reading did not declare");
    }
    if (!Number.isInteger(entry.orderInDay) || (entry.orderInDay as number) < 1) {
      reject("An entry has no usable order");
    }
    if (typeof entry.role !== "string" || !ROLES.has(entry.role)) {
      reject("An entry has no known role");
    }
    const endpoints = entry.transitEndpoints as
      | { from?: unknown; to?: unknown }
      | null
      | undefined;
    return {
      sourceEntryId: text(entry.sourceEntryId ?? null, "sourceEntryId", false),
      dayNumber: entry.dayNumber as number,
      orderInDay: entry.orderInDay as number,
      name: text(entry.name, "name", true) as string,
      aliases: Array.isArray(entry.aliases)
        ? entry.aliases.map((alias) => text(alias, "alias", true) as string)
        : undefined,
      regionContext: text(entry.regionContext ?? null, "regionContext", false),
      role: entry.role as ItineraryRecognitionCandidateEntry["role"],
      transitEndpoints: endpoints
        ? {
          from: text(endpoints.from, "transitEndpoints.from", true) as string,
          to: text(endpoints.to, "transitEndpoints.to", true) as string,
        }
        : null,
      truncated: entry.truncated === true,
      sourceInvalid: entry.sourceInvalid === true,
    };
  });

  return {
    contractVersion: 1,
    // The adapter's own recorded build wins over anything the reading claims
    // about itself, so provenance cannot be written by the thing being read.
    recognizerVersion,
    sourceTitle: text(document.sourceTitle ?? null, "sourceTitle", false),
    sourceReportedDayCount: optionalCount(document.sourceReportedDayCount),
    sourceReportedPlaceCount: optionalCount(document.sourceReportedPlaceCount),
    days,
    entries,
  };
}

/**
 * Every recogniser call is bounded. A provider that never answers must fail
 * the request rather than hold a member's import open, and the deadline is
 * enforced here rather than trusted to an adapter.
 */
export async function withRecognitionTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ItineraryImportStageError(
        "ai-extraction",
        "ITINERARY_RECOGNITION_TIMEOUT",
        `Itinerary recognition did not answer within ${timeoutMs}ms`,
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
