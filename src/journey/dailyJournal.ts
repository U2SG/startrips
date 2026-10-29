import { isPersistedCalendarDate } from "./calendarDate";

export const JOURNAL_MAX_TEXT = 200_000;
export type JournalStatus = "actual" | "planned" | "cancelled" | "uncertain";
export type JournalEvent = {
  id: string;
  source: string;
  text: string;
  status: JournalStatus;
  // Wall time and its context are evidence, never an inferred instant.
  localDate: string | null;
  localTime: string | null;
  timeContext: string;
  routePointId: string | null;
  mediaIds: string[];
  edited: boolean;
};
export type JournalSuggestion = {
  eventId: string;
  text: string;
  questions: string[];
  background: string;
};
export type JournalChapter = {
  id: string;
  date: string;
  /** Immutable import identity; older stored chapters may omit it. */
  importDate?: string;
  title: string;
  source: string;
  events: JournalEvent[];
  suggestions: JournalSuggestion[];
};
export type DailyJournal = { revision: number; chapters: JournalChapter[] };
export const EMPTY_JOURNAL: DailyJournal = { revision: 0, chapters: [] };
const statuses = new Set(["actual", "planned", "cancelled", "uncertain"]);
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Strict bounded wire validation shared by API and preview. No coordinates exist in this contract. */
export function parseJournalChapters(value: unknown): JournalChapter[] | null {
  if (!Array.isArray(value) || value.length > 120 || new TextEncoder().encode(JSON.stringify(value)).length > 480_000) return null;
  const ids = new Set<string>();
  const validId = (id: unknown) => {
    if (typeof id !== "string" || !idPattern.test(id) || ids.has(id)) return false;
    ids.add(id); return true;
  };
  const sources = new Set<string>();
  let count = 0;
  for (const chapter of value) {
    if (!object(chapter) || !validId(chapter.id) || !isPersistedCalendarDate(chapter.date)
      || (chapter.importDate !== undefined && !isPersistedCalendarDate(chapter.importDate))
      || !text(chapter.title, 200) || !text(chapter.source, JOURNAL_MAX_TEXT)
      || !Array.isArray(chapter.events) || !Array.isArray(chapter.suggestions)) return null;
    const identity = `${chapter.importDate ?? chapter.date}\0${chapter.source}`;
    if (sources.has(identity)) return null;
    sources.add(identity);
    for (const event of chapter.events) {
      count += 1;
      if (count > 2000 || !object(event) || !validId(event.id) || !text(event.source, JOURNAL_MAX_TEXT)
        || !text(event.text, JOURNAL_MAX_TEXT) || (typeof event.status !== "string" || !statuses.has(event.status))
        || (event.localDate !== null && !isPersistedCalendarDate(event.localDate))
        || (event.localTime !== null && (typeof event.localTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.localTime)))
        || !text(event.timeContext, 200) || typeof event.edited !== "boolean"
        || (event.routePointId !== null && (typeof event.routePointId !== "string" || !idPattern.test(event.routePointId)))
        || (event.status !== "actual" && event.routePointId !== null)
        || !Array.isArray(event.mediaIds) || event.mediaIds.length > 100
        || event.mediaIds.some((id) => typeof id !== "string" || !idPattern.test(id))
        || new Set(event.mediaIds).size !== event.mediaIds.length) return null;
    }
    if (chapter.suggestions.length > chapter.events.length) return null;
    const suggestionIds = new Set<string>();
    for (const suggestion of chapter.suggestions) {
      if (!object(suggestion) || typeof suggestion.eventId !== "string"
        || !chapter.events.some((e) => e.id === suggestion.eventId) || suggestionIds.has(suggestion.eventId)
        || !text(suggestion.text, JOURNAL_MAX_TEXT) || !text(suggestion.background, 4000)
        || !Array.isArray(suggestion.questions) || suggestion.questions.length > 20
        || suggestion.questions.some((q) => !text(q, 1000))) return null;
      suggestionIds.add(suggestion.eventId);
    }
  }
  // Project known fields: model/clients cannot smuggle coordinates or other authority.
  return value.map((c: JournalChapter) => ({ id: c.id, date: c.date, ...(c.importDate === undefined ? {} : { importDate: c.importDate }), title: c.title, source: c.source,
    events: c.events.map((e) => ({ id: e.id, source: e.source, text: e.text, status: e.status,
      localDate: e.localDate, localTime: e.localTime, timeContext: e.timeContext,
      routePointId: e.routePointId, mediaIds: e.mediaIds, edited: e.edited })),
    suggestions: c.suggestions.map((s) => ({ eventId: s.eventId, text: s.text, questions: s.questions, background: s.background })),
  }));
}

/** Only explicit source labels convey status; an arbitrary heading or verb never proves a visit. */
function journalStatusMarker(line: string): { status: JournalStatus; rest: string; section: boolean } | null {
  const clean = line.trim().replace(/^(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/, "");
  const match = clean.match(/^(?:[【\[(](实际|计划|取消|待确认)[】\])]|(实际|计划|取消|待确认)(?:[：:]|$))\s*(.*)$/);
  if (!match) return null;
  const labels: Record<string, JournalStatus> = { 实际: "actual", 计划: "planned", 取消: "cancelled", 待确认: "uncertain" };
  return { status: labels[match[1] ?? match[2]], rest: match[3], section: /^#{1,6}\s/.test(line.trim()) || !match[3] };
}

/** Explicit headings only. Undated prose stays intact under the user-selected fallback day. */
export function previewJournalImport(source: string, fallbackDate: string, existing: readonly JournalChapter[] = [], makeId = () => crypto.randomUUID()): JournalChapter[] {
  if (!source.trim() || source.length > JOURNAL_MAX_TEXT || !isPersistedCalendarDate(fallbackDate)) throw new Error("请输入有效日期及不超过 20 万字的原文。");
  const chunks: { date: string; title: string; lines: string[]; heading: boolean }[] = [];
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^\s*(?:#{1,6}\s*)?(?:(\d{4})[-年/.])?(\d{1,2})[-月/.](\d{1,2})(?:日)?(?:\s|$)(.*)$/);
    if (match) {
      const date = `${match[1] ?? fallbackDate.slice(0, 4)}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
      if (!isPersistedCalendarDate(date)) throw new Error(`日期无效：${line}`);
      chunks.push({ date, title: match[4].trim(), lines: [line], heading: true });
    } else {
      if (!chunks.length) chunks.push({ date: fallbackDate, title: "", lines: [], heading: false });
      chunks[chunks.length - 1].lines.push(line);
    }
  }
  const chapters = [...existing];
  for (const chunk of chunks) {
    const raw = chunk.lines.join("\n");
    if (!raw.trim() || chapters.some((c) => (c.importDate ?? c.date) === chunk.date && c.source === raw)) continue;
    let sectionStatus: JournalStatus = /^(?:行程)?计划$/.test(chunk.title) ? "planned" : "uncertain";
    const events: JournalEvent[] = [];
    for (const line of chunk.lines.slice(chunk.heading ? 1 : 0)) {
      if (!line.trim()) continue;
      const marker = journalStatusMarker(line);
      if (marker?.section) { sectionStatus = marker.status; continue; }
      if (/^#{1,6}\s/.test(line.trim())) { sectionStatus = "uncertain"; continue; }
      const status = marker?.status ?? sectionStatus;
      // Keep the marker in the prose/source. Parsing never rewrites what was said.
      const time = (marker?.rest ?? line.trim()).match(/^([01]?\d|2[0-3]):([0-5]\d)(?:\s|$)/);
      events.push({ id: makeId(), source: line, text: line, status,
        localDate: null, localTime: time ? `${time[1].padStart(2, "0")}:${time[2]}` : null,
        timeContext: "当地时间（具体时区未确认）", routePointId: null, mediaIds: [], edited: false });
    }
    chapters.push({ id: makeId(), date: chunk.date, importDate: chunk.date, title: chunk.title, source: raw, suggestions: [], events });
  }
  if (!parseJournalChapters(chapters)) throw new Error("手记超过单次容量，请分旅程保存。");
  return chapters;
}

/** New proposals live alongside member prose; neither generation nor import overwrites it. */
export function mergeJournalSuggestions(chapters: JournalChapter[], suggestions: JournalSuggestion[]): JournalChapter[] {
  return chapters.map((chapter) => ({ ...chapter, suggestions: suggestions.filter((s) => chapter.events.some((e) => e.id === s.eventId)) }));
}

/** Bulk adoption only changes untouched event prose, inside the unsaved preview. */
export function adoptJournalSuggestions(chapters: JournalChapter[]): JournalChapter[] {
  return chapters.map((chapter) => ({ ...chapter, events: chapter.events.map((event) => {
    const suggestion = chapter.suggestions.find((s) => s.eventId === event.id);
    return suggestion && !event.edited ? { ...event, text: suggestion.text } : event;
  }) }));
}
