import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Confetti } from '../components/Confetti';
import { Flame } from '../components/Flame';
import { GlassHeader, GlassPanel, GlowLayer, GradientButton } from '../components/Glass';
import * as data from '../data';
import { saveFlashcardAnswer } from '../flashcardReview';
import { sessionGuard } from '../accountScope';
import { dayStreakOf, localDay, nextBatchOf } from '../stats';
import { haptic } from '../haptics';
import { useResource } from '../hooks';
import { accentGrad, font, Ink, radius, space, tnum, type_, useTheme } from '../theme';
import { Busy, ErrorNote } from '../ui';

type DueCard = { card: data.Flashcard; file: data.FlashcardFile };
type FlashcardLoadResult = { picked: DueCard[]; files: data.FlashcardFile[] };

// 庆祝页的大火苗勋章（轻微漂浮）
function Medallion({ ink }: { ink: Ink }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 1500, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 1500, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={{
      width: 88, height: 88, borderRadius: 44, backgroundColor: ink.streakSoft,
      alignItems: 'center', justifyContent: 'center', marginBottom: 8,
      transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }],
    }}>
      <Flame size={42} color={ink.streak} />
    </Animated.View>
  );
}

export default function FlashcardsScreen(props: {
  worldId: string | null;
  quizConvId?: string | null;   // 设了则进入「课后小测」：只测这节课的新卡、不计入 SRS
  onExitQuiz?: () => void;
}) {
  const { worldId, quizConvId, onExitQuiz } = props;
  const quiz = !!quizConvId;
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const [queue, setQueue] = useState<DueCard[]>([]);
  const [cur, setCur] = useState<DueCard | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [answerError, setAnswerError] = useState(''); // answer() 写盘失败的动作错误
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const chosenRef = useRef<number | null>(null);
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; return () => { epoch.current++; }; }, [worldId, quizConvId]);
  const [streak, setStreak] = useState(0); // 本次复习的连对数，答错归零
  const [sessionDone, setSessionDone] = useState(0); // 本次已答张数
  const [sessionCorrect, setSessionCorrect] = useState(0); // 本次答对张数
  const [maxStreak, setMaxStreak] = useState(0); // 本次最高连对
  const filesRef = useRef<data.FlashcardFile[]>([]); // 庆祝页统计用（day streak / 下一批）
  const popScale = useRef(new Animated.Value(0)).current; // 答对：正确项弹一下
  const shakeX = useRef(new Animated.Value(0)).current; // 答错：错误项左右抖
  const explainY = useRef(new Animated.Value(0)).current; // 解析：上滑淡入

  // 资源加载：读取闪卡文件并筛选到期卡
  const { data: loadResult, busy, error: loadError, reload } = useResource<FlashcardLoadResult>(
    async () => {
      const ids = await data.listFlashcardFiles(worldId!);
      const files = await Promise.all(ids.map((id) => data.readFlashcards(worldId!, id)));
      const now = new Date().toISOString();
      const picked: DueCard[] = [];
      for (const f of files) {
        for (const c of f.cards) {
          if (c.status !== 'active') continue;
          if (quizConvId) {
            // 课后小测：只取本节课刚生成的卡（按到期与否，全测一遍）
            if (c.conversationId === quizConvId) picked.push({ card: c, file: f });
          } else if (!c.nextReview || c.nextReview <= now) {
            picked.push({ card: c, file: f });
          }
        }
      }
      if (!quizConvId) picked.sort((a, b) => (a.card.nextReview || '').localeCompare(b.card.nextReview || ''));
      return { picked, files };
    },
    [worldId, quizConvId],
    { enabled: !!worldId, busyText: '读取闪卡…' },
  );

  const error = loadError || answerError;

  // 新数据到达后重置会话状态并初始化队列
  useEffect(() => {
    if (!loadResult) return;
    epoch.current++;
    chosenRef.current = null;
    savingRef.current = false;
    setSaving(false);
    setAnswerError('');
    filesRef.current = loadResult.files;
    setQueue(loadResult.picked);
    setCur(loadResult.picked[0] || null);
    setChosen(null);
    setStreak(0);
    setSessionDone(0);
    setSessionCorrect(0);
    setMaxStreak(0);
    popScale.setValue(0); shakeX.setValue(0); explainY.setValue(0);
  }, [loadResult]);

  async function answer(i: number) {
    if (!worldId || !cur || chosenRef.current !== null || savingRef.current) return;
    const guard = sessionGuard();
    const currentEpoch = epoch.current;
    chosenRef.current = i;
    const correct = i === cur.card.correctIndex;
    setChosen(i);

    if (correct) {
      Animated.spring(popScale, { toValue: 1, friction: 5, useNativeDriver: true }).start();
      haptic.ok();
    } else {
      Animated.sequence([
        Animated.timing(shakeX, { toValue: 8, duration: 45, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: -8, duration: 45, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: 5, duration: 45, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: 0, duration: 45, useNativeDriver: true }),
      ]).start();
      haptic.bad();
    }
    Animated.timing(explainY, { toValue: 1, duration: 260, useNativeDriver: true }).start();

    const countAnswer = () => {
      setStreak((v) => {
        const nv = correct ? v + 1 : 0;
        if (nv > maxStreak) setMaxStreak(nv);
        return nv;
      });
      setSessionDone((n) => n + 1);
      if (correct) setSessionCorrect((n) => n + 1);
    };
    // Quiz answers are local; scheduled reviews count only after persistence.
    if (quiz) { countAnswer(); return; }
    savingRef.current = true;
    setSaving(true);
    setAnswerError('');
    try {
      await saveFlashcardAnswer(cur.file, cur.card, i, new Date(), (updated) => {
        guard();
        return data.writeFlashcards(worldId, updated);
      });
      guard();
      if (epoch.current === currentEpoch) countAnswer();
    } catch (e: unknown) {
      if (epoch.current === currentEpoch) setAnswerError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (epoch.current === currentEpoch) { savingRef.current = false; setSaving(false); }
    }
  }

  function next() {
    if (savingRef.current || saving || answerError || busy) return;
    chosenRef.current = null;
    popScale.setValue(0); shakeX.setValue(0); explainY.setValue(0); // 复位动画
    const rest = queue.slice(1);
    setQueue(rest);
    setCur(rest[0] || null);
    setChosen(null);
  }

  const answered = chosen !== null;
  const gotIt = cur && chosen === cur.card.correctIndex;
  const total = loadResult?.picked.length ?? 0;
  const pctDone = total ? Math.round((sessionDone / total) * 100) : 0;

  // 完成庆祝：本次答完了全部到期卡片
  if (!cur && !busy && sessionDone > 0) {
    const dayStreak = dayStreakOf(filesRef.current);
    const accuracy = Math.round((sessionCorrect / sessionDone) * 100);
    const batch = nextBatchOf(filesRef.current);
    const tomorrow = localDay(new Date(Date.now() + 86400000).toISOString());
    const batchDay = batch ? (batch.day === tomorrow ? '明天' : batch.day.slice(5).replace('-', '/')) : null;
    return (
      <View style={s.root}>
        <GlowLayer />
        <Confetti />
        <View style={s.cbWrap}>
          <Medallion ink={ink} />
          <Text style={s.cbStreakLabel}>{quiz ? '课后小测' : `DAY STREAK · ${dayStreak}`}</Text>
          <Text style={s.cbTitle}>{quiz ? '本课小测\n完成' : '今天的复习\n全部完成'}</Text>
          <Text style={s.cbSub}>
            {quiz
              ? `刚学的 ${sessionDone} 张过了一遍，\n明天会正式到期、计入复习。`
              : `${dayStreak > 1 ? `连续 ${dayStreak} 天没断过，` : '今天也坚持下来了，'}\n这些知识记得越来越牢了。`}
          </Text>
          <View style={s.cbStats}>
            <GlassPanel rounded={16} style={{ flex: 1 }} contentStyle={s.cbStat}>
              <Text style={[s.cbStatNum, { color: ink.fg }]}>{sessionDone}</Text>
              <Text style={s.cbStatLabel}>今日复习</Text>
            </GlassPanel>
            <GlassPanel rounded={16} style={{ flex: 1 }} contentStyle={s.cbStat}>
              <Text style={[s.cbStatNum, { color: ink.green }]}>{accuracy}%</Text>
              <Text style={s.cbStatLabel}>正确率</Text>
            </GlassPanel>
            <GlassPanel rounded={16} style={{ flex: 1 }} contentStyle={s.cbStat}>
              <Text style={[s.cbStatNum, { color: ink.streak }]}>×{maxStreak}</Text>
              <Text style={s.cbStatLabel}>最高连对</Text>
            </GlassPanel>
          </View>
        </View>
        <View style={s.cbFoot}>
          <Pressable onPress={quiz ? onExitQuiz : reload} style={({ pressed }) => [s.cbBtn, pressed && { opacity: 0.8 }]}>
            <Text style={s.cbBtnText}>{quiz ? '完成' : '明天见'}</Text>
          </Pressable>
          {!quiz && batch && batchDay ? (
            <Text style={s.cbNext}>下一批 {batch.count} 张 · {batchDay}到期</Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <GlowLayer />
      <GlassHeader>
        <View>
          <View style={s.fcHeadTop}>
            <Text style={s.fcTitle}>{quiz ? '课后小测' : '闪卡'}</Text>
            <View style={s.streakBox}>
              <Flame size={15} color={ink.streak} animate={streak > 0} />
              <Text style={s.streakLabel}>连对</Text>
              <Text style={s.streakNum}>{streak}</Text>
            </View>
          </View>
          <View style={s.progRow}>
            <View style={s.track}><View style={[s.fill, { width: `${pctDone}%` }]} /></View>
            <Text style={s.progTxt}>{sessionDone} / {total || 0}</Text>
          </View>
        </View>
      </GlassHeader>
      <ErrorNote text={error} />
      {busy ? <Busy text={busy} /> : null}
      {!cur && !busy ? (
        <View style={s.doneWrap}>
          <Text style={s.doneText}>{quiz ? '这节课没有生成可测的闪卡。' : '今天的复习做完了。'}</Text>
          <Pressable onPress={quiz ? onExitQuiz : reload} style={({ pressed }) => [s.refreshChip, pressed && { opacity: 0.7 }]}>
            <Text style={s.refreshTxt}>{quiz ? '完成' : '刷新'}</Text>
          </Pressable>
        </View>
      ) : null}
      {cur ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingTop: 12, gap: 9, paddingBottom: space(3) }}>
          <GlassPanel tone="bubble" rounded={18} contentStyle={s.qCardInner}>
            <Text style={s.source} numberOfLines={1}>
              {cur.card.source.textbook} · {cur.card.source.chapter}
            </Text>
            <Text style={s.question}>{cur.card.question}</Text>
          </GlassPanel>
          <View style={{ gap: 9 }}>
            {cur.card.choices.map((c, i) => {
              const isOk = answered && i === cur.card.correctIndex;
              const isBad = answered && i === chosen && i !== cur.card.correctIndex;
              const dim = answered && !isOk && !isBad;
              const anim = isOk
                ? { transform: [{ scale: popScale.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] }
                : isBad ? { transform: [{ translateX: shakeX }] } : null;
              return (
                <Animated.View key={i} style={[s.choice, isOk && s.choiceOk, isBad && s.choiceBad, dim && { opacity: 0.4 }, anim]}>
                  <Pressable style={s.choiceInner} onPress={() => answer(i)} disabled={answered}>
                    <View style={[s.keyDot, isOk && s.keyOk, isBad && s.keyBad]}>
                      <Text style={[s.keyTxt, (isOk || isBad) && { color: '#fff' }]}>{isOk ? '✓' : isBad ? '✕' : 'ABCD'[i]}</Text>
                    </View>
                    <Text style={[s.choiceTxt, isOk && { color: ink.green, fontFamily: font.bold }, isBad && { color: ink.red }]}>
                      {c}
                    </Text>
                  </Pressable>
                </Animated.View>
              );
            })}
          </View>
          {answered ? (
            <>
              <Animated.View style={[s.explain, {
                backgroundColor: gotIt ? ink.greenSoft : ink.redSoft,
                opacity: explainY,
                transform: [{ translateY: explainY.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
              }]}>
                <Text style={[s.explainTitle, { color: gotIt ? ink.green : ink.red }]}>
                  {gotIt ? (streak > 1 ? `答对了 · 连对 ×${streak}` : '答对了') : '再想想'}
                </Text>
                <Text style={s.explainTxt}>{cur.card.explanation}</Text>
                <Text style={s.nextReview}>下次复习 {cur.card.nextReview?.slice(0, 10)}</Text>
              </Animated.View>
              <GradientButton label={answerError ? '重试' : saving ? '保存中…' : queue.length > 1 ? '下一张' : '完成'} onPress={answerError ? reload : next} disabled={saving || !!busy} height={46} rounded={radius.lg} />
            </>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.canvas },
  fcHeadTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fcTitle: { fontFamily: font.black, fontSize: 26, letterSpacing: -0.5, color: ink.fg },
  streakBox: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 14, backgroundColor: ink.streakSoft,
  },
  streakLabel: { fontFamily: font.sans, fontSize: type_.xs, color: ink.streak },
  streakNum: { fontFamily: font.extra, fontSize: 18, lineHeight: 19, color: ink.streak, ...tnum },
  progRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 11 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: ink.sunken, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: ink.accent },
  progTxt: { fontFamily: font.med, fontSize: type_.xs, color: ink.muted, ...tnum },

  doneWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space(2) },
  doneText: { color: ink.muted, fontSize: type_.body, fontFamily: font.sans },
  refreshChip: { paddingHorizontal: 18, height: 40, borderRadius: 12, backgroundColor: ink.accentSoft, alignItems: 'center', justifyContent: 'center' },
  refreshTxt: { color: ink.accent, fontFamily: font.med, fontSize: type_.body },

  qCardInner: { padding: 16 },
  source: { fontSize: 10, color: ink.muted, fontFamily: font.med, letterSpacing: 0.4 },
  question: { fontSize: type_.lead, color: ink.fg, lineHeight: 23, fontFamily: font.med, marginTop: 7 },

  choice: { borderRadius: radius.lg, backgroundColor: ink.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: ink.glassBorder, overflow: 'hidden' },
  choiceOk: { borderWidth: 1.5, borderColor: ink.green, backgroundColor: ink.greenSoft },
  choiceBad: { borderWidth: 1.5, borderColor: ink.red, backgroundColor: ink.redSoft },
  choiceInner: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 13, paddingVertical: 12, minHeight: 48 },
  keyDot: { width: 25, height: 25, borderRadius: 12.5, backgroundColor: ink.sunken, alignItems: 'center', justifyContent: 'center' },
  keyOk: { backgroundColor: ink.green },
  keyBad: { backgroundColor: ink.red },
  keyTxt: { fontFamily: font.bold, fontSize: 12, color: ink.muted },
  choiceTxt: { flex: 1, fontFamily: font.sans, fontSize: 13.5, lineHeight: 19, color: ink.fg },

  explain: { borderRadius: 16, padding: 14, marginTop: 2 },
  explainTitle: { fontFamily: font.bold, fontSize: 13, marginBottom: 5 },
  explainTxt: { fontFamily: font.sans, fontSize: 12.5, lineHeight: 20, color: ink.fg },
  nextReview: { fontFamily: font.med, fontSize: 10, color: ink.muted, marginTop: 8, ...tnum },

  cbWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 26, zIndex: 1 },
  cbStreakLabel: { fontFamily: font.bold, fontSize: 11, letterSpacing: 2.4, color: ink.streak, ...tnum },
  cbTitle: { fontFamily: font.black, fontSize: 27, color: ink.fg, textAlign: 'center', lineHeight: 35, letterSpacing: -0.5, marginTop: 8, marginBottom: 6 },
  cbSub: { fontSize: 13, color: ink.muted, textAlign: 'center', lineHeight: 20, marginBottom: 22, fontFamily: font.sans },
  cbStats: { flexDirection: 'row', gap: 9, alignSelf: 'stretch' },
  cbStat: { paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center' },
  cbStatNum: { fontFamily: font.extra, fontSize: 23, lineHeight: 25, ...tnum },
  cbStatLabel: { fontSize: 10, color: ink.muted, marginTop: 5, fontFamily: font.sans },
  cbFoot: { padding: 24, paddingBottom: 26, zIndex: 1 },
  cbBtn: { backgroundColor: ink.fg, borderRadius: 15, height: 50, alignItems: 'center', justifyContent: 'center' },
  cbBtnText: { fontFamily: font.bold, fontSize: 15, color: ink.canvas },
  cbNext: { textAlign: 'center', marginTop: 11, fontSize: 11, color: ink.muted, fontFamily: font.sans, ...tnum },
});
