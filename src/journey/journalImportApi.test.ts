import { afterEach, describe, expect, it, vi } from "vitest";
import { previewJournalImport } from "./dailyJournal";
import { createJournalImportClient, JournalImportConnectionError, readJournalImportSnapshot, type JournalImportInput } from "./journalImportApi";

const jobId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const input: JournalImportInput = { journeyId: "journey-a", atlasId: "atlas-a", sentence: "导入并关联酒店", source: "2027-04-03\n计划入住合成酒店", fallbackDate: "2027-04-03" };
const chapters = () => previewJournalImport(input.source, input.fallbackDate, [], (() => { let id = 0; return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` as ReturnType<typeof crypto.randomUUID>; })());
function complete() {
  const after = chapters();
  return { jobId, status: "completed", planDigest: "a".repeat(64), envelope: { signature: "b".repeat(64), plan: {
    version: 2, target: { journeyId: input.journeyId, atlasId: input.atlasId }, before: { revision: 4, chapters: [] },
    after: { revision: 5, chapters: after }, importedChapterIds: [after[0].id], expires: Date.now() + 3_600_000,
  } } };
}
const progress = { jobId, status: "running", phase: "receiving", characters: 18, chunks: 3 };
const event = (type: string, payload: unknown) => `event: ${type}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
function sse(...parts: (string | Uint8Array)[]) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of parts) controller.enqueue(typeof part === "string" ? new TextEncoder().encode(part) : part);
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
afterEach(() => vi.useRealTimers());

describe("journal streaming transport", () => {
  it("echoes opaque provider identity, sends credentials and never sends atlas authority", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ available: true, baseUrl: "provider:opaque-consent", model: "fixture" })).mockResolvedValueOnce(json({ jobId }));
    const client = createJournalImportClient(fetcher), signal = new AbortController().signal;
    const prepared = await client.prepare(input, jobId, signal);
    expect(await client.submit(prepared, signal)).toBe(jobId);
    const [, options] = fetcher.mock.calls[1];
    expect(JSON.parse(options!.body as string)).toEqual({ requestId: jobId, journeyId: input.journeyId, sentence: input.sentence, source: input.source, fallbackDate: input.fallbackDate, provider: { baseUrl: "provider:opaque-consent", model: "fixture" } });
    expect(options!.credentials).toBe("include");
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/intents/journal-import/"))).toBe(true);
  });

  it("assembles split UTF-8 and CRLF frames; only completed creates a draft with before revision", async () => {
    const bytes = new TextEncoder().encode(event("progress", progress) + event("completed", complete()));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse(...Array.from(bytes, byte => new Uint8Array([byte]))));
    const received = vi.fn();
    const result = await createJournalImportClient(fetcher).observe(jobId, input, new AbortController().signal, received);
    expect(received).toHaveBeenCalledExactlyOnceWith({ phase: "receiving", characters: 18, chunks: 3 });
    expect(result).toEqual({ status: "completed", draft: { revision: 4, chapters: chapters() } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reconnects the same job after an observation window, including beyond 65 seconds", async () => {
    vi.useFakeTimers();
    let close!: () => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(event("progress", progress))); close = () => controller.close();
      } }), { headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(json(progress))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(sse(event("completed", complete()))), 10_000)));
    const result = createJournalImportClient(fetcher).observe(jobId, input, new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(60_000); close();
    await vi.advanceTimersByTimeAsync(11_000);
    expect((await result).status).toBe("completed");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `/api/intents/journal-import/jobs/${jobId}/events`, `/api/intents/journal-import/jobs/${jobId}`, `/api/intents/journal-import/jobs/${jobId}/events`,
    ]);
    expect(fetcher.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
  });

  it("uses a snapshot after a truncated terminal frame without accepting the partial frame", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(sse('event: completed\ndata: {"envelope":'))
      .mockResolvedValueOnce(json({ jobId, status: "interrupted", error: "JOURNAL_JOB_INTERRUPTED" }));
    const result = await createJournalImportClient(fetcher).observe(jobId, input, new AbortController().signal, vi.fn());
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("draft");
  });

  it("bounds rapid disconnections and leaves recovery on the same job", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith("/events") ? sse() : json(progress));
    const result = createJournalImportClient(fetcher).observe(jobId, input, new AbortController().signal, vi.fn());
    const rejected = expect(result).rejects.toBeInstanceOf(JournalImportConnectionError);
    await vi.advanceTimersByTimeAsync(5_000); await rejected;
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
  });

  it("explicitly cancels with a bodyless POST; aborting observation alone never cancels", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(json({ jobId, status: "cancelled" }));
    const client = createJournalImportClient(fetcher), controller = new AbortController();
    const observing = client.observe(jobId, input, controller.signal, vi.fn());
    controller.abort();
    await expect(observing).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client.cancel(jobId, input, new AbortController().signal)).toEqual({ status: "cancelled" });
    expect(fetcher.mock.calls[1]).toEqual([`/api/intents/journal-import/jobs/${jobId}/cancel`, expect.objectContaining({ method: "POST", credentials: "include" })]);
    expect(fetcher.mock.calls[1][1]).not.toHaveProperty("body");
  });

  it("refuses a foreign journey, malformed draft or unsupported done event", async () => {
    const foreign = complete(); foreign.envelope.plan.target.journeyId = "other";
    expect(() => readJournalImportSnapshot(foreign, jobId, input)).toThrow();
    const malformed = complete(); malformed.envelope.plan.after.chapters[0].events[0].localTime = "25:00";
    expect(() => readJournalImportSnapshot(malformed, jobId, input)).toThrow();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse(event("done", complete())));
    await expect(createJournalImportClient(fetcher).observe(jobId, input, new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not expose provider response bodies on failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-provider-url-and-key", { status: 403 }));
    await expect(createJournalImportClient(fetcher).prepare(input, jobId, new AbortController().signal)).rejects.toThrow("当前账户不能导入");
  });
});
