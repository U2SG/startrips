// src/components/TypingDots.tsx — “正在输入” 三点跳动
import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';

export function TypingDots({ color = '#b7ad9a' }: { color?: string }) {
  const d0 = useRef(new Animated.Value(0)).current;
  const d1 = useRef(new Animated.Value(0)).current;
  const d2 = useRef(new Animated.Value(0)).current;
  const dots = [d0, d1, d2];
  useEffect(() => {
    const anims = dots.map((v, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * 160),
      Animated.timing(v, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 300, useNativeDriver: true }),
      Animated.delay((2 - i) * 160),
    ])));
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
      {dots.map((v, i) => (
        <Animated.View key={i} style={{
          width: 6, height: 6, borderRadius: 3, backgroundColor: color,
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
          transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
        }} />
      ))}
    </View>
  );
}
