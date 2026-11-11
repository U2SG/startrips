import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { prepareJournalImport, JOURNAL_DEGRADED_QUESTION, JOURNAL_DROPPED_CLAIM_QUESTION, JOURNAL_IMPORT_SCHEMA, JOURNAL_SEGMENT_CONCURRENCY } from "./journal-import-workflow";
import { mockChapter, mockEvent, mockJournalModel, suppliedLines, toolResponse } from "./journal-import-test-fixtures";
import { segmentJournalLines, JOURNAL_SEGMENT_BUDGET } from "./journal-import-segments";
import { JOURNAL_DATE_HEADING, previewJournalImport } from "../../src/journey/dailyJournal";
const lines = ["2028年6月3–5日", "- 23:30 实际：她在虚构城入住星桥酒店。", "- 07:30 计划：离开城市。", "- 10:30–13:30 计划：游览景点。实际遇到雪景，体感很冷。", "- 08:00 取消：原计划入住山谷酒店。", "- 00:20 实际：她准备睡觉。", "- 09:00 实际：她觉得很冷。"];
export const fictionalSource = lines.join("\n");
export function fictionalDraft() {
  const times = ["23:30", "07:30", "10:30", "08:00", "00:20", "09:00"];
  return { chapters: [{ firstLine: 0, lastLine: 6, heading: true, dateStatus: "range", questions: [], date: "2028-06-03", dateEnd: "2028-06-05", dateEvidence: lines[0],
    events: lines.slice(1).map((_, i) => ({ line: i + 1, status: ["actual", "planned", "uncertain", "cancelled", "actual", "actual"][i],
      dateStatus: "absent", localDate: null, dateEvidence: null, time: times[i], timeEnd: i === 2 ? "13:30" : null,
      timeEvidence: i === 2 ? "10:30–13:30" : times[i], placeName: null, questions: [] })) }] };
}
const input = { source: fictionalSource, sentence: "导入原稿并关联已入住酒店", fallbackDate: "2028-06-01" };
const model = { baseUrl: "https://model.example.test/v1", apiKey: "mock-only", model: "mock", timeoutMs: 1000 };
const hashId = (s: string) => "ji_" + createHash("sha256").update(s).digest("hex").slice(0, 32);
/** A synthetic model that groups only the supplied lines at dated headings. */
function stageByHeadings(supplied: { line: number; text: string }[]) {
  const chapters: ReturnType<typeof mockChapter>[] = [];
  for (const { line, text } of supplied) {
    const m = text.match(JOURNAL_DATE_HEADING);
    if (!chapters.length || m) {
      chapters.push({ firstLine: line, lastLine: line, heading: !!m, dateStatus: m ? "single" : "absent", questions: [], dateEnd: null, events: [],
        date: m ? `${m[1] ?? "2028"}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null, dateEvidence: m ? text.trim() : null });
      if (m) continue;
    }
    const c = chapters[chapters.length - 1]; c.lastLine = line;
    if (text.trim()) c.events.push(mockEvent(text, line));
  }
  return { chapters };
}
const byHeadings = vi.fn(async (_url: unknown, init?: RequestInit) => toolResponse("stage_journal_import", stageByHeadings(suppliedLines(init))));
// Sizes below were written for a 4,000-character budget; scale them so the
// segmentation expectations hold for the current budget.
const prose = (n: number, mark: string) => `她在${mark}散步。`.repeat(Math.max(1, Math.round(n * JOURNAL_SEGMENT_BUDGET / 4_000)));

describe("journal model boundary", () => {
  it("uses a real named tool and preserves range, clock order, mixed facts, person and existing edits", async () => {
    const old = previewJournalImport("2028-05-01\n实际：旧记事", "2028-05-01"); old[0].events[0].text = "private edited prose"; old[0].events[0].edited = true;
    const fetcher = vi.fn(async () => toolResponse("stage_journal_import", fictionalDraft()));
    const draft = await prepareJournalImport(input, { revision: 1, chapters: old }, { ...model, fetcher });
    const result = draft.chapters;
    expect(result[0]).toEqual(old[0]); expect(result[1].source).toBe(fictionalSource); expect(result[1].title).toBe(lines[0]);
    expect(result[1].events.map(e => e.text)).toEqual(lines.slice(1));
    expect(result[1].events.map(e => e.status)).toEqual(["actual", "planned", "uncertain", "cancelled", "actual", "actual"]);
    expect(result[1].events.map(e => e.localTime)).toEqual(["23:30", "07:30", null, "08:00", "00:20", "09:00"]);
    expect(result[1].events.every(e => e.localDate === null && e.routePointId === null)).toBe(true);
    expect(result[1].events[2].timeContext).toContain("10:30–13:30");
    expect(result[1].suggestions[0].questions.join()).toContain("未推断逐日分配");
    expect(draft).toMatchObject({ segments: 1, degradedLines: 0, degradations: [] });
    const body = JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(body.tool_choice.function.name).toBe("stage_journal_import"); expect(body.messages[1].content).not.toContain("private edited prose");
    expect(body.messages[1].content).not.toContain("apiKey");
    expect(await prepareJournalImport(input, { revision: 2, chapters: result }, { ...model, fetcher })).toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never asks the model to copy whole lines", () => {
    const schema = JSON.stringify(JOURNAL_IMPORT_SCHEMA);
    for (const removed of ['"evidence"', '"reading"', '"headingEvidence"']) expect(schema).not.toContain(removed);
    expect(schema).toContain('"heading"');
  });
});
it("covers fourteen synthetic chapters with list-first clocks and preserves date-line order", async () => {
  const blocks = Array.from({ length: 14 }, (_, i) => [`2028年6月${i + 1}日`, "- 23:30 实际：她从甲城出发。", "- 18:20 实际：她抵达乙城。", "- 08:00 计划：虚构花园。", "- 09:00 取消：原酒店。"]);
  const source = blocks.flat().join("\n");
  const response = { chapters: blocks.map((lines, i) => ({ firstLine: i * 5, lastLine: i * 5 + 4, heading: true, dateStatus: "single", questions: [], date: `2028-06-${String(i + 1).padStart(2, "0")}`, dateEnd: null, dateEvidence: lines[0],
    events: lines.slice(1).map((_, j) => ({ line: i * 5 + j + 1, status: ["actual", "actual", "planned", "cancelled"][j], dateStatus: "absent", localDate: null, dateEvidence: null,
      time: ["23:30", "18:20", "08:00", "09:00"][j], timeEnd: null, timeEvidence: ["23:30", "18:20", "08:00", "09:00"][j], placeName: null, questions: [] })) })) };
  const result = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", response) });
  expect(result.chapters).toHaveLength(14); expect(result.chapters.map(c => c.source).join("\n")).toBe(source);
  for (const c of result.chapters) { expect(c.events.map(e => e.localTime)).toEqual(["23:30", "18:20", "08:00", "09:00"]); expect(c.events.map(e => e.status)).toEqual(["actual", "actual", "planned", "cancelled"]); }
});

async function prepare(source: string, chapter = mockChapter(source)) {
  return prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, { ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [chapter] }) });
}
const twoLines = "2028年6月3日她出发。\n2028年6月5日她返回。";
it.each([
  ["extra", "$.chapters[0].events[0]", "EXTRA_ARGUMENT"], ["copied-line", "$.chapters[0].events[0]", "EXTRA_ARGUMENT"],
])("degrades the whole segment after an uncorrected schema violation %s and records only its path and code", async (kind, path, code) => {
  const c = mockChapter(twoLines), e = c.events[0];
  if (kind === "extra") Object.assign(e, { latitude: 1 });
  if (kind === "copied-line") Object.assign(e, { evidence: "2028年6月3日她出发。" });
  const result = await prepare(twoLines, c);
  expect(result.degradations).toEqual([{ segment: 0, path, code }]);
  expect(result.degradedLines).toBe(2);
  expect(result.chapters.map(ch => [ch.source, ch.date])).toEqual([[twoLines, "2028-06-01"]]);
  for (const [i, ev] of result.chapters[0].events.entries()) {
    expect(ev).toMatchObject({ status: "uncertain", localDate: null, localTime: null, routePointId: null });
    expect(result.chapters[0].suggestions[i].questions).toContain(JOURNAL_DEGRADED_QUESTION);
  }
  expect(JSON.stringify(result.degradations)).not.toContain("她");
});
it.each([["omission", 1], ["order", 0]])("leaves only the line without a matching event for review, no fallback (%s)", async (kind, missing) => {
  const c = mockChapter(twoLines);
  if (kind === "omission") c.events.pop();
  // Both events now claim line 1: the first wins, so line 0 has none.
  if (kind === "order") c.events[0].line = 1;
  const result = await prepare(twoLines, c);
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(1);
  expect(result.chapters[0].source).toBe(twoLines);
  for (const [i, ev] of result.chapters[0].events.entries()) {
    expect(ev.text).toBe(twoLines.split("\n")[i]);
    expect(ev.status).toBe(i === missing ? "uncertain" : "actual");
    expect(result.chapters[0].suggestions[i].questions.includes(JOURNAL_DEGRADED_QUESTION)).toBe(i === missing);
  }
});
it.each([
  ["date", { dateStatus: "single", date: "2028-02-30", dateEvidence: "2028年6月3日" }],
  ["range-order", { dateStatus: "range", date: "2028-06-05", dateEnd: "2028-06-03", dateEvidence: "2028年6月3日" }],
])("drops a chapter date claim that fails verification and uses the archive date without retry (%s)", async (_kind, patch) => {
  const c = mockChapter(twoLines); Object.assign(c, patch);
  const result = await prepare(twoLines, c);
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(0);
  expect(result.chapters.map(ch => [ch.source, ch.date])).toEqual([[twoLines, "2028-06-01"]]);
  expect(result.chapters[0].events.map(e => e.status)).toEqual(["actual", "actual"]);
  expect(result.chapters[0].suggestions[0].questions).toContain("章节日期未明确，暂用指定归档日。");
});
it("checks a chapter date quote against the whole chapter text, not only its first line", async () => {
  const c = mockChapter(twoLines); Object.assign(c, { dateStatus: "single", date: "2028-06-05", dateEvidence: "2028年6月5日" });
  const result = await prepare(twoLines, c);
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(0);
  expect(result.chapters[0].date).toBe("2028-06-05");
});
it.each(["time", "clock-quote", "place", "event-date", "questions"])("keeps the model's status and drops only the claim that fails verification (%s)", async kind => {
  const c = mockChapter(twoLines), e = c.events[0];
  if (kind === "time") Object.assign(e, { time: "25:30", timeEvidence: "出发" });
  if (kind === "clock-quote") Object.assign(e, { time: "11:30", timeEvidence: "fabricated" });
  if (kind === "place") Object.assign(e, { status: "planned", placeName: "出发" });
  if (kind === "event-date") Object.assign(e, { dateStatus: "single", localDate: "2028-06-03", dateEvidence: "2028年6月5日" });
  if (kind === "questions") e.questions = Array.from({ length: 18 }, (_, i) => `问题${i}`);
  const result = await prepare(twoLines, c);
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(0);
  const [first, second] = result.chapters[0].events, [firstQuestions, secondQuestions] = result.chapters[0].suggestions.map(s => s.questions);
  expect(first).toMatchObject({ text: "2028年6月3日她出发。", status: kind === "place" ? "planned" : "actual", localDate: null, localTime: null });
  expect(firstQuestions).not.toContain(JOURNAL_DEGRADED_QUESTION);
  // A dropped clock or date is flagged; a dropped place is silent.
  expect(firstQuestions.includes(JOURNAL_DROPPED_CLAIM_QUESTION)).toBe(["time", "clock-quote", "event-date"].includes(kind));
  if (kind === "questions") { expect(firstQuestions).toContain("问题16"); expect(firstQuestions).not.toContain("问题17"); }
  expect(second).toMatchObject({ text: "2028年6月5日她返回。", status: "actual" });
  expect(secondQuestions).not.toContain(JOURNAL_DEGRADED_QUESTION); expect(secondQuestions).not.toContain(JOURNAL_DROPPED_CLAIM_QUESTION);
  expect(result.placeClaims).toEqual([]);
});
it("keeps status and inherits the chapter date when events repeat the heading date as their evidence", async () => {
  const source = "2028年6月3日\n她出发。\n她返回。", c = mockChapter(source); c.events.shift();
  Object.assign(c, { heading: true, dateStatus: "single", date: "2028-06-03", dateEvidence: "2028年6月3日" });
  for (const [i, e] of c.events.entries()) Object.assign(e, { status: i ? "planned" : "actual", dateStatus: "single", localDate: "2028-06-03", dateEvidence: "2028年6月3日" });
  const result = await prepare(source, c);
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(0);
  expect(result.chapters[0]).toMatchObject({ date: "2028-06-03", title: "2028年6月3日" });
  expect(result.chapters[0].events.map(e => [e.status, e.localDate])).toEqual([["actual", null], ["planned", null]]);
  expect(result.chapters[0].suggestions.map(s => s.questions)).toEqual([[], []]);
});
it("drops a place name expanded beyond the line text without a question or a place claim", async () => {
  const source = "她入住星桥酒店。", c = mockChapter(source);
  Object.assign(c.events[0], { status: "actual", placeName: "星桥酒店一号楼" });
  const result = await prepare(source, c);
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(0);
  expect(result.chapters[0].events[0]).toMatchObject({ status: "actual", routePointId: null });
  expect(result.placeClaims).toEqual([]);
  const questions = result.chapters[0].suggestions[0].questions;
  expect(questions).not.toContain(JOURNAL_DEGRADED_QUESTION); expect(questions).not.toContain(JOURNAL_DROPPED_CLAIM_QUESTION);
});
it("splits a fallback segment at dated headings and keeps each heading date", async () => {
  const source = "2028年6月3日\n她出发。\n2028年6月5日 返程\n她返回。", c = mockChapter(source); Object.assign(c.events[0], { latitude: 1 });
  const result = await prepare(source, c);
  expect(result.degradations).toEqual([{ segment: 0, path: "$.chapters[0].events[0]", code: "EXTRA_ARGUMENT" }]);
  expect(result.chapters.map(ch => [ch.source, ch.date, ch.events.length])).toEqual([["2028年6月3日\n她出发。", "2028-06-03", 2], ["2028年6月5日 返程\n她返回。", "2028-06-05", 2]]);
  expect(result.chapters[0].suggestions[0].questions).toEqual([JOURNAL_DEGRADED_QUESTION]);
  expect(result.degradedLines).toBe(4);
});
it("leaves a first line without an event for review unless the model marks it as a heading", async () => {
  const source = "### 2028年6月3日\n她出发。", c = mockChapter(source); c.events.shift();
  const unmarked = await prepare(source, c);
  expect(unmarked.degradations).toEqual([]); expect(unmarked.degradedLines).toBe(1);
  expect(unmarked.chapters[0].events.map(e => [e.text, e.status])).toEqual([[source.split("\n")[0], "uncertain"], ["她出发。", "actual"]]);
  expect(unmarked.chapters[0].suggestions[0].questions).toContain(JOURNAL_DEGRADED_QUESTION);
  c.heading = true;
  const result = await prepare(source, c);
  expect(result.degradedLines).toBe(0);
  expect(result.chapters[0]).toMatchObject({ source, title: "### 2028年6月3日" });
  expect(result.chapters[0].events.map(e => e.text)).toEqual(["她出发。"]);
});
it("keeps semantic status supplied for review without keyword reclassification", async () => {
  const source = "她没有入住星桥酒店，后来取消计划。", c = mockChapter(source);
  c.events[0].status = "uncertain"; c.events[0].questions = ["实际行为待确认"];
  const result = await prepare(source, c);
  expect(result.chapters[0].events[0]).toMatchObject({ status: "uncertain", text: source, routePointId: null });
  expect(result.chapters[0].suggestions[0].questions).toContain("实际行为待确认");
  expect(result.chapters[0].suggestions[0].text).toBe(source);
});
it("drops an invalid chapter date claim without a second model call and keeps its questions", async () => {
  const source = "2028年6月？日到2028年6月5日，她旅行。", c = mockChapter(source);
  Object.assign(c, { dateStatus: "unknown", date: "2028-06-05", dateEvidence: source, questions: ["日期范围待确认"] });
  const fetcher = vi.fn(async () => toolResponse("stage_journal_import", { chapters: [c] }));
  const result = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, { ...model, fetcher });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(result.chapters[0].events[0].localDate).toBeNull();
  expect(result.chapters[0].date).toBe("2028-06-01");
  expect(result.chapters[0].suggestions[0].questions).toContain("日期范围待确认");
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(0);
});

it.each([false, true])("joins same-input repetitions from one response instead of retrying (prior=%s)", async withPrior => {
  const text = "她在湖边散步。", source = `${text}\n${text}`;
  const prior = withPrior ? (await prepare(text)).chapters : [];
  const before = { revision: withPrior ? 1 : 0, chapters: prior }, snapshot = structuredClone(before);
  const fetcher = vi.fn(async () => toolResponse("stage_journal_import", { chapters: [mockChapter(text), mockChapter(text, 1)] }));
  const result = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, before, { ...model, fetcher });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.degradations).toEqual([]); expect(result.degradedLines).toBe(0);
  expect(result.chapters.filter(c => result.importedChapterIds.includes(c.id)).map(c => c.source).join("\n")).toBe(source);
  expect(result.chapters.at(-1)!.events.map(e => e.source)).toEqual([text, text]);
  expect(new Set(result.importedChapterIds).size).toBe(result.importedChapterIds.length);
  expect(new Set(result.chapters.at(-1)!.events.map(e => e.id)).size).toBe(2);
  expect(before).toEqual(snapshot);
  if (withPrior) expect(result.chapters[0]).toEqual(prior[0]);
});
it("joins repeated chapter grouping into one chapter in a single call and keeps the model's statuses", async () => {
  const text = "她在湖边散步。", source = `${text}\n${text}`;
  const fetcher = vi.fn(async () => toolResponse("stage_journal_import", { chapters: [mockChapter(text), mockChapter(text, 1)] }));
  const result = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, { ...model, fetcher });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.degradations).toEqual([]);
  expect(result.chapters).toHaveLength(1); expect(result.chapters[0].source).toBe(source);
  expect(result.chapters[0].events.map(e => [e.text, e.status])).toEqual([[text, "actual"], [text, "actual"]]);
});

it("keeps IDs unique when a saved chapter of the same source was dated differently", async () => {
  const source = "2028年6月3日她出发。\n她返回。", dated = mockChapter(source);
  Object.assign(dated, { dateStatus: "single", date: "2028-06-03", dateEvidence: "2028年6月3日" });
  const saved = await prepare(source, dated);
  const result = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 1, chapters: saved.chapters },
    { ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [mockChapter(source)] }) });
  expect(result.chapters).toHaveLength(2);
  const ids = result.chapters.flatMap(c => [c.id, ...c.events.map(e => e.id)]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(result.chapters[0]).toEqual(saved.chapters[0]);
});

describe("segmented staging", () => {
  it("cuts deterministically: whole days up to the budget, then blank lines, then any line", () => {
    const day = (d: number, n: number) => [`2028年6月${d}日`, prose(n, "甲")];
    expect(segmentJournalLines([...day(1, 10), ...day(2, 10)])).toEqual([{ firstLine: 0, lastLine: 3 }]);
    const days = [...day(1, 400), ...day(2, 400), ...day(3, 10)];
    expect(segmentJournalLines(days)).toEqual([{ firstLine: 0, lastLine: 1 }, { firstLine: 2, lastLine: 5 }]);
    const long = ["2028年6月1日", prose(300, "乙"), "", prose(300, "丙"), "", prose(300, "丁")];
    expect(segmentJournalLines(long)).toEqual([{ firstLine: 0, lastLine: 4 }, { firstLine: 5, lastLine: 5 }]);
    const lines = Array.from({ length: 12 }, (_, i) => prose(100, String(i)));
    const cut = segmentJournalLines(lines);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.flatMap(s => Array.from({ length: s.lastLine - s.firstLine + 1 }, (_, i) => s.firstLine + i))).toEqual(lines.map((_, i) => i));
    for (const s of cut) expect(lines.slice(s.firstLine, s.lastLine + 1).join("\n").length).toBeLessThanOrEqual(JOURNAL_SEGMENT_BUDGET);
    // A blank-only run never becomes its own model call.
    expect(segmentJournalLines(["她出发。", ...Array.from({ length: 5000 }, () => "")]).length).toBe(1);
  });

  it("stages each segment with absolute line numbers and keeps re-import IDs stable", async () => {
    const source = [1, 2, 3].flatMap(d => [`2028年6月${d}日`, prose(400, `第${d}城`)]).join("\n");
    byHeadings.mockClear();
    const progress = vi.fn();
    const result = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: byHeadings }, progress);
    expect(byHeadings).toHaveBeenCalledTimes(3);
    expect(byHeadings.mock.calls.map(([, init]) => suppliedLines(init).map(l => l.line)).sort()).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(progress.mock.calls[0][0]).toEqual({ segments: 3, segmentsDone: 0 });
    expect(progress.mock.calls.at(-1)![0]).toEqual({ segments: 3, segmentsDone: 3 });
    expect(result).toMatchObject({ segments: 3, degradedLines: 0, degradations: [] });
    expect(result.chapters.map(c => c.date)).toEqual(["2028-06-01", "2028-06-02", "2028-06-03"]);
    expect(result.chapters[1].id).toBe(hashId(`${input.fallbackDate}\0${source}\0chapter2`));
    expect(result.chapters[1].events[0].id).toBe(hashId(`${input.fallbackDate}\0${source}\0${3}`));
    const again = await prepareJournalImport({ ...input, source }, { revision: 1, chapters: result.chapters }, { ...model, fetcher: byHeadings });
    expect(again.chapters).toEqual(result.chapters); expect(again.importedChapterIds).toEqual(result.importedChapterIds);
  });

  it("continues a chapter cut mid-day into the previous segment's last chapter", async () => {
    const source = ["2028年6月3日 远行", prose(300, "乙"), "", prose(300, "丙"), "", prose(300, "丁")].join("\n");
    byHeadings.mockClear();
    const result = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: byHeadings });
    expect(byHeadings).toHaveBeenCalledTimes(2);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]).toMatchObject({ source, date: "2028-06-03", title: "2028年6月3日 远行" });
    expect(result.chapters[0].events.map(e => e.text)).toEqual([prose(300, "乙"), prose(300, "丙"), prose(300, "丁")]);
    expect(result.chapters[0].id).toBe(hashId(`${input.fallbackDate}\0${source}\0chapter0`));
  });

  it("joins identical dated days staged by different calls instead of failing or dropping a line", async () => {
    const day = ["2028年6月3日", prose(300, "湖边")], source = [...day, ...day].join("\n");
    const result = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: byHeadings });
    expect(result.segments).toBe(2); expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].source).toBe(source);
    expect(result.chapters[0].events.map(e => e.text)).toEqual([day[1], day[0], day[1]]);
    expect(result.degradedLines).toBe(1);
  });

  it("bounds concurrent model calls", async () => {
    const source = [1, 2, 3, 4, 5, 6, 7].flatMap(d => [`2028年6月${d}日`, prose(300, `第${d}城`)]).join("\n");
    let active = 0, peak = 0;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return toolResponse("stage_journal_import", stageByHeadings(suppliedLines(init)));
    });
    const result = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(7); expect(result.chapters).toHaveLength(7);
    expect(peak).toBe(JOURNAL_SEGMENT_CONCURRENCY);
  });

  it("stops every segment when cancelled mid-import", async () => {
    const source = [1, 2, 3, 4, 5, 6].flatMap(d => [`2028年6月${d}日`, prose(300, `第${d}城`)]).join("\n");
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) return toolResponse("stage_journal_import", stageByHeadings(suppliedLines(init)));
      controller.abort();
      return new Promise<Response>((_, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    await expect(prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher, signal: controller.signal })).rejects.toMatchObject({ code: "INTENT_CANCELLED" });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(JOURNAL_SEGMENT_CONCURRENCY + 1);
  });

  it("fails the job on a transport error and reports that error, not a sibling's cancellation", async () => {
    const source = [1, 2, 3, 4].flatMap(d => [`2028年6月${d}日`, prose(300, `第${d}城`)]).join("\n");
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (suppliedLines(init)[0].line === 2) return new Response("provider detail", { status: 500 });
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        setTimeout(() => resolve(toolResponse("stage_journal_import", stageByHeadings(suppliedLines(init)))), 50);
      });
    });
    await expect(prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher })).rejects.toMatchObject({ code: "INTENT_FAILED" });
  });
});
