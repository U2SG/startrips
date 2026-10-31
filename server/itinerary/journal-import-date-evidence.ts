import { isPersistedCalendarDate } from "../../src/journey/calendarDate";

type Fragment = { start: number; end: number; raw: string; value: string; kind: "calendar" | "day" | "number" };
type Range = { left: number; right: number; start: number; end: number };
// Lexical fragments deliberately include invalid/missing fields. Validation must
// not erase an unparseable endpoint and thereby turn its neighbour into one day.
const fragmentsPattern = /(?<!\d)(?:\d+年(?:[\dx?]*月(?:[\dx?]*日?)?)?|[\dx?]*月[\dx?]*日?|\d{3,}[-/.][\dx?]*(?:[-/.][\dx?]*)?日?|\d+[-/.][\dx?]*日?|\d+日|\d+)/giu;
const rangeGap = /^(?:\s|[\p{Ps}\p{Pe}]|左右|前后|上下)*(?:[-–—~～至到]|to)(?:\s|[\p{Ps}\p{Pe}]|约|大约|大概|近|about|around)*$/iu;
const pairs: Record<string, string> = { "(": ")", "（": "）", "[": "]", "【": "】", "{": "}", "「": "」", "『": "』" };
const closing = new Set(Object.values(pairs));

function scan(source: string) {
  const tokens: Fragment[] = [...source.matchAll(fragmentsPattern)]
    .filter(m => /[\dx?]/iu.test(m[0]))
    .map(m => ({ start: m.index!, end: m.index! + m[0].length, raw: m[0], value: m[0],
      kind: /^\d+$/.test(m[0]) ? "number" : /^\d+日$/.test(m[0]) ? "day" : "calendar" }));
  const fragments: Fragment[] = [];
  // Adjacent explicit year/month prefixes belong to the same date evidence,
  // including fields wrapped separately. Do not infer across narrative text.
  const prefix = /^(?:\d+年(?:\d+月)?|\d+月|\d{3,}[-/.](?:\d+[-/.])?)$/;
  for (const token of tokens) {
    const previous = fragments.at(-1);
    if (previous && prefix.test(previous.value) && /^[\s\p{Ps}\p{Pe}]*$/u.test(source.slice(previous.end, token.start))) {
      previous.end = token.end;
      previous.raw = source.slice(previous.start, token.end);
      previous.value += token.value;
    } else fragments.push(token);
  }
  const ranges: Range[] = [];
  const eligible = (f: Fragment) => f.kind !== "number"
    // A bare right/left day is only identifiable at a syntactic boundary.
    // '到3号楼', 'to 10 Downing Street', and times are not calendar endpoints.
    || /^(?:\s*(?:$|[\p{Pe}，。；,;!?！？]|[-–—~～至到]))/u.test(source.slice(f.end));
  for (let i = 1; i < fragments.length; i++) {
    const a = fragments[i - 1], b = fragments[i];
    if ((a.kind !== "number" || b.kind !== "number") && eligible(a) && eligible(b)
      && rangeGap.test(source.slice(a.end, b.start))) ranges.push({ left: i - 1, right: i, start: a.start, end: b.end });
  }
  return { fragments, ranges };
}

function balancedWrapping(text: string) {
  const stack: string[] = [];
  for (const char of text) {
    if (pairs[char]) stack.push(pairs[char]);
    else if (closing.has(char) && stack.pop() !== char) return false;
  }
  return stack.length === 0;
}

function dateValue(raw: string, fallbackYear: string, preceding?: string): string | null {
  let year: string, month: string, day: string;
  const chinese = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?$/.exec(raw);
  const full = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})日?$/.exec(raw);
  const partial = /^(\d{1,2})([-/.])(\d{1,2})日?$/.exec(raw);
  const dayOnly = /^(\d{1,2})日?$/.exec(raw);
  if (chinese) [year, month, day] = [chinese[1] ?? preceding?.slice(0, 4) ?? fallbackYear, chinese[2], chinese[3]];
  else if (full) [year, month, day] = [full[1], full[3], full[4]];
  else if (partial) [year, month, day] = [preceding?.slice(0, 4) ?? fallbackYear, partial[1], partial[3]];
  else if (dayOnly && preceding) [year, month, day] = [preceding.slice(0, 4), preceding.slice(5, 7), dayOnly[1]];
  else return null;
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isPersistedCalendarDate(value) ? value : null;
}

export function hasJournalDateRange(source: string): boolean {
  return scan(source).ranges.length > 0;
}

/** Quote grounding is separate from normalization. Both chapter dates and event
 * dates use this boundary; events additionally require exactly one returned day. */
export function groundedJournalDates(quote: unknown, source: string, year: string): string[] | null {
  if (typeof quote !== "string" || !quote || !source.includes(quote) || !balancedWrapping(quote)) return null;
  const { fragments, ranges } = scan(source);
  const participating = new Set(ranges.flatMap(r => [r.left, r.right]));
  let result: string[] | null = null;
  // Substrings have no source offset. A repeated quote cannot hide a later
  // occurrence that crops a range or supplies a different omitted-year context.
  for (let at = source.indexOf(quote); at !== -1; at = source.indexOf(quote, at + 1)) {
    const end = at + quote.length;
    if (ranges.some(r => r.start < end && r.end > at && (r.start < at || r.end > end))) return null;
    const selected = fragments.map((f, index) => ({ ...f, index })).filter(f =>
      (f.kind !== "number" || participating.has(f.index)) && f.start < end && f.end > at);
    if (!selected.length || selected.length > 2 || selected.some(f => f.start < at || f.end > end)) return null;
    // A date fragment must end at a field boundary. Extra contiguous fields
    // cannot be discarded merely because the supported date has three fields.
    if (selected.some(f => /^(?:[\d年月日]|[/.][\dx?])/iu.test(source.slice(f.end)))) return null;
    // Approximate qualifiers are evidence too, even when omitted from quote.
    if (selected.some(f => {
      const before = source.slice(0, f.start).replace(/[\s\p{Ps}\p{Pe}]+$/u, "");
      const after = source.slice(f.end).replace(/^[\s\p{Ps}\p{Pe}]+/u, "");
      return /(?:约|大约|大概|近|(?<![a-z])(?:about|around))$/iu.test(before) || /^(?:左右|前后|上下)/u.test(after);
    })) return null;
    const first = dateValue(selected[0].value, year);
    if (!first) return null;
    const dates = [first];
    if (selected.length === 2) {
      if (!ranges.some(r => r.left === selected[0].index && r.right === selected[1].index)) return null;
      const last = dateValue(selected[1].value, year, first);
      // In particular, never infer a new year/month merely to make a range fit.
      if (!last || last < first) return null;
      dates.push(last);
    }
    if (result && JSON.stringify(result) !== JSON.stringify(dates)) return null;
    result = dates;
  }
  return result;
}

/** Only genuine date-only headings may be omitted from the event list. */
export function isJournalDateHeading(source: string, year: string): boolean {
  const text = source.replace(/^\s*(?:#{1,6}\s*)?/, "").replace(/\s*(?:（(?:星期|周)[一二三四五六日天]）|\((?:星期|周)[一二三四五六日天]\))\s*$/, "").trim();
  const dates = groundedJournalDates(text, text, year);
  if (!dates || scan(text).fragments.length !== dates.length) return false;
  const rest = text.replace(fragmentsPattern, "");
  return dates.length === 1 ? /^[\s\p{Ps}\p{Pe}]*$/u.test(rest) : rangeGap.test(rest);
}
