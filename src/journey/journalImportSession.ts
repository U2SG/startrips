import { JournalImportConnectionError, JournalImportRejectedError, type JournalImportClient, type JournalImportInput, type JournalImportProgress, type JournalImportSubmission } from "./journalImportApi";
import type { DailyJournal } from "./dailyJournal";

export type JournalImportState = {
  status: "submitting" | "observing" | "stopping" | "paused" | "completed" | "cancelled" | "failed";
  progress?: JournalImportProgress;
  message?: string;
  stopping?: boolean;
};
export type JournalImportSession = ReturnType<typeof createJournalImportSession>;

/** Owns one immutable submission; reconnects/retries can never create a second ID. */
export function createJournalImportSession(client: JournalImportClient, input: JournalImportInput, callbacks: {
  onState: (state: JournalImportState) => void;
  onPreview: (draft: DailyJournal) => void;
}, requestId = crypto.randomUUID()) {
  let alive = true, generation = 0, stopRequested = false, postStarted = false;
  let prepared: JournalImportSubmission | undefined, jobId: string | undefined;
  let controller: AbortController | undefined, task: Promise<void> | undefined;
  let state: JournalImportState = { status: "submitting" };
  const publish = (next: JournalImportState) => { state = next; if (alive) callbacks.onState(next); };
  const terminal = () => ["completed", "cancelled", "failed"].includes(state.status);
  const cancelled = () => alive && state.status === "cancelled";

  function execute(): Promise<void> {
    const version = ++generation;
    const current = () => alive && version === generation;
    const active = new AbortController(); controller = active;
    publish({ status: stopRequested ? "stopping" : jobId ? "observing" : "submitting" });
    const running = (async () => {
      try {
        if (!prepared) prepared = await client.prepare(input, requestId, active.signal);
        if (!current()) return;
        if (!jobId) {
          postStarted = true;
          jobId = await client.submit(prepared, active.signal);
        }
        if (!current()) return;
        if (stopRequested) {
          await client.cancel(jobId, input, active.signal);
          if (current()) publish({ status: "cancelled" });
          return;
        }
        publish({ status: "observing" });
        const outcome = await client.observe(jobId, input, active.signal, progress => {
          if (current() && !stopRequested) publish({ status: "observing", progress });
        });
        if (!current() || stopRequested) return;
        if (outcome.status === "completed") {
          // Publishing complete does not write. The host still requires confirmation.
          callbacks.onPreview(outcome.draft);
          publish({ status: "completed" });
        } else if (outcome.status === "failed") publish({ status: "failed", message: outcome.message });
        else publish({ status: "cancelled" });
      } catch (error) {
        if (!current()) return;
        if (!jobId && error instanceof JournalImportRejectedError) {
          postStarted = false;
          publish({ status: "failed", message: error.message });
          return;
        }
        // Once submitted, a failed observer/cancel does not establish job failure.
        // Keep the same ID and offer a deliberate resume, never automatic re-POST.
        if (jobId || postStarted || error instanceof JournalImportConnectionError) {
          publish({ status: "paused", stopping: stopRequested, message: stopRequested
            ? "未能确认停止，请重试停止。"
            : error instanceof Error ? error.message : "连接中断；可继续接收当前导入。" });
        } else publish({ status: "failed", message: error instanceof Error ? error.message : "无法开始导入；原文已保留。" });
      }
    })();
    task = running;
    void running.finally(() => { if (task === running) task = undefined; });
    return running;
  }
  return {
    start() { return !alive ? Promise.resolve() : task ?? (terminal() ? Promise.resolve() : execute()); },
    resume() { return !alive ? Promise.resolve() : task ?? (terminal() ? Promise.resolve() : execute()); },
    async stop() {
      if (!alive) return false;
      if (terminal()) return true;
      if (stopRequested && task && state.status === "stopping") {
        await task; return cancelled();
      }
      stopRequested = true;
      if (!postStarted && !jobId) {
        generation += 1; controller?.abort(); publish({ status: "cancelled" }); return true;
      }
      const submitting = !jobId && !!task;
      publish({ status: "stopping" });
      // Do not abort an in-flight POST and lose its job ID. Its response is
      // immediately cancelled, provided this account/panel is still active.
      if (submitting) await task;
      else { controller?.abort(); await execute(); }
      return cancelled();
    },
    dispose() {
      alive = false; generation += 1; controller?.abort();
      // Account/Journey changes detach observation only. Never send a delayed
      // cancel using whatever account the browser may have switched to.
    },
  };
}
