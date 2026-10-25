import { Directory, File, Paths } from 'expo-file-system';
let cleaned = false;
export async function cacheAudio(url: string, name: string): Promise<string> {
  const directory = new Directory(Paths.cache, 'tts');
  if (!directory.exists) directory.create();
  if (!cleaned) {
    cleaned = true;
    directory.list().forEach((file) => { try { file.delete(); } catch {} });
  }
  const target = new File(directory, name);
  if (target.exists) target.delete();
  return (await File.downloadFileAsync(url, target)).uri;
}
export function removeAudio(uri: string) { try { new File(uri).delete(); } catch {} }
