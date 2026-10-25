import * as SecureStore from 'expo-secure-store';
const KEY = 'startrips.soc.session';
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
