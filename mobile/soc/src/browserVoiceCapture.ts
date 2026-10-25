export function createBrowserVoiceCapture<T>(
  resolveCredentials: (signal: AbortSignal) => Promise<T | null>,
  transcribe: (credentials: T, audio: string, format: string, signal: AbortSignal) => Promise<string>,
) {
  let current: AbortController | null = null;
  const cancel = () => current?.abort();
  async function listen(onLevel?: (value: number) => void, onRecognizing?: () => void): Promise<string> {
    cancel();
    const controller = new AbortController();
    current = controller;
    const { signal } = controller;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let finish: (() => void) | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('浏览器不支持录音，请使用 App');
      const credentials = await resolveCredentials(signal);
      if (signal.aborted) return '';
      if (!credentials) throw new Error('请先配置语音模型');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
      if (signal.aborted) return '';
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const chunks: BlobPart[] = [];
      let spoke = 0, silence = 0, elapsed = 0, floor = 0.005;
      const samples = new Float32Array(analyser.fftSize);
      const blob = await new Promise<Blob>((resolve, reject) => {
        let timer: ReturnType<typeof setInterval> | undefined;
        finish = () => { clearInterval(timer); if (recorder.state !== 'inactive') recorder.stop(); };
        signal.addEventListener('abort', finish, { once: true });
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => { clearInterval(timer); reject(new Error('录音失败，请重试')); };
        recorder.onstop = () => { clearInterval(timer); resolve(new Blob(chunks, { type: mime })); };
        recorder.start();
        void context!.resume();
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          floor = Math.min(floor + 0.00002, rms);
          onLevel?.(Math.min(1, rms * 12));
          elapsed += 80;
          if (rms > Math.max(0.007, floor * 3)) { spoke += 80; silence = 0; } else if (spoke) silence += 80;
          if ((spoke >= 350 && silence >= 850) || elapsed >= 30000 || (!spoke && elapsed >= 9000)) finish?.();
        }, 80);
      });
      if (signal.aborted || spoke < 350) return '';
      onRecognizing?.();
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('无法读取录音'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(blob);
      });
      if (signal.aborted) return '';
      const text = await transcribe(credentials, encoded, mime.endsWith('mp4') ? 'mp4' : 'webm', signal);
      return signal.aborted ? '' : text;
    } catch (error) {
      if (signal.aborted) return '';
      throw error;
    } finally {
      if (finish) { signal.removeEventListener('abort', finish); finish(); }
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close();
      if (current === controller) current = null;
    }
  }
  return { listen, cancel };
}
