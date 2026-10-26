import AsyncStorage from '@react-native-async-storage/async-storage';
let scope = '';
export const storageScope = () => scope;
export function setStorageScope(origin: string, userId: string) { scope = `${origin}/${userId}`; }
const key = (name: string) => {
  if (!scope) throw new Error('请先登录');
  return `startrips.soc/${scope}/${name}`;
};
export default {
  getItem: (name: string) => AsyncStorage.getItem(key(name)),
  setItem: (name: string, value: string) => AsyncStorage.setItem(key(name), value),
  removeItem: (name: string) => AsyncStorage.removeItem(key(name)),
};
