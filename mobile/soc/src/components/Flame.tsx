// src/components/Flame.tsx — 连对火苗（View 拼水滴形 + 呼吸缩放）
import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

export function Flame({ size = 16, color = '#c8821f', animate = true }:
                      { size?: number; color?: string; animate?: boolean }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!animate) { v.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [animate]);
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  return (
    <Animated.View style={{
      width: size, height: size,
      backgroundColor: color,
      borderTopLeftRadius: size, borderTopRightRadius: size, borderBottomLeftRadius: size, borderBottomRightRadius: 2,
      transform: [{ rotate: '45deg' }, { scale }],
    }} />
  );
}
