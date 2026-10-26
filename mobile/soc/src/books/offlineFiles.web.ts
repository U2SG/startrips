import { wavDuration } from './wav';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('startrips-soc-listening', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('audio');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('audio', mode);
      const request = run(tx.objectStore('audio'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('离线存储不可用'));
    });
  } finally { db.close(); }
}
export async function storeAudio(key: string, url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('语音下载失败');
  const blob = await response.blob();
  if (signal.aborted) throw new Error('下载已暂停');
  if (blob.size < 44) throw new Error('语音文件不完整');
  await transaction('readwrite', (store) => store.put(blob, key));
  return key;
}
export async function readAudio(key: string) {
  const blob = await transaction<Blob | undefined>('readonly', (store) => store.get(key));
  return blob ? URL.createObjectURL(blob) : null;
}
export async function deleteAudio(key: string) { await transaction('readwrite', (store) => store.delete(key)); }
export async function audioDuration(uri: string) { return wavDuration(new Uint8Array(await (await fetch(uri)).arrayBuffer())); }
export function releaseAudio(uri: string) { if (uri.startsWith('blob:')) URL.revokeObjectURL(uri); }
