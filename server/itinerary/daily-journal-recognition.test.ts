import { describe, expect, it, vi } from "vitest";
import { suggestJournalReading } from "./daily-journal-recognition";
import { previewJournalImport } from "../../src/journey/dailyJournal";
const chapters = previewJournalImport("2027-05-01\n实际：她记录了同一事件，地点不清楚", "2027-05-01");
const options = { baseUrl: "https://model.example.test/v1", apiKey: "mock-only-key", model: "test", timeoutMs: 1000 };
const completion = (suggestions: unknown[]) => Response.json({ choices: [{ message: { content: JSON.stringify({ suggestions }) } }] });
describe("daily journal standard model adapter", () => {
  it("uses standard chat/completions, excludes edited prose and rejects invented references", async () => {
    chapters[0].events[0].text = "private manual reading";
    const fetcher = vi.fn(async () => completion([{ eventId: "invented", text: "x", questions: [], background: "" }]));
    await expect(suggestJournalReading(chapters, { ...options, fetcher })).rejects.toThrow("格式无效");
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://model.example.test/v1/chat/completions");
    expect(body.response_format.json_schema).toMatchObject({ name:"daily_journal_reading", strict:true });
    expect(body.messages[1].content).not.toContain("private manual reading");
    expect(body.messages[0].content).toContain("leave the subject implicit");
    expect(body).not.toHaveProperty("document");
  });
  it("rewrites all events across bounded requests and preserves their order", async () => {
    const source = ["2027-05-01", ...Array.from({length: 55}, (_, index) => `清晨到了码头，看到第 ${index + 1} 艘船。`)].join("\n");
    const input = previewJournalImport(source, "2027-05-01");
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const { chapters } = JSON.parse(body.messages[1].content) as {chapters: {events: {eventId: string; source: string}[]}[]};
      const events = chapters.flatMap(chapter => chapter.events);
      expect(events.length).toBeLessThanOrEqual(24);
      return completion(events.reverse().map(({eventId, source: text}) => ({eventId, text, questions: [], background: ""})));
    });
    const suggestions = await suggestJournalReading(input, { ...options, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(suggestions.map(({eventId}) => eventId)).toEqual(input[0].events.map(event => event.id));
  });
  it("keeps questions/background separate and rejects duplicates, omissions, refusals and failed responses", async () => {
    const suggestions = [{ eventId: chapters[0].events[0].id, text: "她记录了事件，位置待确认。", questions: ["哪处地点准确？"], background: "待核实背景" }];
    await expect(suggestJournalReading(chapters, { ...options, fetcher: async () => completion(suggestions) })).resolves.toEqual(suggestions);
    for (const bad of [[], [...suggestions, ...suggestions]]) await expect(suggestJournalReading(chapters, { ...options, fetcher: async () => completion(bad) })).rejects.toThrow("格式无效");
    await expect(suggestJournalReading(chapters, { ...options, fetcher: async () => Response.json({ choices:[{message:{refusal:"no"}}] }) })).rejects.toThrow("格式无效");
    await expect(suggestJournalReading(chapters, { ...options, fetcher: async () => new Response("down", { status: 503 }) })).rejects.toMatchObject({ status:502 });
  });
});
