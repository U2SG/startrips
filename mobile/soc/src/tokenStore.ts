import * as SecureStore from 'expo-secure-store';
const KEY = 'startrips.soc.session';
const OFFLINE_KEY = 'startrips.soc.offline-user';
export type OfflineUser = { id: string; name: string; email: string };
export async function readOfflineUser(origin: string): Promise<OfflineUser | null> {
  const raw = await SecureStore.getItemAsync(OFFLINE_KEY);
  if (!raw) return null;
  const saved = JSON.parse(raw);
  return saved.origin === origin ? saved.user : null;
}
export async function writeOfflineUser(origin: string, user: OfflineUser | null) {
  if (user) await SecureStore.setItemAsync(OFFLINE_KEY, JSON.stringify({ origin, user }), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(OFFLINE_KEY);
}
export async function readToken(origin: string): Promise<string> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return '';
  const saved = JSON.parse(raw);
  return saved.origin === origin ? saved.token : '';
}
export async function writeToken(origin: string, token: string): Promise<void> {
  if (token) await SecureStore.setItemAsync(KEY, JSON.stringify({ origin, token }), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(KEY);
}
