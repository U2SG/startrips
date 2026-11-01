import { afterEach, expect, it, vi } from "vitest";
import { requestIntentModelAnswer, type IntentModelOptions } from "./intent-model-request";
import { ShareIntentError } from "./create-share-intent";
import { runStagingTool, toolObject } from "./staging-tool";

// Synthetic provider contract fixture, never a recording of a private import.
const baseUrl = "https://synthetic.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const schema = toolObject({ chapters: { type: "array", items: toolObject({ title: { type: "string" } }) } });
const args = { chapters: [{ title: "Synthetic chapter" }] };
const frame = (argumentsPart: string, first = false, last = false) => `data: ${JSON.stringify({ choices: [{ index: 0,
  delta: { tool_calls: [{ index: 0, ...(first ? { id: "synthetic-call", type: "function" } : {}),
    function: { ...(first ? { name: "stage" } : {}), arguments: argumentsPart } }] }, finish_reason: last ? "stop" : null }] })}\n\n`;
const request = { systemPrompt: "Synthetic extraction", userContent: "Synthetic data", schemaName: "stage", schema,
  toolName: "stage", captureToolCall: true, providerName: "synthetic",
  fail: (c: string, m: string, s?: number) => new ShareIntentError(c, m, s) };
const options = { baseUrl, apiKey: "synthetic-key", model: "qwen3.8-max-0902", timeoutMs: 1 };
const encoder = new TextEncoder();
afterEach(() => vi.useRealTimers());

function complexProvider(forceBuffered = false) {
  const cancel = vi.fn();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    const incremental = body.tool_stream === true && !forceBuffered;
    const timers: ReturnType<typeof setTimeout>[] = [];
    return new Response(new ReadableStream({ start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      send(frame('{"chapters":[', true));
      if (incremental) timers.push(setTimeout(() => send(frame('{"title":"Synthetic chapter"}')), 20_000));
      else {
        timers.push(setTimeout(() => send(": keepalive\n\n"), 10_000));
        timers.push(setTimeout(() => send(`data: ${JSON.stringify({ choices: [{ index: 0,
          delta: { reasoning_content: "Synthetic unexpected reasoning" }, finish_reason: null }] })}\n\n`), 20_000));
      }
      timers.push(setTimeout(() => {
        send(frame(incremental ? ']}' : '{"title":"Synthetic chapter"}]}', false, true));
        send("data: [DONE]\n\n"); controller.close();
      }, 40_000));
    }, cancel() { timers.forEach(clearTimeout); cancel(); } }), { headers: { "content-type": "text/event-stream" } });
  });
  return { fetcher, cancel };
}

it("streams complex Max tool arguments across the unchanged 30-second idle bound", async () => {
  vi.useFakeTimers();
  const { fetcher } = complexProvider(); const progress = vi.fn();
  const result = requestIntentModelAnswer({ ...options, fetcher, stream: { onProgress: progress } }, request);
  const checked = expect(result).resolves.toMatchObject({ id: "synthetic-call", function: { arguments: JSON.stringify(args) } });
  await vi.advanceTimersByTimeAsync(40_001); await checked;
  expect(progress.mock.calls.map(([p]) => p.characters)).toEqual([0, 13, 42, 44]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ stream: true, tool_stream: true,
    enable_thinking: false, parallel_tool_calls: false, tool_choice: { type: "function", function: { name: "stage" } } });
});

it("still aborts a provider that buffers the complex arguments without executing or retrying", async () => {
  vi.useFakeTimers();
  // The documented default behavior is also the counterfactual for the old request
  // without tool_stream. It is simulated here, not asserted as a captured wire trace.
  const { fetcher, cancel } = complexProvider(true); const execute = vi.fn(); const validate = vi.fn(); const progress = vi.fn();
  const result = runStagingTool({ ...options, fetcher, stream: { onProgress: progress } }, {
    name: "stage", description: "Synthetic", input: {}, schema, validate, execute,
  });
  const checked = expect(result).rejects.toMatchObject({ code: "INTENT_IDLE_TIMEOUT", status: 504 });
  await vi.advanceTimersByTimeAsync(30_001); await checked;
  expect(progress.mock.calls.map(([p]) => p.characters)).toEqual([0, 13]);
  expect(fetcher).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  expect(validate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

it.each([
  ["sync tool", baseUrl, "qwen3.8-max-0902", false, true, false],
  ["non-tool stream", baseUrl, "qwen3.8-max-0902", true, false, false],
  ["other provider", "https://model.example.test/v1", "qwen3.8-max-0902", true, true, false],
  ["host suffix spoof", "https://maas.aliyuncs.com.example.test/v1", "qwen3.8-max-0902", true, true, false],
  ["unconfigured model family", baseUrl, "qwen3.7-max", true, true, false],
  ["simple model", baseUrl, "qwen3.8-flash", true, true, false],
  ["Max alias", baseUrl, "qwen3.8-max", true, true, true],
  ["pinned Max", baseUrl, "qwen3.8-max-0902", true, true, true],
] as const)("scopes the extension for %s", async (_name, url, model, stream, tool, enabled) => {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(null, { status: 400 }));
  const config: IntentModelOptions = { ...options, baseUrl: url, model, fetcher, ...(stream ? { stream: {} } : {}) };
  await expect(requestIntentModelAnswer(config, { ...request, toolName: tool ? "stage" : undefined })).rejects.toMatchObject({ code: "INTENT_FAILED" });
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  if (enabled) expect(body.tool_stream).toBe(true); else expect(body).not.toHaveProperty("tool_stream");
  expect(body).not.toHaveProperty("max_tokens"); expect(body).not.toHaveProperty("max_completion_tokens");
  expect(fetcher).toHaveBeenCalledOnce();
});
