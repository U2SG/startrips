/** Compiled into a separate CI-only APK. The downloadable release always uses App. */
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { hideAsync } from 'expo-splash-screen';
import { BookEngine } from './engine';
import { createBookAudio } from './audio';
import * as files from './offlineFiles';

export default function AudioQueueQA() {
  const [label, setLabel] = useState('Preparing native audio queue');
  useEffect(() => {
    void hideAsync();
    let engine: BookEngine;
    const audio = createBookAudio({
      create: () => {
        const player = createAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true });
        console.info('SOC_QA_PLAYER', typeof (player as unknown as { bookAppend?: unknown }).bookAppend);
        player.addListener('playbackStatusUpdate', (s) => console.info('SOC_QA_NATIVE', JSON.stringify(s)));
        const start = player.play.bind(player);
        player.play = () => { console.info('SOC_QA_START'); start(); console.info('SOC_QA_STARTED'); };
        const lock = player.setActiveForLockScreen.bind(player);
        player.setActiveForLockScreen = (...args) => { console.info('SOC_QA_ACTIVATE'); lock(...args); console.info('SOC_QA_ACTIVE'); };
        if (!(player as unknown as { bookAppend?: unknown }).bookAppend) throw new Error('Native book queue missing');
        return player;
      },
      guard() {}, configure: () => setAudioModeAsync({ shouldPlayInBackground: true, playsInSilentMode: true, interruptionMode: 'doNotMix' }),
      metadata: () => ({ title: 'Soc CI background playback' }),
      status(s) {
        console.info('SOC_BOOK_QA ' + JSON.stringify({ key: s.bookKey, seconds: s.currentTime, playing: s.playing }));
        engine.tick(s.currentTime, s.duration, s.playing, s.didJustFinish, s.bookKey);
      },
    });
    engine = new BookEngine({
      focus() {}, player: audio, remove: files.releaseAudio, async save() {},
      async page(number) {
        return { page: number, total: 6, signature: 'ci-background', passages: Array.from({ length: 8 }, (_, i) => ({ text: `CI phrase ${number}-${i}`, speaker: 'narrator', voice: 'Cherry', tone: 'neutral' })) };
      },
      async audio(page, index, signal) {
        const uri = await files.storeAudio(`ci-${page.page}-${index}`, `http://127.0.0.1:18991/clip/${page.page}/${index}.wav`, signal);
        console.info('SOC_QA_FILE', uri);
        const duration = await files.audioDuration(uri); console.info('SOC_QA_DURATION', duration);
        return { uri, duration };
      },
    });
    const unsubscribe = engine.subscribe(() => {
      const state = engine.getState();
      console.info('SOC_QA_ENGINE', JSON.stringify({ status: state.status, error: state.error, passage: state.bookmark?.passage }));
      setLabel(state.error || `${state.status} ${state.bookmark?.page}/${state.bookmark?.passage}`);
    });
    void engine.open({ version: 1, segmentation: 2, page: 1, passage: 0, seconds: 0.5, signature: 'ci-background', speed: 1, dramatic: true, savedAt: 0 }).then(() => engine.play());
    return () => { unsubscribe(); engine.dispose(); };
  }, []);
  return <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}><Text accessibilityLabel="Native queue QA">{label}</Text></View>;
}
