// 逐伙伴音色选择弹窗（仅本机覆盖，不回写桌面）。设置页用；自带试听播放器。
import { useAudioPlayer } from 'expo-audio';
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Companion } from '../data';
import { font, Ink, tnum, useTheme } from '../theme';
import { getCompanionVoice, resolveVoiceCreds, setCompanionVoice, synthesizeChunk, VOICE_GROUPS } from '../voice';
import { GlassPanel, GradientButton } from './Glass';

type Co = NonNullable<Companion>;

export function VoicePickerModal(props: {
  visible: boolean;
  worldId: string | null;
  companion: Co | null;
  onClose: () => void;
}) {
  const { visible, worldId, companion, onClose } = props;
  const { ink } = useTheme();
  const s = React.useMemo(() => makeStyles(ink), [ink]);
  const player = useAudioPlayer();
  const [cur, setCur] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (visible && worldId && companion) getCompanionVoice(worldId, companion).then(setCur).catch(() => {});
    if (!visible) { setErr(''); setPreview(null); }
  }, [visible, worldId, companion]);

  function stop() { try { player.pause(); } catch { /* ignore */ } }
  function close() { stop(); onClose(); }

  async function pick(v: string) {
    if (!worldId || !companion) return;
    setCur(v);
    await setCompanionVoice(worldId, companion, v);
  }
  async function play(v: string) {
    if (!companion) return;
    stop();
    setPreview(v);
    setErr('');
    try {
      const creds = await resolveVoiceCreds();
      if (!creds) throw new Error('未配置 Qwen / DashScope，无法试听');
      const url = await synthesizeChunk(creds, `你好，我是${companion.name}。`, v);
      player.replace(url);
      player.play();
    } catch (e: any) {
      setErr(String(e.message));
    } finally {
      setPreview(null);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close} />
      <GlassPanel rounded={28} style={s.sheet} contentStyle={s.inner}>
        <View style={s.handle} />
        <Text style={s.title}>{companion?.name} 的音色 · 仅本机</Text>
        {err ? <Text style={s.err}>{err}</Text> : null}
        <ScrollView style={{ flexGrow: 0, maxHeight: 380 }} contentContainerStyle={{ paddingBottom: 8 }}>
          {VOICE_GROUPS.map((g) => (
            <View key={g.label} style={{ marginBottom: 10 }}>
              <Text style={s.groupLabel}>{g.label}</Text>
              <View style={s.wrap}>
                {g.voices.map((v) => {
                  const on = cur === v;
                  return (
                    <View key={v} style={[s.chip, on && s.chipOn]}>
                      <Pressable onPress={() => pick(v)} hitSlop={4}>
                        <Text style={[s.chipTxt, on && { color: '#fff', fontFamily: font.bold }]}>{v}</Text>
                      </Pressable>
                      <Pressable onPress={() => play(v)} hitSlop={6} style={s.playBtn}>
                        <Text style={[s.playTxt, on && { color: '#fff' }]}>{preview === v ? '…' : '▷'}</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
        <GradientButton label="完成" onPress={close} height={44} rounded={14} style={{ marginTop: 10 }} />
      </GlassPanel>
    </Modal>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,15,5,0.4)' },
  sheet: { position: 'absolute', left: 8, right: 8, bottom: 8, maxHeight: '85%' },
  inner: { padding: 18, paddingBottom: 22 },
  handle: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: ink.border, marginBottom: 14 },
  title: { fontFamily: font.med, fontSize: 12, color: ink.muted, marginBottom: 12 },
  err: { fontFamily: font.sans, fontSize: 12, color: ink.red, marginBottom: 8 },
  groupLabel: { fontFamily: font.med, fontSize: 11, color: ink.muted, marginBottom: 7 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 8, height: 36,
    borderRadius: 12, backgroundColor: ink.sunken,
  },
  chipOn: { backgroundColor: ink.accent },
  chipTxt: { fontFamily: font.med, fontSize: 13, color: ink.fg, ...tnum },
  playBtn: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.06)' },
  playTxt: { fontSize: 11, color: ink.accent },
});
