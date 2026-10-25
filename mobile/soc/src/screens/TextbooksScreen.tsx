import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GlassHeader, GlowLayer } from '../components/Glass';
import * as data from '../data';
import { sessionGuard } from '../api';
import { pickTextbook } from '../textbookPicker';
import { useResource } from '../hooks';
import { accentGrad, font, Ink, radius, space, tnum, type_, useTheme } from '../theme';
import { Busy, ErrorNote } from '../ui';

export type ActiveSel = { worldId: string; textbookId: string };

export default function TextbooksScreen(props: {
  active: ActiveSel | null;
  onActivated: (sel: ActiveSel, tb: data.TextbookEntry) => void;
}) {
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const [worldId, setWorldId] = useState<string | null>(props.active?.worldId ?? null);
  const [activateBusy, setActivateBusy] = useState('');
  const [activateError, setActivateError] = useState('');

  // 第一步：读取所有世界列表
  const { data: worlds, busy: worldsBusy, error: worldsError, reload: reloadWorlds } = useResource<{ id: string; name: string }[]>(
    async () => {
      const ids = await data.listWorlds();
      const metas = await Promise.all(ids.map((id) => data.readWorldMeta(id).catch(() => null)));
      return ids.map((id, i) => ({ id, name: metas[i]?.name || id }));
    },
    [],
    { busyText: '读取世界…' },
  );

  // 世界列表到达后，初始化 worldId（props.active 优先，否则取第一个）
  useEffect(() => {
    if (!worlds || worldId) return;
    const wid = props.active?.worldId || worlds[0]?.id;
    if (wid) setWorldId(wid);
  }, [worlds]);

  // 第二步：根据选中世界读取教材列表（进度权威来源是 progress.md 头部）
  const { data: index, busy: indexBusy, error: indexError, reload: reloadIndex } = useResource<data.TextbookIndex>(
    async () => {
      const idx = await data.readTextbookIndex(worldId!);
      // 进度权威来源是 progress.md 头部，index 的 currentPage 可能滞后
      await Promise.all(idx.textbooks.map(async (t) => {
        const head = data.parseProgressPage(await data.readProgress(worldId!, t).catch(() => null));
        if (head != null && head > t.currentPage) t.currentPage = head;
      }));
      return idx;
    },
    [worldId],
    { enabled: !!worldId, busyText: '读取教材列表…' },
  );

  // 合并 busy 与 error（加载态 + 激活动作态）
  const busy = activateBusy || worldsBusy || indexBusy;
  const error = activateError || worldsError || indexError;

  async function upload() {
    const guard = sessionGuard();
    try {
      setActivateError('');
      const picked = await pickTextbook();
      if (!picked) return;
      guard();
      setActivateBusy('上传并解析教材…');
      const targetWorld = worldId || 'study';
      const textbook = await data.importTextbook(targetWorld, picked.name, picked.body);
      guard();
      setWorldId(targetWorld);
      await reloadWorlds();
      guard();
      if (targetWorld === worldId) await reloadIndex();
      await data.setActive(targetWorld, textbook.id);
      guard();
      props.onActivated({ worldId: targetWorld, textbookId: textbook.id }, textbook);
    } catch (error: any) { setActivateError(String(error.message)); }
    finally { setActivateBusy(''); }
  }

  async function activate(tb: data.TextbookEntry) {
    if (!worldId) return;
    setActivateBusy('激活教材…');
    try {
      await data.setActive(worldId, tb.id);
      props.onActivated({ worldId, textbookId: tb.id }, tb);
      setActivateError('');
      // 激活后刷新列表以同步最新状态
      await reloadIndex();
    } catch (e: any) {
      setActivateError(String(e.message));
    } finally {
      setActivateBusy('');
    }
  }

  const worldList = worlds ?? [];
  const curWorld = worldList.find((w) => w.id === worldId);

  return (
    <View style={s.root}>
      <GlowLayer />
      <GlassHeader>
        <View>
          <View style={s.titleRow}>
            <Text style={s.navTitle}>教材</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="上传教材" disabled={!!busy}
              onPress={upload} style={({ pressed }) => [s.upload, { opacity: busy || pressed ? 0.5 : 1 }]}>
              <Text style={s.uploadText}>上传教材</Text>
            </Pressable>
          </View>
          {worldList.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: 10, marginHorizontal: -18 }}
              contentContainerStyle={s.worldRow}
            >
              {worldList.map((w) => {
                const on = w.id === worldId;
                return on ? (
                  <LinearGradient
                    key={w.id}
                    colors={accentGrad}
                    start={{ x: 0.15, y: 0 }} end={{ x: 0.85, y: 1 }}
                    style={s.worldChip}
                  >
                    <Text style={[s.worldChipText, { color: '#fff', fontFamily: font.med }]} numberOfLines={1}>{w.name}</Text>
                  </LinearGradient>
                ) : (
                  <Pressable key={w.id} onPress={() => setWorldId(w.id)} style={[s.worldChip, s.worldChipOff]}>
                    <Text style={s.worldChipText} numberOfLines={1}>{w.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : curWorld ? (
            <Text style={s.navSub} numberOfLines={1}>{curWorld.name}</Text>
          ) : null}
        </View>
      </GlassHeader>

      <ErrorNote text={error} />
      {busy ? <Busy text={busy} /> : null}
      <FlatList
        data={index?.textbooks || []}
        style={{ flex: 1 }}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ padding: 16, gap: space(1.5), paddingBottom: space(4) }}
        renderItem={({ item }) => {
          const isActive = props.active?.textbookId === item.id && props.active?.worldId === worldId;
          const started = item.currentPage > 0;
          const pct = item.numPages ? Math.min(100, Math.round((item.currentPage / item.numPages) * 100)) : 0;
          return (
            <Pressable
              disabled={!!busy}
              onPress={() => activate(item)}
              style={({ pressed }) => [s.card, isActive && s.cardActive, pressed && { opacity: 0.85 }]}
            >
              <View style={s.cardHead}>
                <Text style={s.title} numberOfLines={2}>{item.title}</Text>
                {isActive ? <View style={s.badge}><Text style={s.badgeText}>在读</Text></View> : null}
              </View>
              <Text style={s.meta} numberOfLines={1}>
                {[item.author, item.year, item.field].filter(Boolean).join(' · ') || item.format?.toUpperCase() || 'PDF'}
              </Text>
              <View style={s.progressRow}>
                <View style={s.track}>
                  {started ? (
                    <LinearGradient
                      colors={accentGrad}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                      style={[s.fill, { width: `${Math.max(pct, 2)}%` }]}
                    />
                  ) : null}
                </View>
                <Text style={[s.pct, started && { color: ink.accent }]}>
                  {started ? `${item.currentPage}/${item.numPages} · ${pct}%` : '未开始'}
                </Text>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={busy ? null : <Text style={s.empty}>上传一本 PDF 或 EPUB，开始学习。</Text>}
      />
    </View>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.canvas },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  upload: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, backgroundColor: ink.accentSoft, borderRadius: 14 },
  uploadText: { color: ink.accent, fontSize: type_.body, fontFamily: font.med },
  navTitle: { fontSize: 30, fontFamily: font.black, letterSpacing: -0.5, color: ink.fg },
  navSub: { fontSize: type_.xs, color: ink.muted, marginTop: 4, fontFamily: font.sans },
  worldRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 18 },
  worldChip: { paddingHorizontal: 14, height: 32, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  worldChipOff: { backgroundColor: ink.sunken },
  worldChipText: { color: ink.muted, fontSize: type_.body, fontFamily: font.med },

  card: {
    backgroundColor: ink.raised, borderRadius: radius.card, padding: 16, gap: 0,
    shadowColor: ink.shadow, shadowOpacity: 0.2, shadowRadius: 16, shadowOffset: { width: 0, height: 10 }, elevation: 3,
  },
  cardActive: { borderWidth: 1.5, borderColor: ink.accent },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, fontSize: type_.title, color: ink.fg, fontFamily: font.extra, lineHeight: 23, letterSpacing: -0.2 },
  badge: { backgroundColor: ink.accentSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { color: ink.accent, fontSize: 10, fontFamily: font.bold },
  meta: { fontSize: type_.xs, color: ink.muted, fontFamily: font.sans, marginTop: 5 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 13 },
  track: { flex: 1, height: 7, backgroundColor: ink.sunken, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 7, borderRadius: 4 },
  pct: { fontSize: type_.xs, color: ink.muted, fontFamily: font.med, ...tnum },
  empty: { color: ink.muted, fontSize: type_.small, textAlign: 'center', marginTop: space(4), fontFamily: font.sans },
});
