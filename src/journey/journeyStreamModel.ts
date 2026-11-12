import { JOURNAL_DATE_HEADING, type JournalChapter, type JournalEvent } from "./dailyJournal";
import { isLodgingLabelLine } from "./journalHotels";
import { isVisualMediaAsset } from "./journeyModel";
import type { Journey, JourneyMediaAsset, MediaPreviewRead, RoutePoint } from "./types";

/**
 * #393 Journey Stream (after Undertow): a Journey read as one thread of its
 * own light colour. The thread runs through its pictures and videos in Route
 * order; each Route Point's note is written in the margin beside the first
 * picture of that point, as a journal is. A point with a note and no media is
 * a bead on the thread with its note beside it — space carrying the story when
 * there are no pictures. Points with neither carry no story and are skipped.
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
export function journeyStreamEntries(journey: Journey, focusPointId: string | null = null): JourneyStreamEntry[] {
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
      if (note || point.id === focusPointId) entries.push({ kind: "note", key: `note:${point.id}`, routePoint: point, place, date, note: note ?? "" });
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

type JournalReadingEvent = Pick<JournalEvent, "id" | "text" | "localDate" | "localTime"> & { point?: RoutePoint };
type JournalReadingChapter = { id: string; title: string; source: string; events: JournalReadingEvent[] };
export type JourneyStreamJournalDay = { date: string; chapters: JournalReadingChapter[] };

const journalStatusPrefix = /^(?:[【\[（(]\s*(实际(?:发生)?|计划|(?:已)?取消|(?:状态)?待确认|(?:状态)?未确认|未核实|待核实|未记录)\s*[】\]）)]\s*[：:]?|(实际(?:发生)?|计划|(?:已)?取消|(?:状态)?待确认|(?:状态)?未确认|未核实|待核实|未记录)\s*[：:])\s*/u;
const journalStatusSuffix = /\s*[（(]\s*(?:(?:状态)?(?:待确认|未确认)|未核实|待核实|未记录)\s*[）)]$/u;
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
    const marker = content.match(journalStatusPrefix);
    const label = marker?.[1] ?? marker?.[2];
    const prose = (marker ? content.slice(marker[0].length) : clean).replace(journalStatusSuffix, "");
    if (!prose || label === "计划" || /^(?:实际(?:发生)?|计划|(?:已)?取消)$/.test(prose)) return [];
    if ((label === "取消" || label === "已取消") && !journalCancellationNarrative.test(prose)) return [];
    return journalMissingLine.test(prose.replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, ""))
      ? []
      : [prose];
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
      return text || point ? [{ id: event.id, text, localDate: event.localDate, localTime: event.localTime, point }] : [];
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
