// 按字重子路径分别导入：barrel `@expo-google-fonts/noto-sans-sc` 的 index.js
// 顶层 require 了全部 9 个字重 ttf，Metro 对 asset require 不 tree-shake，
// 走 barrel 会把 9 个 CJK 字体（每个 ~10.5MB）全打进包。只引用到的 5 个子模块、
// useFonts 直接取自 expo-font，包体省下 ~42MB。
import { NotoSansSC_400Regular } from '@expo-google-fonts/noto-sans-sc/400Regular';
import { NotoSansSC_500Medium } from '@expo-google-fonts/noto-sans-sc/500Medium';
import { NotoSansSC_700Bold } from '@expo-google-fonts/noto-sans-sc/700Bold';
import { NotoSansSC_800ExtraBold } from '@expo-google-fonts/noto-sans-sc/800ExtraBold';
import { NotoSansSC_900Black } from '@expo-google-fonts/noto-sans-sc/900Black';
import { FontDisplay, useFonts } from 'expo-font';
import AsyncStorage from './src/storage';
import { LinearGradient } from 'expo-linear-gradient';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from './src/api';
import { AuthGate } from './src/AuthGate';
import { glassShadow, TabBarHeightCtx } from './src/components/Glass';
import { TabIcon } from './src/components/TabIcon';
import * as data from './src/data';
import * as session from './src/lessonSession';
import FlashcardsScreen from './src/screens/FlashcardsScreen';
import GroupChatScreen from './src/screens/GroupChatScreen';
import LessonScreen from './src/screens/LessonScreen';
import { rescheduleForActiveWorld } from './src/notify';
import SettingsScreen from './src/screens/SettingsScreen';
import TextbooksScreen, { ActiveSel } from './src/screens/TextbooksScreen';
import { loadSettings, saveSettings, Settings } from './src/settings';
import { font, Ink, motion, ThemeMode, ThemeProvider, useTheme } from './src/theme';

const TABS = ['教材', '上课', '群聊', '闪卡', '设置'] as const;
type Tab = (typeof TABS)[number];

const PROFILE_KEY = 'socratopia.llmProfile';

// 原生等待包内字体；网页先用系统字体，下载完成后替换，不阻塞登录。
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    NotoSansSC_400Regular: { uri: NotoSansSC_400Regular, display: FontDisplay.SWAP },
    NotoSansSC_500Medium: { uri: NotoSansSC_500Medium, display: FontDisplay.SWAP },
    NotoSansSC_700Bold: { uri: NotoSansSC_700Bold, display: FontDisplay.SWAP },
    NotoSansSC_800ExtraBold: { uri: NotoSansSC_800ExtraBold, display: FontDisplay.SWAP },
    NotoSansSC_900Black: { uri: NotoSansSC_900Black, display: FontDisplay.SWAP },
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [appReady, setAppReady] = useState(false); // AppInner 首屏就绪信号
  const [splashGone, setSplashGone] = useState(false); // 退场动画跑完才卸载开屏层
  const [startupExpired, setStartupExpired] = useState(false);
  const fontsReady = Platform.OS === 'web' || fontsLoaded || !!fontError || startupExpired;

  function changeTheme(m: ThemeMode) {
    setThemeMode(m);
    if (settings) saveSettings({ ...settings, themeMode: m });
  }

  // 兜底：连接卡住（如网络不通 ping 不返回）也不让开屏永久挂着
  useEffect(() => {
    const t = setTimeout(() => { setAppReady(true); setStartupExpired(true); }, 6000);
    return () => clearTimeout(t);
  }, []);

  return (
    <ThemeProvider mode={themeMode} setMode={changeTheme}>
      <SafeAreaProvider>
        {fontsReady ? (
          <AuthGate onReady={() => setAppReady(true)}>
          <AppInner
            settings={settings}
            setSettings={setSettings}
            setThemeMode={setThemeMode}
            onReady={() => setAppReady(true)}
          />
        </AuthGate>
        ) : null}
        {!splashGone ? (
          <AnimatedSplash exit={fontsReady && appReady} onDone={() => setSplashGone(true)} />
        ) : null}
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

// 开屏退场：原生 splash（静态 logo）→ 就绪后 hideAsync 揭幕到这层同款 JS 覆盖层 →
// logo 轻微放大 1.0→1.08（spring）+ 整屏淡出，跑完卸载。覆盖层 bg 与原生 splash 一致，无缝衔接。
function AnimatedSplash({ exit, onDone }: { exit: boolean; onDone: () => void }) {
  const { ink } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const started = useRef(false);
  useEffect(() => {
    if (!exit || started.current) return;
    started.current = true;
    SplashScreen.hideAsync().catch(() => {}); // 撤掉原生 splash，露出这层同款覆盖层
    Animated.parallel([
      Animated.spring(scale, { toValue: 1.08, friction: 7, tension: 80, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: motion.dur.slow, useNativeDriver: true }),
    ]).start(() => onDone());
  }, [exit]);
  return (
    <Animated.View
      testID="soc-splash"
      pointerEvents={exit ? 'none' : 'auto'}
      style={[StyleSheet.absoluteFill, {
        backgroundColor: ink.canvas, alignItems: 'center', justifyContent: 'center', zIndex: 100, opacity,
      }]}
    >
      <Animated.Image
        source={require('./assets/splash-icon.png')}
        style={{ width: 200, height: 200, resizeMode: 'contain', transform: [{ scale }] }}
      />
    </Animated.View>
  );
}

function AppInner(props: {
  settings: Settings | null;
  setSettings: (s: Settings) => void;
  setThemeMode: (m: ThemeMode) => void;
  onReady: () => void;
}) {
  const { settings, setSettings, setThemeMode, onReady } = props;
  const { ink, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const compactNav = width < 390;

  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('上课');
  const [tabBarH, setTabBarH] = useState(0);
  const [quizConvId, setQuizConvId] = useState<string | null>(null); // 下课后「课后小测」的本课会话 id
  const [llmConfig, setLlmConfig] = useState<data.LlmConfig | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveSel | null>(null);
  const [textbook, setTextbook] = useState<data.TextbookEntry | null>(null);

  async function connect(ns: Settings) {
    api.configureApi(ns);
    await api.ping();
    const [cfg, act] = await Promise.all([data.readLlmConfig(), data.getActive()]);
    setLlmConfig(cfg);
    const saved = await AsyncStorage.getItem(PROFILE_KEY);
    setProfileName(saved && cfg.profiles.some((p) => p.name === saved) ? saved : cfg.active);
    setActive(act);
    if (act?.worldId && act?.textbookId) {
      const idx = await data.readTextbookIndex(act.worldId);
      setTextbook(idx.textbooks.find((t) => t.id === act.textbookId) || null);
    }
    rescheduleForActiveWorld(); // 用最新到期张数排今天的复习提醒（不阻塞连接）
  }

  useEffect(() => {
    (async () => {
      const ns = await loadSettings();
      setSettings(ns);
      setThemeMode(ns.themeMode);
      try {
        await connect(ns);
      } catch {
        setTab('设置'); // 连不上先去设置页
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // 首屏数据就绪 → 通知 App 退场开屏动画
  useEffect(() => { if (ready) onReady(); }, [ready]);

  // 回前台时用当前到期张数刷新提醒（通知文案在调度时固定，靠这里保持新鲜）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') rescheduleForActiveWorld();
    });
    return () => sub.remove();
  }, []);

  const profile = llmConfig?.profiles.find((p) => p.name === profileName) || null;

  return (
    <TabBarHeightCtx.Provider value={tabBarH}>
    <View style={s.root}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {!ready || !settings ? null : (
        <>
          <View style={{ flex: 1 }}>
            {tab === '教材' ? (
              <TextbooksScreen
                active={active}
                onActivated={(sel, tb) => {
                  setActive(sel);
                  setTextbook(tb);
                  session.discard(); // 停听课/朗读引擎 + 丢弃旧课 ctx（引擎不随组件卸载而死）
                  setTab('上课');
                }}
              />
            ) : null}
            {/* 上课页常驻挂载、display 隐藏：切 tab 不丢输入草稿/滚动位置，回来不重拉交接卡 */}
            <View style={{ flex: 1, display: tab === '上课' ? 'flex' : 'none' }}>
              <LessonScreen
                worldId={active?.worldId || null}
                textbook={textbook}
                profile={profile}
                onEnded={(convId) => { setQuizConvId(convId); setTab('闪卡'); }}
              />
            </View>
            {tab === '群聊' ? <GroupChatScreen worldId={active?.worldId || null} profile={profile} /> : null}
            {tab === '闪卡' ? (
              <FlashcardsScreen
                worldId={active?.worldId || null}
                quizConvId={quizConvId}
                onExitQuiz={() => setQuizConvId(null)}
              />
            ) : null}
            {tab === '设置' ? (
              <SettingsScreen
                settings={settings}
                worldId={active?.worldId || null}
                llmConfig={llmConfig}
                profileName={profileName}
                onSaved={async (ns) => {
                  setSettings(ns);
                  await connect(ns);
                }}
                onProfileChange={(name) => {
                  setProfileName(name);
                  AsyncStorage.setItem(PROFILE_KEY, name);
                }}
              />
            ) : null}
          </View>
          <View
            onLayout={(e) => setTabBarH(e.nativeEvent.layout.height)}
            style={[s.tabBarWrap, { paddingBottom: Math.max(insets.bottom, 8) + 6, paddingHorizontal: compactNav ? 10 : 16 }]}
          >
            <View style={[s.liquidDock, compactNav && s.liquidDockCompact, glassShadow(ink, isDark)]}>
              <View style={s.liquidDockClip}>
                <LinearGradient colors={ink.glassPanelGrad} start={{ x: 0.08, y: 0 }} end={{ x: 0.95, y: 1 }} style={StyleSheet.absoluteFill} />
                <View pointerEvents="none" style={s.edgeHighlight} />
                <View pointerEvents="none" style={s.innerRim} />
                <View style={s.tabRow}>
                  {TABS.map((t) => (
                    <TabButton
                      key={t}
                      tab={t}
                      active={t === tab}
                      onPress={() => { setTab(t); setQuizConvId(null); }}
                    />
                  ))}
                </View>
              </View>
            </View>
          </View>
        </>
      )}
    </View>
    </TabBarHeightCtx.Provider>
  );
}

// 底栏按钮：5 个等宽常显（图标在上、文字在下）。
// 选中态动效：图标 spring 放大 1.14，accentSoft 圆底淡入。
// 只对图标叶子节点做 transform，不包裹任何 FlatList 祖先（规避 Fabric + useNativeDriver transform 崩溃）。
function TabButton(props: { tab: Tab; active: boolean; onPress: () => void }) {
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const scale = useRef(new Animated.Value(props.active ? 1.14 : 1)).current;
  const pillOpacity = useRef(new Animated.Value(props.active ? 1 : 0)).current;

  const prevActive = useRef(props.active);
  useEffect(() => {
    if (prevActive.current === props.active) return;
    prevActive.current = props.active;
    Animated.parallel([
      Animated.spring(scale, {
        toValue: props.active ? 1.14 : 1,
        ...motion.springSnappy, useNativeDriver: true,
      }),
      Animated.timing(pillOpacity, {
        toValue: props.active ? 1 : 0,
        duration: motion.dur.fast, useNativeDriver: true,
      }),
    ]).start();
  }, [props.active]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      accessibilityLabel={props.tab}
      hitSlop={6}
      onPress={props.onPress}
      style={({ pressed }) => [s.tabBtn, pressed && { opacity: 0.6 }]}
    >
      <View style={s.iconWrap}>
        <Animated.View style={[s.iconPill, { opacity: pillOpacity }]} />
        <Animated.View style={{ transform: [{ scale }] }}>
          <TabIcon name={props.tab} color={props.active ? ink.accent : ink.muted} />
        </Animated.View>
      </View>
      <Text numberOfLines={1} style={[s.tabText, props.active && s.tabTextOn]}>
        {props.tab}
      </Text>
    </Pressable>
  );
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.canvas },
  tabBarWrap: {
    paddingTop: 8,
    backgroundColor: 'transparent',
    alignItems: 'center',
  },
  liquidDock: {
    width: '100%',
    maxWidth: 430,
    borderRadius: 26,
    backgroundColor: ink.glassFill,
  },
  liquidDockCompact: { borderRadius: 24 },
  liquidDockClip: {
    minHeight: 50,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: ink.glassSolid,
  },
  edgeHighlight: {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
    borderRadius: 26, borderTopWidth: 1, borderColor: ink.glassHighlight,
  },
  innerRim: {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
    borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, borderColor: ink.glassBorder,
  },
  tabRow: {
    minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingHorizontal: 8, paddingVertical: 4,
  },
  tabBtn: {
    flex: 1, minHeight: 44, flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 2, paddingVertical: 3,
  },
  iconWrap: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  iconPill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 14, backgroundColor: ink.accentSoft },
  tabText: { fontFamily: font.sansMed, fontSize: 10, color: ink.muted },
  tabTextOn: { fontFamily: font.sansBold, color: ink.accent },
});
