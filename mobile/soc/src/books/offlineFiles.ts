import { Directory, File, Paths } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { normalizeWav, wavDuration } from './wav';

export async function storeAudio(_key: string, url: string, signal: AbortSignal) {
  const directory = new Directory(Paths.document, 'listening');
  if (!directory.exists) directory.create();
  const file = new File(directory, `${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('语音下载失败');
    const bytes = normalizeWav(new Uint8Array(await response.arrayBuffer()));
    if (signal.aborted) throw new Error('下载已暂停');
    if (bytes.length < 44) throw new Error('语音文件不完整');
    file.create(); file.write(bytes);
    return file.uri;
  } catch (error) { if (file.exists) file.delete(); throw error; }
}
export async function readAudio(uri: string) { return new File(uri).exists ? uri : null; }
export async function audioExists(uri: string) { return new File(uri).exists; }
export async function audioDuration(uri: string) { return wavDuration(await new File(uri).bytes()); }
export async function deleteAudio(uri: string) {
  const root = new Directory(Paths.document, 'listening').uri;
  if (!uri.startsWith(`${root.replace(/\/$/, '')}/`)) return;
  const file = new File(uri); if (file.exists) file.delete();
}
export function releaseAudio(_uri: string) {}
