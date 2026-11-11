import type { JournalChapter } from "../../src/journey/dailyJournal";

/** `pointId` is a model-selected existing point (validated against the supplied list); otherwise `name` must equal a point label exactly. */
export type JournalPlaceClaim = { eventId: string; name: string; date?: string | null; pointId?: string | null };
/** Match only source-grounded, single-place claims. Existing events belong to the member. */
export function linkJournalPlaces(previous: JournalChapter[], chapters: JournalChapter[], claims: JournalPlaceClaim[], points: { id: string; label: string; occurredAt?: Date | string | null }[]): JournalChapter[] {
  const existing = new Set(previous.flatMap(c => c.events.map(e => e.id)));
  const evidence = new Map(claims.map(c => [c.eventId, c]));
  const normalize = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase();
  return chapters.map(chapter => {
    const questions = new Map<string, string>();
    const events = chapter.events.map(event => {
      const claim = evidence.get(event.id), name = claim?.name;
      const date = event.localDate ?? claim?.date;
      if (existing.has(event.id) || event.routePointId || event.status !== "actual") return event;
      const chosen = claim?.pointId ? points.filter(point => point.id === claim.pointId) : [];
      if (!chosen.length && (!name?.trim() || !event.source.includes(name))) return event;
      const matches = chosen.length ? chosen : points.filter(point => normalize(point.label) === normalize(name!));
      if (matches.length > 1) questions.set(event.id, "旅程中有多个同名地点，请确认本次对应哪一个；暂未关联媒体。");
      if (matches.length === 1 && date && matches[0].occurredAt) {
        const instant = new Date(matches[0].occurredAt).getTime(), day = Date.parse(`${date}T00:00:00Z`);
        // No timezone is known: only reject instants impossible in every UTC offset within ±14h.
        if (instant < day - 14 * 3600_000 || instant >= day + 38 * 3600_000) {
          questions.set(event.id, "手记日期与同名地点的记录时间不一致，请确认是否是同一次到访；暂未关联媒体。");
          return event;
        }
      }
      return matches.length === 1 ? { ...event, routePointId: matches[0].id } : event;
    });
    return { ...chapter, events, suggestions: chapter.suggestions.map(suggestion => questions.has(suggestion.eventId)
      ? { ...suggestion, questions: [...new Set([...suggestion.questions, questions.get(suggestion.eventId)!])] }
      : suggestion) };
  });
}
