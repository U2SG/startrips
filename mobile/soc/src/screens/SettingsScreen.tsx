import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as api from '../api';
import { Avatar } from '../components/Avatar';
import { GlassHeader } from '../components/Glass';
import { VoicePickerModal } from '../components/VoicePickerModal';
import * as data from '../data';
import type { Companion, LlmConfig } from '../data';
import { Settings } from '../settings';
import { elev, font, Ink, radius, space, ThemeMode, tnum, type_, useTheme } from '../theme';
import { getCompanionVoice, resolveVoiceCreds } from '../voice';
import { ErrorNote } from '../ui';
import { requestSignOut } from '../AuthGate';
import { Linking } from 'react-native';
import StudyStatsScreen from './StudyStatsScreen';

type Co = NonNullable<Companion>;

type Props = {
  settings: Settings;
  worldId: string | null;
  llmConfig: LlmConfig | null;
  profileName: string | null;
  onSaved: (s: Settings) => Promise<void>;
  onProfileChange: (name: string) => void;
};

const THEME_OPTS: { v: ThemeMode; label: string }[] = [
  { v: 'system', label: '跟随系统' },
  { v: 'light', label: '浅色' },
  { v: 'dark', label: '深色' },
];

export default function SettingsScreen({ settings, worldId, llmConfig, profileName, onSaved, onProfileChange }: Props) {
  const { ink, mode, setMode } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  // 音色：当前世界的伙伴 + 各自音色 + 是否配了 DashScope
  const [companions, setCompanions] = useState<Co[]>([]);
  const [voices, setVoices] = useState<Record<string, string>>({});
  const [voiceAvail, setVoiceAvail] = useState(false);
  const [voiceCo, setVoiceCo] = useState<Co | null>(null); // 正在设置音色的伙伴（开弹窗）
  const [showStats, setShowStats] = useState(false); // 学习数据子页面

  const coKey = (c: Co) => c.candidateId || c.name;

  async function loadVoices(cos: Co[]) {
    if (!worldId) return;
    const entries = await Promise.all(cos.map(async (c) => [coKey(c), await getCompanionVoice(worldId, c)] as const));
    setVoices(Object.fromEntries(entries));
  }

  useEffect(() => {
    resolveVoiceCreds().then((c) => setVoiceAvail(!!c)).catch(() => setVoiceAvail(false));
    if (!worldId) { setCompanions([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const meta = await data.readWorldMeta(worldId);
        const cos = (meta.companions || []).filter((c): c is Co => !!c);
        if (cancelled) return;
        setCompanions(cos);
        await loadVoices(cos);
      } catch { /* 没连上 / 无世界，音色区不显示 */ }
    })();
    return () => { cancelled = true; };
  }, [worldId, settings.serverUrl, settings.token]);

  async function onSave() {
    setError('');
    setStatus('连接中…');
    const ns = settings;
    try {
      api.configureApi(ns);
      await api.ping();
      setStatus('已更新');
      await onSaved(ns);
    } catch (e: any) {
      setStatus('');
      setError(`连接失败：${e.message}`);
    }
  }

  if (showStats) {
    return <StudyStatsScreen worldId={worldId} onClose={() => setShowStats(false)} />;
  }

  return (
    <View style={s.root}>
      <GlassHeader big title="设置" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: space(2), paddingBottom: space(4) }}>
        {/* 学习数据入口 */}
        <View>
          <Text style={s.groupLabel}>学习</Text>
          <Pressable
            onPress={() => setShowStats(true)}
            style={({ pressed }) => [s.group, s.navRow, pressed && { opacity: 0.7 }]}
          >
            <Text style={s.navRowText}>学习数据</Text>
            <Text style={s.navChevron}>›</Text>
          </Pressable>
        </View>

        <View style={s.group}>
          <Pressable style={s.navRow} onPress={() => void onSave()}><Text style={s.navRowText}>刷新</Text></Pressable>
          <Pressable style={s.navRow} onPress={() => void Linking.openURL(settings.serverUrl)}><Text style={s.navRowText}>Startrips</Text></Pressable>
          <Pressable style={s.navRow} onPress={requestSignOut}><Text style={[s.navRowText, { color: ink.red }]}>退出</Text></Pressable>
        </View>
        {status ? <Text style={s.status}>{status}</Text> : null}
        <ErrorNote text={error} />

        {/* 外观 */}
        <View>
          <Text style={s.groupLabel}>外观</Text>
          <View style={s.segment}>
            {THEME_OPTS.map((o) => {
              const on = mode === o.v;
              return (
                <Pressable key={o.v} onPress={() => setMode(o.v)} style={[s.segBtn, on && s.segBtnOn]}>
                  <Text style={[s.segTxt, on && s.segTxtOn]}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* LLM */}
        <View>
          <Text style={s.groupLabel}>模型</Text>
          {llmConfig ? (
            <View style={s.group}>
              {llmConfig.profiles.map((p, i) => {
                const on = p.name === profileName;
                return (
                  <Pressable
                    key={p.name}
                    onPress={() => onProfileChange(p.name)}
                    style={[s.profileRow, i > 0 && s.profileDivider, on && s.profileOn]}
                  >
                    <View style={[s.radio, on && s.radioOn]}>{on ? <View style={s.radioDot} /> : null}</View>
                    <Text style={s.profileName}>{p.name}</Text>
                    <Text style={[s.profileModel, tnum]}>{p.model}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <View style={s.group}>
              <Text style={[s.label, { padding: 14 }]}>请先在服务器配置模型。</Text>
            </View>
          )}
        </View>

        {/* 音色：逐伙伴设置朗读音色（仅本机，不回写桌面） */}
        {voiceAvail && companions.length ? (
          <View>
            <Text style={s.groupLabel}>音色</Text>
            <View style={s.group}>
              {companions.map((c, i) => (
                <Pressable
                  key={coKey(c)}
                  onPress={() => setVoiceCo(c)}
                  style={({ pressed }) => [s.voiceRow, i > 0 && s.profileDivider, pressed && { backgroundColor: ink.accentSoft }]}
                >
                  <Avatar name={c.name} color={c.color} size={30} />
                  <Text style={s.voiceName} numberOfLines={1}>{c.name}</Text>
                  <Text style={[s.voiceVal, tnum]}>{voices[coKey(c)] || '…'}</Text>
                  <Text style={s.voiceChevron}>›</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <VoicePickerModal
        visible={!!voiceCo}
        worldId={worldId}
        companion={voiceCo}
        onClose={() => { const c = voiceCo; setVoiceCo(null); if (c) loadVoices(companions); }}
      />
    </View>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.canvas },
  groupLabel: { fontSize: type_.xs, fontFamily: font.med, letterSpacing: 0.4, color: ink.muted, marginBottom: 7, marginLeft: 4 },
  groupCaption: { fontSize: 10, color: ink.muted, marginBottom: 7, marginLeft: 4, lineHeight: 15, opacity: 0.8 },
  group: {
    backgroundColor: ink.raised, borderRadius: radius.xxl, overflow: 'hidden',
    ...elev(ink, 2),
  },
  field: { paddingHorizontal: 14, paddingVertical: 9 },
  label: { fontSize: type_.xs, color: ink.muted, lineHeight: 17, fontFamily: font.sans },
  input: {
    marginTop: 6, minHeight: 40, borderRadius: radius.md,
    paddingHorizontal: 13, paddingVertical: 9,
    fontSize: type_.body, color: ink.fg, backgroundColor: ink.canvas,
    borderWidth: StyleSheet.hairlineWidth, borderColor: ink.border, fontFamily: font.sans,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: ink.border, marginLeft: 14 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9, paddingLeft: 4 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: ink.green },
  status: { fontSize: type_.xs, color: ink.green, fontFamily: font.med, ...tnum },

  segment: { flexDirection: 'row', backgroundColor: ink.sunken, borderRadius: 13, padding: 3, gap: 3 },
  segBtn: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  segBtnOn: {
    backgroundColor: ink.raised,
    shadowColor: ink.shadow, shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  segTxt: { fontFamily: font.med, fontSize: 13, color: ink.muted },
  segTxtOn: { fontFamily: font.bold, color: ink.accent },

  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingHorizontal: 14 },
  profileDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ink.border },
  profileOn: { backgroundColor: ink.accentSoft },
  radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1.5, borderColor: ink.muted, justifyContent: 'center', alignItems: 'center' },
  radioOn: { borderColor: ink.accent },
  radioDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: ink.accent },
  profileName: { flex: 1, fontSize: type_.body, color: ink.fg, fontFamily: font.med },
  profileModel: { fontSize: type_.xs, color: ink.muted, fontFamily: font.sans },

  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 50, paddingHorizontal: 14 },
  voiceName: { flex: 1, fontSize: type_.body, color: ink.fg, fontFamily: font.med },
  voiceVal: { fontSize: type_.small, color: ink.accent, fontFamily: font.med },
  voiceChevron: { fontSize: 18, color: ink.muted },

  navRow: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 14, gap: 10 },
  navRowText: { fontSize: type_.body, color: ink.fg, fontFamily: font.med },
  navRowSub: { flex: 1, fontSize: type_.xs, color: ink.muted, fontFamily: font.sans },
  navChevron: { fontSize: 20, color: ink.muted },
});
