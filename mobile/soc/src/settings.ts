import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ThemeMode } from './theme';
import { readToken, writeToken } from './tokenStore';
export type Settings = { serverUrl: string; token: string; themeMode: ThemeMode };
const KEY = 'startrips.soc.settings';
export async function loadSettings(): Promise<Settings> {
  const raw = await AsyncStorage.getItem(KEY);
  const saved = raw ? JSON.parse(raw) : {};
  const serverUrl = Platform.OS === 'web' ? window.location.origin : saved.serverUrl || process.env.EXPO_PUBLIC_STARTRIPS_ORIGIN || '';
  return { serverUrl, token: await readToken(serverUrl), themeMode: saved.themeMode || 'system' };
}
export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify({ serverUrl: settings.serverUrl, themeMode: settings.themeMode }));
  await writeToken(settings.serverUrl, settings.token);
}
