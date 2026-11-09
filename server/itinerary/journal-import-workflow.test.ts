import { describe, expect, it, vi } from "vitest";
import { prepareJournalImport } from "./journal-import-workflow";
import { mockChapter, mockJournalModel, toolResponse } from "./journal-import-test-fixtures";
import { previewJournalImport } from "../../src/journey/dailyJournal";
const lines = ["2028年6月3–5日", "- 23:30 实际：她在虚构城入住星桥酒店。", "- 07:30 计划：离开城市。", "- 10:30–13:30 计划：游览景点。实际遇到雪景，体感很冷。", "- 08:00 取消：原计划入住山谷酒店。", "- 00:20 实际：她准备睡觉。", "- 09:00 实际：她觉得很冷。"];
export const fictionalSource = lines.join("\n");
export function fictionalDraft() {
  const times = ["23:30", "07:30", "10:30", "08:00", "00:20", "09:00"];
  return { chapters: [{ firstLine: 0, lastLine: 6, headingEvidence: lines[0], dateStatus: "range", questions: [], date: "2028-06-03", dateEnd: "2028-06-05", dateEvidence: lines[0],
    events: lines.slice(1).map((evidence, i) => ({ line: i + 1, evidence, status: ["actual", "planned", "uncertain", "cancelled", "actual", "actual"][i],
      dateStatus: "absent", localDate: null, dateEvidence: null, time: times[i], timeEnd: i === 2 ? "13:30" : null,
      timeEvidence: i === 2 ? "10:30–13:30" : times[i], placeName: null, reading: i === 4 ? "她已经睡着了。" : evidence, questions: [] })) }] };
}
const input = { source: fictionalSource, sentence: "导入原稿并关联已入住酒店", fallbackDate: "2028-06-01" };
const model = { baseUrl: "https://model.example.test/v1", apiKey: "mock-only", model: "mock", timeoutMs: 1000 };

describe("whole-source journal model boundary", () => {
  it("uses a real named tool and preserves range, clock order, mixed facts, person and existing edits", async () => {
    const old = previewJournalImport("2028-05-01\n实际：旧记事", "2028-05-01"); old[0].events[0].text = "private edited prose"; old[0].events[0].edited = true;
    const fetcher = vi.fn(async () => toolResponse("stage_journal_import", fictionalDraft()));
    const draft = await prepareJournalImport(input, { revision: 1, chapters: old }, { ...model, fetcher });
    const result = draft.chapters;
    expect(result[0]).toEqual(old[0]); expect(result[1].source).toBe(fictionalSource);
    expect(result[1].events.map(e => e.status)).toEqual(["actual", "planned", "uncertain", "cancelled", "actual", "actual"]);
    expect(result[1].events.map(e => e.localTime)).toEqual(["23:30", "07:30", null, "08:00", "00:20", "09:00"]);
    expect(result[1].events.every(e => e.localDate === null && e.routePointId === null)).toBe(true);
    expect(result[1].events[2].timeContext).toContain("10:30–13:30");
    expect(result[1].events[4].text).toContain("准备睡觉"); expect(JSON.stringify(result)).not.toContain("已经睡着");
    expect(result[1].suggestions[0].questions.join()).toContain("未推断逐日分配");
    const body = JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(body.tool_choice.function.name).toBe("stage_journal_import"); expect(body.messages[1].content).not.toContain("private edited prose");
    expect(body.messages[1].content).not.toContain("apiKey");
    expect(await prepareJournalImport(input, { revision: 2, chapters: result }, { ...model, fetcher })).toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
it("covers fourteen synthetic chapters with list-first clocks and preserves date-line order", async () => {
  const blocks = Array.from({ length: 14 }, (_, i) => [`2028年6月${i + 1}日`, "- 23:30 实际：她从甲城出发。", "- 18:20 实际：她抵达乙城。", "- 08:00 计划：虚构花园。", "- 09:00 取消：原酒店。"]);
  const source = blocks.flat().join("\n");
  const response = { chapters: blocks.map((lines, i) => ({ firstLine: i * 5, lastLine: i * 5 + 4, headingEvidence: lines[0], dateStatus: "single", questions: [], date: `2028-06-${String(i + 1).padStart(2, "0")}`, dateEnd: null, dateEvidence: lines[0],
    events: lines.slice(1).map((evidence, j) => ({ line: i * 5 + j + 1, evidence, status: ["actual", "actual", "planned", "cancelled"][j], dateStatus: "absent", localDate: null, dateEvidence: null,
      time: ["23:30", "18:20", "08:00", "09:00"][j], timeEnd: null, timeEvidence: ["23:30", "18:20", "08:00", "09:00"][j], placeName: null, reading: evidence, questions: [] })) })) };
  const result = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", response) });
  expect(result.chapters).toHaveLength(14); expect(result.chapters.map(c => c.source).join("\n")).toBe(source);
  for (const c of result.chapters) { expect(c.events.map(e => e.localTime)).toEqual(["23:30", "18:20", "08:00", "09:00"]); expect(c.events.map(e => e.status)).toEqual(["actual", "actual", "planned", "cancelled"]); }
});

async function prepare(source: string, chapter = mockChapter(source)) {
  return prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, { ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [chapter] }) });
}
it.each(["omission", "source", "order", "date", "time", "range-order", "extra", "wrong-line-quote"])("rejects structural/source violation %s", async kind => {
  const source = "2028年6月3日她出发。\n2028年6月5日她返回。", c = mockChapter(source), e = c.events[0];
  if (kind === "omission") c.events.pop();
  if (kind === "source") e.evidence = "fabricated";
  if (kind === "order") e.line = 1;
  if (kind === "date") Object.assign(c, { dateStatus: "single", date: "2028-02-30", dateEvidence: "2028年6月3日" });
  if (kind === "time") Object.assign(e, { time: "25:30", timeEvidence: "出发" });
  if (kind === "range-order") Object.assign(c, { dateStatus: "range", date: "2028-06-05", dateEnd: "2028-06-03", dateEvidence: "2028年6月3日" });
  if (kind === "extra") Object.assign(e, { latitude: 1 });
  if (kind === "wrong-line-quote") Object.assign(c, { dateStatus: "single", date: "2028-06-05", dateEvidence: "2028年6月5日" });
  await expect(prepare(source, c)).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
});
it("requires explicit whole heading reference to omit a first line", async () => {
  const source = "### 2028年6月3日\n她出发。", c = mockChapter(source); c.events.shift();
  await expect(prepare(source, c)).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
  c.headingEvidence = "2028年6月3日";
  await expect(prepare(source, c)).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
  c.headingEvidence = source.split("\n")[0];
  expect((await prepare(source, c)).chapters[0].source).toBe(source);
});
it("keeps semantic status and prose supplied for review without keyword reclassification", async () => {
  const source = "她没有入住星桥酒店，后来取消计划。", c = mockChapter(source);
  c.events[0].status = "uncertain"; c.events[0].reading = "已入住"; c.events[0].questions = ["实际行为待确认"];
  const result = await prepare(source, c);
  expect(result.chapters[0].events[0]).toMatchObject({ status: "uncertain", text: source, routePointId: null });
  expect(result.chapters[0].suggestions[0].questions).toContain("实际行为待确认");
  expect(result.chapters[0].suggestions[0].text).toBe(source);
});
it("corrects an invalid date argument with a matched error before staging once", async () => {
  const source = "2028年6月？日到2028年6月5日，她旅行。", c = mockChapter(source);
  Object.assign(c, { dateStatus: "unknown", date: "2028-06-05", dateEvidence: source, questions: ["日期范围待确认"] });
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const messages = JSON.parse(String(init?.body)).messages;
    if (messages.length > 2) { expect(messages.at(-1).tool_call_id).toBe(messages.at(-2).tool_calls[0].id); c.date = null; }
    return toolResponse("stage_journal_import", { chapters: [c] });
  });
  const result = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, { ...model, fetcher });
  expect(fetcher).toHaveBeenCalledTimes(2); expect(result.chapters[0].events[0].localDate).toBeNull();
  expect(result.chapters[0].suggestions[0].questions).toContain("日期范围待确认");
});

it.each([false, true])("does not collapse same-input repetitions into saved-record replay (prior=%s)", async withPrior => {
  const text = "她在湖边散步。", source = `${text}\n${text}`;
  const prior = withPrior ? (await prepare(text)).chapters : [];
  const before = { revision: withPrior ? 1 : 0, chapters: prior }, snapshot = structuredClone(before);
  const first = mockChapter(text), second = mockChapter(text);
  second.firstLine = second.lastLine = second.events[0].line = 1;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (fetcher.mock.calls.length === 1) return toolResponse("stage_journal_import", { chapters: [first, second] });
    const messages = JSON.parse(String(init?.body)).messages;
    expect(JSON.parse(messages.at(-1).content).error).toMatchObject({ path: "$.chapters[1]", code: "DUPLICATE_CHAPTER_SOURCE" });
    expect(messages.at(-1).tool_call_id).toBe(messages.at(-2).tool_calls[0].id);
    return toolResponse("stage_journal_import", { chapters: [mockChapter(source)] });
  });
  const result = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, before, { ...model, fetcher });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.chapters.filter(c => result.importedChapterIds.includes(c.id)).map(c => c.source).join("\n")).toBe(source);
  expect(result.chapters.at(-1)!.events.map(e => e.source)).toEqual([text, text]);
  expect(new Set(result.importedChapterIds).size).toBe(result.importedChapterIds.length);
  expect(new Set(result.chapters.at(-1)!.events.map(e => e.id)).size).toBe(2);
  expect(before).toEqual(snapshot);
  if (withPrior) expect(result.chapters[0]).toEqual(prior[0]);
});
it("stops repeated invalid chapter grouping without returning a shortened preview", async () => {
  const text = "她在湖边散步。", source = `${text}\n${text}`, first = mockChapter(text), second = mockChapter(text);
  second.firstLine = second.lastLine = second.events[0].line = 1;
  const fetcher = vi.fn(async () => toolResponse("stage_journal_import", { chapters: [first, second] }));
  await expect(prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, { ...model, fetcher })).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
