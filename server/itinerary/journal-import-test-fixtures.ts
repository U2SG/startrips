/** Synthetic model outputs only. These fixtures do not measure LLM quality. */
import { randomUUID } from "node:crypto";
import type { JournalDateStatus } from "./journal-import-date-evidence";
export const mockJournalModel = { baseUrl: "https://model.example.test/v1", apiKey: "mock-only", model: "mock", timeoutMs: 1000 };
export const toolResponse = (name: string, payload: unknown) => Response.json({ choices: [{ finish_reason: "tool_calls", message: {
  tool_calls: [{ id: `mock-${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(payload) } }],
} }] });
export const mockEvent = (source: string, line = 0) => ({ line, evidence: source, status: "actual", dateStatus: "absent" as JournalDateStatus,
  localDate: null as string | null, dateEvidence: null as string | null, time: null as string | null, timeEnd: null as string | null,
  timeEvidence: null as string | null, reading: source, questions: [] as string[] });
export const mockChapter = (source: string) => ({ firstLine: 0, lastLine: source.split("\n").length - 1,
  headingEvidence: null as string | null, dateStatus: "absent" as JournalDateStatus, date: null as string | null,
  dateEnd: null as string | null, dateEvidence: null as string | null, questions: [] as string[],
  events: source.split("\n").flatMap((s, line) => s.trim() ? [mockEvent(s, line)] : []),
});
