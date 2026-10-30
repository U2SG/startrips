import { describe, expect, it, vi } from "vitest";
import { prepareJournalImport } from "./journal-import-workflow";
import { previewJournalImport } from "../../src/journey/dailyJournal";
const lines = ["2028年6月3–5日", "- 23:30 实际：她在虚构城入住星桥酒店。", "- 07:30 计划：离开城市。", "- 10:30–13:30 计划：游览景点。实际遇到雪景，体感很冷。", "- 08:00 取消：原计划入住山谷酒店。", "- 00:20 实际：她准备睡觉。", "- 09:00 实际：她觉得很冷。"];
export const fictionalSource = lines.join("\n");
export function fictionalDraft() {
  const times = ["23:30", "07:30", "10:30", "08:00", "00:20", "09:00"];
  return { chapters: [{ firstLine: 0, lastLine: 6, date: "2028-06-03", dateEnd: "2028-06-05", dateEvidence: lines[0],
    events: lines.slice(1).map((evidence, i) => ({ line: i + 1, evidence, status: ["actual", "planned", "actual", "cancelled", "actual", "actual"][i],
      localDate: null, dateEvidence: null, time: times[i], timeEnd: i === 2 ? "13:30" : null,
      timeEvidence: i === 2 ? "10:30–13:30" : times[i], reading: i === 4 ? "她已经睡着了。" : evidence, questions: [] })) }] };
}
const input = { source: fictionalSource, sentence: "导入原稿并关联已入住酒店", fallbackDate: "2028-06-01" };
const model = { baseUrl: "https://model.example.test/v1", apiKey: "mock-only", model: "mock", timeoutMs: 1000 };
export const toolResponse = (name: string, payload: unknown) => Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(payload) } }] } }] });
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
  it.each(["omission", "source", "order", "date", "time", "range", "date-rollover", "wrong-tool"])("rejects %s instead of writing or guessing", async kind => {
    const draft = fictionalDraft(); const event = draft.chapters[0].events[0];
    if (kind === "omission") draft.chapters[0].events.pop();
    if (kind === "source") event.evidence = "fabricated";
    if (kind === "order") event.line = 2;
    if (kind === "date") draft.chapters[0].date = "2028-06-04";
    if (kind === "time") event.time = "25:30";
    if (kind === "range") { draft.chapters[0].events[2].timeEnd = null; draft.chapters[0].events[2].timeEvidence = "10:30"; }
    if (kind === "date-rollover") Object.assign(event, { localDate: "2028-06-04", dateEvidence: "" });
    await expect(prepareJournalImport(input, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse(kind === "wrong-tool" ? "sql" : "stage_journal_import", draft) })).rejects.toThrow();
  });
  it("fails clearly on unsupported provider responses and does not fall back to invented success", async () => {
    await expect(prepareJournalImport(input, { revision: 0, chapters: [] }, { ...model, fetcher: async () => Response.json({ choices: [{ message: { content: "{}" } }] }) })).rejects.toThrow();
  });
});

it.each(["10:30–13:30 计划：游览。", "约 07:30 实际：出发。"])("rejects cropped/approximate clock in %s", async source => {
  const time = source.startsWith("约") ? "07:30" : "13:30";
  const draft = { chapters: [{ firstLine: 0, lastLine: 0, date: null, dateEnd: null, dateEvidence: null, events: [{ line: 0, evidence: source, status: "planned", localDate: null, dateEvidence: null,
    time, timeEnd: null, timeEvidence: time, reading: "", questions: [] }] }] };
  await expect(prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", draft) })).rejects.toThrow();
});
it("cannot hide a dated prose event as a chapter heading", async () => {
  const source = "09:00 实际：她于2028年6月3日抵达虚构城。";
  const draft = { chapters: [{ firstLine: 0, lastLine: 0, date: "2028-06-03", dateEnd: null, dateEvidence: "2028年6月3日", events: [] }] };
  await expect(prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", draft) })).rejects.toThrow();
});
it("preserves negation and distinct undated import days", async () => {
  const source = "她没有入住星桥酒店。";
  const draft = { chapters: [{ firstLine: 0, lastLine: 0, date: null, dateEnd: null, dateEvidence: null, events: [{ line: 0, evidence: source, status: "uncertain", localDate: null, dateEvidence: null,
    time: null, timeEnd: null, timeEvidence: null, reading: "入住星桥酒店", questions: [] }] }] };
  const fetcher = async () => toolResponse("stage_journal_import", draft);
  const first = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher });
  expect(first.chapters[0].suggestions[0].text).toBe(source);
  const second = await prepareJournalImport({ ...input, source, fallbackDate: "2028-06-02" }, { revision: 1, chapters: first.chapters }, { ...model, fetcher });
  expect(second.chapters.map(c => c.date)).toEqual(["2028-06-01", "2028-06-02"]);
  expect(second.importedChapterIds).toEqual([second.chapters[1].id]);
  expect(new Set(second.chapters.flatMap(c => [c.id, ...c.events.map(e => e.id)])).size).toBe(4);
});
it("covers fourteen synthetic chapters with list-first clocks and preserves date-line order", async () => {
  const blocks = Array.from({ length: 14 }, (_, i) => [`2028年6月${i + 1}日（虚构）`, "- 23:30 实际：她从甲城出发。", "- 18:20 实际：她抵达乙城。", "- 08:00 计划：虚构花园。", "- 09:00 取消：原酒店。"]);
  const source = blocks.flat().join("\n");
  const response = { chapters: blocks.map((lines, i) => ({ firstLine: i * 5, lastLine: i * 5 + 4, date: `2028-06-${String(i + 1).padStart(2, "0")}`, dateEnd: null, dateEvidence: lines[0],
    events: lines.slice(1).map((evidence, j) => ({ line: i * 5 + j + 1, evidence, status: ["actual", "actual", "planned", "cancelled"][j], localDate: null, dateEvidence: null,
      time: ["23:30", "18:20", "08:00", "09:00"][j], timeEnd: null, timeEvidence: ["23:30", "18:20", "08:00", "09:00"][j], reading: evidence, questions: [] })) })) };
  const result = await prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", response) });
  expect(result.chapters).toHaveLength(14); expect(result.chapters.map(c => c.source).join("\n")).toBe(source);
  for (const c of result.chapters) { expect(c.events.map(e => e.localTime)).toEqual(["23:30", "18:20", "08:00", "09:00"]); expect(c.events.map(e => e.status)).toEqual(["actual", "actual", "planned", "cancelled"]); }
});
it.each(["range-end", "cropped-invalid-date"])("rejects ungrounded chapter date %s", async kind => {
  const source = kind === "range-end" ? "2028年6月3–5日\n她休息。" : "### 2028年6月35日\n她休息。";
  const draft = { chapters: [{ firstLine: 0, lastLine: 1, date: kind === "range-end" ? "2028-06-05" : "2028-06-03", dateEnd: null,
    dateEvidence: kind === "range-end" ? "2028年6月3–5日" : "2028年6月3", events: [{ line: 1, evidence: "她休息。", status: "uncertain", localDate: null, dateEvidence: null, time: null, timeEnd: null, timeEvidence: null, reading: "", questions: [] }] }] };
  await expect(prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", draft) })).rejects.toThrow();
});
it.each([" 至 ", " 到 ", " - ", "–"])("rejects the cropped right endpoint of a %s date range", async separator => {
  const source = `### 2028年6月3日${separator}2028年6月5日\n她休息。`;
  const draft = { chapters: [{ firstLine: 0, lastLine: 1, date: "2028-06-05", dateEnd: null, dateEvidence: "2028年6月5日",
    events: [{ line: 1, evidence: "她休息。", status: "uncertain", localDate: null, dateEvidence: null, time: null, timeEnd: null, timeEvidence: null, reading: "", questions: [] }] }] };
  await expect(prepareJournalImport({ ...input, source }, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", draft) })).rejects.toThrow();
});
it("does not silently accept missing structured clocks with no uncertainty question", async () => {
  const draft = fictionalDraft(); Object.assign(draft.chapters[0].events[0], { time: null, timeEnd: null, timeEvidence: null });
  await expect(prepareJournalImport(input, { revision: 0, chapters: [] }, { ...model, fetcher: async () => toolResponse("stage_journal_import", draft) })).rejects.toThrow();
});
