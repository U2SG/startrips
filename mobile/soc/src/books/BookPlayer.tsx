import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font, tnum, useTheme } from '../theme';
import { getBook, subscribe, getDownload, subscribeDownload, cancelDownload, type ListeningBook } from './runtime';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export function BookPlayer({ expanded, onExpand, onCollapse, busy, error, retry }: {
  expanded: boolean; onExpand(): void; onCollapse(): void; busy: boolean; error: string; retry(): void;
}) {
  const book = useSyncExternalStore(subscribe, getBook);
  const { ink } = useTheme();
  return <>
    {book && !expanded ? <MiniPlayer book={book} onExpand={onExpand} /> : null}
    <Modal visible={expanded} animationType="slide" onRequestClose={onCollapse} presentationStyle="fullScreen">
      {book && !busy && !error ? <Reader book={book} onCollapse={onCollapse} /> :
        <View style={{ flex: 1, backgroundColor: ink.canvas, justifyContent: 'center', padding: 32, gap: 24 }}>
          <Control label="收起听书" onPress={onCollapse}>收起</Control>
          {busy ? <ActivityIndicator color={ink.accent} accessibilityLabel="读取听书位置" /> : null}
          {error ? <><Text accessibilityRole="alert" style={{ color: ink.red }}>{error}</Text><Control label="重试打开听书" onPress={retry}>重试</Control></> : null}
        </View>}
    </Modal>
  </>;
}

function Control({ children, label, onPress, primary, disabled, selected, choice, toggle, expanded }: {
  children: React.ReactNode; label: string; onPress(): void; primary?: boolean; disabled?: boolean; selected?: boolean; choice?: boolean; toggle?: boolean; expanded?: boolean;
}) {
  const { ink } = useTheme();
  return <Pressable accessibilityRole={choice ? 'radio' : toggle ? 'switch' : 'button'} accessibilityLabel={label} accessibilityState={{ disabled: !!disabled, checked: choice || toggle ? !!selected : undefined }}
    aria-checked={choice || toggle ? !!selected : undefined} aria-disabled={!!disabled} aria-expanded={expanded}
    disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      minHeight: primary ? 64 : 44, minWidth: primary ? 64 : 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center',
      borderRadius: primary ? 32 : 12, backgroundColor: primary ? ink.accent : selected ? ink.accentSoft : 'transparent', opacity: disabled || pressed ? 0.45 : 1,
    })}>
    <Text style={{ color: primary ? ink.raised : selected ? ink.accent : ink.fg, fontFamily: font.med, fontSize: primary ? 24 : 14 }}>{children}</Text>
  </Pressable>;
}

export function Track({ ratio, height = 4, style }: { ratio: number; height?: number; style?: StyleProp<ViewStyle> }) {
  const { ink } = useTheme();
  const width = `${Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) * 100 : 0}%` as const;
  return <View pointerEvents="none" style={[{ height, backgroundColor: ink.sunken, borderRadius: height / 2, overflow: 'hidden' }, style]}>
    <View style={{ height, width, backgroundColor: ink.accent }} />
  </View>;
}

function MiniPlayer({ book, onExpand }: { book: ListeningBook; onExpand(): void }) {
  const state = useSyncExternalStore(book.engine.subscribe, book.engine.getState);
  const { ink } = useTheme();
  const playing = state.status === 'playing' || state.status === 'loading';
  const problem = state.error || state.syncError;
  return <View testID="listening-mini" style={{ marginHorizontal: 16, backgroundColor: ink.raised, borderRadius: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, overflow: 'hidden' }}>
    <Pressable accessibilityRole="button" accessibilityLabel="展开听书" onPress={onExpand} style={{ flex: 1, minHeight: 56, justifyContent: 'center', paddingHorizontal: 8 }}>
      <Text numberOfLines={1} style={{ color: ink.fg, fontFamily: font.med }}>{book.textbook.title}</Text>
      {problem ? <Text numberOfLines={1} style={{ color: ink.red, fontSize: 12, marginTop: 2 }}>{problem}</Text> : null}
    </Pressable>
    <Track ratio={state.length ? state.elapsed / state.length : 0} style={{ position: 'absolute', left: 16, right: 16, bottom: 0 }} height={2} />
    <Control label={playing ? '暂停听书' : '继续听书'} onPress={() => {
      if (playing) book.engine.pause();
      else if (!state.page) { onExpand(); void book.engine.open(state.bookmark); }
      else void book.engine.play();
    }}>{playing ? 'Ⅱ' : '▶'}</Control>
  </View>;
}

function Reader({ book, onCollapse }: { book: ListeningBook; onCollapse(): void }) {
  const engine = book.engine;
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const { page, bookmark: b } = state;
  const { ink } = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const positions = useRef<Record<number, number>>({});
  const [number, setNumber] = useState('');
  const [settings, setSettings] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [trackWidth, setTrackWidth] = useState(1);
  const [jumpError, setJumpError] = useState('');
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadStart, setDownloadStart] = useState('1');
  const [downloadEnd, setDownloadEnd] = useState('');
  const download = useSyncExternalStore(subscribeDownload, getDownload);
  const busy = state.status === 'loading';
  const playing = state.status === 'playing';
  const ended = state.status === 'ended';
  // Submit and the blur that follows it both call jump(); only the first may move the book.
  const requested = useRef(0);
  useEffect(() => {
    setNumber(String(page?.page || 1)); positions.current = {};
  }, [page?.page]);
  useEffect(() => { if (!busy) requested.current = 0; }, [busy]);
  useEffect(() => {
    if (b && positions.current[b.passage] !== undefined) scroll.current?.scrollTo({ y: Math.max(0, positions.current[b.passage] - 48), animated: true });
  }, [b?.passage, page?.page]);
  function jump() {
    if (!number.trim()) { setNumber(String(page?.page || 1)); setJumpError(''); return; }
    const target = Number(number);
    if (!Number.isInteger(target) || target < 1 || (page && target > page.total)) { setJumpError('请输入有效页码'); return; }
    setJumpError('');
    if (target === page?.page || target === requested.current) return;
    requested.current = target; void engine.go(target, 0, playing);
  }
  const ratio = state.length ? Math.min(1, state.elapsed / state.length) : 0;
  return <View testID="listening-reader" style={{ flex: 1, backgroundColor: ink.canvas, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 8) }}>
    <View style={[styles.row, styles.header]}>
      <Control label="收起听书" onPress={onCollapse}>⌄</Control>
      <Text numberOfLines={1} style={{ flex: 1, textAlign: 'center', color: ink.fg, fontFamily: font.bold, fontSize: 17 }}>{book.textbook.title}</Text>
      <Control label="听书设置" selected={settings} onPress={() => { setSettings(!settings); setSpeedOpen(false); }}>···</Control>
    </View>
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={styles.paper}>
      {!page && busy ? <ActivityIndicator color={ink.accent} style={{ marginTop: 64 }} /> : null}
      {page?.passages.map((passage, index) => <Pressable key={`${page.page}-${index}`} accessibilityRole="button" accessibilityLabel={`从第 ${index + 1} 段朗读`}
        accessibilityState={{ selected: index === b?.passage }} disabled={busy}
        onLayout={(e) => { positions.current[index] = e.nativeEvent.layout.y; }}
        onPress={() => void engine.go(page.page, index, true)}
        style={{ minHeight: 44, paddingVertical: 10, paddingHorizontal: 16, borderLeftWidth: 3, borderLeftColor: index === b?.passage ? ink.accent : 'transparent', backgroundColor: index === b?.passage ? ink.accentSoft : 'transparent', borderRadius: 4 }}>
        {index === b?.passage && b.dramatic && passage.speaker ? <Text numberOfLines={1} style={{ color: ink.muted, fontFamily: font.sans, fontSize: 12 }}>{passage.speaker}</Text> : null}
        <Text style={{ color: ink.fg, fontFamily: font.sans, fontSize: 20, lineHeight: 36 }}>{passage.text.trim()}</Text>
      </Pressable>)}
      {page && !page.passages.length ? <Text style={{ color: ink.muted, fontFamily: font.sans, padding: 16 }}>本页没有文字</Text> : null}
    </ScrollView>
    <View style={[styles.controls, { borderColor: ink.border }]}>
      {state.error || state.syncError || jumpError ? <Text accessibilityRole="alert" style={{ color: ink.red, fontFamily: font.sans, fontSize: 13 }}>{state.error || state.syncError || jumpError}</Text> : null}
      {page?.notice ? <Text style={{ color: ink.muted, fontFamily: font.sans, fontSize: 12 }}>{page.notice}</Text> : null}
      {settings ? <View style={{ gap: 8 }}>
        <View style={[styles.row, { gap: 8 }]}>
          <Text accessibilityElementsHidden importantForAccessibility="no" aria-hidden style={{ color: ink.muted, fontSize: 16 }}>◷</Text>
          <View style={[styles.row, { flex: 1 }]} accessibilityRole="radiogroup" accessibilityLabel="定时停止">{[0, 15, 30, 60].map((minutes) => <Control choice key={minutes} label={minutes ? `${minutes} 分钟后停止` : '关闭定时'} selected={minutes === 0 ? !state.sleepAt : !!state.sleepAt && Math.abs((state.sleepAt - Date.now()) / 60000 - minutes) < 1}
            onPress={() => engine.sleep(minutes)}>{minutes || '关'}</Control>)}</View>
        </View>
        <View style={styles.row}>
          <Control toggle label="切换人物分声" disabled={busy} selected={b?.dramatic} onPress={() => void engine.mode(!b?.dramatic)}>人物分声</Control>
          <Control label="从头重听" disabled={busy} onPress={() => void engine.go(1, 0, true)}>从头重听</Control>
        </View>
        {!book.offline ? <Control label="离线下载" selected={downloadOpen} onPress={() => { setDownloadOpen(!downloadOpen); setDownloadEnd(String(page?.total || book.textbook.numPages)); }}>↓ 下载</Control> : null}
        {downloadOpen && !book.offline ? <>
          <View style={[styles.row, { gap: 8 }]}>
            <TextInput accessibilityLabel="下载起始页" keyboardType="number-pad" value={downloadStart} onChangeText={setDownloadStart} style={{ minWidth: 56, minHeight: 44, color: ink.fg, borderBottomWidth: 1, borderColor: ink.border, textAlign: 'center' }} />
            <Text style={{ color: ink.muted }}>—</Text>
            <TextInput accessibilityLabel="下载结束页" keyboardType="number-pad" value={downloadEnd} onChangeText={setDownloadEnd} style={{ minWidth: 56, minHeight: 44, color: ink.fg, borderBottomWidth: 1, borderColor: ink.border, textAlign: 'center' }} />
            <Control label={download.active ? '暂停下载' : '开始下载'} onPress={() => {
              if (download.active) cancelDownload();
              else { setJumpError(''); void book.download(Number(downloadStart), Number(downloadEnd)).catch((e: Error) => setJumpError(e.message)); }
            }}>{download.active ? '暂停' : '下载'}</Control>
          </View>
          {download.page > 0 ? <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: download.total, now: download.done }} accessibilityLiveRegion="polite" aria-live="polite" accessibilityLabel={`第 ${download.page} / ${download.end} 页 · ${download.done} / ${download.total} 段`}
            style={[styles.row, { gap: 12 }]}>
            <Track ratio={download.total ? download.done / download.total : 0} height={2} style={{ flex: 1 }} />
            <Text style={{ color: ink.muted, fontSize: 12, ...tnum }}>{download.done} / {download.total}</Text>
          </View> : null}
          {download.error ? <Text accessibilityRole="alert" style={{ color: ink.red }}>{download.error}</Text> : null}
        </> : null}
      </View> : null}
      <View style={styles.row}>
        <Control label="上一页" disabled={busy || !page || page.page <= 1} onPress={() => void engine.go((page?.page || 1) - 1, 0, playing)}>‹</Control>
        <View style={[styles.row, { gap: 4 }]}>
          <TextInput accessibilityLabel="听书页码" value={number} onChangeText={setNumber} onSubmitEditing={jump} onBlur={jump} keyboardType="number-pad" selectTextOnFocus
            style={{ width: 56, minHeight: 44, color: ink.fg, textAlign: 'center', borderBottomWidth: 1, borderColor: ink.border, fontFamily: font.med, ...tnum }} />
          <Text style={{ color: ink.muted, ...tnum }}>/ {page?.total || '—'}</Text>
        </View>
        <Control label="下一页" disabled={busy || !page || page.page >= page.total} onPress={() => void engine.go((page?.page || 1) + 1, 0, playing)}>›</Control>
      </View>
      <Pressable accessibilityRole="adjustable" accessibilityLabel="播放进度" accessibilityValue={{ min: 0, max: Math.round(state.length), now: Math.round(state.elapsed) }}
        aria-valuemin={0} aria-valuemax={Math.round(state.length)} aria-valuenow={Math.round(state.elapsed)}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={(e) => void engine.skip(e.nativeEvent.actionName === 'increment' ? 5 : -5)}
        disabled={busy || !state.length} onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        onPress={(e) => void engine.seekTimeline((e.nativeEvent.locationX / trackWidth) * state.length)} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Track ratio={ratio} />
      </Pressable>
      {speedOpen ? <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="播放速度">
        {[0.75, 1, 1.25, 1.5, 2].map((speed) => <Control choice key={speed} label={`${speed} 倍速`} selected={b?.speed === speed}
          onPress={() => { engine.speed(speed); setSpeedOpen(false); }}>{speed}×</Control>)}
      </View> : null}
      <View style={[styles.row, { marginTop: -12 }]}>
        <Text style={{ flex: 1, color: ink.muted, fontSize: 12, ...tnum }}>{clock(state.elapsed)}</Text>
        <Control label="调整播放倍速" disabled={!b} selected={speedOpen} expanded={speedOpen} onPress={() => { setSpeedOpen(!speedOpen); setSettings(false); }}>{b?.speed || 1}×</Control>
        <Text numberOfLines={1} style={{ flex: 1, color: ink.muted, fontSize: 12, textAlign: 'right', ...tnum }}>{state.sleepAt ? '◷  ' : ''}-{clock(Math.max(0, state.length - state.elapsed))}</Text>
      </View>
      <View style={styles.row}>
        <Control label="上一段" disabled={busy || !page} onPress={() => void engine.next(-1)}>Ⅰ‹</Control>
        <Control label="后退 15 秒" disabled={busy || !state.duration} onPress={() => void engine.skip(-15)}>↶ 15</Control>
        <Control primary label={busy || playing ? '暂停听书' : state.status === 'error' ? '重试朗读' : ended ? '从头重听' : '播放听书'} onPress={() => {
          if (busy || playing) engine.pause();
          else if (!page) void engine.open(b);
          else if (ended) void engine.go(1, 0, true);
          else void engine.play();
        }}>{busy ? '···' : playing ? 'Ⅱ' : ended ? '↺' : '▶'}</Control>
        <Control label="前进 15 秒" disabled={busy || !state.duration} onPress={() => void engine.skip(15)}>15 ↷</Control>
        <Control label="下一段" disabled={busy || !page} onPress={() => void engine.next(1)}>›Ⅰ</Control>
      </View>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  header: { paddingHorizontal: 12, minHeight: 56, gap: 8 },
  paper: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 24, paddingBottom: 80 },
  controls: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 8, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 4 },
});
