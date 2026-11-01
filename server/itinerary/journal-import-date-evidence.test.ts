import { expect, it } from "vitest";
import { groundedJournalDates, hasJournalDateRange, isJournalDateHeading } from "./journal-import-date-evidence";
import { prepareJournalImport } from "./journal-import-workflow";

const formats = [
  ["2028年6月3日", "2028年6月5日"], ["6月3日", "6月5日"],
  ["2028-06-03", "2028-06-05"], ["2028/06/03", "2028/06/05"],
  ["2028.06.03", "2028.06.05"], ["6/3", "6/5"],
];
const wrappers = [(x: string) => x, (x: string) => `(${x})`, (x: string) => `（${x}）`,
  (x: string) => `[${x}]`, (x: string) => `【${x}】`, (x: string) => `（[${x}]）`];
const separators = ["到", "至", " - ", "–", "—", "~", "～", " to "];
const ranges = formats.flatMap(([a, b]) => wrappers.flatMap(w => separators.map(sep => ({ a, b, evidence: w(a) + sep + w(b) }))));
it.each(ranges)("keeps the complete date range $evidence", ({ evidence }) => {
  expect(groundedJournalDates(evidence, `记录：${evidence}。`, "2028")).toEqual(["2028-06-03", "2028-06-05"]);
  expect(isJournalDateHeading(`### ${evidence}`, "2028")).toBe(true);
});
it.each(ranges)("cannot crop either date endpoint of $evidence", ({ a, b, evidence }) => {
  for (const quote of [a, b]) expect(groundedJournalDates(quote, `记录：${evidence}。`, "2028")).toBeNull();
});
const unresolved = ["2028年6月35日", "2028年6月", "2028年6月xx日", "2028-06-", "2028-06-xx", "2028/13/01", "2028.02.30", "2028年6月0日", "2028年", "月5日", "2028/06", "6月", "6/", "2028年6月?日", "约2028年6月5日", "2028年6月5日左右", "around 2028-06-05"];
const neighbours = [...unresolved, "6月5日", "5日", "5", "（5日）"];
const cropped = neighbours.flatMap(endpoint => ["到", "至", " to "].flatMap(sep => [
  `2028年6月3日${sep}（${endpoint}）`, `（${endpoint}）${sep}2028年6月3日`,
]));
it.each(cropped)("retains invalid, approximate and elided neighbouring fragments: %s", source => {
  expect(hasJournalDateRange(source)).toBe(true);
  expect(groundedJournalDates("2028年6月3日", source, "2028")).toBeNull();
});
it.each(unresolved)("does not normalize incomplete or approximate full evidence: %s", endpoint => {
  const source = `（2028年6月3日）到（${endpoint}）`;
  expect(groundedJournalDates(source, source, "2028")).toBeNull();
});
it.each([
  ["（2028年6月3日）到（5日）", "2028-06-03", "2028-06-05"],
  ["2028年6月3–5日", "2028-06-03", "2028-06-05"],
  ["（6月3日）到（5）", "2028-06-03", "2028-06-05"],
  ["2028年6月30日至7月2日", "2028-06-30", "2028-07-02"],
  ["2028-06-30 - 07/02", "2028-06-30", "2028-07-02"],
  ["2028-06-03-05", "2028-06-03", "2028-06-05"],
  ["2028-12-30至2029-01-02", "2028-12-30", "2029-01-02"],
  ["2028年2月28–29日", "2028-02-28", "2028-02-29"],
])("inherits only explicitly shared right-hand fields: %s", (source, start, end) => {
  expect(groundedJournalDates(source, source, "2028")).toEqual([start, end]);
});
it.each(["2028年12月30日到1月2日", "2028年6月30日至2日", "2029年2月28日至29日", "3日到2028年6月5日", "2028年6月到2028年7月", "2028年6月3日至2028年6月5日至2028年6月7日"])("does not invent missing fields or rollover: %s", source => {
  expect(groundedJournalDates(source, source, "2028")).toBeNull();
});
const ordinary = ["2028年6月3日到酒店。", "2028年6月3日至此结束。", "2028年6月3日到3号楼。", "2028年6月3日 to 10 Downing Street", "2028年6月3日 to Amsterdam", "2028年6月3日（周六）抵达。", "2028年6月3日（第3天）抵达。", "2028年6月3日（虚构花园）散步。", "2028年6月3日 09:00出发。", "2028年6月3日 3人同行。", "2028年6月3日出发，2028年6月5日返程。", "2028年6月3日（休息）后出发，到2028年6月5日才返回。"];
it.each(ordinary)("does not turn intervening prose or addresses into date spans: %s", source => {
  expect(groundedJournalDates("2028年6月3日", source, "2028")).toEqual(["2028-06-03"]);
  expect(hasJournalDateRange(source)).toBe(false);
  expect(isJournalDateHeading(source, "2028")).toBe(false);
});
it.each(wrappers)("accepts a single wrapped date without creating a range", wrap => {
  const source = wrap("2028年6月3日");
  expect(groundedJournalDates(source, source, "2028")).toEqual(["2028-06-03"]);
  expect(hasJournalDateRange(source)).toBe(false);
});
it.each(["2028年6月3日出发；2028年6月3日到（2028年6月5日）休息。", "（2028年6月3日）到2028年6月5日；2028年6月3日出发。", "2028年6月3日，约（2028年6月3日）"])("checks every occurrence of repeated evidence: %s", source => {
  expect(groundedJournalDates("2028年6月3日", source, "2028")).toBeNull();
});
it.each(["### （2028年6月3日）", "2028年6月3日（周六）", "（2028年6月3日到2028年6月5日）", "### 【2028/06/03】 to 【2028/06/05】"])("recognizes only a date-only heading: %s", source => {
  expect(isJournalDateHeading(source, "2028")).toBe(true);
});
it.each(["### （2028年6月3日） 实际：她出发。", "2028年6月3日到", "2028年6月3日（计划：散步）", "（2028年6月3日） 至 （2028年6月5日】"])("keeps prose, truncated and unbalanced headings as events: %s", source => {
  expect(isJournalDateHeading(source, "2028")).toBe(false);
});
it.each([
  ["2028/06/03/05", "2028/06/03"], ["2028.06.03.5", "2028.06.03"],
  ["2028年6月3日00", "2028年6月3日"], ["2028-06-0300", "2028-06-03"],
  ["2028年6月3日日", "2028年6月3日"], ["2028/06/03/xx", "2028/06/03"],
])("cannot crop contiguous extra date fields or discard them as a heading: %s", (source, quote) => {
  expect(groundedJournalDates(quote, source, "2028")).toBeNull();
  expect(isJournalDateHeading(source, "2028")).toBe(false);
});
it.each(["2028年6月3日 00", "2028年6月3日（第3天）", "2028年6月3日 09:00"])("does not delete unselected numeric content from a heading: %s", source => {
  expect(isJournalDateHeading(source, "2028")).toBe(false);
});
it.each(["3日至5日", "（3日）到（5日）", "（3日）到（5）"])("recognizes day-only uncertainty without inventing a month: %s", source => {
  expect(hasJournalDateRange(source)).toBe(true);
  expect(groundedJournalDates(source, source, "2028")).toBeNull();
});
it.each(["2028/06/03日", "2028-06-03日", "6/3日"])("retains existing numeric dates with explicit day suffix: %s", source => {
  expect(groundedJournalDates(source, source, "2028")).toEqual(["2028-06-03"]);
});
const splitFields = [
  ["2027年", "6月3日"], ["2027-", "06-03"], ["2027/", "6/3"],
  ["2027.", "06.03"], ["2027年6月", "3日"], ["2027/06/", "03"],
].flatMap(([prefix, rest]) => wrappers.map(w => ({ source: `${prefix} ${w(rest)}`, rest })));
it.each(splitFields)("binds separated explicit year/month fields in $source", ({ source, rest }) => {
  expect(groundedJournalDates(source, source, "2028")).toEqual(["2027-06-03"]);
  expect(groundedJournalDates(rest, source, "2028")).toBeNull();
  expect(isJournalDateHeading(source, "2028")).toBe(true);
});
it.each(["2027年（6月）3日", "2027/（06/）03", "2027年 6月 3日"])("consumes all separated calendar fields: %s", source => {
  expect(groundedJournalDates(source, source, "2028")).toEqual(["2027-06-03"]);
  expect(groundedJournalDates("3日", source, "2028")).toBeNull();
});
it.each(["2027年行程：6月3日", "2027年（旅行总结）6月3日"])("does not join a year across narrative text: %s", source => {
  expect(groundedJournalDates("6月3日", source, "2028")).toEqual(["2028-06-03"]);
  expect(groundedJournalDates(source, source, "2028")).toBeNull();
  expect(isJournalDateHeading(source, "2028")).toBe(false);
});

async function prepare(source: string, quote: string | null, date: string | null, end: string | null, mode: "chapter" | "event", omitHeading = false) {
  const lines = source.split("\n"), answer = { chapters: [{ firstLine: 0, lastLine: lines.length - 1,
    date: mode === "chapter" ? date : null, dateEnd: end, dateEvidence: mode === "chapter" ? quote : null,
    events: lines.flatMap((evidence, line) => omitHeading && line === 0 ? [] : [{ line, evidence, status: "actual",
      localDate: mode === "event" ? date : null, dateEvidence: mode === "event" ? quote : null,
      time: null, timeEnd: null, timeEvidence: null, reading: evidence, questions: [] }]) }] };
  return prepareJournalImport({ source, sentence: "导入合成日期记录", fallbackDate: "2028-06-01" }, { revision: 0, chapters: [] }, {
    baseUrl: "https://mock.example.test/v1", apiKey: "mock-only", model: "mock", timeoutMs: 1000,
    fetcher: async () => Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: {
      name: "stage_journal_import", arguments: JSON.stringify(answer),
    } }] } }] }),
  });
}
for (const mode of ["chapter", "event"] as const) {
  it.each(["2028年6月3日", "2028年6月5日"])(`rejects cropped ${mode} dates through the real model boundary: %s`, async quote => {
    await expect(prepare("记录：（2028年6月3日）到（2028年6月5日）", quote, quote.includes("3日") ? "2028-06-03" : "2028-06-05", null, mode)).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
  });
  it(`keeps a ${mode} range explicitly unresolved with its full original`, async () => {
    const source = "记录：（2028年6月3日）到（2028年6月5日）", result = await prepare(source, null, null, null, mode);
    expect(result.chapters[0].source).toBe(source);
    expect(result.chapters[0].events[0].localDate).toBeNull();
    expect(result.chapters[0].suggestions[0].questions.join()).toContain("日期范围");
  });
}
it("preserves a complete wrapped chapter range and an omitted date-only heading", async () => {
  const heading = "（2028年6月3日）到（2028年6月5日）", source = heading + "\n她沿湖步行。";
  const result = await prepare(source, heading, "2028-06-03", "2028-06-05", "chapter", true);
  expect(result.chapters[0].source).toBe(source);
  expect(result.chapters[0].events).toHaveLength(1);
  expect(result.chapters[0].events[0].localDate).toBeNull();
  expect(result.chapters[0].suggestions[0].questions).toContain("原文日期区间 2028-06-03 至 2028-06-05；未推断逐日分配。");
});
it("cannot discard a wrapped dated prose heading as if it were only a date", async () => {
  const source = "### （2028年6月3日） 她出发。\n她沿湖步行。";
  await expect(prepare(source, "2028年6月3日", "2028-06-03", null, "chapter", true)).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
});
it.each(["3日至5日", "（3日）到（5日）"])("adds an explicit range question to unresolved day-only input: %s", async source => {
  const result = await prepare(source, null, null, null, "chapter");
  expect(result.chapters[0].source).toBe(source);
  expect(result.chapters[0].events[0].localDate).toBeNull();
  expect(result.chapters[0].suggestions[0].questions.join()).toContain("日期范围待确认");
});

// Independent review regressions: unknown date fields must stay in the source
// span, while a measured number must not become the second calendar endpoint.
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
it.each(uncertainRangeSources)("keeps every incomplete endpoint in its evidence span: %s", source => {
  expect(hasJournalDateRange(source)).toBe(true);
  expect(groundedJournalDates("2028年6月5日", source, "2028")).toBeNull();
  expect(groundedJournalDates(source, source, "2028")).toBeNull();
  expect(isJournalDateHeading(source, "2028")).toBe(false);
});
const measuredDestinations = [
  "（3.5公里外的酒店）", "（3.5千米外的酒店）", "（3.5 km外的酒店）", "（3.5）公里外的酒店",
  "（3.5元的报价）", "（3.5万元的报价）", "（3.5 USD的报价）", "（3.5）美元的报价",
  "（3.5公斤的行李处）", "（3.5 kg的行李处）", "（3.5小时车程的酒店）", "（3.5℃的冰室）",
  "（3.5%的坡道）", "（3.5 m高的平台）", "（3/5升的水壶旁）", "（3）公里外的酒店",
  "（３．５公里外的酒店）", "（３．５）元的报价",
];
it.each(measuredDestinations)("keeps a real single date next to a quantity: %s", destination => {
  const source = `她于2028年6月3日到${destination}入住。`;
  expect(hasJournalDateRange(source)).toBe(false);
  expect(groundedJournalDates("2028年6月3日", source, "2028")).toEqual(["2028-06-03"]);
  expect(isJournalDateHeading(source, "2028")).toBe(false);
});
it.each(["3.5公里", "（3.5）公里", "3.5元", "3.5 kg", "3.5℃", "3.5%", "3/5升", "３．５公里"])("does not ground a quantity itself as a calendar date: %s", source => {
  const quote = source.includes("３") ? "３．５" : source.includes("3/5") ? "3/5" : "3.5";
  expect(groundedJournalDates(quote, source, "2028")).toBeNull();
});
it.each([
  ["2028.06.03", "2028.06.05"], ["2028.06.03", "6.5"],
  ["２０２８．０６．０３", "２０２８．０６．０５"], ["２０２８年６月３日", "６．５"],
])("preserves genuine dotted date endpoints %s to %s", (left, right) => {
  const quote = `（${left}）到（${right}）`, source = `${quote}返程。`;
  expect(hasJournalDateRange(source)).toBe(true);
  expect(groundedJournalDates(quote, source, "2028")).toEqual(["2028-06-03", "2028-06-05"]);
  expect(groundedJournalDates(left, source, "2028")).toBeNull();
  expect(groundedJournalDates(right, source, "2028")).toBeNull();
  expect(isJournalDateHeading(quote, "2028")).toBe(true);
});
for (const mode of ["chapter", "event"] as const) {
  it.each(uncertainRangeSources)(`rejects incomplete ${mode} range cropping at the model boundary: %s`, async source => {
    await expect(prepare(source, "2028年6月5日", "2028-06-05", null, mode)).rejects.toMatchObject({ code: "JOURNAL_IMPORT_MALFORMED" });
  });
  it.each(measuredDestinations)(`preserves the ${mode} single date beside a measured destination: %s`, async destination => {
    const source = `她于2028年6月3日到${destination}入住。`;
    const result = await prepare(source, "2028年6月3日", "2028-06-03", null, mode);
    expect(result.chapters[0].source).toBe(source);
    expect(result.chapters[0].date).toBe(mode === "chapter" ? "2028-06-03" : "2028-06-01");
    expect(result.chapters[0].events[0].localDate).toBe(mode === "event" ? "2028-06-03" : null);
    expect(result.chapters[0].suggestions[0].questions.join()).not.toMatch(/日期范围|日期区间/);
  });
  it.each(["记录：（2028年6月？日）到（2028年6月5日），她旅行。", "记录：（2028年6月5日）到（2028年？月5日），她旅行。"])(`keeps incomplete ${mode} evidence explicitly unresolved: %s`, async source => {
    const result = await prepare(source, null, null, null, mode);
    expect(result.chapters[0].source).toBe(source);
    expect(result.chapters[0].events[0].localDate).toBeNull();
    expect(result.chapters[0].suggestions[0].questions.join()).toContain("日期范围");
  });
}
