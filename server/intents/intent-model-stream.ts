import type { ShareIntentError } from "./create-share-intent";
export type ModelStreamProgress = { phase: "connecting" | "receiving"; characters: number; chunks: number };
export type ModelStreamOptions = { signal?: AbortSignal; connectTimeoutMs?: number; firstByteTimeoutMs?: number; idleTimeoutMs?: number; onProgress?: (progress: ModelStreamProgress) => void };
type Fail = (code: string, message: string, status?: number) => ShareIntentError;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_EVENT_BYTES = 128_000;
/** Parse actual provider SSE deltas. Partial JSON is never returned as a draft. */
export async function requestModelStream(url: string, apiKey: string, body: object, toolName: string | undefined, options: ModelStreamOptions, fetcher: typeof fetch, fail: Fail): Promise<unknown> {
  const controller = new AbortController();
  let timedOut: "connect" | "first-byte" | "idle" | null = null, timer: ReturnType<typeof setTimeout>;
  const arm = (phase: NonNullable<typeof timedOut>, ms: number) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = phase; controller.abort(); }, ms); };
  const cancel = () => controller.abort(); options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  // Race blocking I/O too: a provider adapter must not be able to ignore AbortSignal.
  const abortable = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve,reject)=>{
    const aborted=()=>{cleanup();reject(new Error("STREAM_ABORTED"));};
    const cleanup=()=>controller.signal.removeEventListener("abort",aborted);
    if(controller.signal.aborted){reject(new Error("STREAM_ABORTED"));return;}
    controller.signal.addEventListener("abort",aborted,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let toolId: string | undefined;
  let content = "", tool = "", calls = 0, chunks = 0, outputBytes = 0, done = false, finished = false;
  const invalid = () => fail("INTENT_STREAM_INVALID", "The model stream was incomplete or invalid", 502);
  options.onProgress?.({ phase: "connecting", characters: 0, chunks: 0 });
  arm("connect", options.connectTimeoutMs ?? 30_000);
  try {
    let response: Response;
    try { response = await abortable(fetcher(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ ...body, stream: true }), signal: controller.signal })); }
    catch (e) { if (controller.signal.aborted) throw e; throw fail("INTENT_UNREACHABLE", "The model provider could not be reached", 502); }
    if (!response.ok) throw fail("INTENT_FAILED", "The model provider rejected the request", 502);
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) throw invalid();
    reader = response.body.getReader();
    arm("first-byte", options.firstByteTimeoutMs ?? 30_000);
    const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", first = true;
    function event(block: string) {
      const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) return; // Comments/heartbeats do not extend the semantic idle budget.
      if (data === "[DONE]") { if (!finished) throw invalid(); done = true; return; }
      if (done) throw invalid();
      let value: any; try { value = JSON.parse(data); } catch { throw invalid(); }
      if (value?.error) throw fail("INTENT_FAILED", "The model stream returned an error", 502);
      if (!Array.isArray(value?.choices)) throw invalid();
      if (value.choices.length === 0) return; // Optional usage frame.
      if (value.choices.length !== 1 || (value.choices[0].index !== undefined && value.choices[0].index !== 0)) throw invalid();
      const choice = value.choices[0], delta = choice.delta;
      if (!delta || typeof delta !== "object") throw invalid();
      let piece = "";
      if (toolName) {
        if (delta.content) throw invalid();
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 1) throw invalid();
          const call = delta.tool_calls[0];
          if (call.index !== 0 || call.type && call.type !== "function" || !call.function || typeof call.function !== "object") throw invalid();
          if(call.id !== undefined) { if(typeof call.id!=="string" || !call.id || call.id.length>256 || toolId && call.id!==toolId) throw invalid(); toolId=call.id; }
          if (call.function.name !== undefined) { if (typeof call.function.name !== "string") throw invalid(); tool += call.function.name; if(!toolName.startsWith(tool))throw invalid(); }
          if (call.function.arguments !== undefined) { if (typeof call.function.arguments !== "string") throw invalid(); piece = call.function.arguments; }
          calls = 1;
        }
      } else if (delta.content !== undefined && delta.content !== null) { if (typeof delta.content !== "string") throw invalid(); piece = delta.content; }
      if (finished && piece) throw invalid();
      if (piece) {
        outputBytes += Buffer.byteLength(piece); if (outputBytes > MAX_OUTPUT_BYTES) throw fail("INTENT_STREAM_LIMIT", "The model output exceeded the supported size", 502);
        content += piece; chunks++; options.onProgress?.({ phase: "receiving", characters: content.length, chunks });
        if (piece.trim()) arm("idle", options.idleTimeoutMs ?? 30_000);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (choice.finish_reason !== (toolName ? "tool_calls" : "stop") || finished) throw invalid();
        finished = true;
      }
    }
    while (!done) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try { read = await abortable(reader.read()); } catch (e) { if (controller.signal.aborted) throw e; throw fail("INTENT_UNREACHABLE", "The model stream disconnected", 502); }
      if (read.done) break;
      if (first) { first = false; arm("idle", options.idleTimeoutMs ?? 30_000); }
      try { buffer += decoder.decode(read.value, { stream: true }); } catch { throw invalid(); }
      let split: RegExpExecArray | null;
      while ((split = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, split.index); buffer = buffer.slice(split.index + split[0].length);
        if (Buffer.byteLength(block) > MAX_EVENT_BYTES) throw invalid(); event(block);
      }
      if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw invalid();
    }
    if (!done || !finished || (toolName && (calls !== 1 || tool !== toolName))) throw invalid();
    try { return JSON.parse(content); } catch { throw invalid(); }
  } catch (e) {
    if (controller.signal.aborted) {
      if (options.signal?.aborted) throw fail("INTENT_CANCELLED", "The model request was cancelled", 499);
      throw fail(timedOut === "connect" ? "INTENT_CONNECT_TIMEOUT" : timedOut === "first-byte" ? "INTENT_FIRST_BYTE_TIMEOUT" : "INTENT_IDLE_TIMEOUT", "The model stream stopped making progress", 504);
    }
    throw e;
  } finally {
    clearTimeout(timer!); options.signal?.removeEventListener("abort", cancel); controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
