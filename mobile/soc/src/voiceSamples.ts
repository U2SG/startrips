import Storage, { storageScope } from './storage';
import { accountGeneration, sessionGuard } from './accountScope';
import { synthesizeChunk } from './voice';
import { ParagraphCache } from './books/paragraphCache';
import * as files from './books/offlineFiles';

let current: { scope: string; generation: number; cache: ParagraphCache } | null = null;
const sample = '你好，很高兴认识你。';
export async function voiceSample(voice: string, signal: AbortSignal) {
  const scope = storageScope();
  const generation = accountGeneration();
  if (!current || current.scope !== scope || current.generation !== generation) current = { scope, generation, cache: new ParagraphCache({
    guard: sessionGuard(), namespace: `${scope}/voice-samples`,
    read: () => Storage.getItem('voice-samples'), write: (value) => Storage.setItem('voice-samples', value),
    store: files.storeAudio, open: files.readAudio, duration: files.audioDuration, remove: files.deleteAudio, release: files.releaseAudio,
  }) };
  return current.cache.get(JSON.stringify(['qwen3-tts-flash', voice, sample]), signal,
    () => synthesizeChunk({ model: 'qwen3-tts-flash' }, sample, voice, signal));
}
