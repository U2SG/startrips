import { describe, expect, it, vi } from "vitest";
import { createJournalImportSession, type JournalImportState } from "./journalImportSession";
import { JournalImportConnectionError, JournalImportRejectedError, type JournalImportClient, type JournalImportInput, type JournalImportOutcome, type JournalImportProgress } from "./journalImportApi";
const input: JournalImportInput = { journeyId: "journey-a", atlasId: "atlas-a", sentence: "导入流水账", source: "2027-04-03 合成旅程", fallbackDate: "2027-04-03" };
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const done: JournalImportOutcome = { status: "completed", draft: { revision: 4, chapters: [] } };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture(overrides: Partial<JournalImportClient> = {}) {
  const client: JournalImportClient = {
    prepare: vi.fn(async (data, requestId) => ({ ...data, requestId, provider: { baseUrl: "provider:fixture", model: "fixture" } })),
    submit: vi.fn(async () => id), observe: vi.fn(async () => done), cancel: vi.fn(async () => ({ status: "cancelled" as const })), ...overrides,
  };
  const states: JournalImportState[] = [], onPreview = vi.fn();
  const session = createJournalImportSession(client, input, { onState: state => states.push(state), onPreview }, id);
  return { client, session, states, onPreview };
}

describe("journal import lifecycle", () => {
  it("deduplicates clicks and publishes a complete draft exactly once", async () => {
    const result = deferred<JournalImportOutcome>();
    const f = fixture({ observe: vi.fn(() => result.promise) });
    const first = f.session.start();
    expect(f.session.start()).toBe(first);
    await tick();
    expect(f.client.submit).toHaveBeenCalledOnce();
    expect(f.onPreview).not.toHaveBeenCalled();
    result.resolve(done); await first;
    expect(f.onPreview).toHaveBeenCalledExactlyOnceWith({ revision: 4, chapters: [] });
    expect(f.states.at(-1)?.status).toBe("completed");
  });

  it("keeps the accepted job after lost observation and resumes without submitting", async () => {
    const observe = vi.fn<JournalImportClient["observe"]>().mockRejectedValueOnce(new JournalImportConnectionError("断开"))
      .mockResolvedValueOnce(done);
    const f = fixture({ observe });
    await f.session.start();
    expect(f.states.at(-1)?.status).toBe("paused");
    expect(f.onPreview).not.toHaveBeenCalled();
    await f.session.resume();
    expect(f.client.submit).toHaveBeenCalledOnce();
    expect(observe.mock.calls.map(call => call[0])).toEqual([id, id]);
    expect(f.onPreview).toHaveBeenCalledOnce();
  });

  it("retries an uncertain submission with the identical ID, input and provider", async () => {
    const submit = vi.fn<JournalImportClient["submit"]>().mockRejectedValueOnce(new JournalImportConnectionError("失联"))
      .mockResolvedValueOnce(id);
    const f = fixture({ submit });
    await f.session.start(); await f.session.resume();
    expect(f.client.prepare).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
    expect(submit.mock.calls[1][0].requestId).toBe(id);
  });

  it("allows recovery from a definitive rejected submission without claiming an active job", async () => {
    const f = fixture({ submit: vi.fn(async () => { throw new JournalImportRejectedError("已有导入任务"); }) });
    await f.session.start();
    expect(f.states.at(-1)?.status).toBe("failed");
    expect(await f.session.stop()).toBe(true);
    expect(f.client.cancel).not.toHaveBeenCalled();
  });

  it("cancels a job accepted after stop was pressed during submission", async () => {
    const accepted = deferred<string>();
    const f = fixture({ submit: vi.fn(() => accepted.promise) });
    const running = f.session.start(); await tick();
    const stopped = f.session.stop();
    expect(f.states.at(-1)?.status).toBe("stopping");
    accepted.resolve(id); await running;
    expect(await stopped).toBe(true);
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith(id, input, expect.any(AbortSignal));
    expect(f.client.observe).not.toHaveBeenCalled();
    expect(f.onPreview).not.toHaveBeenCalled();
  });

  it("ignores progress and a late completed response after explicit cancel", async () => {
    const response = deferred<JournalImportOutcome>();
    let progress!: (value: JournalImportProgress) => void;
    const f = fixture({ observe: vi.fn((_id, _input, _signal, callback) => { progress = callback; return response.promise; }) });
    const running = f.session.start(); await tick();
    expect(await f.session.stop()).toBe(true);
    const count = f.states.length;
    progress({ phase: "receiving", characters: 100, chunks: 3 }); response.resolve(done); await running;
    expect(f.states).toHaveLength(count);
    expect(f.onPreview).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.status).toBe("cancelled");
  });

  it("keeps cancellation failures recoverable without adopting an already completed plan", async () => {
    const response = deferred<JournalImportOutcome>();
    const cancel = vi.fn<JournalImportClient["cancel"]>().mockRejectedValueOnce(new JournalImportConnectionError()).mockResolvedValueOnce(done);
    const f = fixture({ observe: vi.fn(() => response.promise), cancel });
    const running = f.session.start(); await tick();
    expect(await f.session.stop()).toBe(false);
    expect(f.states.at(-1)).toMatchObject({ status: "paused", stopping: true });
    await f.session.resume();
    expect(f.states.at(-1)?.status).toBe("cancelled");
    expect(f.client.submit).toHaveBeenCalledOnce();
    expect(f.onPreview).not.toHaveBeenCalled();
    response.resolve(done); await running;
  });

  it("only detaches on journey/account switch; never sends a late cancel under the new account", async () => {
    const accepted = deferred<string>();
    const f = fixture({ submit: vi.fn(() => accepted.promise) });
    const running = f.session.start(); await tick();
    const stop = f.session.stop();
    f.session.dispose(); const count = f.states.length;
    accepted.resolve(id); await running;
    expect(await stop).toBe(false);
    expect(f.client.cancel).not.toHaveBeenCalled();
    expect(f.client.observe).not.toHaveBeenCalled();
    expect(f.onPreview).not.toHaveBeenCalled();
    expect(f.states).toHaveLength(count);
  });

  it("does not submit when stopped while checking provider availability", async () => {
    const configured = deferred<Awaited<ReturnType<JournalImportClient["prepare"]>>>();
    const f = fixture({ prepare: vi.fn(() => configured.promise) });
    const running = f.session.start();
    expect(await f.session.stop()).toBe(true);
    configured.resolve({ ...input, requestId: id, provider: { baseUrl: "provider:fixture", model: "fixture" } });
    await running;
    expect(f.client.submit).not.toHaveBeenCalled();
    expect(f.client.cancel).not.toHaveBeenCalled();
  });
});
