import { useCallback, useRef } from 'react';
import { resolveVoiceCreds, transcribeAudio } from './voice';
import type { VoiceCapture } from './stt';

export function useVoiceCapture(): VoiceCapture {
  const cancelCurrent = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => cancelCurrent.current?.(), []);
  const listen = useCallback(async (onLevel?: (value: number) => void, onRecognizing?: () => void): Promise<string> => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('浏览器不支持录音，请使用 App');
    const credentials = await resolveVoiceCreds();
    if (!credentials) throw new Error('请先配置语音模型');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: BlobPart[] = [];
    let cancelled = false;
    let spoke = 0;
    let silence = 0;
    let elapsed = 0;
    let floor = 0.005;
    const samples = new Float32Array(analyser.fftSize);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        let timer: ReturnType<typeof setInterval>;
        const finish = () => { clearInterval(timer); if (recorder.state !== 'inactive') recorder.stop(); };
        cancelCurrent.current = () => { cancelled = true; finish(); };
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => { clearInterval(timer); reject(new Error('录音失败，请重试')); };
        recorder.onstop = () => { clearInterval(timer); resolve(new Blob(chunks, { type: mime })); };
        recorder.start();
        void context.resume();
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          floor = Math.min(floor + 0.00002, rms);
          onLevel?.(Math.min(1, rms * 12));
          elapsed += 80;
          if (rms > Math.max(0.007, floor * 3)) { spoke += 80; silence = 0; } else if (spoke) silence += 80;
          if ((spoke >= 350 && silence >= 850) || elapsed >= 30000 || (!spoke && elapsed >= 9000)) finish();
        }, 80);
      });
      if (cancelled || spoke < 350) return '';
      onRecognizing?.();
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('无法读取录音'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(blob);
      });
      return await transcribeAudio(credentials, encoded, mime.endsWith('mp4') ? 'mp4' : 'webm');
    } finally {
      cancelCurrent.current = null;
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
    }
  }, []);
  return { listen, cancel };
}
