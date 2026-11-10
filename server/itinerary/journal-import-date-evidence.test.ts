import { expect, it } from "vitest";
import { validateJournalDateClaim, type JournalDateClaim } from "./journal-import-date-evidence";
import { prepareJournalImport } from "./journal-import-workflow";
import { mockChapter, mockJournalModel, toolResponse } from "./journal-import-test-fixtures";
import { JOURNAL_DEGRADED_QUESTION } from "./journal-import-workflow";
// We verify structured mock claims/provenance, NOT semantic extraction by an LLM.
// Whole-line date-guessing assertions were replaced with the explicit tool contract.
const claim = (overrides: Partial<JournalDateClaim> = {}): JournalDateClaim => ({ status: "single", start: "2028-06-03", end: null, evidence: "2028年6月3日", questions: [], ...overrides });
it.each([
  { start: "2028-02-30" }, { start: "2029-02-29" }, { start: "2028-06-03T00:00" },
  { end: "2028-06-05" }, { evidence: "fabricated" }, { status: "absent" as const },
  { status: "unknown" as const, start: null },
  { status: "range" as const, end: "2028-06-02" },
])("rejects invalid structured claim %j", overrides => {
  expect(() => validateJournalDateClaim(claim(overrides), "2028年6月3日", "$.date")).toThrow();
});
it("does not pretend exact substring provenance proves semantic correctness", () => {
  // This is an explicit limit: a wrong semantic classification remains model/member responsibility.
  expect(() => validateJournalDateClaim(claim(), "2028年6月3日到2028年6月5日", "$.date")).not.toThrow();
});
async function prepare(source: string, mode: "chapter" | "event", unknown: boolean, inconsistent = false) {
  const chapter = mockChapter(source), target = mode === "chapter" ? chapter : chapter.events[0];
  target.dateStatus = unknown ? "unknown" : "single";
  target.dateEvidence = unknown ? source : "2028年6月3日";
  target.questions = unknown ? ["完整日期范围待确认"] : [];
  if (mode === "chapter") chapter.date = unknown && !inconsistent ? null : "2028-06-03";
  else chapter.events[0].localDate = unknown && !inconsistent ? null : "2028-06-03";
  return prepareJournalImport({ source, sentence: "导入合成日期记录", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, {
    ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [chapter] }),
  });
}
const uncertainDateFields = ["?", "？", "x", "ｘ", "X", "Ｘ"].flatMap(unknown => [
  `${unknown.repeat(4)}年6月3日`, `2028年${unknown}月3日`, `2028年6月${unknown}日`,
  `${unknown}月3日`, `6月${unknown}日`, `${unknown}日`,
  ...["-", "/", "."].flatMap(sep => [
    `202${unknown}${sep}06${sep}03`, `2028${sep}${unknown}${sep}03`, `2028${sep}06${sep}${unknown}`,
  ]),
]);
const uncertainRangeSources = uncertainDateFields.flatMap(endpoint => [
  `记录：（${endpoint}）到（2028年6月5日），她旅行。`,
  `记录：（2028年6月5日）到（${endpoint}），她旅行。`,
]);
const measuredDestinations = [
  "（3.5公里外的酒店）", "（3.5千米外的酒店）", "（3.5 km外的酒店）", "（3.5）公里外的酒店",
  "（3.5元的报价）", "（3.5万元的报价）", "（3.5 USD的报价）", "（3.5）美元的报价",
  "（3.5公斤的行李处）", "（3.5 kg的行李处）", "（3.5小时车程的酒店）", "（3.5℃的冰室）",
  "（3.5%的坡道）", "（3.5 m高的平台）", "（3/5升的水壶旁）", "（3）公里外的酒店",
  "（３．５公里外的酒店）", "（３．５）元的报价",
  "（3,500.5元的报价）", "（3,500.5）元的报价", "（3,500米外的酒店）", "（3.5e2米外的酒店）",
];
for (const mode of ["chapter", "event"] as const) {
  it.each(uncertainRangeSources)(`preserves explicit unknown ${mode} dates and questions: %s`, async source => {
    const result = await prepare(source, mode, true);
    expect(result.chapters[0].source).toBe(source);
    expect(result.chapters[0].events[0].localDate).toBeNull();
    expect(result.chapters[0].suggestions[0].questions).toContain("完整日期范围待确认");
  });
  it.each(["记录：（2028年6月？日）到（2028年6月5日），她旅行。", "记录：（2028年6月5日）到（2028年？月5日），她旅行。"])(`never stages a normalized value on an unknown ${mode} claim: %s`, async source => {
    const result = await prepare(source, mode, true, true);
    // A chapter claim is structural (whole segment falls back); an event claim degrades its line.
    expect(result.degradations).toEqual(mode === "chapter" ? [{ segment: 0, path: "$.chapters[0].date", code: "UNKNOWN_DATE_VALUES" }] : []);
    expect(result.degradedLines).toBe(1);
    expect(result.chapters[0]).toMatchObject({ source, date: "2028-06-01" });
    expect(result.chapters[0].events[0]).toMatchObject({ status: "uncertain", localDate: null });
    expect(result.chapters[0].suggestions[0].questions).toContain(JOURNAL_DEGRADED_QUESTION);
  });
  it.each(measuredDestinations)(`does not reject a correct ${mode} single day beside quantities: %s`, async destination => {
    const source = `她于2028年6月3日到${destination}入住。`, result = await prepare(source, mode, false);
    expect(result.chapters[0].source).toBe(source);
    expect(result.chapters[0].date).toBe(mode === "chapter" ? "2028-06-03" : "2028-06-01");
    expect(result.chapters[0].events[0].localDate).toBe(mode === "event" ? "2028-06-03" : null);
    expect(result.chapters[0].suggestions[0].questions.join()).not.toMatch(/日期范围|日期区间/);
  });
}
it.each(["（2028.06.03）到（2028.06.05）", "（２０２８．０６．０３）到（６．５）", "2028年6月3–5日"])("accepts model-normalized inclusive range %s", async source => {
  const chapter = mockChapter(source);
  Object.assign(chapter, { dateStatus: "range", date: "2028-06-03", dateEnd: "2028-06-05", dateEvidence: source });
  const result = await prepareJournalImport({ source, sentence: "导入", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, { ...mockJournalModel, fetcher: async () => toolResponse("stage_journal_import", { chapters: [chapter] }) });
  expect(result.chapters[0].suggestions[0].questions.join()).toContain("2028-06-03 至 2028-06-05");
});
