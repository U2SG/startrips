import { JOURNAL_DATE_HEADING } from "../../src/journey/dailyJournal";

/** Source characters (including line breaks) staged by one model call. */
export const JOURNAL_SEGMENT_BUDGET = 4_000;
/** Inclusive absolute line range of the normalized source. */
export type JournalSegment = { firstLine: number; lastLine: number };

const weight = (lines: readonly string[], r: JournalSegment) => {
  let n = 0;
  for (let i = r.firstLine; i <= r.lastLine; i++) n += lines[i].length + 1;
  return n;
};
const split = (r: JournalSegment, startsUnit: (line: number) => boolean) => {
  const units: JournalSegment[] = [];
  for (let i = r.firstLine; i <= r.lastLine; i++) {
    if (!units.length || startsUnit(i)) units.push({ firstLine: i, lastLine: i });
    else units[units.length - 1].lastLine = i;
  }
  return units;
};

/** Deterministic cut points only. Dated headings are preferred cuts, whole days
 * are packed up to the budget, an oversized day is cut after blank lines and,
 * as a last resort, at any line. Every line belongs to exactly one segment and
 * each segment holds at least one nonempty line. The heading pattern never
 * decides what a chapter means; the model and validator do. */
export function segmentJournalLines(lines: readonly string[], budget = JOURNAL_SEGMENT_BUDGET): JournalSegment[] {
  if (!lines.length) return [];
  const days = split({ firstLine: 0, lastLine: lines.length - 1 }, i => JOURNAL_DATE_HEADING.test(lines[i]));
  const units = days.flatMap(day => weight(lines, day) <= budget ? [day]
    : split(day, i => i > day.firstLine && !lines[i - 1].trim()).flatMap(part => weight(lines, part) <= budget ? [part] : split(part, () => true)));
  const segments: JournalSegment[] = [];
  for (const unit of units) {
    const last = segments[segments.length - 1];
    if (last && weight(lines, { firstLine: last.firstLine, lastLine: unit.lastLine }) <= budget) last.lastLine = unit.lastLine;
    else segments.push({ ...unit });
  }
  // A blank-only run carries nothing to interpret: attach it to a neighbour.
  const filled = (r: JournalSegment) => lines.slice(r.firstLine, r.lastLine + 1).some(line => line.trim());
  const merged: JournalSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && (!filled(segment) || !filled(previous))) previous.lastLine = segment.lastLine;
    else merged.push(segment);
  }
  return merged;
}
