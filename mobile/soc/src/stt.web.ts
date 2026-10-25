import { useEffect, useMemo } from 'react';
import { createBrowserVoiceCapture } from './browserVoiceCapture';
import { resolveVoiceCreds, transcribeAudio } from './voice';
import type { VoiceCapture } from './stt';

export function useVoiceCapture(): VoiceCapture {
  const capture = useMemo(() => createBrowserVoiceCapture(resolveVoiceCreds, transcribeAudio), []);
  useEffect(() => () => capture.cancel(), [capture]);
  return capture;
}
