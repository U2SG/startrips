import { ALL_FORMATS, AudioSampleSink, AudioSampleSource, BlobSource, Input, canEncodeAudio, type Output } from "mediabunny";
import { FILM_AUDIO_BITRATE } from "./journeyFilmBudget";

const AUDIO_CONFIG = { numberOfChannels: 2, sampleRate: 48_000, bitrate: FILM_AUDIO_BITRATE };
let fallbackRegistration: Promise<void> | null = null;

async function ensureAacEncoder(signal: AbortSignal): Promise<void> {
  if (await canEncodeAudio("aac", AUDIO_CONFIG)) return;
  signal.throwIfAborted();
  // The same pinned upstream library supplies the AAC-LC fallback. Load it
  // only on browsers without native AAC; never substitute a silent export.
  fallbackRegistration ??= import("@mediabunny/aac-encoder").then(({ registerAacEncoder }) => { registerAacEncoder(); })
    .catch((error) => { fallbackRegistration = null; throw error; });
  try { await fallbackRegistration; }
  catch (error) { signal.throwIfAborted(); throw new Error("journey_film_audio_codec_unavailable", { cause: error }); }
  signal.throwIfAborted();
  if (!await canEncodeAudio("aac", AUDIO_CONFIG)) throw new Error("journey_film_audio_codec_unavailable");
}

/** Bounded decoded-sample queue; music is interleaved with video, never whole-film PCM. */
export async function prepareJourneyFilmSoundtrack(
  blob: Blob, output: Output, durationSeconds: number, signal: AbortSignal,
): Promise<{ addUntil: (seconds: number) => Promise<void>; close: () => void; dispose: () => Promise<void> }> {
  signal.throwIfAborted();
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const abort = () => input.dispose();
  signal.addEventListener("abort", abort, { once: true });
  let samples: ReturnType<AudioSampleSink["samples"]> | null = null;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !await track.canDecode()) throw new Error("journey_film_soundtrack_unsupported");
    const start = Math.max(0, await track.getFirstTimestamp());
    const end = await input.computeDuration([track]);
    if (!Number.isFinite(end) || end <= start || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("journey_film_soundtrack_unsupported");
    }
    await ensureAacEncoder(signal);
    signal.throwIfAborted();
    const source = new AudioSampleSource({ codec: "aac", bitrate: FILM_AUDIO_BITRATE,
      transform: { numberOfChannels: AUDIO_CONFIG.numberOfChannels, sampleRate: AUDIO_CONFIG.sampleRate } });
    output.addAudioTrack(source);
    const sink = new AudioSampleSink(track);
    let cursor = 0;
    let loopStart = 0;
    let disposed = false;
    samples = sink.samples(start, end);
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", abort);
      input.dispose();
      await samples?.return().catch(() => {});
      samples = null;
    };
    return {
      async addUntil(seconds) {
        const target = Math.min(seconds, durationSeconds);
        while (cursor < target - 1 / AUDIO_CONFIG.sampleRate) {
          signal.throwIfAborted();
          const decoded = await samples!.next();
          if (decoded.done) {
            signal.throwIfAborted();
            if (cursor <= loopStart) throw new Error("journey_film_soundtrack_unsupported");
            loopStart = cursor;
            samples = sink.samples(start, end);
            continue;
          }
          const sample = decoded.value;
          let trimmed: typeof sample | null = null;
          try {
            signal.throwIfAborted();
            // Preserve PCM order, remove negative codec preroll, and trim only
            // the final sample to the exact film end. Each loop resumes at the
            // previous sample's end, avoiding accumulated container padding.
            const first = Math.max(0, Math.ceil((start - sample.timestamp) * sample.sampleRate));
            const available = Math.min(sample.numberOfFrames, Math.floor((end - sample.timestamp) * sample.sampleRate + 1e-6));
            const remainingFrames = Math.round((durationSeconds - cursor) * sample.sampleRate);
            // The exact video end can fall between low-rate input PCM frames.
            // Less than half an input frame is complete, not an empty loop.
            if (remainingFrames <= 0) { cursor = durationSeconds; return; }
            const last = Math.min(available, first + remainingFrames);
            if (last <= first) continue;
            trimmed = sample.trim(first, last);
            trimmed.setTimestamp(cursor);
            await source.add(trimmed);
            signal.throwIfAborted();
            cursor += trimmed.duration;
          } finally { trimmed?.close(); sample.close(); }
        }
      },
      close: () => source.close(),
      dispose,
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    input.dispose();
    await samples?.return().catch(() => {});
    signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith("journey_film_")) throw error;
    throw new Error("journey_film_soundtrack_unsupported", { cause: error });
  }
}
