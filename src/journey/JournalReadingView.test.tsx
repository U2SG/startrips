import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JournalReadingView, journalReadingRows, visibleJournalChapters } from "./JournalReadingView";
import { previewJournalImport } from "./dailyJournal";
import type { Journey } from "./types";

const chapters = previewJournalImport("2027-04-04 第二天\n计划：看日出\n2027-04-03 第一天\n23:30 出发\n18:20 抵达\n实际：海湾散步\n取消：花园", "2027-04-03");
const points = [{ id: "point", label: "虚构海湾" }] as Journey["routePoints"];
chapters[1].events[2].routePointId = "point";
const journey = { routePoints: points } as Journey;

describe("journal reading without changing the record", () => {
  it("sorts chapters by date but preserves event order, including backwards wall clocks", () => {
    expect(journalReadingRows(chapters, points).map(row => row.event.text)).toEqual(["23:30 出发", "18:20 抵达", "实际：海湾散步", "取消：花园", "计划：看日出"]);
    expect(chapters.map(chapter => chapter.date)).toEqual(["2027-04-04", "2027-04-03"]);
  });
  it("combines date, status, and place/text searches without changing data", () => {
    const before = JSON.stringify(chapters);
    expect(journalReadingRows(chapters, points, "2027-04-03", "actual", "虚构海湾")).toHaveLength(1);
    expect(journalReadingRows(chapters, points, "", "uncertain")).toHaveLength(2);
    expect(journalReadingRows(chapters, points, "2027-04-04", "cancelled")).toEqual([]);
    expect(JSON.stringify(chapters)).toBe(before);
  });
  it("does not invent a place for an uncertain record or from prose", () => {
    const copy = structuredClone(chapters);
    copy[1].events[0].routePointId = "point";
    expect(journalReadingRows(copy, points)[0].point).toBeUndefined();
    expect(journalReadingRows(chapters, points)[1].point).toBeUndefined();
  });
  it("keeps source, readable full text and review questions available without making them a blocking alert", () => {
    const copy = structuredClone(chapters);
    copy[1].suggestions = [{ eventId: copy[1].events[0].id, text: "整理建议", questions: ["是否已经出发？"], background: "未经核实的背景" }];
    const markup = renderToStaticMarkup(createElement(JournalReadingView, { chapters: copy, journey, busy: false, onPoint() {}, renderMedia: () => null }));
    expect(markup).toContain("按日阅读"); expect(markup).toContain("表格浏览");
    expect(markup).toContain("2 天 · 5 条记录 · 2 条状态未确认");
    expect(markup).toContain("不代表正文有错"); expect(markup).toContain("是否已经出发？");
    expect(markup).toContain("原始记录"); expect(markup).toContain("18:20 抵达");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("<textarea");
  });
  it("preserves empty chapters and equal-date chapter order", () => {
    const copy = structuredClone(chapters);
    copy[0].date = copy[1].date;
    expect(journalReadingRows(copy, points)[0].chapter.id).toBe(copy[0].id);
    const empty = { ...copy[0], events: [], source: "未拆分的原文" };
    const markup = renderToStaticMarkup(createElement(JournalReadingView, { chapters: [empty], journey, busy: false, onPoint() {}, renderMedia: () => null }));
    expect(markup).toContain("未拆分的原文"); expect(markup).toContain("本章没有拆分事件");
    expect(visibleJournalChapters([empty], [], empty.date)).toHaveLength(1);
    expect(visibleJournalChapters([empty], [], empty.date, "actual")).toHaveLength(0);
  });
});
