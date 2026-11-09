import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { previewJournalImport } from "./dailyJournal";
import { JournalChapterReview, hasJournalReadingSuggestion, journalChapterQuestions } from "./JournalChapterReview";

describe("specific journal review items", () => {
  it("hides empty/no-op suggestions and groups repeated questions without losing event associations", () => {
    const chapter = previewJournalImport("2027-04-03\n第一条\n第二条", "2027-04-03")[0];
    chapter.suggestions = chapter.events.map(event => ({ eventId: event.id, text: event.text, background: "", questions: ["", "  ", "日期是否准确？", " 日期是否准确？ "] }));
    const before = JSON.stringify(chapter);
    expect(journalChapterQuestions(chapter)).toEqual([{ question: "日期是否准确？", events: [1, 2] }]);
    expect(hasJournalReadingSuggestion(chapter.events[0], chapter.suggestions[0])).toBe(false);
    const markup = renderToStaticMarkup(createElement(JournalChapterReview, { chapter }));
    expect(markup).toContain('<summary tabindex="0">');
    expect(markup).toContain("需核实的内容（1 项）"); expect(markup.match(/日期是否准确？/g)).toHaveLength(1);
    expect(markup).toContain("对应本章第 1、2 条记录"); expect(JSON.stringify(chapter)).toBe(before);
  });
  it("shows no confirmation panel when there are no real questions", () => {
    const chapter = previewJournalImport("2027-04-03\n实际：已抵达", "2027-04-03")[0];
    chapter.suggestions = [{ eventId: chapter.events[0].id, text: chapter.events[0].text, background: "", questions: [" "] }];
    expect(renderToStaticMarkup(createElement(JournalChapterReview, { chapter }))).toBe("");
    expect(hasJournalReadingSuggestion(chapter.events[0], { ...chapter.suggestions[0], text: "新建议" })).toBe(true);
    expect(hasJournalReadingSuggestion(chapter.events[0], { ...chapter.suggestions[0], background: "尚未核实的背景" })).toBe(true);
  });
});
