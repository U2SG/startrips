import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serverConfig } from "../config";
import { configuredJournalModel, journalProviderInfo } from "./journal-model";
import { requestIntentModelAnswer } from "../intents/intent-model-request";
import { ShareIntentError } from "../intents/create-share-intent";

const prior = { ...serverConfig };
beforeEach(() => Object.assign(serverConfig, { intentDriver: "http-model", intentBaseUrl: "https://workspace.ap-southeast-1.maas.aliyuncs.com/v1",
  intentApiKey: "synthetic-key", intentModel: "simple-model", intentVisionModel: "vision-model", journalModel: "qwen3.8-max-0902" }));
afterEach(() => Object.assign(serverConfig, prior));

it("never substitutes a simple model for an unavailable journal model", () => {
  Object.assign(serverConfig, { journalModel: null });
  expect(journalProviderInfo()).toMatchObject({ available: false, model: "" });
  expect(configuredJournalModel).toThrow("JOURNAL_MODEL");
  expect(serverConfig.intentModel).toBe("simple-model");
  expect(serverConfig.intentVisionModel).toBe("vision-model");
});

it("binds consent to journal model, endpoint and key, independently of simple and vision models", () => {
  const original = journalProviderInfo();
  Object.assign(serverConfig, { intentModel: "other-simple", intentVisionModel: "other-vision" });
  expect(journalProviderInfo()).toEqual(original);
  Object.assign(serverConfig, { journalModel: "other-journal" });
  expect(journalProviderInfo().baseUrl).not.toBe(original.baseUrl);
  Object.assign(serverConfig, { journalModel: "qwen3.8-max-0902", intentApiKey: "rotated-synthetic-key" });
  expect(journalProviderInfo().baseUrl).not.toBe(original.baseUrl);
  expect(JSON.stringify(journalProviderInfo())).not.toContain("synthetic-key");
});

it.each([false, true])("sends the pinned MaaS model with thinking disabled and forced tools (stream=%s)", async stream => {
  const call = { id: "synthetic-call", type: "function", function: { name: "stage", arguments: '{"ok":true}' } };
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    : Response.json({ choices: [{ finish_reason: "stop", message: { tool_calls: [call] } }] }));
  const result = await requestIntentModelAnswer({ ...configuredJournalModel(), fetcher, ...(stream ? { stream: {} } : {}) }, {
    systemPrompt: "Synthetic probe", userContent: "Synthetic data", schemaName: "stage", schema: {}, toolName: "stage", captureToolCall: true,
    providerName: "synthetic", fail: (c, m, s) => new ShareIntentError(c, m, s),
  });
  expect(result).toEqual(call);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ model: "qwen3.8-max-0902", enable_thinking: false,
    tool_choice: { type: "function", function: { name: "stage" } }, parallel_tool_calls: false });
});

for (const stream of [false, true]) {
  it.each(["other-host", "other-model", "truncated", "filtered", "missing-id", "wrong-tool", "extra-call", "no-call"])(
    `preserves protocol rejection for %s with the stop compatibility adapter (stream=${stream})`, async scenario => {
      const options = configuredJournalModel();
      if (scenario === "other-host") options.baseUrl = "https://model.example.test/v1";
      if (scenario === "other-model") options.model = "simple-model";
      const call = { index: 0, ...(scenario === "missing-id" ? {} : { id: "synthetic-call" }), type: "function",
        function: { name: scenario === "wrong-tool" ? "wrong" : "stage", arguments: '{"ok":true}' } };
      const calls = scenario === "no-call" ? [] : scenario === "extra-call" ? [call, { ...call, index: 1, id: "second" }] : [call];
      const finish_reason = scenario === "truncated" ? "length" : scenario === "filtered" ? "content_filter" : "stop";
      const fetcher = vi.fn(async () => stream
        ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ choices: [{ finish_reason, message: { tool_calls: calls } }] }));
      await expect(requestIntentModelAnswer({ ...options, fetcher, ...(stream ? { stream: {} } : {}) }, {
        systemPrompt: "Synthetic", userContent: "Synthetic", schemaName: "stage", schema: {}, toolName: "stage", captureToolCall: true,
        providerName: "synthetic", fail: (c, m, s) => new ShareIntentError(c, m, s),
      })).rejects.toMatchObject({ status: 502 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
}
