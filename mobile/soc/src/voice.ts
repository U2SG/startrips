// Startrips owns voice credentials; clients receive only generated audio URLs.
import AsyncStorage from './storage';
import * as api from './api';
import type { Companion } from './data';

export type VoiceCreds = { model: string };

type Co = NonNullable<Companion>;

// 已用本账号 key 实测可用的 qwen3-tts-flash 音色池（性别分类沿用桌面端 voice-catalog）。
// 粤语靠 Rocky/Kiki 音色实现（language_type 仍传 Chinese）。
export const VOICE_POOL = {
  female: ['Cherry', 'Serena', 'Chelsie', 'Bella', 'Jennifer', 'Katerina', 'Maia', 'Mia', 'Stella', 'Momo', 'Vivian', 'Elias'],
  male: ['Ethan', 'Ryan', 'Aiden', 'Kai', 'Nofish', 'Neil', 'Arthur', 'Vincent', 'Andre', 'Moon'],
  cantonese: ['Kiki', 'Rocky'], // Kiki 女 / Rocky 男
} as const;

// 音色选择列表（给手机端的逐伙伴音色选择 UI 用），带分组标签
export const VOICE_GROUPS: { label: string; voices: readonly string[] }[] = [
  { label: '女声', voices: VOICE_POOL.female },
  { label: '男声', voices: VOICE_POOL.male },
  { label: '粤语', voices: VOICE_POOL.cantonese },
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** C：确定性默认音色——按性别取池子，用 candidateId/名字哈希稳定分配（同伙伴恒定、不同伙伴尽量岔开） */
export function defaultVoice(c: Co): string {
  const female = !!c.pronoun && c.pronoun.includes('她');
  const pool = female ? VOICE_POOL.female : VOICE_POOL.male;
  return pool[hashStr(c.candidateId || c.name || '') % pool.length];
}

const voiceKey = (worldId: string, c: Co) => `socratopia.voice/${worldId}/${c.candidateId || c.name}`;

/** B：取该伙伴的音色——本机覆盖（AsyncStorage）优先，否则用确定性默认 */
export async function getCompanionVoice(worldId: string, c: Co): Promise<string> {
  try {
    const o = await AsyncStorage.getItem(voiceKey(worldId, c));
    if (o) return o;
  } catch { /* ignore */ }
  return defaultVoice(c);
}

/** B：保存该伙伴的音色覆盖（仅本机，不回写桌面/文件） */
export async function setCompanionVoice(worldId: string, c: Co, voice: string): Promise<void> {
  await AsyncStorage.setItem(voiceKey(worldId, c), voice);
}

/** 语音输入（STT）：把一段本地录音（base64）交给 qwen3-asr-flash 识别成文字。
 *  请求结构已实测：OpenAI 兼容 /compatible-mode/v1/chat/completions + input_audio data URL。
 *  由服务器选择 DashScope 配置，客户端只发送录音。 */
export async function transcribeAudio(_creds: VoiceCreds, base64: string, format = 'm4a', signal?: AbortSignal): Promise<string> {
  const result = await api.studyJson<{ text: string }>('/voice', { action: 'transcribe', audio: `data:audio/${format};base64,${base64}` }, signal);
  return result.text.trim();
}

export async function resolveVoiceCreds(signal?: AbortSignal): Promise<VoiceCreds | null> {
  const result = await api.studyJson<{ available: boolean }>('/voice', undefined, signal);
  return result.available ? { model: 'qwen3-tts-flash' } : null;
}

export function prepareForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // 代码块
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/\*[^*]*\*/g, '') // *斜体* 神态描写
    .replace(/[#>*_~[\]()]/g, ' ') // 其余 md 符号
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 清洗后按句切分用于 TTS 分块合成：单次合成耗时随文本线性增长（12 字≈2s，216 字≈8s），
 * 切成短块并行合成、按序播放，首声延迟≈首块合成时间（~2s）而非整段。
 * 短文本整段一块；长文本按句末标点/换行切，累积到约 targetChars 一块。
 */
export function chunkForSpeech(text: string, targetChars = 60): string[] {
  const clean = prepareForSpeech(text);
  if (!clean) return [];
  if (clean.length <= targetChars) return [clean];
  // 按句末标点/换行切并保留标点（手动扫描，规避 Hermes 对 lookbehind 的兼容性差异）
  const sentences: string[] = [];
  let s = '';
  for (const ch of clean) {
    s += ch;
    if ('。！？.!?\n'.includes(ch)) { sentences.push(s); s = ''; }
  }
  if (s) sentences.push(s);
  const chunks: string[] = [];
  let cur = '';
  for (const sen of sentences) {
    if (cur && (cur + sen).length > targetChars) {
      chunks.push(cur);
      cur = sen;
    } else {
      cur += sen;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/** 合成一块（已清洗）文本，返回可直接播放的音频 url。http→https 升级以规避 Android 明文流量拦截 */
export async function synthesizeChunk(_creds: VoiceCreds, cleanText: string, voice: string, signal?: AbortSignal): Promise<string> {
  const result = await api.studyJson<{ url: string }>('/voice', { action: 'synthesize', text: cleanText.slice(0, 4000), voice }, signal);
  return result.url;
}
