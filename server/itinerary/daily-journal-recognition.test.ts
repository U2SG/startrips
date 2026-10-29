import { describe, expect, it, vi } from "vitest";
import { suggestJournalReading } from "./create-itinerary-recognition";
import { previewJournalImport } from "../../src/journey/dailyJournal";
const chapters = previewJournalImport("2027-05-01\n她在两处不同地点描述了同一事件", "2027-05-01");
const options = { baseUrl: "https://model.example.test", apiKey: null, model: "test", timeoutMs: 1000 };
describe("daily journal model proposals", () => {
  it("uses the existing provider envelope, excludes member edits and rejects invented references", async () => {
    chapters[0].events[0].text = "private manual reading";
    const fetcher = vi.fn(async () => Response.json({ contractVersion: 1, suggestions: [{ eventId: "invented", text: "x", questions: [], background: "" }] }));
    await expect(suggestJournalReading(chapters, { ...options, fetcher })).rejects.toThrow("未知事件");
    const body = JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(body.document.kind).toBe("daily-journal");
    expect(JSON.stringify(body.document)).not.toContain("private manual reading");
    expect(body.instructions).toContain("Do not infer UTC");
  });
  it("keeps questions and unverified background separate and refuses malformed/failed responses", async () => {
    const suggestions = [{ eventId: chapters[0].events[1].id, text: "她记录了事件，位置待确认。", questions: ["两处地点哪个准确？"], background: "待核实的背景" }];
    await expect(suggestJournalReading(chapters, { ...options, fetcher: async () => Response.json({ contractVersion: 1, suggestions }) })).resolves.toEqual(suggestions);
    await expect(suggestJournalReading(chapters, { ...options, fetcher: async () => Response.json({ contractVersion: 1, suggestions: [...suggestions, ...suggestions] }) })).rejects.toThrow("格式无效");
    await expect(suggestJournalReading(chapters, { ...options, fetcher: async () => new Response("down", { status: 503 }) })).rejects.toThrow("仍可手动编辑");
  });
});
