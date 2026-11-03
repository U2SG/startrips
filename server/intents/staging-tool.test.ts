import { describe, expect, it, vi } from "vitest";
import { runStagingTool, toolObject, requireTool, ToolArgumentError } from "./staging-tool";
import { ShareIntentError } from "./create-share-intent";
import type { ModelMessage } from "./intent-model-request";
import { importDiagnostic } from "../admin/journal-import-diagnostic";
const model = { baseUrl: "https://mock.invalid/v1", apiKey: "mock-only", model: "synthetic", timeoutMs: 1000 };
const schema = toolObject({ day: { type: "integer", minimum: 1, description: "Day, integer 1–31." } });
const validate = (value: unknown) => { const args = value as { day: number }; requireTool(args.day <= 31, "$.day", "DAY_RANGE"); return args; };
function response(id: string | undefined, args: unknown, name = "stage", raw = false) {
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id, type: "function", function: { name, arguments: raw ? args : JSON.stringify(args) } }] } }] });
}
const tool = { name: "stage", description: "Stage synthetic values; no writes.", input: { source: "synthetic" }, schema, validate, execute: vi.fn((v: { day: number }) => v.day) };
it("wrong args → matched error → correction → terminal success executes once", async () => {
  const conversation: ModelMessage[] = [], execute = vi.fn(tool.execute);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.parallel_tool_calls).toBe(false); expect(body.tool_choice.function.name).toBe("stage");
    if (fetcher.mock.calls.length === 1) return response("first", { day: 99 });
    expect(body.messages.slice(2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "first", type: "function", function: { name: "stage", arguments: '{"day":99}' } }] },
      { role: "tool", tool_call_id: "first", content: expect.any(String) },
    ]);
    expect(JSON.parse(body.messages.at(-1).content)).toMatchObject({ ok: false, error: { category: "tool_arguments", path: "$.day", code: "DAY_RANGE", retryable: true } });
    return response("second", { day: 3 });
  });
  expect(await runStagingTool({ ...model, fetcher }, { ...tool, execute, conversation })).toBe(3);
  expect(fetcher).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledTimes(1);
  expect(conversation.at(-1)).toEqual({ role: "tool", tool_call_id: "second", content: '{"ok":true,"staged":true}' });
});
it.each(["repeat", "budget"])("bounds %s failures without execution", async kind => {
  const execute = vi.fn(), inputs = kind === "repeat" ? [{ day: 99 }, { day: 98 }] : [{}, { day: "3" }, { day: 99 }];
  const fetcher = vi.fn(async () => response(String(fetcher.mock.calls.length), inputs[fetcher.mock.calls.length - 1]));
  await expect(runStagingTool({ ...model, fetcher }, { ...tool, execute })).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID", status: 422 });
  expect(fetcher).toHaveBeenCalledTimes(inputs.length); expect(execute).not.toHaveBeenCalled();
});
it("corrects malformed JSON and forbids unexpected arguments without reflecting secrets", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const n = fetcher.mock.calls.length, body = JSON.parse(String(init?.body));
    if (n === 1) return response("1", "{bad", "stage", true);
    if (n === 2) { expect(JSON.parse(body.messages.at(-1).content).error.code).toBe("INVALID_JSON"); return response("2", { day: 1, "secret-key": "private" }); }
    const feedback = body.messages.at(-1).content;
    expect(feedback).not.toContain("secret-key"); expect(feedback).not.toContain("private");
    expect(JSON.parse(feedback).error.code).toBe("EXTRA_ARGUMENT"); return response("3", { day: 2 });
  });
  expect(await runStagingTool({ ...model, fetcher }, tool)).toBe(2);
});
it.each(["missing-id", "wrong-tool", "reuse-id", "truncated"])("does not repair protocol failure %s", async kind => {
  const execute = vi.fn(), fetcher = vi.fn(async () => {
    if (kind === "truncated") return Response.json({ choices: [{ finish_reason: "length", message: { tool_calls: [{ id: "id", type: "function", function: { name: "stage", arguments: '{"day":1}' } }] } }] });
    return response(kind === "missing-id" ? undefined : "id", { day: kind === "reuse-id" ? 99 : 1 }, kind === "wrong-tool" ? "execute_sql" : "stage");
  });
  await expect(runStagingTool({ ...model, fetcher }, { ...tool, execute })).rejects.toMatchObject({ code: "INTENT_TOOL_PROTOCOL_INVALID" });
  expect(fetcher).toHaveBeenCalledTimes(kind === "reuse-id" ? 2 : 1); expect(execute).not.toHaveBeenCalled();
});
it.each(["provider", "validator", "unknown-execution", "business"])("never retries %s failures", async kind => {
  const fetcher = vi.fn(async () => { if (kind === "provider") throw new Error("private transport"); return response("id", { day: 1 }); });
  const validate = () => { if (kind === "validator") throw new Error("private validator"); if (kind === "business") throw new ShareIntentError("JOURNAL_CAPACITY_EXCEEDED", "capacity", 422); return { day: 1 }; };
  const execute = vi.fn(() => { throw new Error("UNKNOWN_EXECUTION_RESULT"); });
  const promise = runStagingTool({ ...model, fetcher }, { ...tool, validate, execute });
  if (kind === "unknown-execution") await expect(promise).rejects.toThrow("UNKNOWN_EXECUTION_RESULT");
  else await expect(promise).rejects.toMatchObject({ code: kind === "provider" ? "INTENT_UNREACHABLE" : kind === "business" ? "JOURNAL_CAPACITY_EXCEEDED" : "TOOL_VALIDATOR_ERROR" });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(kind === "unknown-execution" ? 1 : 0);
});
it.each(["cancel", "version", "permission", "lease"])("stops %s before correction", async kind => {
  const signal = new AbortController(), execute = vi.fn(); let checks = 0;
  const fetcher = vi.fn(async () => { if (kind === "cancel") signal.abort(); return response("id", { day: 99 }); });
  const checkCurrent = async () => { if (++checks === 2 && kind !== "cancel") throw new Error(kind === "version" ? "JOURNAL_CHANGED" : kind === "permission" ? "TARGET_PERMISSION_DENIED" : "JOURNAL_JOB_INTERRUPTED"); };
  await expect(runStagingTool({ ...model, fetcher, signal: signal.signal, checkCurrent }, { ...tool, execute })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
});
it("cancels a sync provider that ignores AbortSignal, without another request", async () => {
  const controller = new AbortController(); const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const pending = runStagingTool({ ...model, fetcher, signal: controller.signal }, tool);
  await new Promise(r => setTimeout(r, 0)); controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "INTENT_CANCELLED" }); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("uses the production SSE parser for a matched correction round", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const n = fetcher.mock.calls.length, body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(true);
    if (n === 2) expect(body.messages.at(-1).tool_call_id).toBe("sse-1");
    const call = { index: 0, id: `sse-${n}`, type: "function", function: { name: "stage", arguments: JSON.stringify({ day: n === 1 ? 99 : 3 }) } };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  expect(await runStagingTool({ ...model, fetcher, stream: {} }, tool)).toBe(3); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("classifies server validator, argument, protocol, transport, conflict and permission separately", () => {
  for (const [code, kind] of [["TOOL_VALIDATOR_ERROR", "validator"], ["TOOL_ARGUMENTS_INVALID", "tool_arguments"], ["INTENT_TOOL_PROTOCOL_INVALID", "protocol"], ["INTENT_UNREACHABLE", "transport"]])
    expect(importDiagnostic(new ShareIntentError(code, "private", 502), "llm-preview")).toMatchObject({ error: code, kind });
  expect(importDiagnostic(new Error("JOURNAL_CHANGED"), "llm-preview").kind).toBe("business");
  expect(importDiagnostic(new Error("TARGET_PERMISSION_DENIED"), "llm-preview").kind).toBe("permission");
});

it("an execution error cannot re-enter argument correction even if it has that error type", async () => {
  const fetcher = vi.fn(async () => response("id", { day: 1 }));
  const execute = vi.fn(() => { throw new ToolArgumentError("$.day", "EXECUTION_OUTCOME_UNKNOWN"); });
  await expect(runStagingTool({ ...model, fetcher }, { ...tool, execute })).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
  expect(execute).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([null, { choices: [null] }, { choices: { length: 1, 0: { finish_reason: "tool_calls" } } }])("rejects malformed provider envelope without validator attribution", async payload => {
  const fetcher = vi.fn(async () => Response.json(payload));
  await expect(runStagingTool({ ...model, fetcher }, tool)).rejects.toMatchObject({ code: "INTENT_TOOL_PROTOCOL_INVALID" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
