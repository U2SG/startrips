import React, { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as api from './api';
import * as data from './data';
import * as session from './lessonSession';
import { loadSettings, saveSettings } from './settings';
import { setStorageScope } from './storage';
import { font, useTheme } from './theme';
import { writeToken } from './tokenStore';
import { cancelReminders } from './notify';

type User = { id: string; name: string; email: string };
const signOutListeners = new Set<() => void>();
export function requestSignOut() { signOutListeners.forEach((listener) => listener()); }

export function AuthGate({ children, onReady }: { children: ReactNode; onReady: () => void }) {
  const { ink } = useTheme();
  const [user, setUser] = useState<User | null>(null);
  const [origin, setOrigin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  async function acceptUser(next: User) {
    setStorageScope(api.serverCfg().serverUrl, next.id);
    data.clearProfileCache();
    setUser(next);
  }
  async function clearSession() {
    session.discard();
    await cancelReminders();
    await writeToken(api.serverCfg().serverUrl, '');
    api.clearCredentials();
    data.clearProfileCache();
    setUser(null);
    setPassword('');
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const settings = await loadSettings();
        api.configureApi(settings);
        setOrigin(settings.serverUrl);
        if (settings.serverUrl && (settings.token || Platform.OS === 'web')) {
          const response = await api.authFetch('/api/soc/session');
          if (response.ok && live) await acceptUser((await response.json()).user);
        }
      } catch { if (live) setError('连接失败，请检查网络后重试'); }
      finally { if (live) { setBusy(false); onReady(); } }
    })();
    const expired = api.onUnauthorized(() => { void clearSession(); });
    const signOut = () => { void api.authFetch('/api/auth/sign-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).finally(clearSession); };
    signOutListeners.add(signOut);
    return () => { live = false; expired(); signOutListeners.delete(signOut); };
  }, []);

  async function signIn() {
    setError(''); setBusy(true);
    try {
      const server = new URL(Platform.OS === 'web' ? window.location.origin : origin.trim());
      if (server.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(server.hostname)) throw new Error('服务器地址需要使用 HTTPS');
      const settings = await loadSettings();
      api.configureApi({ serverUrl: server.origin, token: '' });
      const response = await api.authFetch('/api/auth/sign-in/email', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.origin },
        body: JSON.stringify({ email: email.trim(), password, rememberMe: true }),
      });
      if (!response.ok) {
        const value = await response.json();
        throw new Error(value.code === 'EMAIL_NOT_VERIFIED' ? '请先验证邮箱' : '登录失败，请检查邮箱和密码');
      }
      if (Platform.OS !== 'web' && !api.serverCfg().token) throw new Error('服务器尚未支持 App 登录，请更新服务器');
      await saveSettings({ ...settings, ...api.serverCfg() });
      const check = await api.authFetch('/api/soc/session');
      if (!check.ok) throw new Error('登录已失效，请重试');
      await acceptUser((await check.json()).user);
      setPassword('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '登录失败'); }
    finally { setBusy(false); }
  }
  if (user) return <React.Fragment key={user.id}>{children}</React.Fragment>;
  const input = [styles.input, { backgroundColor: ink.raised, color: ink.fg, borderColor: ink.border }];
  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: ink.canvas }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.form}>
        <Text style={[styles.title, { color: ink.fg }]}>小苏</Text>
        {Platform.OS !== 'web' ? <TextInput accessibilityLabel="服务器地址" style={input} placeholder="https://example.com" placeholderTextColor={ink.muted} value={origin} onChangeText={setOrigin} autoCapitalize="none" keyboardType="url" /> : null}
        <TextInput accessibilityLabel="邮箱" style={input} placeholder="邮箱" placeholderTextColor={ink.muted} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
        <TextInput accessibilityLabel="密码" style={input} placeholder="密码" placeholderTextColor={ink.muted} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" onSubmitEditing={() => void signIn()} />
        {error ? <Text accessibilityRole="alert" style={{ color: ink.red }}>{error}</Text> : null}
        <Pressable accessibilityRole="button" disabled={busy || !email || !password} onPress={() => void signIn()} style={[styles.button, { backgroundColor: ink.accent, opacity: busy ? 0.5 : 1 }]}>
          <Text style={{ color: ink.canvas, fontFamily: font.bold }}>{busy ? '连接中…' : '登录'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  form: { width: '100%', maxWidth: 360, gap: 16 },
  title: { fontSize: 32, fontFamily: font.bold, marginBottom: 16 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, fontSize: 16 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
});
