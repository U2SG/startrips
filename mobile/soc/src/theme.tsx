import React, { createContext, useContext } from 'react';
import { Platform, useColorScheme } from 'react-native';

// ── Apple Glass 令牌（来自 v1.1 设计稿 · 暖纸 + 蓝）──────────────────────
// 浅深两套同构（键一一对应）。玻璃 / 渐变是 v1.1 新增项。
export const lightInk = {
  canvas: '#eeeae2', raised: '#fbfaf6', sunken: 'rgba(60,50,30,0.10)', sidebar: '#f3ede0',
  border: 'rgba(60,50,30,0.12)', fg: '#17150f', muted: '#8a8276',
  accent: '#3a78d4', accentSoft: 'rgba(58,120,212,0.12)',
  green: '#34b460', greenSoft: 'rgba(52,180,96,0.14)',
  red: '#d4423a', redSoft: 'rgba(212,66,58,0.12)',
  streak: '#d68a2b', streakSoft: 'rgba(214,138,43,0.14)',
  // 玻璃：blur 之上的半透明给色层 + 边 + 顶部高光
  blurTint: 'light' as 'light' | 'dark',
  // 实底仿玻璃（Android blur 不可用，用近不透明底保证可读，再叠给色光泽）
  glassSolid: 'rgba(251,250,246,0.92)',
  glassFill: 'rgba(250,249,245,0.42)',
  glassBorder: 'rgba(255,255,255,0.5)',
  glassHighlight: 'rgba(255,255,255,0.85)',
  // blur 之上的渐变给色（左上亮→右下淡）：导航/坞 vs 气泡/选项
  glassPanelGrad: ['rgba(255,255,255,0.6)', 'rgba(255,255,255,0.16)'] as [string, string],
  glassBubbleGrad: ['rgba(255,255,255,0.74)', 'rgba(255,255,255,0.4)'] as [string, string],
  shadow: '#2a200a',
  // 页面背景的暖蓝光晕（给玻璃折射用）
  glowA: 'rgba(58,120,212,0.18)',
  glowB: 'rgba(214,138,43,0.16)',
};

export const darkInk: typeof lightInk = {
  canvas: '#100f0c', raised: '#1b1915', sunken: 'rgba(255,250,235,0.10)', sidebar: '#16140f',
  border: 'rgba(255,250,235,0.10)', fg: '#f1ece0', muted: '#9a9183',
  accent: '#5e9be6', accentSoft: 'rgba(94,155,230,0.18)',
  green: '#54c07a', greenSoft: 'rgba(84,192,122,0.16)',
  red: '#f08a82', redSoft: 'rgba(240,138,130,0.16)',
  streak: '#e0a64a', streakSoft: 'rgba(224,166,74,0.18)',
  blurTint: 'dark',
  glassSolid: 'rgba(27,25,21,0.90)',
  glassFill: 'rgba(40,37,30,0.45)',
  glassBorder: 'rgba(255,255,255,0.12)',
  glassHighlight: 'rgba(255,255,255,0.20)',
  glassPanelGrad: ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.04)'],
  glassBubbleGrad: ['rgba(255,255,255,0.13)', 'rgba(255,255,255,0.04)'],
  shadow: '#000000',
  glowA: 'rgba(94,155,230,0.22)',
  glowB: 'rgba(224,166,74,0.16)',
};

export type Ink = typeof lightInk;
export type ThemeMode = 'system' | 'light' | 'dark';

// accent 渐变（按钮 / FAB / 我方气泡 / 进度条）——浅深两版同款蓝
export const accentGrad = ['#5a93e6', '#3a78d4'] as const;

type ThemeCtx = { ink: Ink; isDark: boolean; mode: ThemeMode; setMode: (m: ThemeMode) => void };
const Ctx = createContext<ThemeCtx>(null as any);
export const useTheme = () => useContext(Ctx);

export function ThemeProvider(p: { mode: ThemeMode; setMode: (m: ThemeMode) => void; children: React.ReactNode }) {
  const sys = useColorScheme();
  const isDark = p.mode === 'dark' || (p.mode === 'system' && sys === 'dark');
  const value: ThemeCtx = { ink: isDark ? darkInk : lightInk, isDark, mode: p.mode, setMode: p.setMode };
  return <Ctx.Provider value={value}>{p.children}</Ctx.Provider>;
}

// 圆角：玻璃坞 20–24 · 卡 18–20 · 气泡 17/5 · 胶囊 10–14
export const radius = {
  sm: 10, md: 12, lg: 14, xl: 16, xxl: 20,
  pill: 14, bubble: 17, card: 20, nav: 22, dock: 24,
} as const;
export const space = (n: number) => n * 8;

// 字体族名 = @expo-google-fonts 导出的 key。v1.1 全部走 Noto Sans SC（含 800/900），
// 不再用衬线 / 等宽体；数字统一加 `tnum` 取 tabular-nums。
const fontFamily = (name: string) => Platform.OS === 'web' ? `${name}, system-ui, sans-serif` : name;
export const font = {
  sans: fontFamily('NotoSansSC_400Regular'),
  med: fontFamily('NotoSansSC_500Medium'),
  bold: fontFamily('NotoSansSC_700Bold'),
  extra: fontFamily('NotoSansSC_800ExtraBold'),
  black: fontFamily('NotoSansSC_900Black'),
  // 向后兼容别名（旧屏引用，已重映射到 Noto Sans；serif/mono 不再有衬线/等宽含义）
  sansMed: fontFamily('NotoSansSC_500Medium'),
  sansBold: fontFamily('NotoSansSC_700Bold'),
  serif: fontFamily('NotoSansSC_700Bold'),
  serifBlack: fontFamily('NotoSansSC_900Black'),
  mono: fontFamily('NotoSansSC_500Medium'),
} as const;

// 字号：大标题 30/900 · 卡标题 18/800 · headline 15/600 · 正文 14/400 · 副标 11/500
export const type_ = { xs: 11, small: 13, body: 14, lead: 15, title: 18, display: 30 } as const;

// 所有数字行加上它（tabular-nums，不再用等宽字体）
export const tnum: { fontVariant: ['tabular-nums'] } = { fontVariant: ['tabular-nums'] };

// ── 设计语言 token（design/DESIGN.md · Warm Liquid Glass）─────────────────
// 统一柔影梯度：替代各屏零散 shadow 写法。e1 小卡/Row · e2 卡/输入坞/导航条 · e3 Modal/语音浮层。
// shadow 色随主题（ink.shadow，暖调），故做成 ink 的函数。
export const elev = (ink: Ink, level: 1 | 2 | 3) => {
  const m = { 1: { o: 0.10, r: 6, y: 2, e: 2 }, 2: { o: 0.16, r: 14, y: 8, e: 4 }, 3: { o: 0.22, r: 24, y: 14, e: 8 } }[level];
  return { shadowColor: ink.shadow, shadowOpacity: m.o, shadowRadius: m.r, shadowOffset: { width: 0, height: m.y }, elevation: m.e };
};

// 动效：spring 偏轻快（Eames 节制律动），统一时长。全部 useNativeDriver: true。
export const motion = {
  springLight: { friction: 8, tension: 90 },   // 消息进场等
  springSnappy: { friction: 6, tension: 120 }, // tab 选中 / 按压回弹
  dur: { fast: 160, base: 240, slow: 450 },    // fast=微交互 base=过渡 slow=开屏退场
} as const;

// expo-blur intensity 梯度（CSS blur 16/20/24 的近似映射；上限 75 勿超）。Android 走 glassSolid 实底回退。
export const blurI = { bubble: 45, panel: 60, modal: 75 } as const;
