// 课程会话引擎（模块级）：持有「这节课」本身——ctx / 未下课指针 / 备课-恢复-下课的忙碌状态。
// 之前 ctx 挂在 App.tsx 的 useRef + force 计数上、pending/busy 散在 LessonScreen 本地 state，
// 组件卸载即丢、跨组件读写靠 props 钻传。引擎化后 UI 只订阅（与 speech/lecture 同款模式）。
// 操作错误交给页面；指针读取失败保留在状态中，让未知状态可见并可重试。
import { sessionGuard } from './api';
import type { LlmProfile, TextbookEntry } from './data';
import {
  clearLessonPointer, endLesson, LessonContext, LessonPointer,
  loadLessonPointer, resumeLesson, startLesson,
} from './lesson';
import { pendingAfterResumeFailure, startAfterPointer } from './lessonRecovery';
import * as lecture from './speech/lecture';
import * as speech from './speech/player';

export type SessionState = {
  ctx: LessonContext | null;      // 进行中的课（null = 未上课）
  pending: LessonPointer | null;  // 未下课的课指针（仅 ctx 为 null 时有意义）
  busy: string;                   // 备课/恢复/下课的状态文案（'' = 空闲）
  pointerReady: boolean;
  pointerError: string;
};

let state: SessionState = { ctx: null, pending: null, busy: '', pointerReady: false, pointerError: '' };
let pendingRead = 0;
const listeners = new Set<() => void>();

function patch(p: Partial<SessionState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function getState(): SessionState { return state; }

/** 重进 app / 下课后检查有没有未下课的课（桌面版同规则：没下课不能开新课） */
export async function refreshPending(): Promise<void> {
  if (state.ctx) return;
  const guard = sessionGuard();
  const read = ++pendingRead;
  patch({ pointerReady: false, pointerError: '' });
  try {
    const p = await loadLessonPointer();
    if (read !== pendingRead || state.ctx) return;
    guard();
    patch({ pending: p, pointerReady: true });
  } catch (error) {
    if (read !== pendingRead || state.ctx) return;
    patch({ pointerReady: false, pointerError: error instanceof Error ? error.message : '课程状态读取失败，请重试' });
  }
}

/** 开始一节课。失败 throw，busy 自行复位。 */
export async function start(worldId: string, textbook: TextbookEntry, preferSlot?: string): Promise<LessonContext> {
  if (state.busy || state.ctx) throw new Error('正在处理上一个操作');
  const guard = sessionGuard();
  let pointerRead = false;
  ++pendingRead;
  patch({ busy: '检查未完成课程…', pointerReady: false, pointerError: '' });
  try {
    const ctx = await startAfterPointer(loadLessonPointer, guard, (pending) => {
      pointerRead = true;
      patch({ pending, pointerReady: true });
    }, () => startLesson(worldId, textbook, (s) => { guard(); patch({ busy: s }); }, preferSlot));
    guard();
    patch({ ctx, pending: null, busy: '' });
    return ctx;
  } catch (e) {
    guard();
    patch({ busy: '', ...(!pointerRead ? { pointerReady: false, pointerError: e instanceof Error ? e.message : '课程状态读取失败，请重试' } : {}) });
    throw e;
  }
}

/** 恢复未下课的课。课程文件已不在（如被桌面端清理）时清掉指针再 throw，允许放弃这节课。 */
export async function resume(): Promise<LessonContext> {
  const pending = state.pending;
  if (!pending) throw new Error('没有可恢复的课');
  if (state.busy) throw new Error('正在处理上一个操作');
  const guard = sessionGuard();
  try {
    const ctx = await resumeLesson(pending, (s) => patch({ busy: s }));
    guard();
    patch({ ctx, pending: null, busy: '' });
    return ctx;
  } catch (e) {
    guard();
    const retained = await pendingAfterResumeFailure(e, pending, clearLessonPointer, guard);
    guard();
    patch({ pending: retained, busy: '' });
    throw e;
  }
}

/** 下课：先停听课/朗读引擎，跑课后管线。成功后 ctx 清空。 */
export async function end(profile: LlmProfile): Promise<{ convId: string; endingPage: number }> {
  const ctx = state.ctx;
  if (!ctx) throw new Error('没有进行中的课');
  if (state.busy) throw new Error('正在处理上一个操作');
  const guard = sessionGuard();
  lecture.stopLecture();
  speech.stop();
  const convId = ctx.chat.id; // ctx 清空前先存，给课后小测用
  patch({ busy: '正在下课…' });
  try {
    const { endingPage } = await endLesson(ctx, profile, (s) => { if (state.ctx === ctx) patch({ busy: s }); });
    guard();
    ctx.assertSession();
    ctx.controller.abort();
    patch({ ctx: null, busy: '' });
    return { convId, endingPage };
  } catch (e) {
    guard();
    if (state.ctx === ctx) patch({ busy: '' });
    throw e;
  }
}

/** 丢弃当前课上下文（换教材/换世界）：必须显式停掉听课与朗读引擎——
 *  它们不随组件卸载而死，否则会拿着旧 ctx 继续讲课写文件。不清 lesson 指针，之后仍可恢复。 */
export function discard(): void {
  state.ctx?.controller.abort();
  lecture.reset();
  speech.stop();
  patch({ ctx: null, busy: '' });
  refreshPending();
}

export function reset(): void {
  ++pendingRead;
  state.ctx?.controller.abort();
  lecture.reset();
  speech.stop();
  patch({ ctx: null, pending: null, busy: '', pointerReady: false, pointerError: '' });
}
