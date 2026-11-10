import { expect, it } from "vitest";
import { prepareJournalImport } from "./journal-import-workflow";
import { JOURNAL_DEGRADED_QUESTION } from "./journal-import-workflow";
import { mockChapter, mockJournalModel, toolResponse } from "./journal-import-test-fixtures";
// Mock semantic clock claims. The server checks shape/provenance, not prose interpretation.
async function prepare(source: string, time: string | null, evidence: string | null, end: string | null = null, questions = time === null ? ["钟点待确认"] : []) {
  const c = mockChapter(source); Object.assign(c.events[0], { time, timeEnd: end, timeEvidence: evidence, questions });
  return prepareJournalImport({ source, sentence: "导入合成记录", fallbackDate: "2028-06-03" }, { revision: 0, chapters: [] }, {
    ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [c] }),
  });
}
const endpoints = ["约10:30", "大约 10:30", "around 10:30", "about 10:30", "晚上约10:30", "10:30左右", "10:30 PM", "10:000", "100:00", "10:0", "99:00", "10:60", "10:", "10:xx", ":30", "(10:30)", "（10:30）"];
const cases = endpoints.flatMap(endpoint => ["到", "至", " to "].flatMap(separator => [
  `09:00${separator}${endpoint} 实际：途中。`, `${endpoint}${separator}09:00 实际：途中。`,
]));
it.each(cases)("preserves model-declared clock uncertainty and full source: %s", async source => {
  const result = await prepare(source, null, source);
  expect(result.chapters[0].events[0]).toMatchObject({ source, localTime: null, localDate: null });
  expect(result.chapters[0].suggestions[0].questions).toContain("钟点待确认");
});
it.each(["09:00到10号酒店", "09:00 to 10 Downing Street", "09:00-抵达酒店。", "Amsterdam 09:00 she arrives.", "09:00 tomorrow she arrives."])("accepts correct single-clock parameters next to prose: %s", async source => {
  expect((await prepare(source, "09:00", "09:00")).chapters[0].events[0]).toMatchObject({ source, localTime: "09:00", localDate: null });
});
it.each(["09:00到（10:30）", "(09:00) to (10:30)", "（09:00至10:30）", "【09:00】到【10:30】"])("accepts a model-normalized complete range %s", async evidence => {
  const result = await prepare(evidence, "09:00", evidence, "10:30");
  expect(result.chapters[0].events[0]).toMatchObject({ localTime: null, localDate: null });
  expect(result.chapters[0].events[0].timeContext).toContain(evidence);
});
it("preserves wrapped meridiem and midnight without inferring a new date", async () => {
  const source = "（晚上11:30）到（凌晨1:00） 实际：途中。";
  expect((await prepare(source, "23:30", source, "01:00")).chapters[0].events[0]).toMatchObject({ source, localTime: null, localDate: null });
});
const degradedLine = async (result: ReturnType<typeof prepare>) => {
  const draft = await result;
  expect(draft.degradedLines).toBe(1);
  expect(draft.chapters[0].events[0]).toMatchObject({ status: "uncertain", localTime: null, localDate: null });
  expect(draft.chapters[0].suggestions[0].questions).toContain(JOURNAL_DEGRADED_QUESTION);
};
it.each(["25:00", "10:60", "9:00", "09:000"])("leaves a line with malformed normalized clock %s for review", async time => {
  await degradedLine(prepare("09:00 出发", time, "09:00"));
});
it("leaves lines with ungrounded or inconsistent clock fields for review", async () => {
  await degradedLine(prepare("约09:00", null, "约09:00", null, []));
  await degradedLine(prepare("09:00", "09:00", "fabricated"));
  await degradedLine(prepare("09:00", "09:00", null));
  await degradedLine(prepare("约09:00", null, "约09:00", "10:00"));
});
