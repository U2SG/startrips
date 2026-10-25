// src/components/Confetti.tsx — 完成庆祝彩纸（Animated 循环下落，useNativeDriver）
import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';

const PIECES = [
  { left: '14%', w: 8, h: 12, color: '#4a7fb5', round: false, duration: 2600, delay: 0 },
  { left: '30%', w: 9, h: 9, color: '#c8821f', round: true, duration: 3100, delay: 400 },
  { left: '48%', w: 7, h: 13, color: '#16a34a', round: false, duration: 2300, delay: 800 },
  { left: '66%', w: 9, h: 9, color: '#4a7fb5', round: true, duration: 2900, delay: 200 },
  { left: '82%', w: 8, h: 12, color: '#c8821f', round: false, duration: 3300, delay: 600 },
  { left: '22%', w: 7, h: 7, color: '#16a34a', round: true, duration: 2500, delay: 1100 },
  { left: '74%', w: 7, h: 11, color: '#4a7fb5', round: false, duration: 2700, delay: 1400 },
] as const;

function Piece({ p }: { p: (typeof PIECES)[number] }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(p.delay),
      Animated.timing(v, { toValue: 1, duration: p.duration, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View
      style={{
        position: 'absolute', left: p.left as any, top: -20,
        width: p.w, height: p.h,
        backgroundColor: p.color,
        borderRadius: p.round ? p.w / 2 : 2,
        opacity: v.interpolate({ inputRange: [0, 0.1, 0.9, 1], outputRange: [0, 1, 1, 0] }),
        transform: [
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, 660] }) },
          { rotate: v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '540deg'] }) },
        ],
      }}
    />
  );
}

export function Confetti() {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
      {PIECES.map((p, i) => <Piece key={i} p={p} />)}
    </View>
  );
}
