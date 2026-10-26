// 逐伙伴音色选择弹窗（仅本机覆盖，不回写桌面）。设置页用；自带试听播放器。
import { useAudioPlayer } from 'expo-audio';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Companion } from '../data';
import { font, Ink, tnum, useTheme } from '../theme';
import { getCompanionVoice, setCompanionVoice, VOICE_GROUPS } from '../voice';
import { voiceSample } from '../voiceSamples';
import { releaseAudio } from '../books/offlineFiles';
import { GlassPanel, GradientButton } from './Glass';
import { claimAudioFocus, registerAudioFocus } from '../audioFocus';

type Co = NonNullable<Companion>;

export function VoicePickerModal(props: {
  visible: boolean;
  worldId: string | null;
  companion: Co | null;
  onClose: () => void;
  target?: { name: string; voice: string; save(voice: string): Promise<void> };
}) {
  const { visible, worldId, companion, onClose, target } = props;
  const { ink } = useTheme();
  const s = React.useMemo(() => makeStyles(ink), [ink]);
  const player = useAudioPlayer();
  const [cur, setCur] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const sampleUri = useRef<string | null>(null);
  useEffect(() => registerAudioFocus('preview', () => { ++generation.current; request.current?.abort(); player.pause(); }), [player]);

  useEffect(() => {
    const seq = ++generation.current;
    if (visible && target) setCur(target.voice);
    else if (visible && worldId && companion) getCompanionVoice(worldId, companion).then((voice) => { if (seq === generation.current) setCur(voice); }).catch(() => {});
    if (!visible) { setErr(''); setPreview(null); }
    return () => { ++generation.current; request.current?.abort(); try { player.pause(); } catch {} if (sampleUri.current) { releaseAudio(sampleUri.current); sampleUri.current = null; } };
  }, [visible, worldId, companion, target?.name]);

  function stop() { request.current?.abort(); try { player.pause(); } catch { /* ignore */ } }
  function close() { ++generation.current; stop(); onClose(); }

  async function pick(v: string) {
    ++generation.current; stop(); setPreview(null); setErr('');
    try {
      if (target) await target.save(v);
      else if (worldId && companion) await setCompanionVoice(worldId, companion, v);
      setCur(v);
    } catch (error) { setErr(error instanceof Error ? error.message : '音色保存失败'); }
  }
  async function play(v: string) {
    if (!companion && !target) return;
    stop();
    claimAudioFocus('preview');
    const seq = ++generation.current;
    const controller = new AbortController(); request.current = controller;
    setPreview(v);
    setErr('');
    try {
      const clip = await voiceSample(v, controller.signal);
      if (seq !== generation.current) { releaseAudio(clip.uri); return; }
      if (sampleUri.current) releaseAudio(sampleUri.current);
      sampleUri.current = clip.uri;
      player.replace(clip.uri);
      player.play();
    } catch (e: any) {
      if (seq === generation.current) setErr(String(e.message));
    } finally {
      if (seq === generation.current) setPreview(null);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close} />
      <GlassPanel rounded={28} style={s.sheet} contentStyle={s.inner}>
        <View style={s.handle} />
        <Text style={s.title}>{target?.name || companion?.name}</Text>
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
                      <Pressable accessibilityRole="radio" accessibilityLabel={`选择 ${v}`} aria-checked={on} accessibilityState={{ checked: on }} onPress={() => void pick(v)} style={{ minHeight: 44, justifyContent: 'center' }}>
                        <Text style={[s.chipTxt, on && { color: '#fff', fontFamily: font.bold }]}>{v}</Text>
                      </Pressable>
                      <Pressable accessibilityRole="button" accessibilityLabel={`试听 ${v}`} onPress={() => void play(v)} style={s.playBtn}>
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
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 0, minHeight: 44,
    borderRadius: 12, backgroundColor: ink.sunken,
  },
  chipOn: { backgroundColor: ink.accent },
  chipTxt: { fontFamily: font.med, fontSize: 13, color: ink.fg, ...tnum },
  playBtn: { width: 44, height: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.06)' },
  playTxt: { fontSize: 11, color: ink.accent },
});
