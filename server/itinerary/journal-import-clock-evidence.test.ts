import { expect, it } from "vitest";
import { prepareJournalImport } from "./journal-import-workflow";

async function prepare(source: string, time: string | null, evidence: string | null, end: string | null = null) {
  const questions = time === null ? ["钟点待确认"] : [];
  const answer = { chapters: [{ firstLine: 0, lastLine: 0, date: null, dateEnd: null, dateEvidence: null,
    events: [{ line: 0, evidence: source, status: "actual", localDate: null, dateEvidence: null,
      time, timeEnd: end, timeEvidence: evidence, reading: source, questions }] }] };
  return prepareJournalImport({ source, sentence: "导入合成记录", fallbackDate: "2028-06-03" }, { revision: 0, chapters: [] }, {
    baseUrl: "https://synthetic.example.test/v1", apiKey: "mock-only", model: "mock", timeoutMs: 1000,
    fetcher: async () => Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: {
      name: "stage_journal_import", arguments: JSON.stringify(answer),
    } }] } }] }),
  });
}
const endpoints = ["约10:30", "大约 10:30", "around 10:30", "about 10:30", "晚上约10:30", "10:30左右", "10:30 PM", "10:000", "100:00", "10:0", "99:00", "10:60", "10:", "10:xx", ":30", "(10:30)", "（10:30）"];
const cases = endpoints.flatMap(endpoint => ["到", "至", " to "].flatMap(separator => [
  `09:00${separator}${endpoint} 实际：途中。`, `${endpoint}${separator}09:00 实际：途中。`,
]));
it.each(cases)("preserves both range fragments or explicit clock uncertainty: %s", async source => {
  await expect(prepare(source, "09:00", "09:00")).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
  const result = await prepare(source, null, null);
  expect(result.chapters[0].events[0]).toMatchObject({ source, localTime: null, localDate: null });
  expect(result.chapters[0].suggestions[0].questions).toContain("钟点待确认");
});
it.each(["09:00到10号酒店", "09:00 to 10 Downing Street", "09:00-抵达酒店。", "Amsterdam 09:00 she arrives.", "09:00 tomorrow she arrives."])("does not invent a range from destination prose: %s", async source => {
  expect((await prepare(source, "09:00", "09:00")).chapters[0].events[0]).toMatchObject({ source, localTime: "09:00", localDate: null });
});
it.each(["09:00到（10:30）", "(09:00) to (10:30)", "（09:00至10:30）", "【09:00】到【10:30】"])("accepts the complete balanced range %s", async evidence => {
  const source = `${evidence} 实际：途中。`, result = await prepare(source, "09:00", evidence, "10:30");
  expect(result.chapters[0].events[0]).toMatchObject({ source, localTime: null, localDate: null });
  expect(result.chapters[0].events[0].timeContext).toContain(evidence);
});
it("preserves wrapped meridiem and midnight without inferring a new date", async () => {
  const evidence = "（晚上11:30）到（凌晨1:00）", source = `${evidence} 实际：途中。`;
  expect((await prepare(source, "23:30", evidence, "01:00")).chapters[0].events[0]).toMatchObject({ source, localTime: null, localDate: null });
});
it("rejects a repeated evidence token when another occurrence crops a range", async () => {
  await expect(prepare("09:00醒来，09:00到（10:30）散步。", "09:00", "09:00")).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
});

it.each(["约（09:00）", "（09:00左右）", "（09:00）左右出发", "09:00（左右）出发", "around (09:00)", "(09:00) PM", "09:00醒来，约（09:00）散步。"])("does not crop wrapped or repeated clock context: %s", async source => {
  await expect(prepare(source, "09:00", "09:00")).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
});

it("checks qualifiers of every occurrence of a complete range quote", async () => {
  await expect(prepare("09:00到10:30，09:00到10:30 PM", "09:00", "09:00到10:30", "10:30")).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
});

it.each(["2028-06-01 09:00 实际：她出发。", "09:00 10号门集合。"])("keeps whitespace-separated date or address digits distinct: %s", async source => {
  expect((await prepare(source, "09:00", "09:00")).chapters[0].events[0].localTime).toBe("09:00");
});
