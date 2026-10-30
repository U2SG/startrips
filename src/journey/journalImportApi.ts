import { isPersistedCalendarDate } from "./calendarDate";
import { parseJournalChapters, type DailyJournal } from "./dailyJournal";

const ROOT = "/api/intents/journal-import";
const MAX_FRAME = 2_000_000;
export const JOURNAL_IMPORT_MAX_TEXT = 100_000;
export type JournalImportInput = { journeyId: string; atlasId: string; sentence: string; source: string; fallbackDate: string };
export type JournalImportSubmission = JournalImportInput & { requestId: string; provider: { baseUrl: string; model: string } };
export type JournalImportProgress = { phase: "queued" | "connecting" | "receiving" | "validating"; characters: number; chunks: number };
export type JournalImportOutcome =
  | { status: "completed"; draft: DailyJournal }
  | { status: "cancelled" }
  | { status: "failed"; message: string };
export type JournalImportClient = {
  prepare: (input: JournalImportInput, requestId: string, signal: AbortSignal) => Promise<JournalImportSubmission>;
  submit: (input: JournalImportSubmission, signal: AbortSignal) => Promise<string>;
  observe: (jobId: string, input: JournalImportInput, signal: AbortSignal, onProgress: (progress: JournalImportProgress) => void) => Promise<JournalImportOutcome>;
  cancel: (jobId: string, input: JournalImportInput, signal: AbortSignal) => Promise<JournalImportOutcome>;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export class JournalImportConnectionError extends Error {}
export class JournalImportRejectedError extends Error {}
class JournalImportProtocolError extends Error {
  constructor() { super("未收到完整有效的导入结果；原文已保留。"); }
}
function statusError(status: number) {
  return new JournalImportRejectedError(status === 401 || status === 403 ? "当前账户不能导入，请重新登录后重试。"
    : status === 404 ? "导入任务已不可用，请重新打开手记。"
    : status === 409 ? "已有导入任务或手记已更新，请先完成当前任务。"
    : "无法开始导入；原文已保留，请稍后重试。");
}
function failedMessage(code: unknown) {
  return code === "JOURNAL_CHANGED" ? "手记已更新，请保留原文，重新打开后导入。"
    : code === "JOURNAL_JOB_INTERRUPTED" ? "导入已中断；原文已保留，可重新生成。"
    : code === "INTENT_TIMEOUT" ? "模型长时间没有返回有效内容；原文已保留，可重试。"
    : "未能完成导入；原文已保留，可重试。";
}

/** A completed, bounded server plan is the only thing that can become a draft. */
export function readJournalImportSnapshot(value: unknown, jobId: string, input: JournalImportInput): JournalImportOutcome | JournalImportProgress {
  if (!object(value) || value.jobId !== jobId) throw new JournalImportProtocolError();
  if (value.status === "completed") {
    const envelope = value.envelope;
    if (!object(envelope) || typeof envelope.signature !== "string" || !/^[a-f0-9]{64}$/.test(envelope.signature)
      || typeof value.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.planDigest)) throw new JournalImportProtocolError();
    const plan = envelope.plan;
    if (!object(plan) || plan.version !== 2 || !object(plan.target) || plan.target.journeyId !== input.journeyId
      || plan.target.atlasId !== input.atlasId || !object(plan.before) || !object(plan.after)
      || !counter(plan.before.revision) || !counter(plan.after.revision)
      || (plan.after.revision !== plan.before.revision && plan.after.revision !== plan.before.revision + 1)
      || typeof plan.expires !== "number" || plan.expires <= Date.now()) throw new JournalImportProtocolError();
    const chapters = parseJournalChapters(plan.after.chapters);
    if (!chapters || !parseJournalChapters(plan.before.chapters) || !Array.isArray(plan.importedChapterIds)
      || plan.importedChapterIds.some(id => typeof id !== "string" || !chapters.some(c => c.id === id))) throw new JournalImportProtocolError();
    return { status: "completed", draft: { revision: plan.before.revision, chapters } };
  }
  if (value.status === "cancelled") return { status: "cancelled" };
  if (value.status === "failed" || value.status === "interrupted") return { status: "failed", message: failedMessage(value.error) };
  if ((value.status !== "queued" && value.status !== "running")
    || !["queued", "connecting", "receiving", "validating"].includes(value.phase as string)
    || !counter(value.characters) || !counter(value.chunks)) throw new JournalImportProtocolError();
  return { phase: value.phase as JournalImportProgress["phase"], characters: value.characters, chunks: value.chunks };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function boundedSignal(parent: AbortSignal, ms: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, ms);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener("abort", abort); controller.abort(); } };
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

export function createJournalImportClient(fetcher: typeof fetch = fetch): JournalImportClient {
  async function json(path: string, signal: AbortSignal, body?: unknown, method = "GET") {
    const boundary = boundedSignal(signal, 30_000);
    try {
      const response = await abortable(fetcher(ROOT + path, { method, signal: boundary.signal, credentials: "include", cache: "no-store",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), boundary.signal);
      if (!response.ok) {
        if (response.status >= 500) throw new JournalImportConnectionError("连接中断；可继续接收当前导入。");
        throw statusError(response.status);
      }
      return await abortable(response.json(), boundary.signal) as unknown;
    } catch (error) {
      if (!signal.aborted && (boundary.signal.aborted || error instanceof TypeError)) throw new JournalImportConnectionError("连接中断；可继续接收当前导入。");
      throw error;
    } finally { boundary.dispose(); }
  }
  const snapshot = async (jobId: string, input: JournalImportInput, signal: AbortSignal) =>
    readJournalImportSnapshot(await json(`/jobs/${encodeURIComponent(jobId)}`, signal), jobId, input);

  async function connection(jobId: string, input: JournalImportInput, signal: AbortSignal, onProgress: (progress: JournalImportProgress) => void) {
    // The server closes each observation at 60s. This bounds a stuck observation,
    // never the durable job or its overall generation time.
    const boundary = boundedSignal(signal, 75_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await abortable(fetcher(`${ROOT}/jobs/${encodeURIComponent(jobId)}/events`, {
        signal: boundary.signal, credentials: "include", cache: "no-store", headers: { accept: "text/event-stream" },
      }), boundary.signal);
      if (!response.ok) {
        if (response.status >= 500) throw new JournalImportConnectionError();
        throw statusError(response.status);
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new JournalImportProtocolError();
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      while (true) {
        const { value, done } = await abortable(reader.read(), boundary.signal);
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > MAX_FRAME) throw new JournalImportProtocolError();
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index); buffer = buffer.slice(separator.index + separator[0].length);
          let event = "message"; const data: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (!data.length) continue;
          if (!["progress", "completed", "failed", "cancelled"].includes(event)) throw new JournalImportProtocolError();
          let payload: unknown;
          try { payload = JSON.parse(data.join("\n")); } catch { throw new JournalImportProtocolError(); }
          const result = readJournalImportSnapshot(payload, jobId, input);
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          if ("status" in result) {
            if (event !== result.status) throw new JournalImportProtocolError();
            return result;
          }
          if (event !== "progress") throw new JournalImportProtocolError();
          onProgress(result);
        }
        // An incomplete last frame is discarded; only a full terminal event or
        // authenticated snapshot can complete the preview after reconnecting.
        if (done) return null;
      }
    } catch (error) {
      if (!signal.aborted && (boundary.signal.aborted || error instanceof TypeError)) throw new JournalImportConnectionError();
      throw error;
    } finally { boundary.dispose(); if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
  }

  return {
    async prepare(input, requestId, signal) {
      if (!input.source.trim() || input.source.length > JOURNAL_IMPORT_MAX_TEXT || !input.sentence.trim()
        || input.sentence.length > 500 || !isPersistedCalendarDate(input.fallbackDate)) throw new Error("请输入有效日期、操作要求及不超过 10 万字的原文。");
      const provider = await json("/provider", signal);
      if (!object(provider) || provider.available !== true || typeof provider.baseUrl !== "string" || typeof provider.model !== "string") throw new Error("AI 导入暂不可用，可按日期生成预览。");
      return { ...input, requestId, provider: { baseUrl: provider.baseUrl, model: provider.model } };
    },
    async submit(input, signal) {
      const { atlasId: _atlasId, ...body } = input;
      const result = await json("/jobs", signal, body, "POST");
      if (!object(result) || typeof result.jobId !== "string" || !/^[a-f0-9-]{36}$/i.test(result.jobId)) throw new JournalImportProtocolError();
      return result.jobId;
    },
    async observe(jobId, input, signal, onProgress) {
      let interrupted = 0;
      while (!signal.aborted) {
        const started = Date.now();
        try {
          const result = await connection(jobId, input, signal, onProgress);
          if (result) return result;
        } catch (error) {
          if (signal.aborted || !(error instanceof JournalImportConnectionError)) throw error;
        }
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          const current = await snapshot(jobId, input, signal);
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          if ("status" in current) return current;
          onProgress(current);
        } catch (error) {
          if (signal.aborted || !(error instanceof JournalImportConnectionError)) throw error;
        }
        interrupted = Date.now() - started >= 10_000 ? 0 : interrupted + 1;
        if (interrupted >= 3) throw new JournalImportConnectionError("连接中断；可继续接收当前导入。");
        await pause(500 * 2 ** interrupted, signal);
      }
      throw new DOMException("Aborted", "AbortError");
    },
    async cancel(jobId, input, signal) {
      const current = readJournalImportSnapshot(await json(`/jobs/${encodeURIComponent(jobId)}/cancel`, signal, undefined, "POST"), jobId, input);
      if (!("status" in current)) throw new JournalImportConnectionError("未能确认停止，请重试停止。");
      return current;
    },
  };
}
export const journalImportClient = createJournalImportClient();
