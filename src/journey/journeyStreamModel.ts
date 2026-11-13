import { JOURNAL_DATE_HEADING, type JournalChapter, type JournalEvent } from "./dailyJournal";
import { isLodgingLabelLine } from "./journalHotels";
import { isVisualMediaAsset } from "./journeyModel";
import type { Journey, JourneyMediaAsset, MediaPreviewRead, RoutePoint } from "./types";

/**
 * #393 Journey Stream (after Undertow): a Journey read as one thread of its
 * own light colour. The thread runs through its pictures and videos in Route
 * order; each Route Point's note is written in the margin beside the first
 * picture of that point, as a journal is. A point with a note and no media is
 * a bead on the thread with its note beside it. A point linked from the
 * journal or opened directly can also anchor the story without a picture.
 */
export type JourneyStreamEntry =
  | { kind: "intro"; key: string; note: string | null }
  | {
    kind: "media";
    key: string;
    asset: JourneyMediaAsset;
    routePoint: RoutePoint | null;
    /** Place and date open a point's first entry only. */
    place: string | null;
    date: string | null;
    note: string | null;
  }
  | { kind: "note"; key: string; routePoint: RoutePoint; place: string | null; date: string | null; note: string };

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** The calendar part of an occurrence time, as written. */
export function streamDate(occurredAt: string | null | undefined): string | null {
  const value = trimmed(occurredAt);
  return value ? value.slice(0, 10) : null;
}

function ownerMedia(journey: Journey, routePointId: string | null): JourneyMediaAsset[] {
  return journey.media
    .filter((asset) => asset.routePointId === routePointId && isVisualMediaAsset(asset))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

/** Entries oldest first, in canonical Route order. */
export function journeyStreamEntries(
  journey: Journey, focusPointId: string | null = null, journalPoints?: ReadonlySet<string>,
): JourneyStreamEntry[] {
  const entries: JourneyStreamEntry[] = [{ kind: "intro", key: "intro", note: trimmed(journey.note) }];
  for (const asset of ownerMedia(journey, null)) {
    entries.push({ kind: "media", key: `media:${asset.id}`, asset, routePoint: null, place: null, date: null, note: null });
  }
  for (const point of journey.routePoints) {
    const media = ownerMedia(journey, point.id);
    const note = trimmed(point.note);
    const place = trimmed(point.label);
    const date = streamDate(point.occurredAt);
    if (media.length === 0) {
      if (note || point.id === focusPointId || journalPoints?.has(point.id)) {
        entries.push({ kind: "note", key: `note:${point.id}`, routePoint: point, place, date, note: note ?? "" });
      }
      continue;
    }
    media.forEach((asset, index) => {
      entries.push({
        kind: "media",
        key: `media:${asset.id}`,
        asset,
        routePoint: point,
        place: index === 0 ? place : null,
        date: index === 0 ? date : null,
        note: index === 0 ? note : null,
      });
    });
  }
  return entries;
}

type JournalReadingEvent = Pick<JournalEvent, "id" | "text" | "localDate" | "localTime" | "mediaIds"> & {
  point?: RoutePoint;
  writtenTime: string | null;
};
type JournalReadingChapter = { id: string; title: string; source: string; events: JournalReadingEvent[] };
export type JourneyStreamJournalDay = { date: string; chapters: JournalReadingChapter[] };

const journalStatusPrefix = /^(?:[【\[（(]\s*(实际(?:发生)?|计划|(?:已)?取消|(?:状态)?待确认|(?:状态)?未确认|未核实|待核实|未记录)\s*[】\]）)]\s*[：:]?|(实际(?:发生)?|计划|(?:已)?取消|(?:状态)?待确认|(?:状态)?未确认|未核实|待核实|未记录)\s*[：:])\s*/u;
const journalStatusSuffix = /\s*[（(]\s*(?:(?:状态)?(?:待确认|未确认)|未核实|待核实|未记录)\s*[）)]$/u;
const journalClock = String.raw`(?:[01]?\d|2[0-3]):[0-5]\d`;
const journalPartOfDay = "凌晨|清晨|早上|上午|中午|午后|下午|傍晚|晚间|晚上|夜间|日落";
// Older imports can put the status after the time or a short context label.
const journalStatusContext = new RegExp(
  String.raw`^(?:${journalClock}(?:\s*[-–—~～至]\s*${journalClock})?|(?:${journalPartOfDay})(?:至(?:${journalPartOfDay}))?|途中|随后|原定|早餐|午餐|晚餐|购物|停车|[\p{Script=Han}]{1,6}[里内外])(?:左右|前后|前|后)?(?:\s*[（(][^）)\r\n]{1,20}[）)])?\s*`,
  "u",
);
const journalMissingLine = /^(?:[\p{L}\p{N}、/]{1,8}\s*[：:]\s*|(?:状态|日期|时间|时区|地点|位置|住宿|酒店|交通|餐饮|天气|行程|活动|备注)\s*)?[【\[（(]?\s*(?:暂无记录|无记录|未提及|未注明|不详|(?:尚)?未(?:确认|核实|记录|填写|提供|标注|关联)|待(?:确认|核实|补充)|无)\s*[】\]）)]?[。.!！…]*$/u;
const journalCancellationNarrative = /取消|改签|改期|改去|改走|改道|(?:没|未)(?:去成|能去|赶上)|不去了/u;

function cleanJournalLine(line: string) {
  return line.trim().replace(/^#{1,6}\s+/, "").replace(/\\+$/, "").trimEnd();
}

function journalReadingText(value: string, status?: JournalEvent["status"]): string {
  if (status === "planned") return "";
  const text = value.split(/\r\n?|\n/).flatMap(line => {
    const clean = cleanJournalLine(line);
    if (!clean) return [""];
    const content = clean.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    const context = content.match(journalStatusContext)?.[0] ?? "";
    const afterContext = content.slice(context.length);
    const marker = afterContext.match(journalStatusPrefix);
    const label = marker?.[1] ?? marker?.[2];
    const prose = (marker ? afterContext.slice(marker[0].length) : clean).replace(journalStatusSuffix, "");
    if (!prose || label === "计划" || /^(?:实际(?:发生)?|计划|(?:已)?取消)$/.test(prose)) return [];
    if ((label === "取消" || label === "已取消") && !journalCancellationNarrative.test(prose)) return [];
    if (journalMissingLine.test(prose.replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, ""))) return [];
    const prefix = marker ? context.trim().replace(journalStatusSuffix, "") : "";
    return [prefix ? `${prefix} ${prose}` : prose];
  }).join("\n").trim();
  return status === "cancelled" && !journalCancellationNarrative.test(text) ? "" : text;
}

/** Readable excerpts stay in source order and never participate in media placement. */
export function journeyStreamJournalDays(
  chapters: readonly JournalChapter[], points: ReadonlyMap<string, RoutePoint>,
): JourneyStreamJournalDay[] {
  const days = new Map<string, JournalReadingChapter[]>();
  for (const chapter of chapters) {
    const title = journalReadingText(chapter.title);
    const events = chapter.events.flatMap(event => {
      const linkedPoint = event.routePointId ? points.get(event.routePointId) : undefined;
      const confirmedLodging = (event.status === "planned" || event.status === "uncertain")
        && linkedPoint?.placeRole === "accommodation" && isLodgingLabelLine(event.source);
      const point = event.status === "actual" || confirmedLodging ? linkedPoint : undefined;
      const text = journalReadingText(event.text.trim() || event.source, confirmedLodging ? undefined : event.status);
      return text || point ? [{
        id: event.id,
        text,
        localDate: event.localDate,
        localTime: event.localTime && !text.startsWith(event.localTime) ? event.localTime : null,
        writtenTime: event.localTime,
        mediaIds: event.mediaIds,
        point,
      }] : [];
    });
    const source = chapter.events.length ? "" : journalReadingText(chapter.source.trim().replace(/^([^\r\n]*)(?:\r\n?|\n|$)/, (line, first: string) => (
      JOURNAL_DATE_HEADING.test(first) ? "" : line
    )));
    if (!title && !events.length && !source) continue;
    const group = days.get(chapter.date) ?? [];
    group.push({ id: chapter.id, title, events, source });
    days.set(chapter.date, group);
  }
  return [...days].sort(([left], [right]) => left.localeCompare(right)).map(([date, chapters]) => ({ date, chapters }));
}

/** Explicit links locate a reading day even when older Route Points have no timestamp. */
export function journeyStreamJournalPlacement(
  entries: readonly JourneyStreamEntry[], days: readonly JourneyStreamJournalDay[],
) {
  const mediaEntries = new Map<string, JourneyStreamEntry>();
  const pointEntries = new Map<string, JourneyStreamEntry>();
  const datedEntries = new Map<string, JourneyStreamEntry>();
  for (const entry of entries) {
    if (entry.kind === "intro") continue;
    if (entry.kind === "media") mediaEntries.set(entry.asset.id, entry);
    if (entry.routePoint && !pointEntries.has(entry.routePoint.id)) pointEntries.set(entry.routePoint.id, entry);
    if (entry.date && !datedEntries.has(entry.date)) datedEntries.set(entry.date, entry);
  }
  const order = new Map(entries.map((entry, index) => [entry, index]));
  const byEntry = new Map<string, JourneyStreamJournalDay[]>();
  const byDate = new Map<string, string>();
  const visitsByPoint = new Map<string, Map<string, Set<string>>>();
  const firstEntry = (candidates: readonly JourneyStreamEntry[]) => candidates.reduce<JourneyStreamEntry | undefined>(
    (first, candidate) => !first || order.get(candidate)! < order.get(first)! ? candidate : first,
    undefined,
  );

  for (const day of days) {
    const linkedMedia: JourneyStreamEntry[] = [];
    const linkedPoints: JourneyStreamEntry[] = [];
    for (const { events } of day.chapters) {
      for (const event of events) {
        const linkedPoint = event.point && pointEntries.get(event.point.id);
        if (linkedPoint) linkedPoints.push(linkedPoint);
        const matchedMedia = event.mediaIds.flatMap(id => mediaEntries.get(id) ?? []);
        linkedMedia.push(...matchedMedia);
        // A manually associated photo may belong to a different stop. Only
        // a direct place link supplies a local visit date for that stop.
        if (!event.point || event.point.occurredAt) continue;
        const visits = visitsByPoint.get(event.point.id) ?? new Map<string, Set<string>>();
        const date = event.localDate ?? day.date;
        const times = visits.get(date) ?? new Set<string>();
        if (event.writtenTime) times.add(event.writtenTime);
        visits.set(date, times);
        visitsByPoint.set(event.point.id, visits);
      }
    }
    const anchor = firstEntry(linkedPoints) ?? firstEntry(linkedMedia) ?? datedEntries.get(day.date);
    if (!anchor) continue;
    const groupedDays = byEntry.get(anchor.key) ?? [];
    groupedDays.push(day);
    byEntry.set(anchor.key, groupedDays);
    byDate.set(day.date, anchor.key);
  }
  const visitByEntry = new Map<string, string>();
  for (const [id, visits] of visitsByPoint) {
    const entry = pointEntries.get(id);
    if (!entry) continue;
    const dates = [...visits.keys()].sort();
    const times = visits.get(dates[0]);
    const time = dates.length === 1 && times?.size === 1 ? [...times][0] : null;
    visitByEntry.set(entry.key, time ? `${dates[0]} ${time}` : dates.join(" / "));
  }
  return { byEntry, byDate, visitByEntry };
}

/** Width / height of a picture, from the best size known so far. */
export function streamAspect(
  asset: Pick<JourneyMediaAsset, "displayWidth" | "displayHeight">,
  preview?: Pick<MediaPreviewRead, "width" | "height"> | null,
  natural?: { width: number; height: number } | null,
): number {
  for (const size of [natural, { width: asset.displayWidth, height: asset.displayHeight }, preview]) {
    if (size?.width && size.height && size.width > 0 && size.height > 0) return size.width / size.height;
  }
  return 4 / 3;
}

export type JourneyStreamLayout = {
  /** Wide screens write the note beside the picture; narrow ones below it. */
  beside: boolean;
  /** Width of a landscape picture; portrait pictures are narrower. */
  pictureWidth: number;
  gap: number;
  noteWidth: number;
  gutter: number;
  /** Tallest a picture may be, so one always fits on screen. */
  maxPictureHeight: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function journeyStreamLayout(width: number, height: number): JourneyStreamLayout {
  const gap = Math.round(clamp(height * 0.075, 36, 80));
  const noteWidth = Math.round(clamp(width * 0.2, 220, 300));
  const gutter = Math.round(clamp(width * 0.04, 28, 60));
  let pictureWidth = Math.min(clamp(height * 0.44, 220, 380), width * 0.64);
  const beside = width >= pictureWidth + 2 * (gutter + noteWidth + 40);
  if (!beside) pictureWidth = Math.min(width * 0.84, 440);
  return {
    beside,
    pictureWidth: Math.round(pictureWidth),
    gap,
    noteWidth,
    gutter,
    maxPictureHeight: Math.round(height * 0.62),
  };
}

export function streamPictureSize(aspect: number, layout: JourneyStreamLayout): { width: number; height: number } {
  let width = aspect < 1 ? layout.pictureWidth * 0.72 : layout.pictureWidth;
  let height = width / aspect;
  if (height > layout.maxPictureHeight) {
    height = layout.maxPictureHeight;
    width = height * aspect;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** Offset that puts an entry's centre at the middle of a viewport of `height`. */
export function streamOffsetFor(entryCenter: number, height: number): number {
  return height / 2 - entryCenter;
}
