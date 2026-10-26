import Storage from '../storage';
import { sessionGuard } from '../accountScope';
import { VOICE_GROUPS } from '../voice';

let voices: Record<string, string> = {};
const listeners = new Set<() => void>();
let writes: Promise<void> = Promise.resolve();
export const subscribeVoices = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getVoices = () => voices;
export function resetVoices() { voices = {}; }
export async function loadVoices() {
  const guard = sessionGuard();
  const raw = await Storage.getItem('listening/voices'); guard();
  try { voices = raw ? JSON.parse(raw) : {}; } catch { voices = {}; }
  return voices;
}
export async function setVoice(speaker: string, voice: string) {
  if (!VOICE_GROUPS.some((group) => group.voices.includes(voice))) throw new Error('音色不可用');
  const guard = sessionGuard();
  const write = writes.then(async () => {
    guard(); const next = { ...voices, [speaker]: voice };
    await Storage.setItem('listening/voices', JSON.stringify(next)); guard();
    voices = next; listeners.forEach((fn) => fn());
  });
  writes = write.catch(() => {});
  return write;
}
export function passageVoice(speaker: string, fallback: string, dramatic: boolean) {
  return dramatic ? voices[speaker] || (speaker === '旁白' ? voices['旁白'] || fallback : fallback) : voices['旁白'] || 'Cherry';
}
