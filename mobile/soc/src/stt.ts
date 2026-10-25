// 语音采集（带静音自动断句 VAD）：用于「语音对话模式」的免手听写。
// 录音格式钉 16kHz 单声道 m4a/aac（qwen3-asr-flash 要求 16k mono）；开启 metering 实时读音量判静音。
import { useCallback, useRef } from 'react';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { resolveVoiceCreds, transcribeAudio } from './voice';

// 录完恢复成播放用的 audioMode（与 LessonScreen mount 时一致），否则录音后 TTS 不出声
const PLAYBACK_MODE = { allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' as const };

// VAD 参数（真机可微调）。阈值不再写死：跟踪环境噪声底自适应——
// 固定 -38dB 在安静环境听不到轻声说话、嘈杂环境永远「在说话」不断句，两头都表现为不灵敏。
const SPEECH_OVER_FLOOR_DB = 10; // 高于噪声底这么多视为「在说话」
const SPEECH_DB_MIN = -50;       // 阈值下限：环境极静时防呼吸声/衣料摩擦误触
const SPEECH_DB_MAX = -28;       // 阈值上限：环境很吵时仍能断句
const FLOOR_RISE_PER_TICK = 0.15; // 噪声底缓慢上爬（≈2dB/s）：环境变吵能跟上；变静由「取最小」即时跟下
const SILENCE_MS = 850;    // 说过话后，连续静音超过这个时长即断句
const MIN_SPEECH_MS = 350; // 太短的声音（咳嗽/碰撞）不算一句
const MAX_MS = 30000;      // 单句硬上限
const NOSPEECH_MS = 9000;  // 一直没人说话就放弃这一轮
const POLL_MS = 80;

/** dB → 0..1，给说话动效用（-60dB≈静音，-10dB≈大声） */
function levelOf(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 50));
}

export type VoiceCapture = {
  /** 录一句（VAD 自动断句）并识别成文字；cancel/无人说话返回 ''。
   *  onLevel 实时回传 0..1 音量；onRecognizing 在停录、开始网络识别时触发一次（用于切「识别中」相位）。 */
  listen: (onLevel?: (v: number) => void, onRecognizing?: () => void) => Promise<string>;
  /** 中止当前 listen（用户退出语音模式时调用） */
  cancel: () => void;
};

// 麦克风权限只请求一次（每轮 listen 重复弹系统调用是轮间「聋区」的来源之一）
let micGranted = false;

export function useVoiceCapture(): VoiceCapture {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    sampleRate: 16000,
    numberOfChannels: 1,
    isMeteringEnabled: true,
  });
  const cancelled = useRef(false);
  const stopPoll = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    cancelled.current = true;
    stopPoll.current?.();
  }, []);

  const listen = useCallback(async (onLevel?: (v: number) => void, onRecognizing?: () => void): Promise<string> => {
    cancelled.current = false;
    let spokeMs = 0;
    try {
      if (!micGranted) {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) throw new Error('需要麦克风权限');
        micGranted = true;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();

      // 轮询 metering 做 VAD：说过话后静音达阈值即停；超时/无声/取消也停。
      // 阈值 = 噪声底 + SPEECH_OVER_FLOOR_DB（噪声底取观测最小值即时跟下、缓慢上爬，自适应环境）。
      await new Promise<void>((resolve) => {
        let silenceMs = 0;
        let elapsed = 0;
        let floor = Number.NaN; // 首个采样初始化
        let smooth = 0;         // 动效音量：快起慢落（起=瞬时，落≈0.66s 归零），消除 UI 阶跃
        const id = setInterval(() => {
          if (cancelled.current) return done();
          const st = recorder.getStatus();
          const db = st.metering ?? -160;
          floor = Number.isNaN(floor) ? db : db < floor ? db : floor + FLOOR_RISE_PER_TICK;
          const threshold = Math.max(SPEECH_DB_MIN, Math.min(SPEECH_DB_MAX, floor + SPEECH_OVER_FLOOR_DB));
          const raw = levelOf(db);
          smooth = raw > smooth ? raw : Math.max(raw, smooth - 0.12);
          onLevel?.(smooth);
          elapsed += POLL_MS;
          if (db > threshold) { spokeMs += POLL_MS; silenceMs = 0; }
          else if (spokeMs > 0) { silenceMs += POLL_MS; }
          const endpoint = spokeMs >= MIN_SPEECH_MS && silenceMs >= SILENCE_MS;
          if (endpoint || elapsed >= MAX_MS || (spokeMs === 0 && elapsed >= NOSPEECH_MS)) done();
        }, POLL_MS);
        const done = () => { clearInterval(id); stopPoll.current = null; resolve(); };
        stopPoll.current = done;
      });

      await recorder.stop();
      await setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
      if (cancelled.current || spokeMs < MIN_SPEECH_MS) return '';
      onRecognizing?.(); // 进入「识别中」相位：停录后到出字这 1-2s 不让动效冻住

      const uri = recorder.uri;
      if (!uri) return '';
      const creds = await resolveVoiceCreds();
      if (!creds) throw new Error('未配置 Qwen / DashScope，无法语音识别');
      const base64 = await new File(uri).base64();
      return await transcribeAudio(creds, base64, 'm4a');
    } catch (e) {
      await setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
      throw e;
    }
  }, [recorder]);

  return { listen, cancel };
}
