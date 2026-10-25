// 听课引擎（模块级）：单回合发送（流式节流 + 可选边生成边合成朗读）+ 连续听课循环。
// 搬出组件的原因：旧实现的循环长在 LessonScreen 里，切 tab 卸载组件循环即死；
// 息屏续命靠的是 player 引擎 pin 住的媒体会话（整堂课不清），也不能绑在组件生命周期上。
// 回合间推进是事件驱动（等播放引擎 idle 事件），替代旧的 200ms 轮询 + 3 分钟兜底盲跳。
import type { LlmProfile } from '../data';
import { sendLessonMessage, type LessonContext } from '../lesson';
import { getCompanionVoice, resolveVoiceCreds } from '../voice';
import * as speech from './player';
import type { MediaMeta } from './player';

export type LectureDeps = { ctx: LessonContext; profile: LlmProfile };

export type LectureState = {
  lecturing: boolean;  // 连续听课进行中
  turnActive: boolean; // 有回合进行中（发送/流式接收中）
  error: string;       // 最近一次回合错误（点掉后 clearError）
  rev: number;         // 消息列表变更计数：回合落盘后 +1，驱动订阅方重渲染
};

const MAX_TURNS = 40;
const END_MARK = '本节已讲完';

let state: LectureState = { lecturing: false, turnActive: false, error: '', rev: 0 };
const listeners = new Set<() => void>();

function patch(p: Partial<LectureState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function getState(): LectureState { return state; }
export function clearError(): void { if (state.error) patch({ error: '' }); }

// 流式文本走单独的快通道订阅：100ms 一跳只驱动流式气泡组件重渲染，
// 不带动订阅慢状态的整个 LessonScreen（长课 40+ 回合时是实打实的卡点）。
let streamText = ''; // '' = 没有回合进行中；' ' = 回合已开始但还没内容
const streamListeners = new Set<() => void>();
function setStream(t: string) {
  if (t === streamText) return;
  streamText = t;
  streamListeners.forEach((l) => l());
}
export function subscribeStream(l: () => void): () => void {
  streamListeners.add(l);
  return () => { streamListeners.delete(l); };
}
export function getStreamText(): string { return streamText; }

function lectureMeta(ctx: LessonContext): MediaMeta {
  return {
    title: `听课 · 第 ${ctx.windowStart}-${ctx.windowEnd} 页`,
    artist: ctx.companion.name ?? 'Socratopia',
    albumTitle: ctx.textbook.title,
  };
}

let turnSeq = 0;
let lastReply = '';

/** 发送一个回合并流式接收：节流刷 streamText；speak 时边生成边按句合成播放。
 *  返回是否成功。abort（语音打断）不算错、不回滚已说内容。 */
export async function runTurn(
  deps: LectureDeps,
  text: string,
  opts: { speak?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (state.turnActive) return false; // 已有回合进行中
  const my = ++turnSeq;
  patch({ turnActive: true, error: '' });
  setStream(' ');
  let buf = '';
  // 流式渲染节流：onDelta 只写缓冲，100ms 刷一次，避免逐字 re-render 抖动
  const timer = setInterval(() => { if (turnSeq === my) setStream(buf || ' '); }, 100);

  let vs: ReturnType<typeof speech.startStreamingSpeech> | null = null;
  if (opts.speak) {
    try {
      const creds = await resolveVoiceCreds();
      if (creds) {
        const voice = await getCompanionVoice(deps.ctx.worldId, deps.ctx.companion);
        vs = speech.startStreamingSpeech(creds, voice, lectureMeta(deps.ctx));
      }
    } catch { /* 朗读不可用不挡对话 */ }
  }

  let ok = true;
  try {
    const p = sendLessonMessage(deps.ctx, deps.profile, text, (full) => {
      buf = full;
      vs?.onText(full);
    }, opts.signal);
    // 用户消息在 sendLessonMessage 的同步段就已 push 进 chat.messages，
    // 这里立即 bump rev 让用户气泡上屏（流式期间父组件不再随快通道重渲染）
    patch({ rev: state.rev + 1 });
    await p;
    const last = deps.ctx.chat.messages[deps.ctx.chat.messages.length - 1];
    vs?.finish(buf, last?.role === 'assistant' ? last.id : undefined);
  } catch (e: any) {
    ok = false;
    // 语音打断（abort）属预期中止：不报错、保留已说的内容
    if (!opts.signal?.aborted) {
      patch({ error: String(e?.message || e) });
      // chatStream 失败时最后一条是 user 消息，需要回滚；
      // writeChat 失败时 assistant 已 push，不应弹出（内存仍可见，只是未持久化）
      const msgs = deps.ctx.chat.messages;
      if (msgs[msgs.length - 1]?.role === 'user') msgs.pop();
    }
    speech.stop();
  } finally {
    clearInterval(timer);
    lastReply = buf;
    if (turnSeq === my) {
      setStream('');
      patch({ turnActive: false, rev: state.rev + 1 });
    }
  }
  return ok;
}

/** 一键听课：连续讲课到本节讲完（结束标记）或达上限。媒体会话整堂课 pin 住，
 *  段与段之间（LLM 生成期）也持有前台服务，息屏不会被系统冻结。 */
export async function startLecture(deps: LectureDeps): Promise<void> {
  if (state.lecturing || state.turnActive) return;
  patch({ lecturing: true });
  let pinnedHere = false;
  try {
    const speak = !!(await resolveVoiceCreds().catch(() => null));
    if (speak) {
      speech.pinMediaSession(lectureMeta(deps.ctx));
      pinnedHere = true;
    }
    let turns = 0;
    let ok = await runTurn(deps, '给我讲课', { speak });
    while (ok && state.lecturing) {
      if (lastReply.replace(/\s/g, '').includes(END_MARK) || turns >= MAX_TURNS) break;
      await speech.waitUntilIdle(); // 等本段朗读真正播完（事件驱动，无轮询）
      if (!state.lecturing) break;
      turns += 1;
      ok = await runTurn(deps, '继续讲下一页', { speak });
    }
  } finally {
    if (pinnedHere) speech.unpinMediaSession();
    patch({ lecturing: false });
  }
}

/** 停止连续听课：置停 + 释放媒体会话 + 掐掉当前朗读。进行中的 LLM 回合让它自然收尾（消息不丢）。 */
export function stopLecture(): void {
  if (!state.lecturing) return;
  patch({ lecturing: false });
  speech.unpinMediaSession();
  speech.stop();
}
