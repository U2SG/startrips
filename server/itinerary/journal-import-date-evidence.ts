import { isPersistedCalendarDate } from "../../src/journey/calendarDate";
import { requireTool } from "../intents/staging-tool";

export type JournalDateStatus = "absent" | "unknown" | "single" | "range";
export type JournalDateClaim = { status: JournalDateStatus; start: string | null; end: string | null; evidence: string | null; questions: string[] };
/** Checks a model's explicit claim, not the meaning of surrounding prose.
 * Exact references prove provenance, not that the model interpreted it correctly.
 * Semantic uncertainty stays visible in the preview for the member to inspect. */
export function validateJournalDateClaim(claim: JournalDateClaim, source: string, path: string) {
  const cited = typeof claim.evidence === "string" && !!claim.evidence.trim() && source.includes(claim.evidence);
  if (claim.status === "absent") {
    requireTool(claim.start === null && claim.end === null && claim.evidence === null, path, "ABSENT_DATE_FIELDS");
  } else if (claim.status === "unknown") {
    requireTool(claim.start === null && claim.end === null, path, "UNKNOWN_DATE_VALUES");
    requireTool(cited, `${path}.evidence`, "SOURCE_REFERENCE");
    requireTool(claim.questions.some(q => q.trim()), `${path}.questions`, "UNCERTAINTY_QUESTION");
  } else {
    requireTool(cited, `${path}.evidence`, "SOURCE_REFERENCE");
    requireTool(isPersistedCalendarDate(claim.start), `${path}.start`, "CALENDAR_DATE");
    if (claim.status === "single") requireTool(claim.end === null, `${path}.end`, "SINGLE_DATE_END");
    else {
      requireTool(claim.status === "range" && isPersistedCalendarDate(claim.end), `${path}.end`, "CALENDAR_DATE");
      requireTool(claim.end! >= claim.start!, path, "DATE_RANGE_ORDER");
    }
  }
}
