// Startrips LLM 客户端（流式 + 非流式）；配置名称由服务器解析为模型与密钥。
import * as api from './api';
import type { LlmProfile } from './data';
import { modelRequest, type ModelCancellation } from './modelRequest';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function llmFetch(profile: LlmProfile, body: object, signal?: AbortSignal) {
  return api.authFetch('/api/soc/llm', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, profile: profile.name }),
  });
}

/** 流式对话；onDelta 持续收增量，返回完整文本。 */
export function chatStream(
  profile: LlmProfile,
  messages: LlmMessage[],
  onDelta: (delta: string, full: string) => void,
  cancellation?: ModelCancellation,
): Promise<string> {
  return modelRequest((signal) => llmFetch(profile, { messages, stream: true }, signal), true, onDelta, cancellation);
}

/** 非流式一次性调用（课后管线用）。 */
export function chatOnce(profile: LlmProfile, messages: LlmMessage[], cancellation?: ModelCancellation): Promise<string> {
  return modelRequest((signal) => llmFetch(profile, { messages, stream: false }, signal), false, undefined, cancellation);
}

/** 要求模型返回 JSON 的调用：剥代码围栏并解析 */
export async function chatJson<T>(profile: LlmProfile, messages: LlmMessage[], cancellation?: ModelCancellation): Promise<T> {
  const raw = await chatOnce(profile, messages, cancellation);
  const stripped = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/```[\s\S]*$/, '').trim();
  const candidate = stripped.startsWith('{') || stripped.startsWith('[') ? stripped : raw.trim();
  const start = candidate.search(/[{[]/);
  if (start < 0) throw new Error(`LLM 未返回 JSON：${raw.slice(0, 200)}`);
  return JSON.parse(candidate.slice(start));
}
