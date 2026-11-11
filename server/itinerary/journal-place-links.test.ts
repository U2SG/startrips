import { describe, expect, it } from "vitest";
import { previewJournalImport, parseJournalChapters } from "../../src/journey/dailyJournal";
import { linkJournalPlaces } from "./journal-place-links";
import { prepareJournalImport } from "./journal-import-workflow";
import { mockChapter, mockJournalModel, toolResponse } from "./journal-import-test-fixtures";

const source = "实际：她在星桥花园看花。";
function fixture() {
  const chapters = previewJournalImport(source, "2028-06-03");
  const event = chapters[0].events[0];
  chapters[0].suggestions = [{ eventId: event.id, text: source, background: "", questions: [] }];
  return { chapters, event, claims: [{ eventId: event.id, name: "星桥花园" }], points: [{ id: "point-a", label: "星桥花园" }] };
}
describe("source-grounded existing journey links", () => {
  it("links one exact existing place without inventing time, rewriting text or copying media", () => {
    const f = fixture(), linked = linkJournalPlaces([], f.chapters, f.claims, f.points);
    expect(linked[0].events[0]).toEqual({ ...f.event, routePointId: "point-a" });
    expect(parseJournalChapters(linked)).toEqual(linked);
    expect(f.event.routePointId).toBeNull();
    expect(linkJournalPlaces([], linked, f.claims, f.points)).toEqual(linked);
  });
  it.each(["planned", "cancelled", "uncertain"] as const)("does not turn %s into a visit", status => {
    const f = fixture(); f.event.status = status;
    expect(linkJournalPlaces([], f.chapters, f.claims, f.points)).toEqual(f.chapters);
  });
  it("leaves same-name points unresolved and emits only one deduplicated question", () => {
    const f = fixture(), points = [...f.points, { id: "point-b", label: "星桥花园" }];
    const result = linkJournalPlaces([], f.chapters, f.claims, points);
    expect(result[0].events[0].routePointId).toBeNull();
    expect(result[0].suggestions[0].questions).toHaveLength(1);
    expect(linkJournalPlaces([], result, f.claims, points)).toEqual(result);
  });
  it("preserves saved events including deliberately empty links and manual media", () => {
    const f = fixture(); f.event.mediaIds = ["manual-photo"]; f.event.edited = true;
    expect(linkJournalPlaces(f.chapters, f.chapters, f.claims, f.points)).toEqual(f.chapters);
    f.event.routePointId = "manual-point";
    expect(linkJournalPlaces([], f.chapters, f.claims, f.points)).toEqual(f.chapters);
  });
  it("does not fuzzy-match shorter names, aliases or evidence absent from the source", () => {
    const f = fixture();
    for (const label of ["星桥", "星桥花园分店", "别名"]) expect(linkJournalPlaces([], f.chapters, f.claims, [{ id: "point", label }])).toEqual(f.chapters);
    expect(linkJournalPlaces([], f.chapters, [{ eventId: f.event.id, name: "别名" }], [{ id: "point", label: "别名" }])).toEqual(f.chapters);
  });
  it("carries the model's exact place evidence into server matching without exposing route data", async () => {
    const chapter = mockChapter(source); Object.assign(chapter.events[0], { placeName: "星桥花园" });
    const draft = await prepareJournalImport({ source, sentence: "导入并关联地点", fallbackDate: "2028-06-03" }, { revision: 0, chapters: [] }, {
      ...mockJournalModel, fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[1].content).not.toContain("routePoints");
        return toolResponse("stage_journal_import", { chapters: [chapter] });
      },
    });
    expect(draft.placeClaims).toEqual([{ eventId: draft.chapters[0].events[0].id, name: "星桥花园", date: null }]);
    expect(linkJournalPlaces([], draft.chapters, draft.placeClaims, fixture().points)[0].events[0].routePointId).toBe("point-a");
  });
  it.each([{ placeName: "捏造地点", status: "actual" }, { placeName: "星桥花园", status: "planned" }])("never links an unsupported place claim; the place is dropped and the status kept %o", async patch => {
    const chapter = mockChapter(source); Object.assign(chapter.events[0], patch);
    const draft = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-03" }, { revision: 0, chapters: [] }, {
      ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [chapter] }),
    });
    expect(draft.placeClaims).toEqual([]); expect(draft.degradedLines).toBe(0);
    expect(draft.chapters[0].events[0]).toMatchObject({ status: patch.status, routePointId: null });
  });
});

it("rejects impossible date conflicts without comparing archive dates or guessing a timezone", () => {
  const f = fixture(); f.event.localDate = "2028-06-03";
  const conflict = linkJournalPlaces([], f.chapters, f.claims, [{ ...f.points[0], occurredAt: new Date("2028-05-01T12:00:00Z") }]);
  expect(conflict[0].events[0].routePointId).toBeNull();
  expect(conflict[0].suggestions[0].questions[0]).toContain("记录时间不一致");
  for (const occurredAt of ["2028-06-02T10:00:00Z", "2028-06-04T13:59:00Z"]) {
    expect(linkJournalPlaces([], f.chapters, f.claims, [{ ...f.points[0], occurredAt }])[0].events[0].routePointId).toBe("point-a");
  }
  f.event.localDate = null;
  expect(linkJournalPlaces([], f.chapters, f.claims, [{ ...f.points[0], occurredAt: "2028-05-01T12:00:00Z" }])[0].events[0].routePointId).toBe("point-a");
});

it("keeps multi-place narratives unlinked when the model cannot assert one actual place", async () => {
  const source = "实际：她从星桥花园走到云谷广场。", chapter = mockChapter(source);
  const draft = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-03" }, { revision: 0, chapters: [] }, {
    ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [chapter] }),
  });
  expect(draft.placeClaims).toEqual([]);
  expect(linkJournalPlaces([], draft.chapters, draft.placeClaims, [{ id: "a", label: "星桥花园" }, { id: "b", label: "云谷广场" }])[0].events[0].routePointId).toBeNull();
});

it("uses an explicit single-day heading only to check the link, never to fill event dates", async () => {
  const source = "2028年6月3日\n实际：她在星桥花园看花。", chapter = mockChapter(source);
  Object.assign(chapter, { heading: true, dateStatus: "single", date: "2028-06-03", dateEvidence: "2028年6月3日" });
  chapter.events.shift(); Object.assign(chapter.events[0], { placeName: "星桥花园" });
  const draft = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-07-01" }, { revision: 0, chapters: [] }, {
    ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [chapter] }),
  });
  expect(draft.placeClaims[0].date).toBe("2028-06-03");
  const linked = linkJournalPlaces([], draft.chapters, draft.placeClaims, [{ id: "point", label: "星桥花园", occurredAt: "2028-05-01T00:00:00Z" }]);
  expect(linked[0].events[0]).toMatchObject({ routePointId: null, localDate: null });
  expect(linked[0].suggestions[0].questions.join()).toContain("记录时间不一致");
});

describe("model-selected existing places", () => {
  it("links a model-selected existing point across languages and ignores unknown ids", () => {
    const chapters = previewJournalImport("实际：抵达拉斯维加斯。", "2028-06-03"), event = chapters[0].events[0];
    const points = [{ id: "vegas", label: "Las Vegas" }];
    expect(linkJournalPlaces([], chapters, [{ eventId: event.id, name: "", pointId: "vegas" }], points)[0].events[0].routePointId).toBe("vegas");
    expect(linkJournalPlaces([], chapters, [{ eventId: event.id, name: "", pointId: "elsewhere" }], points)[0].events[0].routePointId).toBeNull();
  });
});
