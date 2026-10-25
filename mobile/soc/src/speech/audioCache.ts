import { Directory, File, Paths } from 'expo-file-system';
import { fetch } from 'expo/fetch';
let cleaned = false;
export async function cacheAudio(url: string, name: string, signal: AbortSignal): Promise<string> {
  const directory = new Directory(Paths.cache, 'tts');
  if (!directory.exists) directory.create();
  if (!cleaned) {
    cleaned = true;
    directory.list().forEach((file) => { try { file.delete(); } catch {} });
  }
  const target = new File(directory, name);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Audio download failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal.aborted) throw new Error('Audio download cancelled');
    target.create();
    target.write(bytes);
    return target.uri;
  } catch (error) {
    if (target.exists) target.delete();
    throw error;
  }
}
export function removeAudio(uri: string) { try { new File(uri).delete(); } catch {} }
