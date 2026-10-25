// 播放引擎（模块级单例）：TTS 分块 合成 → 落盘 → 按序播放。
// 不随组件卸载释放（createAudioPlayer 而非 useAudioPlayer hook）——切 tab 卸载 LessonScreen
// 也不会打断播放和听课循环。
//
// 为什么落盘再播：合成返回的是 OSS 远程 wav 签名 url，边下边播遇到网络抖动会卡在半句、
// didJustFinish 永远不来（旧实现只能靠 3 分钟兜底超时盲跳到下一段）。本地文件播放不受网络影响，
// 网络失败收敛到「合成/下载」阶段，可重试。
//
// 媒体会话（锁屏控制）生命周期：Android 上没有活跃媒体会话，后台约 3 分钟就会被系统冻结/杀掉
// （vivo 尤其激进）。听课期间由 lecture 引擎 pin 住整堂课不清（段与段之间正是「没在播 + 要发
// LLM 请求」的冻结窗口，旧实现每段播完就 clearLockScreenControls 是息屏后没有下一段的直接原因）；
// 单条朗读不 pin，播完即清。
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { cacheAudio, removeAudio } from './audioCache';
import { fetchChunkFile } from './chunkFile';
import { prepareForSpeech, synthesizeChunk, type VoiceCreds } from '../voice';
import { claimAudioFocus } from '../audioFocus';

export type MediaMeta = { title: string; artist?: string; albumTitle?: string };
/** 给 UI 的播报状态：null=没在播；preparing=首块合成中（按钮显示「合成…」） */
export type SpeechState = { msgId: string; status: 'preparing' | 'playing' } | null;

// 与 stt.ts 录音后恢复的 PLAYBACK_MODE 保持一致
const PLAYBACK_MODE = { allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' as const };

const STALL_MS = 6000;         // 起播后播放位置冻结超过此时长 → 判卡死，重试本块
const START_TIMEOUT_MS = 8000; // replace+play 后一直没起播 → 同卡死处理
const TAIL_GRACE_MS = 250;     // 最后一块 didJustFinish 到真实音频尾巴的缓冲，避免 pause 掐掉尾音
const FETCH_TIMEOUT_MS = 30000; // 单次合成+下载的硬超时：fetch 网络黑洞挂死时 job 永不 settle，
                                // playChunk 会卡在 await 上且 watchdog 不覆盖（等下载期间 watch=null）

type Session = {
  controller: AbortController;
  msgId: string;
  jobs: Promise<string | null>[]; // 每块：合成+下载完成后的本地文件 uri（重试后仍失败 = null）
  idx: number;
  streaming: boolean; // 仍在流式追加新块
  waiting: boolean;   // 播放指针已追上队列末尾、在等下一块入队
};

let player: AudioPlayer | null = null;
let session: Session | null = null;
let sessionSeq = 0;
let advancing = false; // 防重入：从「推进」到「下一块真正起播」之间忽略重复的 didJustFinish
let watch: { pos: number; at: number; started: boolean; retried: boolean } | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let pinned = false;
let draining = false;          // 尾巴缓冲进行中：会话已清但音频还差 ~250ms，waitUntilIdle 不许提前放行
let lastPlayedUri: string | null = null; // 上一块的本地文件，起播新块后即删（一堂课几百块 wav 会占上百 MB）

let state: SpeechState = null;
const listeners = new Set<() => void>();
const idleWaiters: (() => void)[] = [];

function notify() { listeners.forEach((l) => l()); }
function setState(s: SpeechState) { state = s; notify(); }

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function getState(): SpeechState { return state; }

export async function ensureAudioMode(): Promise<void> {
  await setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
}

function getPlayer(): AudioPlayer {
  if (!player) {
    player = createAudioPlayer();
    player.addListener('playbackStatusUpdate', (st) => {
      if (!st.didJustFinish || advancing || !session) return;
      advancing = true;
      playChunk(session.idx + 1);
    });
  }
  return player;
}

// ── 卡死看门狗（仅会话进行中运行）────────────────────────────
// 只在两种确定性场景出手：①player.playing 为 true 但位置冻结（解码/底层挂死）；
// ②replace+play 后迟迟没起播。已起播后 playing=false 且不在结尾 → 视为用户从锁屏暂停，不干预。
function ensureWatchdog() {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    const st = session;
    const p = player;
    if (!st || !p || st.waiting || !watch || advancing) return;
    const now = Date.now();
    const pos = p.currentTime || 0;
    if (p.playing) {
      watch.started = true;
      if (pos > watch.pos + 0.05) { watch.pos = pos; watch.at = now; return; }
      if (now - watch.at > STALL_MS) recoverStall(pos);
    } else if (watch.started) {
      // 已起播后停在结尾：didJustFinish 丢了，兜底推进（锁屏暂停停在中段不会命中）
      const dur = p.duration || 0;
      if (dur > 0 && pos >= dur - 0.35 && now - watch.at > 1500) {
        advancing = true;
        playChunk(st.idx + 1);
      }
    } else if (now - watch.at > START_TIMEOUT_MS) {
      recoverStall(0);
    }
  }, 1500);
}
function stopWatchdog() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

async function recoverStall(pos: number) {
  const st = session;
  if (!st || advancing || !watch) return;
  if (watch.retried) {
    // 本块已重试过一次仍卡死 → 跳过本块（只丢一块，不丢整段）
    advancing = true;
    playChunk(st.idx + 1);
    return;
  }
  const idxAtCall = st.idx;
  watch = { pos, at: Date.now(), started: false, retried: true };
  const uri = await st.jobs[st.idx];
  // await 期间可能已推进/跳块/换会话，别把旧块 replace 回去
  if (session !== st || st.idx !== idxAtCall || advancing || !uri) return;
  const p = getPlayer();
  try {
    p.replace(uri);
    if (pos > 0.5) p.seekTo(pos);
    p.play();
  } catch {
    advancing = true;
    playChunk(st.idx + 1);
  }
}

// ── 播放推进 ─────────────────────────────────────────────
async function playChunk(i: number) {
  const st = session;
  if (!st) { advancing = false; return; }
  if (i >= st.jobs.length) {
    if (st.streaming) { st.waiting = true; st.idx = i; watch = null; return; } // 等 enqueue 唤醒；advancing 保持，屏蔽旧块重复事件
    endSession();
    return;
  }
  st.waiting = false;
  st.idx = i;
  watch = null; // 等合成/下载期间不计时
  const uri = await st.jobs[i];
  if (session !== st) return;
  if (!uri) { playChunk(i + 1); return; } // 合成/下载重试后仍失败 → 跳过本块
  const p = getPlayer();
  try {
    p.replace(uri);
    p.play();
  } catch {
    playChunk(i + 1);
    return;
  }
  // 上一块已播完且被 replace 掉，本地文件即删，磁盘占用恒为 ~2 块
  if (lastPlayedUri && lastPlayedUri !== uri) {
    removeAudio(lastPlayedUri);
  }
  lastPlayedUri = uri;
  watch = { pos: 0, at: Date.now(), started: false, retried: false };
  advancing = false; // 新块已起播，确定性复位，允许其播完后推进
  if (state?.msgId !== st.msgId || state?.status !== 'playing') setState({ msgId: st.msgId, status: 'playing' });
}

// 自然播完：留尾巴缓冲再 pause / 清会话（didJustFinish 在这台设备常比真实音频尾巴早一点）
function endSession() {
  session = null;
  advancing = false;
  watch = null;
  draining = true;
  setState(null);
  setTimeout(() => {
    draining = false;
    if (session) return; // 新会话已接管，别去 pause 它
    try { player?.pause(); } catch {}
    if (!pinned) { try { player?.clearLockScreenControls(); } catch {} }
    stopWatchdog();
    flushIdle();
  }, TAIL_GRACE_MS);
}

function flushIdle() {
  idleWaiters.splice(0).forEach((w) => w());
}

/** 立即停止当前播报（用户打断/切换）。pinned（听课中）时保留媒体会话。 */
export function stop(): void {
  const stopped = session;
  session = null;
  stopped?.controller.abort();
  stopped?.jobs.forEach((job) => { void job.then((uri) => { if (uri && uri !== lastPlayedUri) removeAudio(uri); }); });
  advancing = false;
  watch = null;
  draining = false;
  try { player?.pause(); } catch {}
  if (!pinned) { try { player?.clearLockScreenControls(); } catch {} }
  stopWatchdog();
  setState(null);
  flushIdle();
}

/** 等当前播报完全播完（含尾巴缓冲）。没在播则立即返回。 */
export function waitUntilIdle(): Promise<void> {
  if (!session && !draining) return Promise.resolve();
  return new Promise((r) => { idleWaiters.push(r); });
}

// ── 媒体会话 pin（听课整堂课持有，段间不清）──────────────────
export function pinMediaSession(meta: MediaMeta): void {
  claimAudioFocus('speech');
  pinned = true;
  try { getPlayer().setActiveForLockScreen(true, meta); } catch {}
}
export function unpinMediaSession(): void {
  pinned = false;
  if (!session) { try { player?.clearLockScreenControls(); } catch {} }
}

function newSession(msgId: string): Session {
  claimAudioFocus('speech');
  stop();
  sessionSeq += 1;
  const st: Session = { controller: new AbortController(), msgId, jobs: [], idx: 0, streaming: false, waiting: false };
  session = st;
  ensureWatchdog();
  return st;
}

/** 朗读一条完整消息（已切块）：并行合成落盘、从首块开始按序播。 */
export function speakChunks(msgId: string, chunks: string[], creds: VoiceCreds, voice: string, meta: MediaMeta): void {
  const st = newSession(msgId);
  setState({ msgId, status: 'preparing' });
  try { getPlayer().setActiveForLockScreen(true, meta); } catch {}
  const seq = sessionSeq;
  st.jobs = chunks.map((text, i) => fetchChunkFile(`s${seq}_${i}.wav`, {
    synthesize: (signal) => synthesizeChunk(creds, text, voice, signal),
    cache: cacheAudio, remove: removeAudio, signal: st.controller.signal,
  }, FETCH_TIMEOUT_MS));
  playChunk(0);
}

/** 流式边生成边合成：onText 反复喂入完整文本，每凑够整句立即合成入队，首句在模型还在生成后文时就出声。 */
export function startStreamingSpeech(
  creds: VoiceCreds,
  voice: string,
  meta: MediaMeta,
): { onText: (full: string) => void; finish: (full: string, realMsgId?: string) => void } {
  const st = newSession('_stream');
  st.streaming = true;
  setState({ msgId: '_stream', status: 'preparing' });
  try { getPlayer().setActiveForLockScreen(true, meta); } catch {}
  const seq = sessionSeq;
  let cursor = 0;   // 已切句到 full 的位置
  let pending = ''; // 已清洗、未达发送阈值的累积文本

  const enqueue = (text: string) => {
    if (session !== st || !text) return;
    st.jobs.push(fetchChunkFile(`s${seq}_${st.jobs.length}.wav`, {
      synthesize: (signal) => synthesizeChunk(creds, text, voice, signal),
      cache: cacheAudio, remove: removeAudio, signal: st.controller.signal,
    }, FETCH_TIMEOUT_MS));
    if (st.waiting) { st.waiting = false; playChunk(st.idx); } // 唤醒等待中的播放指针
    else if (st.jobs.length === 1) playChunk(0); // 首块启动
  };
  const drain = (full: string, flush: boolean) => {
    if (session !== st) return;
    let end = -1;
    for (let k = full.length - 1; k >= cursor; k--) {
      if ('。！？.!?\n'.includes(full[k])) { end = k; break; }
    }
    const upto = flush ? full.length : end + 1;
    if (upto > cursor) {
      pending = `${pending} ${prepareForSpeech(full.slice(cursor, upto))}`.replace(/\s+/g, ' ').trim();
      cursor = upto;
    }
    // 首块、或播放饥饿（waiting）时：任何就绪整句立即发，最小化空档；有缓冲时攒到 60 字减少请求数
    const limit = st.jobs.length === 0 || st.waiting ? 1 : 60;
    if (pending && (flush || pending.length >= limit)) {
      const text = pending;
      pending = '';
      enqueue(text);
    }
  };

  return {
    onText: (full) => drain(full, false),
    finish: (full, realMsgId) => {
      if (session !== st) return;
      drain(full, true);
      st.streaming = false;
      if (realMsgId) {
        st.msgId = realMsgId;
        if (state) setState({ msgId: realMsgId, status: state.status });
      }
      // 已播完且没有更多待播 → 结束
      if (st.waiting && st.idx >= st.jobs.length) endSession();
    },
  };
}
