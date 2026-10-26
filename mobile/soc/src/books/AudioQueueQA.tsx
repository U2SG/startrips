/** Compiled into a separate CI-only APK. The downloadable release always uses App. */
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { BookEngine } from './engine';
import { createBookAudio } from './audio';
import * as files from './offlineFiles';

export default function AudioQueueQA() {
  const [label, setLabel] = useState('Preparing native audio queue');
  useEffect(() => {
    let engine: BookEngine;
    const audio = createBookAudio({
      create: () => {
        const player = createAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true });
        if (!(player as unknown as { bookAppend?: unknown }).bookAppend) throw new Error('Native book queue missing');
        return player;
      },
      guard() {}, configure: () => setAudioModeAsync({ shouldPlayInBackground: true, playsInSilentMode: true, interruptionMode: 'doNotMix' }),
      metadata: () => ({ title: 'Soc CI background playback' }),
      status(s) {
        console.info('SOC_BOOK_QA', JSON.stringify({ key: s.bookKey, seconds: s.currentTime, playing: s.playing }));
        engine.tick(s.currentTime, s.duration, s.playing, s.didJustFinish, s.bookKey);
      },
    });
    engine = new BookEngine({
      focus() {}, player: audio, remove: files.releaseAudio, async save() {},
      async page(number) {
        return { page: number, total: 6, signature: 'ci-background', passages: Array.from({ length: 8 }, (_, i) => ({ text: `CI phrase ${number}-${i}`, speaker: 'narrator', voice: 'Cherry', tone: 'neutral' })) };
      },
      async audio(page, index, signal) {
        const uri = await files.storeAudio(`ci-${page.page}-${index}`, `http://10.0.2.2:18991/clip/${page.page}/${index}.wav`, signal);
        return { uri, duration: await files.audioDuration(uri) };
      },
    });
    const unsubscribe = engine.subscribe(() => {
      const state = engine.getState();
      setLabel(state.error || `${state.status} ${state.bookmark?.page}/${state.bookmark?.passage}`);
    });
    void engine.open().then(() => engine.play());
    return () => { unsubscribe(); engine.dispose(); };
  }, []);
  return <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}><Text accessibilityLabel="Native queue QA">{label}</Text></View>;
}
