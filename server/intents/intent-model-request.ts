/**
 * The one HTTP call every text intent reader makes: an OpenAI-compatible
 * `chat/completions` request with a strict JSON-schema answer.
 *
 * It answers the parsed JSON (or `null` when the content is not JSON) and
 * leaves the shape check to the caller. Transport failures are named the same
 * way for every intent: unreachable and non-2xx answers are 502, a provider
 * that outlives `timeoutMs` is a 504.
 */

import { requestModelStream, type ModelStreamOptions } from "./intent-model-stream";
import type { ShareIntentError } from "./create-share-intent";

export type IntentModelOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
  stream?: ModelStreamOptions;
};

export function isDashScope(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.endsWith(".aliyuncs.com");
  } catch {
    return false;
  }
}

export async function requestIntentModelAnswer(
  options: IntentModelOptions,
  request: {
    systemPrompt: string;
    userContent: string;
    schemaName: string;
    schema: object;
    /** Optional single whitelisted function; never executes arbitrary model calls. */
    toolName?: string;
    /** Names the provider in error messages, e.g. "share intent provider". */
    providerName: string;
    /** Builds the stage error the caller's route maps to `{ error, message }`. */
    fail: (code: string, message: string, status?: number) => ShareIntentError;
  },
): Promise<unknown> {
  const { baseUrl, apiKey, model, timeoutMs } = options;
  const fetcher = options.fetcher ?? fetch;
  const body = {
          model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userContent },
          ],
          // DashScope's own switch; strict OpenAI-compatible services
          // reject unknown request fields, so only DashScope receives it.
          ...(isDashScope(baseUrl) ? { enable_thinking: false } : {}),
          ...(request.toolName ? {
            tools: [{ type: "function", function: { name: request.toolName, description: request.systemPrompt, strict: true, parameters: request.schema } }],
            tool_choice: { type: "function", function: { name: request.toolName } },
            parallel_tool_calls: false,
          } : { response_format: {
            type: "json_schema",
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          } }),
        };
  if (options.stream) return requestModelStream(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, apiKey, body, request.toolName, options.stream, fetcher, request.fail);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw request.fail(
        "INTENT_UNREACHABLE",
        `The ${request.providerName} could not be reached`,
      );
    }
    if (!response.ok) {
      throw request.fail(
        "INTENT_FAILED",
        `The ${request.providerName} answered ${response.status}`,
      );
    }
    const payload = await response.json().catch((error: unknown) => {
      // A response header is not a completed response: preserve abort/network
      // failures while reading the body instead of misreporting schema failure.
      if (controller.signal.aborted) throw error;
      if (error instanceof SyntaxError) return null;
      throw request.fail("INTENT_UNREACHABLE", `The ${request.providerName} response could not be read`);
    }) as {
      choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ type?: string; function?: { name?: string; arguments?: unknown } }> } }>;
    } | null;
    const message = payload?.choices?.[0]?.message;
    if (request.toolName && (message?.tool_calls?.length !== 1 || message.tool_calls[0].type !== "function" || message.tool_calls[0].function?.name !== request.toolName)) return null;
    const content = request.toolName ? message?.tool_calls?.[0]?.function?.arguments : message?.content;
    if (typeof content !== "string") return null;
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw request.fail(
        "INTENT_TIMEOUT",
        `The ${request.providerName} did not answer within ${timeoutMs}ms`,
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
