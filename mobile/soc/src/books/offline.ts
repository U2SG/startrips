import Storage, { storageScope } from '../storage';
import { sessionGuard } from '../accountScope';
import * as files from './offlineFiles';
import { OfflineShelf } from './offlineStore';
let current: { scope: string; shelf: OfflineShelf } | null = null;
export function shelf() {
  const scope = storageScope();
  if (!current || current.scope !== scope) {
    current = { scope, shelf: new OfflineShelf({
      guard: sessionGuard(), namespace: scope,
      read: () => Storage.getItem('listening/downloads'), write: (value) => Storage.setItem('listening/downloads', value),
      store: files.storeAudio, remove: files.deleteAudio,
    }) };
  }
  return current.shelf;
}
export function resetShelf() { current = null; }
