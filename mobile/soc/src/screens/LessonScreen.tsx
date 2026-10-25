import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator, Animated, FlatList, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { GlassPanel, GlowLayer, GradientButton, GradientFab, PulseDot, SpeakWave, glassShadow, useKeyboardHeight, useTabBarHeight } from '../components/Glass';
import { TypingDots } from '../components/TypingDots';
import { PhaseFade, VoiceOrb } from '../components/VoiceOrb';
import * as data from '../data';
import type { ChatMessage, LlmProfile, TextbookEntry } from '../data';
import { LessonContext, listTeachers } from '../lesson';
import * as session from '../lessonSession';
import type { Companion } from '../data';
import Markdown from '../Markdown';
import * as lecture from '../speech/lecture';
import * as speech from '../speech/player';
import { useVoiceCapture } from '../stt';
import { accentGrad, font, Ink, motion, radius, space, tnum, type_, useTheme } from '../theme';
import { Busy, ErrorNote } from '../ui';
import { chunkForSpeech, getCompanionVoice, prepareForSpeech, resolveVoiceCreds } from '../voice';
import { claimAudioFocus, registerAudioFocus } from '../audioFocus';

type Props = {
  onListen: () => void;
  worldId: string | null;
  textbook: TextbookEntry | null;
  profile: LlmProfile | null;
  onEnded: (convId: string) => void; // 下课成功后切到闪卡做课后小测
};

// ── 精力条（桌面端「电量」复刻）──────────────────────────────
// 反映本节课累积的算力消耗：满格 10，越聊越少。移动端无真实 token，
// 用本课对话累计字符数估算（满格≈1.5h≈这个上限），可按真机体感调。
const ENERGY_CHAR_LIMIT = 18000;
// 伙伴心声（index = 当前格数 0..10），文案原样取自桌面端
const ENERGY_THOUGHTS = [
  '（已经……阵亡了……但你还要学我就奉陪……）',
  '（大脑正在发出关机警告……再坚持一下下？）',
  '（眼皮在造反……掐一下人中，撑住！）',
  '（要不要偷偷打个哈欠……不行，忍住。）',
  '（开始有点上头了……不是知识，是困意。）',
  '（精力还行，但如果有杯咖啡就完美了。）',
  '（过半了啊。时间比想象中快……）',
  '（进入状态了……这种感觉，不讨厌。）',
  '（嗯，节奏刚刚好，继续继续。）',
  '（状态不错，脑子转得挺快的嘛。）',
  '（满血复活！今天要大干一场——）',
];
const ENERGY_DIALOG = '精力条反映的是本节课累积的算力消耗。满格大约对应一个半小时的学习——这也是我们建议每节课的时长。尽管 Socratopia 完全支持你在耗尽精力条后继续无限学习，但为了让教学进度和伙伴记忆系统保持最佳状态，我们强烈建议在精力条清空前点击「下课」。如果你想继续学习，不妨稍事休息后开启新课——伙伴们会记得你这节课的进度。';

function energyLevel(messages: { content: string }[]): number {
  const chars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  return Math.max(0, 10 - Math.floor((chars / ENERGY_CHAR_LIMIT) * 10));
}

// 计时 hook（每秒刷新，m:ss / h:mm:ss）
function useElapsed(startISO?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startISO) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startISO]);
  if (!startISO) return '0:00';
  const total = Math.max(0, Math.floor((now - Date.parse(startISO)) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// 新消息 spring 进场（透明度 + 轻位移 + 微缩放）。active=false 时静态渲染（旧消息不重复动画）。
function Rise({ active, children }: { active: boolean; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(active ? 0 : 1)).current;
  useEffect(() => {
    if (active) Animated.spring(v, { toValue: 1, ...motion.springLight, useNativeDriver: true }).start();
  }, []);
  if (!active) return <>{children}</>;
  return (
    <Animated.View style={{
      opacity: v,
      transform: [
        { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
        { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
      ],
    }}>
      {children}
    </Animated.View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

// 消息行 memo 化：流式打字、计时器秒跳、播报状态变化都不再让旧行重跑 Markdown 解析
const MsgRow = React.memo(function MsgRow({ item, active, playing, busy, voiceAvailable, onSpeak, s, ink }: {
  item: ChatMessage; active: boolean; playing: boolean; busy: boolean;
  voiceAvailable: boolean; onSpeak: (m: ChatMessage) => void; s: Styles; ink: Ink;
}) {
  const node = item.role === 'user' ? (
    <LinearGradient colors={accentGrad} start={{ x: 0.15, y: 0 }} end={{ x: 0.85, y: 1 }} style={s.userBubble}>
      <Text style={s.userText}>{item.content}</Text>
    </LinearGradient>
  ) : (
    <GlassPanel tone="bubble" rounded={radius.bubble} style={s.aiBubble} contentStyle={s.bubblePad}>
      {/* 朗读放气泡顶部：长回复不用翻到底才能点 */}
      {voiceAvailable ? (
        <Pressable onPress={() => onSpeak(item)} hitSlop={10} style={s.speakBtn}>
          {playing ? <SpeakWave color={ink.accent} label="朗读中" /> : <Text style={s.speakText}>{busy ? '合成…' : '▷ 朗读'}</Text>}
        </Pressable>
      ) : null}
      <Markdown text={item.content} />
    </GlassPanel>
  );
  // 只有最新一条 spring 进场（旧消息静态，避免滚动时重复动画）
  return <Rise active={active}>{node}</Rise>;
});

// 流式气泡：单独订阅 lecture 快通道，100ms 的流式跳动只重渲染这一个组件（挂 ListFooter）
function StreamBubble({ s, ink }: { s: Styles; ink: Ink }) {
  const text = useSyncExternalStore(lecture.subscribeStream, lecture.getStreamText);
  if (!text) return null;
  return (
    <GlassPanel tone="bubble" rounded={radius.bubble} style={s.aiBubble} contentStyle={s.bubblePad}>
      {text.trim() ? <Text style={s.streamText}>{text}</Text> : <TypingDots color={ink.muted} />}
    </GlassPanel>
  );
}

// 语音模式里的流式字幕：同样走快通道，不带动整个 modal 之外的屏
function VoiceStreamPreview({ s }: { s: Styles }) {
  const text = useSyncExternalStore(lecture.subscribeStream, lecture.getStreamText);
  if (!text.trim()) return null;
  return <Text style={s.voiceStream} numberOfLines={4}>{prepareForSpeech(text)}</Text>;
}

export default function LessonScreen({ worldId, textbook, profile, onEnded, onListen }: Props) {
  const { ink, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const tabBarH = useTabBarHeight();
  const s = useMemo(() => makeStyles(ink), [ink]);
  // 课程会话（ctx / 未下课指针 / 备课-下课忙碌态）在模块级引擎里，本组件只订阅
  const ses = useSyncExternalStore(session.subscribe, session.getState);
  const { ctx, pending, busy, pointerReady, pointerError } = ses;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [input, setInput] = useState('');
  const [reading, setReading] = useState<{ startPage: number; endPage: number; body: string } | null>(null);
  const [showReading, setShowReading] = useState(false);
  const [showEnergy, setShowEnergy] = useState(false);
  const listRef = useRef<FlatList>(null);
  const elapsed = useElapsed(ctx?.startedAt);
  const opener = useRef<string | null>(null);
  // 键盘弹出/收起时把最新消息滚到可见
  useEffect(() => {
    if (kb) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
  }, [kb]);

  // 语音朗读 + 听课循环都在模块级引擎里（src/speech/），不随本组件卸载而死：
  // 切 tab / 息屏时播放与循环继续，这里只订阅状态渲染 UI。
  const lec = useSyncExternalStore(lecture.subscribe, lecture.getState);
  const sp = useSyncExternalStore(speech.subscribe, speech.getState);
  const turnBusy = lec.turnActive; // 有回合进行中；流式文本走 StreamBubble 的快通道，不进本组件
  const lecturing = lec.lecturing;
  const playingId = sp?.status === 'playing' ? sp.msgId : null;
  const voiceBusyId = sp?.status === 'preparing' ? sp.msgId : null;
  useEffect(() => { speech.ensureAudioMode(); }, []);
  const lockMeta = () => ({ title: ctx ? `听课 · 第 ${ctx.windowStart}-${ctx.windowEnd} 页` : '听课', artist: ctx?.companion.name ?? 'Socratopia', albumTitle: ctx?.textbook.title });
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const atBottom = useRef(true);          // 用户是否贴着底部：只有贴底才自动滚到底，上滑读旧内容时不打扰
  const [navH, setNavH] = useState(64);   // 实测导航卡高度（精力条并入后高度不固定，避免 pill 盖住）
  const [pillH, setPillH] = useState(34); // 实测上下文胶囊高度
  // 消息列表：流式气泡不再混进 data（走 ListFooter），rev 变化（消息增删落定）才重建
  const messages = useMemo(
    () => (ctx ? ctx.chat.messages.filter((m) => !(m.role === 'user' && (m.content === '给我讲课' || m.content === '继续讲下一页'))) : []),
    [ctx, lec.rev],
  );

  // 是否配了 Qwen/DashScope（决定朗读按钮显隐），随服务器连接状态刷新
  useEffect(() => {
    resolveVoiceCreds().then((c) => setVoiceAvailable(!!c)).catch(() => setVoiceAvailable(false));
  }, [profile, worldId]);

  // 朗读一条消息：再次点同一条则停；否则切句交给播放引擎（并行合成落盘、按序播）
  async function onSpeak(msg: ChatMessage) {
    if (!ctx) return;
    if (sp?.msgId === msg.id) { speech.stop(); return; }
    setError('');
    try {
      const creds = await resolveVoiceCreds();
      if (!creds) throw new Error('未配置 Qwen / DashScope，无法朗读');
      const voice = await getCompanionVoice(ctx.worldId, ctx.companion);
      const chunks = chunkForSpeech(msg.content);
      if (!chunks.length) throw new Error('这条消息没有可朗读的内容');
      speech.speakChunks(msg.id, chunks, creds, voice, lockMeta());
    } catch (e: any) {
      setError(String(e.message));
    }
  }
  // 给 memo 行的稳定引用（onSpeak 每次 render 重建会击穿 React.memo）
  const onSpeakRef = useRef(onSpeak);
  onSpeakRef.current = onSpeak;
  const handleSpeak = useCallback((m: ChatMessage) => { onSpeakRef.current(m); }, []);

  // 开始页交接卡数据（上次伙伴 / 读到页 / 上次聊到 / 预计起始页）
  const [hand, setHand] = useState<{
    companionName: string; companionColor?: string; endingPage: number;
    lastAssistant?: string; lastUser?: string;
  } | null>(null);
  const [startPage, setStartPage] = useState<number | null>(null);
  // 开课前的老师选择：列出本世界可选老师 + 当前选中的 slot（默认沿用上次交接的老师）
  const [teachers, setTeachers] = useState<{ slot: string; companion: NonNullable<Companion> }[]>([]);
  const [chosenSlot, setChosenSlot] = useState<string | null>(null);

  // 语音对话模式：免手循环（听→识别→发→AI 流式朗读→说完再听），点按可打断
  const capture = useVoiceCapture();
  const voiceActive = useRef(false);
  const voiceAbort = useRef<AbortController | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voicePhase, setVoicePhase] = useState<'listening' | 'recognizing' | 'responding'>('listening');
  const [voiceLevel, setVoiceLevel] = useState(0); // 0..1 听者音量，给动效
  const [voiceErr, setVoiceErr] = useState('');
  // 卸载时只停语音对话循环（录音依赖本组件的 recorder hook）；
  // 朗读与听课在模块级引擎里，切 tab 卸载本组件也继续播、继续讲——不要在这里停它们。
  useEffect(() => () => { voiceActive.current = false; voiceAbort.current?.abort(); capture.cancel(); }, []);
  useEffect(() => registerAudioFocus('speech', () => {
    voiceActive.current = false; voiceAbort.current?.abort(); capture.cancel(); setVoiceOn(false);
  }), []);

  // 重进 app 时检查有没有未下课的课（桌面版同规则：没下课不能开新课）
  useEffect(() => {
    if (!ctx) session.refreshPending();
  }, [ctx]);

  // 空闲时装载交接卡
  useEffect(() => {
    if (ctx || !worldId || !textbook) return;
    let cancelled = false;
    (async () => {
      try {
        const [handoff, progressMd, meta, preface] = await Promise.all([
          data.readHandoff(worldId, textbook),
          data.readProgress(worldId, textbook),
          data.readWorldMeta(worldId).catch(() => null),
          data.readPreface(worldId, textbook),
        ]);
        if (cancelled) return;
        const progressPage = data.parseProgressPage(progressMd) ?? textbook.currentPage;
        setStartPage(progressPage > 0 ? progressPage + 1 : preface?.contentStartPage || 1);
        // 老师列表 + 默认选中（上次交接的老师，否则第一个）
        const ts = (meta?.companions || [])
          .map((c, i) => ({ slot: ['npc_a', 'npc_b', 'npc_c'][i], companion: c }))
          .filter((x): x is { slot: string; companion: NonNullable<Companion> } => !!x.companion);
        setTeachers(ts);
        const def = (handoff.meta?.companionSlot && ts.some((t) => t.slot === handoff.meta!.companionSlot))
          ? handoff.meta.companionSlot : ts[0]?.slot ?? null;
        setChosenSlot((prev) => prev && ts.some((t) => t.slot === prev) ? prev : def);
        if (handoff.meta) {
          const slotIdx = { npc_a: 0, npc_b: 1, npc_c: 2 }[handoff.meta.companionSlot] ?? 0;
          const tail = handoff.tail?.messages || [];
          const lastAssistant = [...tail].reverse().find((m) => m.role === 'assistant')?.content;
          const lastUser = [...tail].reverse().find((m) => m.role === 'user')?.content;
          setHand({
            companionName: handoff.meta.companionName,
            companionColor: meta?.companions[slotIdx]?.color,
            endingPage: handoff.meta.endingPage,
            lastAssistant,
            lastUser,
          });
        } else {
          setHand(null);
        }
      } catch { /* 交接卡是增强信息，加载失败不挡上课 */ }
    })();
    return () => { cancelled = true; };
  }, [ctx, worldId, textbook]);

  async function onStart(openerText?: string) {
    if (!worldId || !textbook) return;
    claimAudioFocus('speech');
    setError('');
    setNotice('');
    try {
      opener.current = openerText || null;
      await session.start(worldId, textbook, chosenSlot ?? undefined);
      setReading(null);
    } catch (e: any) {
      opener.current = null;
      setError(String(e.message));
    }
  }

  // 开场建议：开课后自动把这句发出去
  useEffect(() => {
    if (ctx && opener.current && profile && !ctx.chat.messages.length) {
      const text = opener.current;
      opener.current = null;
      sendMessage(ctx, text);
    }
  }, [ctx, profile]);

  async function onResume() {
    if (!pending) return;
    setError('');
    setNotice('');
    try {
      await session.resume();
      setReading(null);
    } catch (e: any) {
      // 课程文件已不在（如被桌面端清理），引擎已清掉指针、允许放弃这节课
      setError(`恢复失败：${e.message}`);
    }
  }

  // 发一个回合：流式节流、错误回滚、可选边生成边朗读全在 lecture 引擎里
  async function sendMessage(c: LessonContext, text: string, forceAutoplay = false, signal?: AbortSignal) {
    if (!profile) return false;
    setError('');
    return lecture.runTurn({ ctx: c, profile }, text, { speak: (autoplay || forceAutoplay) && voiceAvailable, signal });
  }

  function onSend() {
    if (!ctx || !input.trim()) return;
    lecture.stopLecture();
    const text = input.trim();
    setInput('');
    sendMessage(ctx, text);
  }

  // 一键听课：交给 lecture 引擎连续讲课（媒体会话整堂课保持，息屏/切 tab 不断）
  function onSocraTeach() {
    if (!ctx || !profile) return;
    if (lecturing) { lecture.stopLecture(); return; } // 进行中 → 停止
    if (turnBusy) return;
    setAutoplay(true);
    lecture.startLecture({ ctx, profile });
  }

  async function voiceTurn() {
    if (!voiceActive.current || !ctx) return;
    setVoicePhase('listening');
    setVoiceLevel(0);
    let text = '';
    try {
      text = await capture.listen((v) => setVoiceLevel(v), () => setVoicePhase('recognizing'));
    } catch (e: any) {
      setVoiceErr(String(e.message));
      voiceActive.current = false;
      return;
    }
    if (!voiceActive.current) return;
    if (!text.trim()) { voiceTurn(); return; } // 没听到内容，继续听
    setVoiceErr('');
    setVoicePhase('responding');
    const ac = new AbortController();
    voiceAbort.current = ac;
    const ok = await sendMessage(ctx, text.trim(), true, ac.signal);
    voiceAbort.current = null;
    if (!voiceActive.current) return;
    if (ok) await speech.waitUntilIdle(); // 等本轮朗读真正播完（被打断时 stop 会立即放行）
    if (!voiceActive.current) return;
    voiceTurn(); // 进入下一轮
  }

  function startVoiceMode() {
    if (!ctx || !profile) return;
    claimAudioFocus('speech');
    lecture.stopLecture(); // 与连续听课互斥
    setVoiceErr('');
    setVoiceOn(true);
    voiceActive.current = true;
    voiceTurn();
  }

  // 打断：AI 说话时点一下 → 中止本轮 + 停朗读；运行中的循环会自然进入下一轮听（不另开循环）
  function interruptVoice() {
    if (!voiceActive.current || voicePhase !== 'responding') return;
    voiceAbort.current?.abort();
    speech.stop();
  }

  function exitVoiceMode() {
    voiceActive.current = false;
    voiceAbort.current?.abort();
    capture.cancel();
    speech.stop();
    setVoiceOn(false);
  }

  // 继续讲下一页：手动推进一页（停掉自动连续，切手动单步）
  function onNextPage() {
    if (!ctx || turnBusy) return;
    lecture.stopLecture();
    sendMessage(ctx, '继续讲下一页');
  }

  async function onEnd() {
    if (!ctx || !profile) return;
    setError('');
    try {
      const { convId, endingPage } = await session.end(profile); // 引擎内先停听课/朗读再跑课后管线
      setNotice(`下课完成：进度推进到第 ${endingPage} 页，闪卡与群聊复盘已生成。`);
      onEnded(convId); // 切到闪卡做本课课后小测
    } catch (e: any) {
      setError(`下课失败：${e.message}`);
    }
  }

  async function openReading() {
    if (!ctx) return;
    if (!reading) setReading(await data.readCurrentReading(ctx.worldId, ctx.chat.id));
    setShowReading(true);
  }

  if (!ctx) {
    const openers = [
      '继续上次的进度',
      ...(hand ? ['先复习上次的结论再继续'] : []),
      '这部分多举几个例子讲',
    ];
    const showDock = !!(textbook || pending);
    return (
      <View style={s.root}>
        <GlowLayer />
        <ErrorNote text={pointerError || error} />
        {pointerError ? <Pressable accessibilityRole="button" accessibilityLabel="重试课程状态" onPress={() => { setError(''); void session.refreshPending(); }}><Text style={{ color: ink.accent, textAlign: 'center', padding: 12 }}>重试</Text></Pressable> : null}
        {busy ? <Busy text={busy} /> : null}
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 18, paddingBottom: showDock ? 96 : 24 }}>
          <View style={{ paddingTop: insets.top + 10, paddingBottom: 12 }}>
            <Text style={s.startBook} numberOfLines={1}>
              {textbook ? `《${textbook.title}》` : '先在「教材」里选一本'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={s.startTitle}>准备上课</Text>
              {textbook ? <Pressable accessibilityRole="button" accessibilityLabel="听这本教材" onPress={onListen} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }}><Text style={{ color: ink.accent, fontFamily: font.med }}>听书</Text></Pressable> : null}
            </View>
          </View>

          {notice ? (
            <View style={s.noticeCard}><Text style={s.noticeText}>{notice}</Text></View>
          ) : null}

          {pending ? (
            <Text style={s.startMeta}>有一节课还没下课，先继续上完才能开新课。</Text>
          ) : textbook ? (
            <View style={{ gap: space(2) }}>
              {/* 交接玻璃卡 */}
              {hand ? (
                <GlassPanel tone="bubble" rounded={24} contentStyle={s.handCard}>
                  <View style={s.handTop}>
                    <Avatar name={hand.companionName} color={hand.companionColor} size={42} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.handLabel}>上次和</Text>
                      <Text style={s.handName}>{hand.companionName}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={s.handPage}>{hand.endingPage}</Text>
                      <Text style={s.handPageSub}>读到 / {textbook.numPages}页</Text>
                    </View>
                  </View>
                  {hand.lastAssistant || hand.lastUser ? (
                    <>
                      <View style={s.handDiv} />
                      <Text style={s.handTopicLabel}>上次聊到</Text>
                      {hand.lastAssistant ? (
                        <Text style={s.handQuote} numberOfLines={2}>
                          「{hand.lastAssistant.replace(/\*[^*]*\*/g, '').trim().slice(0, 60)}」
                        </Text>
                      ) : null}
                      {hand.lastUser ? (
                        <Text style={s.handReply} numberOfLines={1}>
                          — 你当时说：{hand.lastUser.slice(0, 40)}
                        </Text>
                      ) : null}
                    </>
                  ) : null}
                </GlassPanel>
              ) : (
                <Text style={s.startMeta}>新的开始——这本书还没有上过课。</Text>
              )}

              {/* 老师选择：本世界有多位老师时可换人上课（默认沿用上次的老师） */}
              {teachers.length > 1 ? (
                <View>
                  <Text style={s.openerLabel}>选择老师</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.teacherRow}>
                    {teachers.map((t) => {
                      const on = t.slot === chosenSlot;
                      return (
                        <Pressable key={t.slot} onPress={() => setChosenSlot(t.slot)} style={[s.teacherChip, on && s.teacherChipOn]}>
                          <Avatar name={t.companion.name} color={t.companion.color} size={34} />
                          <Text style={[s.teacherName, on && s.teacherNameOn]} numberOfLines={1}>{t.companion.name}</Text>
                          {on ? <View style={s.teacherDot} /> : null}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : null}

              {/* 开场建议 */}
              <View>
                <Text style={s.openerLabel}>从这里开场</Text>
                <View style={{ gap: space(1) }}>
                  {openers.map((o) => (
                    <Pressable
                      key={o}
                      onPress={() => onStart(o)}
                      disabled={!!busy || !profile || !pointerReady}
                      style={({ pressed }) => [pressed && { opacity: 0.7 }, (!!busy || !profile || !pointerReady) && { opacity: 0.5 }]}
                    >
                      <GlassPanel tone="bubble" rounded={16} contentStyle={s.openerInner}>
                        <Text style={s.openerText}>{o}</Text>
                        <Text style={s.openerArrow}>→</Text>
                      </GlassPanel>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          ) : null}
          {!profile ? <Text style={[s.startMeta, { textAlign: 'center', marginTop: space(2) }]}>先到「设置」里连接服务器并选择 LLM</Text> : null}
        </ScrollView>

        {/* 底部上课玻璃坞 */}
        {showDock ? (
          <View style={[s.startDock, { bottom: 16 }, glassShadow(ink, isDark)]}>
            <GradientButton
              height={54}
              rounded={18}
              onPress={pending ? onResume : () => onStart()}
              disabled={!!busy || !profile || !pointerReady}
              label={!pointerReady && !pointerError ? '读取中…' : busy ? (pending ? '正在恢复…' : '正在备课…') : pending ? '继续上课' : '上课'}
              sub={!pending && startPage && !busy ? `从 p.${startPage}` : undefined}
            />
          </View>
        ) : null}
      </View>
    );
  }

  const navTop = insets.top + 4;
  const lift = kb > 0 ? Math.max(0, kb - tabBarH) : 0; // 键盘上方所需抬升（扣掉 tab bar 占位）
  const energy = energyLevel(ctx.chat.messages);
  const energyColor = energy >= 6 ? ink.green : energy >= 3 ? ink.streak : ink.red;
  return (
    <View style={s.root}>
      <GlowLayer />
      <FlatList
        ref={listRef}
        data={messages}
        style={{ flex: 1, marginTop: navTop + navH + pillH + 16 }}
        keyExtractor={(m) => m.id}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => { if (atBottom.current) listRef.current?.scrollToEnd({ animated: false }); }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 86 + lift, gap: 10 }}
        renderItem={({ item, index }) => (
          <MsgRow
            item={item}
            active={index === messages.length - 1}
            playing={playingId === item.id}
            busy={voiceBusyId === item.id}
            voiceAvailable={voiceAvailable}
            onSpeak={handleSpeak}
            s={s}
            ink={ink}
          />
        )}
        ListFooterComponent={<StreamBubble s={s} ink={ink} />}
        ListEmptyComponent={
          <Text style={s.hint}>交接已就绪。说一句话开始这节课，比如「继续上次的进度」。</Text>
        }
      />

      {/* 悬浮玻璃导航：头像 + 伙伴名 + 在线点 + 下课 */}
      <GlassPanel rounded={radius.nav} style={[s.nav, { top: navTop }, glassShadow(ink, isDark)]} contentStyle={s.navInner} onLayout={(e) => setNavH(e.nativeEvent.layout.height)}>
        <View style={s.navRow}>
          <Avatar name={ctx.companion.name} color={ctx.companion.color} size={30} />
          <View style={{ flex: 1, minWidth: 0, marginLeft: 9 }}>
            <Text style={s.coName} numberOfLines={1}>{ctx.companion.name}</Text>
            <View style={s.onlineRow}>
              <PulseDot color={ink.green} size={5} period={2200} />
              <Text style={s.onlineTxt}>苏格拉底式</Text>
            </View>
          </View>
          {/* 精力环：满格 10、越聊越少；环色随余量变化，点开看说明 */}
          <Pressable onPress={() => setShowEnergy(true)} hitSlop={8} style={[s.energyRing, { borderColor: energyColor }]}>
            <Text style={[s.energyRingNum, { color: energyColor }]}>{energy}</Text>
          </Pressable>
          <Pressable onPress={onEnd} disabled={!!busy || turnBusy} hitSlop={6} style={({ pressed }) => [s.endBtn, pressed && { transform: [{ scale: 0.92 }] }]}>
            <Text style={s.endTxt}>下课</Text>
          </Pressable>
        </View>
      </GlassPanel>

      {/* 悬浮上下文胶囊：页码 · 计时（暖点脉动）· 自动朗读 · 看原文 */}
      <GlassPanel rounded={15} style={[s.pill, { top: navTop + navH + 6 }, glassShadow(ink, isDark)]} contentStyle={s.pillInner} onLayout={(e) => setPillH(e.nativeEvent.layout.height)}>
        <Pressable style={s.pillPress} onPress={openReading} hitSlop={4}>
          <Text style={s.ctxPage}>p.{ctx.windowStart}–{ctx.windowEnd}</Text>
          <View style={s.ctxDiv} />
          <PulseDot color={ink.streak} size={6} period={1400} />
          <Text style={s.ctxTimer}>{elapsed}</Text>
          <View style={{ flex: 1 }} />
          {voiceAvailable ? (
            <Pressable onPress={() => setAutoplay((v) => !v)} hitSlop={8}>
              <Text style={[s.ctxAuto, autoplay && s.ctxAutoOn]}>自动朗读</Text>
            </Pressable>
          ) : null}
          <Text style={s.ctxRead}>看原文 ▾</Text>
        </Pressable>
      </GlassPanel>

      {/* 下课/备课等 >2s 操作：居中玻璃浮层 + 暗背景，不再把状态文字压在聊天上 */}
      <Modal visible={!!busy} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={s.busyBackdrop}>
          <GlassPanel rounded={20} intensity={70} style={glassShadow(ink, isDark)} contentStyle={s.busyCard}>
            <ActivityIndicator color={ink.accent} />
            <Text style={s.busyCardText}>{busy || '处理中…'}</Text>
          </GlassPanel>
        </View>
      </Modal>

      {/* 报错：顶部实色卡片，不透字、带阴影、点一下消除（本地错误 + 引擎回合错误） */}
      {error || lec.error ? (
        <Pressable
          onPress={() => { setError(''); lecture.clearError(); }}
          style={[s.errToast, { top: navTop + navH + pillH + 16 }, glassShadow(ink, isDark)]}
        >
          <Text style={s.errToastText}>{error || lec.error}</Text>
          <Text style={s.errToastClose}>×</Text>
        </Pressable>
      ) : null}

      {/* 悬浮输入坞：讲课控制单独一排，主输入行让输入框占满宽度（键盘弹出时整体抬到键盘上方） */}
      <GlassPanel rounded={radius.dock} style={[s.dock, { bottom: 14 + lift }, glassShadow(ink, isDark)]} contentStyle={s.dockInner}>
        {/* 二级动作：连续听课 / 翻页 */}
        <View style={s.dockTools}>
          <Pressable onPress={onSocraTeach} disabled={!lecturing && turnBusy} hitSlop={8} style={[s.toolChip, lecturing && s.toolChipStop]}>
            <Text style={[s.toolTxt, lecturing && s.toolTxtStop]}>{lecturing ? '■ 停止听课' : '▷ 听课'}</Text>
          </Pressable>
          <Pressable onPress={onNextPage} disabled={turnBusy} hitSlop={8} style={[s.toolChip, s.toolChipPlain]}>
            <Text style={[s.toolTxt, s.toolTxtPlain]}>下一页 →</Text>
          </Pressable>
        </View>
        {/* 主输入行：录音 + 输入框（占满宽度）+ 发送 */}
        <View style={s.dockMain}>
          {voiceAvailable ? (
            <Pressable onPress={startVoiceMode} disabled={turnBusy} hitSlop={8} style={({ pressed }) => [s.voiceBtn, pressed && { transform: [{ scale: 0.92 }] }]}>
              <Text style={s.voiceBtnTxt}>语音</Text>
            </Pressable>
          ) : null}
          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="说点什么…"
            placeholderTextColor={ink.muted}
            multiline
            editable={!turnBusy}
          />
          <GradientFab onPress={onSend} disabled={!input.trim() || turnBusy} />
        </View>
      </GlassPanel>

      {/* 看原文：玻璃底部抽屉 */}
      <Modal visible={showReading} animationType="slide" transparent onRequestClose={() => setShowReading(false)}>
        <Pressable style={s.sheetBackdrop} onPress={() => setShowReading(false)} />
        <GlassPanel rounded={28} intensity={80} style={s.sheet} contentStyle={s.sheetInner}>
          <View style={s.sheetHandle} />
          <Text style={s.sheetTitle}>《{ctx.textbook.title}》 p.{ctx.windowStart}–{ctx.windowEnd}</Text>
          <ScrollView style={{ flexGrow: 0, maxHeight: 380 }} contentContainerStyle={{ paddingBottom: 16 }}>
            <Text style={s.sheetBody}>{reading?.body || '正在载入原文…'}</Text>
          </ScrollView>
          <GradientButton label="收起" onPress={() => setShowReading(false)} height={44} rounded={14} style={{ marginTop: 14 }} />
        </GlassPanel>
      </Modal>

      {/* 精力条说明弹窗 */}
      <Modal visible={showEnergy} animationType="fade" transparent onRequestClose={() => setShowEnergy(false)}>
        <Pressable style={s.dialogBackdrop} onPress={() => setShowEnergy(false)}>
          <Pressable style={s.dialogCard} onPress={() => {}}>
            <Text style={s.dialogTitle}>精力</Text>
            <Text style={s.dialogBody}>{ENERGY_DIALOG}</Text>
            <GradientButton label="知道了" onPress={() => setShowEnergy(false)} height={44} rounded={14} style={{ marginTop: 16 }} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* 语音对话模式：全屏免手对话，点按打断 */}
      <Modal visible={voiceOn} animationType="slide" onRequestClose={exitVoiceMode}>
        <View style={s.voiceRoot}>
          <GlowLayer />
          <View style={[s.voiceHead, { paddingTop: insets.top + 14 }]}>
            <Avatar name={ctx.companion.name} color={ctx.companion.color} size={34} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={s.voiceCoName} numberOfLines={1}>{ctx.companion.name}</Text>
              <Text style={s.voiceCoSub}>语音对话 · 苏格拉底式</Text>
            </View>
          </View>

          <View style={s.voiceCenter}>
            <VoiceOrb phase={voicePhase} level={voiceLevel} />
            <PhaseFade k={voicePhase}>
              <Text style={s.voiceStatus}>
                {voicePhase === 'listening' ? '在听你说…' : voicePhase === 'recognizing' ? '识别中…' : 'AI 回应中'}
              </Text>
            </PhaseFade>
            {voicePhase === 'responding' ? <VoiceStreamPreview s={s} /> : null}
            {voiceErr ? <Text style={s.voiceErrTxt}>{voiceErr}</Text> : null}
          </View>

          <View style={[s.voiceFoot, { paddingBottom: insets.bottom + 20 }]}>
            <PhaseFade k={voicePhase}>
              {voicePhase === 'responding' ? (
                <Pressable onPress={interruptVoice} style={({ pressed }) => [s.interruptBtn, pressed && { opacity: 0.85 }]}>
                  <Text style={s.interruptTxt}>■ 打断</Text>
                </Pressable>
              ) : voicePhase === 'listening' ? (
                <Text style={s.voiceHintTxt}>说完停顿一下，会自动发送</Text>
              ) : null}
            </PhaseFade>
            <Pressable onPress={exitVoiceMode} style={({ pressed }) => [s.voiceExit, pressed && { opacity: 0.8 }]}>
              <Text style={s.voiceExitTxt}>结束对话</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.canvas },

  // —— 准备态 ——
  startBook: { fontFamily: font.med, fontSize: 11, letterSpacing: 0.5, color: ink.muted },
  startTitle: { fontFamily: font.black, fontSize: 31, letterSpacing: -0.6, color: ink.fg, marginTop: 2 },
  startMeta: { color: ink.muted, fontSize: type_.small, fontFamily: font.sans },
  noticeCard: { backgroundColor: ink.greenSoft, borderRadius: radius.xl, padding: space(2), marginBottom: space(2) },
  noticeText: { color: ink.green, fontSize: type_.small, lineHeight: 20, textAlign: 'center', fontFamily: font.sans },

  handCard: { padding: 16 },
  handTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  handLabel: { fontSize: 12, color: ink.muted, fontFamily: font.sans },
  handName: { fontFamily: font.bold, fontSize: 17, color: ink.fg, lineHeight: 21, letterSpacing: -0.2 },
  handPage: { fontFamily: font.extra, fontSize: 25, color: ink.accent, lineHeight: 26, ...tnum },
  handPageSub: { fontFamily: font.sans, fontSize: 10, color: ink.muted, marginTop: 2, ...tnum },
  handDiv: { height: StyleSheet.hairlineWidth, backgroundColor: ink.border, marginVertical: 13 },
  handTopicLabel: { fontFamily: font.med, fontSize: 10, letterSpacing: 0.8, color: ink.muted, marginBottom: 7 },
  handQuote: { fontSize: 13, lineHeight: 20, color: ink.fg, fontFamily: font.sans, marginBottom: 6 },
  handReply: { fontSize: 12.5, lineHeight: 19, color: ink.muted, fontFamily: font.sans },

  openerLabel: { fontFamily: font.med, fontSize: 10, letterSpacing: 0.8, color: ink.muted, marginBottom: 7, paddingLeft: 4 },

  // 老师选择横排
  teacherRow: { gap: 9, paddingHorizontal: 4, paddingVertical: 2 },
  teacherChip: {
    width: 74, alignItems: 'center', gap: 6, paddingVertical: 10, borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: ink.border, backgroundColor: ink.raised,
  },
  teacherChipOn: { borderWidth: 1.5, borderColor: ink.accent, backgroundColor: ink.accentSoft },
  teacherName: { fontFamily: font.med, fontSize: 11, color: ink.muted, maxWidth: 64 },
  teacherNameOn: { fontFamily: font.bold, color: ink.accent },
  teacherDot: { position: 'absolute', top: 7, right: 7, width: 7, height: 7, borderRadius: 4, backgroundColor: ink.accent },
  openerInner: {
    minHeight: 44, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  openerText: { fontSize: 13.5, color: ink.fg, fontFamily: font.sans },
  openerArrow: { color: ink.accent, fontFamily: font.med, fontSize: 15 },

  startDock: { position: 'absolute', left: 16, right: 16 },

  // —— 上课中：悬浮玻璃导航 ——
  nav: { position: 'absolute', left: 12, right: 12 },
  navInner: { paddingHorizontal: 11, paddingTop: 8, paddingBottom: 7 },
  navRow: { flexDirection: 'row', alignItems: 'center' },
  coName: { fontFamily: font.bold, fontSize: 14, color: ink.fg, letterSpacing: -0.2 },
  onlineRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  onlineTxt: { fontFamily: font.sans, fontSize: 10, color: ink.green },
  endBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 13, backgroundColor: ink.redSoft },
  endTxt: { fontFamily: font.med, fontSize: 12, color: ink.red },
  // 精力环（取代原来的长条精力条，省高度）：环色随余量变化，内显数字
  energyRing: { width: 32, height: 32, borderRadius: 16, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  // CJK 字体在 Android 有不对称 font padding，数字会沉到环中心偏下；关掉并锁行高才真居中
  energyRingNum: { fontFamily: font.extra, fontSize: 12.5, lineHeight: 14, includeFontPadding: false, ...tnum },

  // 悬浮上下文胶囊
  pill: { position: 'absolute', left: 12, right: 12 },
  pillInner: { paddingHorizontal: 12, paddingVertical: 7 },
  pillPress: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  ctxPage: { fontFamily: font.bold, fontSize: 12, color: ink.accent, ...tnum },
  ctxDiv: { width: 1, height: 11, backgroundColor: ink.border },
  ctxTimer: { fontFamily: font.sans, fontSize: 12, color: ink.fg, ...tnum },
  ctxAuto: { fontFamily: font.med, fontSize: 11, color: ink.muted },
  ctxAutoOn: { color: ink.accent, fontFamily: font.bold },
  ctxRead: { fontFamily: font.med, fontSize: 11, color: ink.accent },

  speakBtn: { alignSelf: 'flex-start', marginBottom: 6, paddingVertical: 2 },
  speakText: { fontFamily: font.med, fontSize: 11, color: ink.accent },
  // 与 Markdown 段落同字号/行高，流式收完切到 Markdown 时不跳行
  streamText: { fontSize: type_.body, color: ink.fg, lineHeight: 24, fontFamily: font.sans },

  // 气泡：AI 玻璃左上收角，我方 accent 渐变右上收角
  aiBubble: { alignSelf: 'flex-start', maxWidth: '90%', borderTopLeftRadius: 6 },
  bubblePad: { paddingHorizontal: 13, paddingVertical: 10 },
  userBubble: {
    alignSelf: 'flex-end', maxWidth: '82%', borderRadius: radius.bubble, borderTopRightRadius: 6,
    paddingHorizontal: 13, paddingVertical: 10,
  },
  userText: { fontSize: type_.body, color: '#fff', lineHeight: 21, fontFamily: font.sans },
  hint: { color: ink.muted, fontSize: type_.small, textAlign: 'center', marginTop: space(4), lineHeight: 20, fontFamily: font.sans },

  // 下课/备课居中浮层
  busyBackdrop: { flex: 1, backgroundColor: 'rgba(20,15,5,0.35)', alignItems: 'center', justifyContent: 'center', padding: 40 },
  busyCard: { paddingHorizontal: 26, paddingVertical: 22, alignItems: 'center', gap: 12, minWidth: 170 },
  busyCardText: { fontFamily: font.med, fontSize: type_.small, color: ink.fg, textAlign: 'center', lineHeight: 20 },

  // 报错顶部实色卡片
  errToast: {
    position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: ink.raised, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(220,38,38,0.3)',
  },
  errToastText: { flex: 1, color: ink.red, fontSize: type_.small, lineHeight: 19, fontFamily: font.sans },
  errToastClose: { color: ink.red, fontSize: 18, fontFamily: font.med, opacity: 0.6 },

  // 悬浮输入坞
  dock: { position: 'absolute', left: 12, right: 12, bottom: 14 },
  dockInner: { paddingHorizontal: 8, paddingTop: 7, paddingBottom: 7, gap: 7 },
  // 二级动作排（讲课控制）
  dockTools: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  toolChip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 34, paddingHorizontal: 13, borderRadius: 11, backgroundColor: ink.accentSoft },
  toolTxt: { fontFamily: font.med, fontSize: 12.5, color: ink.accent },
  toolChipStop: { backgroundColor: ink.redSoft },
  toolTxtStop: { color: ink.red },
  toolChipPlain: { backgroundColor: ink.sunken },
  toolTxtPlain: { color: ink.muted },
  // 主输入行
  dockMain: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  voiceBtn: { height: 40, paddingHorizontal: 13, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.accentSoft },
  voiceBtnTxt: { fontFamily: font.med, fontSize: 13, color: ink.accent },
  input: {
    flex: 1, maxHeight: 120, minHeight: 40, fontSize: type_.body, color: ink.fg, fontFamily: font.sans,
    backgroundColor: ink.sunken, borderRadius: 12, paddingHorizontal: 13,
    paddingTop: Platform.OS === 'ios' ? 11 : 8, paddingBottom: Platform.OS === 'ios' ? 11 : 8,
  },

  // 看原文玻璃抽屉
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(20,15,5,0.4)' },
  sheet: { position: 'absolute', left: 8, right: 8, bottom: 8, maxHeight: '85%' },
  sheetInner: { padding: 18, paddingBottom: 22 },
  sheetHandle: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: ink.border, marginBottom: 14 },
  sheetTitle: { fontFamily: font.med, fontSize: 12, color: ink.muted, marginBottom: 10, ...tnum },
  sheetBody: { fontFamily: font.sans, fontSize: 13, lineHeight: 22, color: ink.fg },

  // 精力条说明弹窗（居中）
  dialogBackdrop: { flex: 1, backgroundColor: 'rgba(20,15,5,0.45)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  dialogCard: {
    width: '100%', backgroundColor: ink.raised, borderRadius: 22, padding: 22,
    shadowColor: ink.shadow, shadowOpacity: 0.4, shadowRadius: 24, shadowOffset: { width: 0, height: 14 }, elevation: 12,
  },
  dialogTitle: { fontFamily: font.extra, fontSize: 18, color: ink.fg, marginBottom: 10 },
  dialogBody: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 22, color: ink.fg },

  // 语音对话全屏浮层
  voiceRoot: { flex: 1, backgroundColor: ink.canvas },
  voiceHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingBottom: 10 },
  voiceCoName: { fontFamily: font.bold, fontSize: 15, color: ink.fg, letterSpacing: -0.2 },
  voiceCoSub: { fontFamily: font.sans, fontSize: 11, color: ink.muted, marginTop: 2 },
  voiceCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 22 },
  voiceStatus: { fontFamily: font.extra, fontSize: 20, color: ink.fg, letterSpacing: -0.3 },
  voiceStream: { fontFamily: font.sans, fontSize: 14, lineHeight: 22, color: ink.muted, textAlign: 'center' },
  voiceErrTxt: { fontFamily: font.sans, fontSize: 13, color: ink.red, textAlign: 'center' },
  voiceFoot: { paddingHorizontal: 24, alignItems: 'center', gap: 14 },
  interruptBtn: { paddingHorizontal: 30, height: 52, borderRadius: 26, backgroundColor: ink.redSoft, alignItems: 'center', justifyContent: 'center' },
  interruptTxt: { fontFamily: font.bold, fontSize: 16, color: ink.red },
  voiceHintTxt: { fontFamily: font.sans, fontSize: 12, color: ink.muted },
  voiceExit: { paddingHorizontal: 20, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  voiceExitTxt: { fontFamily: font.med, fontSize: 14, color: ink.muted },
});
