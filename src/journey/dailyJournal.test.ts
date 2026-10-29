import { describe, expect, it } from "vitest";
import { mergeJournalSuggestions, parseJournalChapters, previewJournalImport } from "./dailyJournal";
const source = "2027-04-03 出发\n23:30 她从甲城出发\n18:20 她抵达乙城\n原计划海湾公园取消，改去山坡花园\n00:30 准备睡觉，属于前一晚的叙事";
describe("daily journal evidence", () => {
  it("preserves raw sequence, third person, plans and wall times without guessing instants or places", () => {
    const [day] = previewJournalImport(source, "2027-04-01");
    expect(day.source).toBe(source);
    expect(day.date).toBe("2027-04-03");
    expect(day.events.map((e) => e.text)).toEqual(source.split("\n"));
    expect(day.events.every((e) => e.status === "uncertain" && e.routePointId === null && e.localTime === null)).toBe(true);
  });
  it("imports identical source once and preserves manual changes and AI suggestions on reimport", () => {
    const first = previewJournalImport(source, "2027-04-01");
    first[0].events[1].text = "手工修订"; first[0].events[1].edited = true;
    first[0].date = "2027-04-04"; // A corrected chapter date must not defeat import identity.
    expect(previewJournalImport(source, "2027-04-01", first)).toEqual(first);
    const suggestions = [{ eventId: first[0].events[1].id, text: "建议", questions: ["地点待确认"], background: "未核实背景" }];
    const next = mergeJournalSuggestions(first, suggestions);
    expect(next[0].events[1].text).toBe("手工修订");
    expect(next[0].suggestions).toEqual(suggestions);
  });
  it("preserves undated prose and long text without truncation", () => {
    const long = "她记录沿途见闻。".repeat(2000);
    expect(previewJournalImport(long, "2027-04-03")[0].events[0].text).toBe(long);
    expect(previewJournalImport("前言\n4月3日 出发\n记事", "2027-04-01").map((c) => c.date)).toEqual(["2027-04-01", "2027-04-03"]);
  });
  it("validates real dates, status, duplicates and bounds", () => {
    expect(() => previewJournalImport("2027-02-30 错误", "2027-04-01")).toThrow();
    const chapters = previewJournalImport(source, "2027-04-01");
    expect(parseJournalChapters([...chapters, ...previewJournalImport(source, "2027-04-01")])).toBeNull();
    const event = chapters[0].events[0];
    event.routePointId = "point";
    expect(parseJournalChapters(chapters)).toBeNull();
    event.status = "actual";
    expect(parseJournalChapters(chapters)).not.toBeNull();
    event.localDate = "2027-04-04"; event.localTime = "00:30";
    expect(parseJournalChapters(chapters)?.[0].date).toBe("2027-04-03");
    event.localTime = "25:00";
    expect(parseJournalChapters(chapters)).toBeNull();
    event.localTime = null; chapters[0].events.push(event);
    expect(parseJournalChapters(chapters)).toBeNull();
  });
});
