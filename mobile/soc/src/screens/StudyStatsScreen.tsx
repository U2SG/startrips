// 学习数据：设置页的子页面。汇总连续天数、复习量、正确率、掌握度与各教材进度。
// 全部来自已落盘的闪卡与教材进度（src/stats.ts），不引新存储。
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Flame } from '../components/Flame';
import { GlassPanel, GlowLayer } from '../components/Glass';
import { useResource } from '../hooks';
import { sendTestNotification } from '../notify';
import { computeStudyStats, localDay, type StudyStats } from '../stats';
import { accentGrad, elev, font, Ink, radius, space, tnum, type_, useTheme } from '../theme';
import { Busy, ErrorNote } from '../ui';

export default function StudyStatsScreen({ worldId, onClose }: { worldId: string | null; onClose: () => void }) {
  const { ink } = useTheme();
  const insets = useSafeAreaInsets();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const [notifyHint, setNotifyHint] = useState('');

  // !worldId 时 enabled:false，不发起请求；错误由下方渲染逻辑处理
  const { data: stats, busy, error } = useResource<StudyStats>(
    () => computeStudyStats(worldId!),
    [worldId],
    { enabled: !!worldId, busyText: '读取学习数据…' },
  );

  async function onTestNotify() {
    setNotifyHint('');
    const err = await sendTestNotification();
    setNotifyHint(err || '已排程，约 5 秒后会收到一条测试提醒。');
  }

  const accuracy = stats && stats.reviewsTotal ? Math.round((stats.reviewsCorrect / stats.reviewsTotal) * 100) : null;
  const tomorrow = localDay(new Date(Date.now() + 86400000).toISOString());
  const batchDay = stats?.nextBatch ? (stats.nextBatch.day === tomorrow ? '明天' : stats.nextBatch.day.slice(5).replace('-', '/')) : null;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <GlowLayer />
      <View style={s.head}>
        <Pressable onPress={onClose} hitSlop={10} style={s.back}><Text style={s.backTxt}>‹ 设置</Text></Pressable>
        <Text style={s.title}>学习数据</Text>
      </View>
      <ErrorNote text={worldId ? error : '还没有可统计的世界，先连接并上一节课。'} />
      {busy ? <Busy text={busy} /> : null}
      {stats ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: space(2), paddingBottom: space(5) }}>
          {/* 连续学习天数 */}
          <GlassPanel rounded={24} contentStyle={s.streakCard}>
            <View style={s.streakMedal}><Flame size={30} color={ink.streak} animate={stats.dayStreak > 0} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.streakNum}>{stats.dayStreak}</Text>
              <Text style={s.streakLabel}>连续学习天数</Text>
            </View>
            {stats.dueNow > 0 ? (
              <View style={s.dueBadge}><Text style={s.dueNum}>{stats.dueNow}</Text><Text style={s.dueLabel}>今日待复习</Text></View>
            ) : null}
          </GlassPanel>

          {/* 统计格 */}
          <View style={s.grid}>
            <Stat ink={ink} num={String(stats.totalCards)} label="闪卡总数" />
            <Stat ink={ink} num={String(stats.masteredCards)} label="已掌握" color={ink.green} />
            <Stat ink={ink} num={accuracy === null ? '—' : `${accuracy}%`} label="累计正确率" color={ink.accent} />
            <Stat ink={ink} num={String(stats.reviews7d)} label="近 7 天复习" />
          </View>

          {/* 下一批到期 */}
          {batchDay && stats.nextBatch ? (
            <Text style={s.nextLine}>下一批 {stats.nextBatch.count} 张 · {batchDay}到期</Text>
          ) : null}

          {/* 各教材进度 */}
          {stats.books.length ? (
            <View>
              <Text style={s.sectionLabel}>教材进度</Text>
              <View style={s.group}>
                {stats.books.map((b, i) => {
                  const pct = b.numPages ? Math.min(100, Math.round((b.currentPage / b.numPages) * 100)) : 0;
                  return (
                    <View key={b.title + i} style={[s.bookRow, i > 0 && s.bookDivider]}>
                      <Text style={s.bookTitle} numberOfLines={1}>{b.title}</Text>
                      <View style={s.bookProgRow}>
                        <View style={s.track}>
                          {b.currentPage > 0 ? (
                            <LinearGradient colors={accentGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[s.fill, { width: `${Math.max(pct, 2)}%` }]} />
                          ) : null}
                        </View>
                        <Text style={s.bookPct}>{b.currentPage > 0 ? `${b.currentPage}/${b.numPages} · ${pct}%` : '未开始'}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* 复习提醒：每天 20:00 本地通知；这里可立即发一条测试 */}
          <View>
            <Text style={s.sectionLabel}>复习提醒</Text>
            <Text style={s.remindCaption}>每天 20:00 提醒今天的待复习闪卡。</Text>
            <Pressable onPress={onTestNotify} style={({ pressed }) => [s.testBtn, pressed && { opacity: 0.7 }]}>
              <Text style={s.testTxt}>发送一条测试提醒（5 秒后）</Text>
            </Pressable>
            {notifyHint ? <Text style={s.remindHint}>{notifyHint}</Text> : null}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

function Stat({ ink, num, label, color }: { ink: Ink; num: string; label: string; color?: string }) {
  const s = useMemo(() => makeStyles(ink), [ink]);
  return (
    <GlassPanel rounded={16} style={s.statCell} contentStyle={s.statInner}>
      <Text style={[s.statNum, color ? { color } : { color: ink.fg }]}>{num}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </GlassPanel>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.canvas },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 12 },
  back: { paddingVertical: 4, paddingRight: 6 },
  backTxt: { fontFamily: font.med, fontSize: 15, color: ink.accent },
  title: { fontFamily: font.black, fontSize: 24, letterSpacing: -0.5, color: ink.fg },

  streakCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  streakMedal: { width: 60, height: 60, borderRadius: 30, backgroundColor: ink.streakSoft, alignItems: 'center', justifyContent: 'center' },
  streakNum: { fontFamily: font.black, fontSize: 34, lineHeight: 38, color: ink.streak, ...tnum },
  streakLabel: { fontFamily: font.med, fontSize: type_.small, color: ink.muted, marginTop: 2 },
  dueBadge: { alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: ink.accentSoft },
  dueNum: { fontFamily: font.extra, fontSize: 22, lineHeight: 24, color: ink.accent, ...tnum },
  dueLabel: { fontFamily: font.sans, fontSize: 10, color: ink.accent, marginTop: 2 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  statCell: { width: '48%' },
  statInner: { paddingVertical: 16, paddingHorizontal: 14, alignItems: 'flex-start' },
  statNum: { fontFamily: font.extra, fontSize: 26, lineHeight: 28, ...tnum },
  statLabel: { fontFamily: font.sans, fontSize: type_.xs, color: ink.muted, marginTop: 6 },

  nextLine: { fontFamily: font.med, fontSize: type_.xs, color: ink.muted, textAlign: 'center', ...tnum },

  sectionLabel: { fontSize: type_.xs, fontFamily: font.med, letterSpacing: 0.4, color: ink.muted, marginBottom: 7, marginLeft: 4 },
  group: {
    backgroundColor: ink.raised, borderRadius: radius.xxl, overflow: 'hidden',
    ...elev(ink, 2),
  },
  bookRow: { paddingHorizontal: 14, paddingVertical: 12 },
  bookDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ink.border },
  bookTitle: { fontFamily: font.med, fontSize: type_.body, color: ink.fg },
  bookProgRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 9 },
  track: { flex: 1, height: 7, backgroundColor: ink.sunken, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 7, borderRadius: 4 },
  bookPct: { fontFamily: font.med, fontSize: type_.xs, color: ink.muted, ...tnum },

  remindCaption: { fontSize: 10, color: ink.muted, marginBottom: 9, marginLeft: 4, lineHeight: 15, opacity: 0.8 },
  testBtn: { alignSelf: 'flex-start', paddingHorizontal: 14, height: 40, borderRadius: 12, backgroundColor: ink.accentSoft, alignItems: 'center', justifyContent: 'center' },
  testTxt: { fontFamily: font.med, fontSize: type_.small, color: ink.accent },
  remindHint: { fontFamily: font.sans, fontSize: type_.xs, color: ink.muted, marginTop: 9, marginLeft: 4, lineHeight: 17 },
});
