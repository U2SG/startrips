// OpenAI 兼容 LLM 客户端（流式 + 非流式）。profile 来自 PC 端 llm-config.json（与桌面版共用）。
import * as api from './api';
import type { LlmProfile } from './data';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function llmFetch(profile: LlmProfile, body: object, signal?: AbortSignal) {
  return api.authFetch('/api/soc/llm', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, profile: profile.name }),
  });
}

const FIRST_BYTE_MS = 60000;    // 发起到响应头（长 prompt 的 TTFB 可能较慢）
const STALL_MS = 45000;         // 流式相邻数据块最大间隔
const BODY_TIMEOUT_MS = 180000; // 非流式读完整响应体（下课大 JSON）

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 流式对话；onDelta 持续收增量，返回完整文本 */
export async function chatStream(
  profile: LlmProfile,
  messages: LlmMessage[],
  onDelta: (delta: string, full: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await withTimeout(
    llmFetch(profile, { messages, stream: true }, signal),
    FIRST_BYTE_MS, 'LLM 连接超时',
  );
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  try {
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), STALL_MS, 'LLM 流式响应停滞，已中断');
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta, full);
          }
        } catch { /* 不完整的 SSE 块，忽略 */ }
      }
    }
  } catch (e) {
    reader.cancel().catch(() => {}); // 停滞/中止时释放底层连接
    throw e;
  }
  return full;
}

/** 非流式一次性调用（课后管线用） */
export async function chatOnce(profile: LlmProfile, messages: LlmMessage[]): Promise<string> {
  const res = await withTimeout(
    llmFetch(profile, { messages, stream: false }),
    FIRST_BYTE_MS, 'LLM 连接超时',
  );
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await withTimeout(res.json(), BODY_TIMEOUT_MS, 'LLM 响应超时');
  return data.choices?.[0]?.message?.content ?? '';
}

/** 要求模型返回 JSON 的调用：剥代码围栏并解析 */
export async function chatJson<T>(profile: LlmProfile, messages: LlmMessage[]): Promise<T> {
  const raw = await chatOnce(profile, messages);
  const stripped = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/```[\s\S]*$/, '').trim();
  const candidate = stripped.startsWith('{') || stripped.startsWith('[') ? stripped : raw.trim();
  const start = candidate.search(/[{[]/);
  if (start < 0) throw new Error(`LLM 未返回 JSON：${raw.slice(0, 200)}`);
  return JSON.parse(candidate.slice(start));
}
