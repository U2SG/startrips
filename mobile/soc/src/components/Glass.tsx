import { LinearGradient } from 'expo-linear-gradient';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Keyboard, Platform, LayoutChangeEvent, Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { accentGrad, font, radius as R, useTheme } from '../theme';

// 底部 tab bar 高度（App 实测后下发，供浮玻璃屏把输入坞抬到键盘上方时扣除）
export const TabBarHeightCtx = createContext(0);
export const useTabBarHeight = () => useContext(TabBarHeightCtx);

// 键盘高度（edge-to-edge 下 Android 不自动 resize，手动抬升输入坞用）
export function useKeyboardHeight() {
  const [h, setH] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => setH(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setH(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return h;
}

// ── 玻璃面板 ──────────────────────────────────────────────
// 真 backdrop blur（Android 走 dimezisBlurView）+ 半透明渐变给色 + 0.5px 玻璃边 + 顶部高光。
// 模糊在某些 Android 上失效时，给色层本身就是半透明 frosted 卡面，不会糊成一片。
export function GlassPanel(props: {
  children?: React.ReactNode;
  rounded?: number;
  intensity?: number;
  tone?: 'panel' | 'bubble';
  style?: StyleProp<ViewStyle>; // 外形/定位（含 padding 也可）
  contentStyle?: StyleProp<ViewStyle>;
  onLayout?: (e: LayoutChangeEvent) => void; // 实测高度用（外层 wrapper 上）
}) {
  const { ink } = useTheme();
  const rounded = props.rounded ?? R.nav;
  const give = props.tone === 'bubble' ? ink.glassBubbleGrad : ink.glassPanelGrad;
  // 单角收窄（如气泡尖角）从 style 里取出，透传到真正裁切的内层 BlurView，
  // 否则放在外层无背景 wrapper 上不可见、内层仍按统一圆角裁切。
  const flat = StyleSheet.flatten(props.style) || {};
  const corners = {
    borderRadius: rounded,
    borderTopLeftRadius: flat.borderTopLeftRadius ?? rounded,
    borderTopRightRadius: flat.borderTopRightRadius ?? rounded,
    borderBottomLeftRadius: flat.borderBottomLeftRadius ?? rounded,
    borderBottomRightRadius: flat.borderBottomRightRadius ?? rounded,
  };
  // 外层 wrapper 承载定位 / 投影（不 clip，否则 iOS 阴影被 overflow:hidden 裁掉）；
  // 内层：圆角 + overflow + 近不透明实底（glassSolid）叠一层给色光泽。安卓上 expo-blur 真模糊要
  // BlurTargetView 接线且难验证，故统一用干净实底——不透字、稳定、跨平台一致。
  return (
    <View style={[corners, props.style]} onLayout={props.onLayout}>
      <View style={[corners, { overflow: 'hidden', backgroundColor: ink.glassSolid }]}>
        {/* 给色光泽：左上亮 → 右下淡 */}
        <LinearGradient colors={give} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
        {/* 顶部 1px 高光 */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, corners, { borderTopWidth: 1, borderTopColor: ink.glassHighlight }]} />
        {/* 全周玻璃边 */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, corners, { borderWidth: StyleSheet.hairlineWidth, borderColor: ink.glassBorder }]} />
        <View style={props.contentStyle}>{props.children}</View>
      </View>
    </View>
  );
}

// 玻璃坞的悬浮投影（绝对定位的容器外层用）
export function glassShadow(ink: { shadow: string }, isDark: boolean) {
  return {
    shadowColor: ink.shadow,
    shadowOpacity: isDark ? 0.55 : 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  } as const;
}

// ── 顶部玻璃导航条（分组玻璃 B 屏：教材/闪卡/设置）────────────
// 半透明系统栏感：blur + 给色 + 底部 hairline。内容区需留出它的高度。
export function GlassHeader(props: {
  title?: string;
  big?: boolean;            // 大标题（30/900）
  right?: React.ReactNode;
  children?: React.ReactNode; // 自定义内容（如教材的分类胶囊行），给了则忽略 title
  extraTop?: number;
}) {
  const { ink } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[hs.wrap, { paddingTop: insets.top + (props.extraTop ?? 6), borderBottomColor: ink.glassBorder, backgroundColor: ink.glassSolid }]}
    >
      {props.children ?? (
        <View style={hs.row}>
          <Text style={[props.big ? hs.big : hs.title, { color: ink.fg }]} numberOfLines={1}>{props.title}</Text>
          {props.right}
        </View>
      )}
    </View>
  );
}

// 绝对定位的光晕层（放在各屏根容器首个子元素，给玻璃折射暖蓝光）
export function GlowLayer() {
  const { ink } = useTheme();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={[ink.glowA, 'transparent']} start={{ x: 0.9, y: 0 }} end={{ x: 0.3, y: 0.55 }} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={['transparent', ink.glowB]} start={{ x: 0.25, y: 0.55 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
    </View>
  );
}

// ── accent 渐变主按钮 ─────────────────────────────────────
export function GradientButton(props: {
  label: string;
  sub?: string;
  onPress: () => void;
  disabled?: boolean;
  height?: number;
  rounded?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable onPress={props.onPress} disabled={props.disabled} style={props.style}>
      {({ pressed }) => (
        <LinearGradient
          colors={accentGrad}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={[
            gs.btn,
            { height: props.height ?? 50, borderRadius: props.rounded ?? R.xl },
            (pressed || props.disabled) && { opacity: 0.6 },
          ]}
        >
          <Text style={gs.btnText}>{props.label}</Text>
          {props.sub ? <Text style={gs.btnSub}>{props.sub}</Text> : null}
        </LinearGradient>
      )}
    </Pressable>
  );
}

// ── 圆形发送 FAB（↑）──────────────────────────────────────
export function GradientFab(props: { onPress: () => void; disabled?: boolean; size?: number }) {
  const size = props.size ?? 38;
  return (
    <Pressable onPress={props.onPress} disabled={props.disabled} hitSlop={8}>
      {({ pressed }) => (
        <LinearGradient
          colors={accentGrad}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={[
            { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' },
            (pressed || props.disabled) && { opacity: 0.5 },
          ]}
        >
          <Text style={{ color: '#fff', fontSize: 18, lineHeight: 20, transform: [{ translateY: -1 }] }}>↑</Text>
        </LinearGradient>
      )}
    </Pressable>
  );
}

// ── 脉动小圆点（在线点 2.2s / 计时暖点 1.4s）────────────────
export function PulseDot({ color, size = 6, period = 1400 }: { color: string; size?: number; period?: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: period / 2, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: period / 2, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [period]);
  return (
    <Animated.View
      style={{
        width: size, height: size, borderRadius: size / 2, backgroundColor: color,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] }) }],
      }}
    />
  );
}

// ── 朗读波形（4 条上下跳动的 bar）────────────────────────────
export function SpeakWave({ color, label }: { color: string; label?: string }) {
  const bars = [useRef(new Animated.Value(0.4)).current, useRef(new Animated.Value(0.4)).current,
    useRef(new Animated.Value(0.4)).current, useRef(new Animated.Value(0.4)).current];
  useEffect(() => {
    const loops = bars.map((b, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * 150),
      Animated.timing(b, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.timing(b, { toValue: 0.35, duration: 400, useNativeDriver: true }),
    ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 7 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 13 }}>
        {bars.map((b, i) => (
          <Animated.View key={i} style={{ width: 2.5, height: 13, borderRadius: 2, backgroundColor: color, transform: [{ scaleY: b }] }} />
        ))}
      </View>
      {label ? <Text style={{ fontSize: 11, fontFamily: font.med, color }}>{label}</Text> : null}
    </View>
  );
}

const gs = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnText: { color: '#fff', fontSize: 16, fontFamily: font.bold },
  btnSub: { color: 'rgba(255,255,255,0.82)', fontSize: 13, fontFamily: font.med, fontVariant: ['tabular-nums'] },
});

const hs = StyleSheet.create({
  wrap: { paddingHorizontal: 18, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  title: { fontSize: 18, fontFamily: font.extra },
  big: { fontSize: 30, fontFamily: font.black, letterSpacing: -0.5 },
});
