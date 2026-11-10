/** Synthetic model outputs only. These fixtures do not measure LLM quality. */
import { randomUUID } from "node:crypto";
import type { JournalDateStatus } from "./journal-import-date-evidence";
export const mockJournalModel = { baseUrl: "https://model.example.test/v1", apiKey: "mock-only", model: "mock", timeoutMs: 1000 };
export const toolResponse = (name: string, payload: unknown) => Response.json({ choices: [{ finish_reason: "tool_calls", message: {
  tool_calls: [{ id: `mock-${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(payload) } }],
} }] });
/** The lines one staging call received (absolute line numbers). */
export const suppliedLines = (init?: RequestInit) => JSON.parse(JSON.parse(String(init?.body)).messages[1].content).lines as { line: number; text: string }[];
export const mockEvent = (_source: string, line = 0) => ({ line, status: "actual", dateStatus: "absent" as JournalDateStatus,
  localDate: null as string | null, dateEvidence: null as string | null, time: null as string | null, timeEnd: null as string | null,
  timeEvidence: null as string | null, placeName: null as string | null, questions: [] as string[] });
/** One chapter covering all lines of `source`, numbered from `offset`. */
export const mockChapter = (source: string, offset = 0) => ({ firstLine: offset, lastLine: offset + source.split("\n").length - 1,
  heading: false, dateStatus: "absent" as JournalDateStatus, date: null as string | null,
  dateEnd: null as string | null, dateEvidence: null as string | null, questions: [] as string[],
  events: source.split("\n").flatMap((s, line) => s.trim() ? [mockEvent(s, offset + line)] : []),
});
