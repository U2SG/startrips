// 语音对话球体动效（Warm Liquid Glass · AI 球体「纯净有序」）。
// 动效逐一绑定业务态，不复用同一动效：
//   listening   呼吸 + 音量 spring 跟随 + 涟漪双环错峰扩散（accent）
//   recognizing 收拢（0.9x）+ 环轨扫描点（streak）
//   responding  呼吸维持 + 涟漪转绿（green），象征对方在说话
// 相位切换：三层色盘透明度交叉淡变 + 基准缩放 spring，无瞬跳。
// 纯 RN Animated、全 useNativeDriver，不引 svg / reanimated。
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { motion, useTheme } from '../theme';

export type VoicePhase = 'listening' | 'recognizing' | 'responding';

const ORB = 150;
const CORE = 62;
const RIPPLE_DUR = 2600;

export function VoiceOrb({ phase, level }: { phase: VoicePhase; level: number }) {
  const { ink } = useTheme();
  const phaseIdx = { listening: 0, recognizing: 1, responding: 2 }[phase];

  // 音量跟随：stt 侧已做快起慢落，这里再过一层 spring，消除 80ms 采样阶跃
  const levelV = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(levelV, {
      toValue: phase === 'listening' ? level : 0,
      friction: 7, tension: 140, useNativeDriver: true,
    }).start();
  }, [level, phase]);

  // 呼吸：常驻缓慢循环（听与回应时可见的生命感；识别态也不冻结）
  const breath = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breath, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  // 相位：三层色盘 crossfade + 基准缩放 spring（识别态微收拢）
  const fades = [
    useRef(new Animated.Value(phaseIdx === 0 ? 1 : 0)).current,
    useRef(new Animated.Value(phaseIdx === 1 ? 1 : 0)).current,
    useRef(new Animated.Value(phaseIdx === 2 ? 1 : 0)).current,
  ];
  const baseScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    fades.forEach((f, i) => {
      Animated.timing(f, { toValue: i === phaseIdx ? 1 : 0, duration: motion.dur.base, useNativeDriver: true }).start();
    });
    Animated.spring(baseScale, { toValue: phase === 'recognizing' ? 0.9 : 1, ...motion.springLight, useNativeDriver: true }).start();
  }, [phase]);

  // 涟漪：双环错峰、easeOut（听=accent、回应=green，色层随相位淡变；识别态两色都归零=无涟漪）
  const rippleA = useRef(new Animated.Value(0)).current;
  const rippleB = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const wave = (v: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, { toValue: 1, duration: RIPPLE_DUR, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]));
    const a = wave(rippleA, 0);
    const b = wave(rippleB, RIPPLE_DUR / 2);
    a.start(); b.start();
    return () => { a.stop(); b.stop(); };
  }, []);

  // 识别中：环轨扫描点
  const orbit = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(orbit, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, []);

  const breathScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] });
  const levelScale = levelV.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] });
  const spin = orbit.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const rippleRing = (v: Animated.Value, color: string, fade: Animated.Value) => (
    <Animated.View
      pointerEvents="none"
      style={[s.ripple, {
        borderColor: color,
        opacity: Animated.multiply(v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }), fade),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 2.1] }) }],
      }]}
    />
  );

  const orbLayers: { bg: string; core: string }[] = [
    { bg: ink.accentSoft, core: ink.accent },   // listening
    { bg: ink.streakSoft, core: ink.streak },   // recognizing
    { bg: ink.greenSoft, core: ink.green },     // responding
  ];

  return (
    <View style={s.wrap}>
      {rippleRing(rippleA, ink.accent, fades[0])}
      {rippleRing(rippleB, ink.accent, fades[0])}
      {rippleRing(rippleA, ink.green, fades[2])}
      {rippleRing(rippleB, ink.green, fades[2])}
      <Animated.View style={{ transform: [{ scale: baseScale }] }}>
        <Animated.View style={{ transform: [{ scale: breathScale }] }}>
          <Animated.View style={[s.orb, { transform: [{ scale: levelScale }] }]}>
            {orbLayers.map((l, i) => (
              <Animated.View key={i} style={[s.orbFill, { backgroundColor: l.bg, opacity: fades[i] }]} />
            ))}
            <View style={s.core}>
              {orbLayers.map((l, i) => (
                <Animated.View key={i} style={[s.coreFill, { backgroundColor: l.core, opacity: fades[i] }]} />
              ))}
            </View>
          </Animated.View>
        </Animated.View>
      </Animated.View>
      {/* 识别中：环轨扫描点（随相位淡入淡出） */}
      <Animated.View pointerEvents="none" style={[s.orbit, { opacity: fades[1], transform: [{ rotate: spin }] }]}>
        <View style={[s.orbitDot, { backgroundColor: ink.streak }]} />
      </Animated.View>
    </View>
  );
}

/** 相位文案/按钮的过渡包装：key 变化时淡入 + 轻上移，替代瞬间跳变 */
export function PhaseFade({ k, children }: { k: string; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(1)).current;
  const prev = useRef(k);
  useEffect(() => {
    if (prev.current === k) return;
    prev.current = k;
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: motion.dur.base, useNativeDriver: true }).start();
  }, [k]);
  return (
    <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>
      {children}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center' },
  ripple: { position: 'absolute', width: ORB, height: ORB, borderRadius: ORB / 2, borderWidth: 2 },
  orb: { width: ORB, height: ORB, borderRadius: ORB / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  orbFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: ORB / 2 },
  core: { width: CORE, height: CORE, borderRadius: CORE / 2, overflow: 'hidden' },
  coreFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: CORE / 2 },
  orbit: { position: 'absolute', width: ORB + 26, height: ORB + 26, alignItems: 'center' },
  orbitDot: { width: 8, height: 8, borderRadius: 4, marginTop: -4 },
});
