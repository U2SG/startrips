import { createHash } from "node:crypto";
import { ShareIntentError } from "./create-share-intent";
import { requestIntentModelAnswer, type IntentModelOptions, type ModelMessage, type ModelToolCall } from "./intent-model-request";

/** Server-owned diagnosis only: never copy source, supplied values or exceptions into feedback. */
export class ToolArgumentError extends Error {
  constructor(readonly path: string, readonly code: string) { super(code); }
}
/** Bounded correction exhausted. Carries only the last server-chosen path/code. */
export class ToolArgumentsRejectedError extends ShareIntentError {
  constructor(code: string, readonly path: string, readonly argumentCode: string) {
    super(code, "Staging arguments could not be corrected within the bounded budget", 422);
  }
}
export type ToolSchema = {
  type: string | string[]; description?: string; enum?: readonly unknown[];
  properties?: Record<string, ToolSchema>; required?: string[]; additionalProperties?: false;
  items?: ToolSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; minimum?: number;
};
export const toolObject = (properties: Record<string, ToolSchema>, description?: string): ToolSchema =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false, description });
export function requireTool(condition: unknown, path: string, code: string): asserts condition {
  if (!condition) throw new ToolArgumentError(path, code);
}
/** Validates the same bounded JSON-schema vocabulary we expose; no coercion/defaults. */
export function validateToolShape(value: unknown, schema: ToolSchema, path = "$"): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = types.some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value)
    : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : t === "integer" ? Number.isSafeInteger(value) : t === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === t);
  requireTool(matches, path, "TYPE");
  if (schema.enum) requireTool(schema.enum.includes(value), path, "ENUM");
  if (value === null) return;
  if (typeof value === "string") requireTool(value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity), path, "STRING_LENGTH");
  if (typeof value === "number" && schema.minimum !== undefined) requireTool(value >= schema.minimum, path, "MINIMUM");
  if (Array.isArray(value)) {
    requireTool(value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity), path, "ARRAY_LENGTH");
    if (schema.items) value.forEach((item, i) => validateToolShape(item, schema.items!, `${path}[${i}]`));
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) requireTool(Object.hasOwn(record, key), `${path}.${key}`, "REQUIRED");
    // Never reflect attacker-supplied property names in feedback.
    if (schema.additionalProperties === false) requireTool(Object.keys(record).every(k => Object.hasOwn(schema.properties ?? {}, k)), path, "EXTRA_ARGUMENT");
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(record, key)) validateToolShape(record[key], child, `${path}.${key}`);
  }
}
const MAX_CALLS = 3;
const messagesForError = (error: ToolArgumentError) => ({ ok: false, error: { category: "tool_arguments", code: error.code,
  path: error.path, message: "Correct this parameter using the tool schema and supplied source. Do not invent missing facts; use explicit unknown values and questions.", retryable: true } });

/** Only validation can request correction. execute is outside the retry catch;
 * search/DB/provider failures or uncertain execution outcomes are never replayed. */
export async function runStagingTool<A, R>(options: IntentModelOptions, tool: {
  name: string; description: string; input: unknown; schema: ToolSchema;
  validate: (value: unknown) => A; execute: (value: A) => R | Promise<R>;
  argumentFailureCode?: string;
  /** Private in-memory protocol history; never returned to clients or persisted. */
  conversation?: ModelMessage[];
  resultMessage?: (result: R) => unknown;
}): Promise<R> {
  const fail = (code: string, message: string, status = 502) => new ShareIntentError(code, message, status);
  const signals = [options.signal, options.stream?.signal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const guard = async () => {
    if (signal?.aborted) throw fail("INTENT_CANCELLED", "Staging cancelled", 499);
    await options.checkCurrent?.();
    if (signal?.aborted) throw fail("INTENT_CANCELLED", "Staging cancelled", 499);
  };
  const conversation = tool.conversation ?? [];
  conversation.push({ role: "user", content: JSON.stringify(tool.input) });
  const messages: ModelMessage[] = [{ role: "system", content: tool.description }, ...conversation];
  const ids = new Set(conversation.flatMap(message => message.role === "assistant" ? message.tool_calls.map(call => call.id) : [])), failures = new Set<string>();
  for (let attempt = 0; attempt < MAX_CALLS; attempt++) {
    await guard();
    const call = await requestIntentModelAnswer({ ...options, signal }, { toolName: tool.name, schemaName: tool.name,
      systemPrompt: tool.description, userContent: "", schema: tool.schema, messages, captureToolCall: true, providerName: "staging provider", fail }) as ModelToolCall;
    await guard();
    if (ids.has(call.id)) throw fail("INTENT_TOOL_PROTOCOL_INVALID", "Repeated tool call identity");
    ids.add(call.id);
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
    let args: A;
    try {
      let value: unknown;
      try { value = JSON.parse(call.function.arguments); } catch { throw new ToolArgumentError("$", "INVALID_JSON"); }
      validateToolShape(value, tool.schema);
      args = tool.validate(value);
    } catch (error) {
      if (error instanceof ShareIntentError) throw error;
      if (!(error instanceof ToolArgumentError)) throw fail("TOOL_VALIDATOR_ERROR", "Server staging validator failed", 500);
      // Path/code are selected by server validators. No raw args, exception text,
      // credentials or source are placed in a tool error message.
      const feedback = messagesForError(error);
      const fingerprint = createHash("sha256").update(JSON.stringify([error.path, error.code])).digest("hex");
      if (failures.has(fingerprint) || attempt === MAX_CALLS - 1) throw new ToolArgumentsRejectedError(tool.argumentFailureCode ?? "TOOL_ARGUMENTS_INVALID", error.path, error.code);
      failures.add(fingerprint);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(feedback) });
      continue;
    }
    await guard();
    // A success is terminal: retain the matched tool result, without asking the
    // provider for an unnecessary final prose response (or risking another call).
    const result = await tool.execute(args);
    await guard();
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(tool.resultMessage ? tool.resultMessage(result) : { ok: true, staged: true }) });
    conversation.splice(0, conversation.length, ...messages.slice(1));
    return result;
  }
  throw fail("TOOL_ARGUMENTS_INVALID", "Staging call budget exhausted", 422);
}
