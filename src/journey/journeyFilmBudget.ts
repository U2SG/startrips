export const FILM_VIDEO_BITRATE = 4_000_000;
export const FILM_AUDIO_BITRATE = 128_000;
/** Estimate only: VBR and muxing vary. Storage enforces its independent runtime byte bound. */
export function estimateJourneyFilmOutputBytes(durationMs: number, soundtrack: boolean): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("journey_film_output_limit");
  const bytes = Math.ceil(durationMs / 1000 * (FILM_VIDEO_BITRATE + (soundtrack ? FILM_AUDIO_BITRATE : 0)) / 8 * 1.2) + 2 * 1024 * 1024;
  if (!Number.isSafeInteger(bytes)) throw new Error("journey_film_output_limit");
  return bytes;
}
