import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { GlassPanel, GlowLayer, GradientFab, glassShadow, useKeyboardHeight, useTabBarHeight } from '../components/Glass';
import { TypingDots } from '../components/TypingDots';
import type { GroupMessage, LlmProfile } from '../data';
import { loadGroupChat, sendGroupMessage } from '../groupchat';
import { useResource } from '../hooks';
import { font, Ink, radius, space, tnum, type_, useTheme } from '../theme';
import { ErrorNote } from '../ui';

type GroupChatData = { messages: GroupMessage[]; learner: string; colors: Record<string, string> };

export default function GroupChatScreen(props: { worldId: string | null; profile: LlmProfile | null }) {
  const { worldId, profile } = props;
  const { ink, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const tabBarH = useTabBarHeight();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false); // onSend 动作态，保留本地 state
  const [sendError, setSendError] = useState('');
  const listRef = useRef<FlatList>(null);

  // 群聊数据加载：messages / learner / colors 三元组
  const { data, error: loadError, reload, setData } = useResource<GroupChatData>(
    () => loadGroupChat(worldId!),
    [worldId],
    { enabled: !!worldId },
  );

  const messages = data?.messages ?? [];
  const me = data?.learner ?? '我';
  const colors = data?.colors ?? {};

  function colorOf(speaker: string) {
    return colors[speaker] || (speaker === me ? ink.green : ink.accent);
  }

  // 只在新消息到达 / 键盘弹出时滚到底；手动上滑不被拽回（不再用 onContentSizeChange）
  useEffect(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
  }, [messages.length, kb]);

  async function onSend() {
    if (!worldId || !profile || !input.trim() || busy) return;
    const text = input.trim();
    setInput('');
    // 乐观插入
    setData((d) => d ? { ...d, messages: [...d.messages, { time: '…', speaker: me, text }] } : d);
    setBusy(true);
    try {
      const newMessages = await sendGroupMessage(worldId, profile, text);
      setData((d) => d ? { ...d, messages: newMessages } : d);
      setSendError('');
    } catch (e: any) {
      setSendError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  const navTop = insets.top + 4;
  const lift = kb > 0 ? Math.max(0, kb - tabBarH) : 0;
  const partnerCount = new Set(messages.filter((m) => m.speaker !== me).map((m) => m.speaker)).size;

  return (
    <View style={s.root}>
      <GlowLayer />
      <FlatList
        ref={listRef}
        data={messages}
        style={{ flex: 1 }}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: navTop + 58, paddingBottom: 80 + lift }}
        renderItem={({ item, index }) => {
          const mine = item.speaker === me;
          const prev = messages[index - 1];
          const grouped = !!prev && prev.speaker === item.speaker; // 与上一条同人 → 省头像/名，气泡贴紧
          if (mine) {
            return (
              <View style={s.meRow}>
                {!grouped && (
                  <Text style={s.meName}>
                    {item.speaker}<Text style={s.time}>  {item.time.slice(5, 16)}</Text>
                  </Text>
                )}
                <View style={s.meBubble}><Text style={s.meText}>{item.text}</Text></View>
              </View>
            );
          }
          return (
            <View style={s.row}>
              <View style={s.avatarCol}>
                {!grouped && <Avatar name={item.speaker} color={colorOf(item.speaker)} size={28} />}
              </View>
              <View style={{ flex: 1, alignItems: 'flex-start' }}>
                {!grouped && (
                  <View style={s.nameRow}>
                    <Text style={[s.speaker, { color: colorOf(item.speaker) }]}>{item.speaker}</Text>
                    <Text style={s.time}>{item.time.slice(5, 16)}</Text>
                  </View>
                )}
                <GlassPanel tone="bubble" rounded={radius.bubble} style={[s.bubble, grouped && { borderTopLeftRadius: radius.bubble }]} contentStyle={s.bubblePad}>
                  <Text style={s.bubbleTxt}>{item.text}</Text>
                </GlassPanel>
              </View>
            </View>
          );
        }}
        ListFooterComponent={busy ? (
          <View style={s.row}>
            <View style={s.avatarCol} />
            <GlassPanel tone="bubble" rounded={radius.bubble} style={s.bubble} contentStyle={[s.bubblePad, { paddingVertical: 13 }]}>
              <TypingDots color={ink.muted} />
            </GlassPanel>
          </View>
        ) : null}
        ListEmptyComponent={busy ? null : <Text style={s.empty}>群里还没有消息。下课后伙伴们会在这里复盘。</Text>}
      />

      {/* 悬浮玻璃导航 */}
      <GlassPanel rounded={radius.nav} style={[s.nav, { top: navTop }, glassShadow(ink, isDark)]} contentStyle={s.navInner}>
        <View style={{ flex: 1 }}>
          <Text style={s.navTitle}>群聊</Text>
          <Text style={s.navSub}>{partnerCount ? `${partnerCount} 位伙伴 · 课后复盘` : '课后复盘'}</Text>
        </View>
        <Pressable onPress={reload} hitSlop={8} disabled={busy}><Text style={s.navAction}>刷新</Text></Pressable>
      </GlassPanel>

      {/* 悬浮输入坞（键盘弹出时抬到键盘上方） */}
      <GlassPanel rounded={radius.dock} style={[s.dock, { bottom: 12 + lift }, glassShadow(ink, isDark)]} contentStyle={s.dockInner}>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="在群里说点什么…"
          placeholderTextColor={ink.muted}
          multiline
        />
        <GradientFab onPress={onSend} disabled={!input.trim() || busy || !profile} />
      </GlassPanel>

      <View style={[s.errSlot, { top: navTop + 58 }]} pointerEvents="box-none"><ErrorNote text={loadError || sendError} /></View>
    </View>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.canvas },
  row: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginBottom: 9 },
  avatarCol: { width: 28 }, // 占位，合并时留空保持对齐
  nameRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 3 },
  speaker: { fontFamily: font.bold, fontSize: 11 },
  time: { fontFamily: font.sans, fontSize: 9, color: ink.muted, ...tnum },
  bubble: { alignSelf: 'flex-start', maxWidth: '100%' },
  bubblePad: { paddingHorizontal: 13, paddingVertical: 9 },
  bubbleTxt: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 21, color: ink.fg },
  meRow: { alignItems: 'flex-end', marginBottom: 9 },
  meName: { fontFamily: font.bold, fontSize: 11, color: ink.green, marginBottom: 3, marginRight: 4 },
  meBubble: {
    alignSelf: 'flex-end', maxWidth: '84%', borderRadius: radius.bubble, borderTopRightRadius: 5,
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: ink.accent,
  },
  meText: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 21, color: '#fff' },
  empty: { color: ink.muted, fontSize: type_.small, textAlign: 'center', marginTop: space(4), fontFamily: font.sans },

  nav: { position: 'absolute', left: 12, right: 12 },
  navInner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9 },
  navTitle: { fontSize: 16, fontFamily: font.extra, color: ink.fg, letterSpacing: -0.2 },
  navSub: { fontSize: 10, color: ink.muted, fontFamily: font.sans, marginTop: 1 },
  navAction: { fontSize: 13, fontFamily: font.med, color: ink.accent },

  dock: { position: 'absolute', left: 12, right: 12, bottom: 12 },
  dockInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 15, paddingRight: 6, paddingVertical: 6 },
  input: { flex: 1, maxHeight: 120, fontSize: type_.body, color: ink.fg, fontFamily: font.sans, paddingVertical: Platform.OS === 'ios' ? 8 : 4 },

  errSlot: { position: 'absolute', left: 0, right: 0 },
});
