import { playbackMediaWaitPolicy, type PlaybackStep } from "./journeyPlayback";
import { videoTrimHoldsStep, type VideoTrimSeekStatus } from "./videoTrimPlayback";
import type { DecodedReadiness } from "./mediaPrefetch";
import type { MediaReadState as MediaRead } from "./mediaReadRefresh";
import type { JourneyMediaAsset } from "./types";

export type PlaybackMediaGate = "waiting" | "ready" | "error";

/**
 * Why playback is waiting on the current beat, if it is.
 *
 * #197 needs `decode` separable from the rest: a video beat legitimately holds
 * the director for its whole runtime, and a trim positions the element before
 * its segment starts. Neither is a symptom of a lookahead that stayed fixed
 * while tempo got faster, so a capture that counted them all as one number
 * could not tell continuity apart from ordinary video playback.
 */
export type PlaybackHoldReason = "none" | "decode" | "video" | "trim";

/**
 * The single decision behind the hold, taken from already-resolved inputs so it
 * is unit-checkable without a journey, a director or a DOM.
 */
export function playbackHoldReason(input: {
  /** The current step's kind; `undefined` outside a run. */
  stepKind: PlaybackStep["kind"] | undefined;
  /** The asset this beat may wait on: a media step's own, or a stop's first image. */
  asset: JourneyMediaAsset | null;
  gate: PlaybackMediaGate;
  /** This asset has already failed to play, so the legacy fallback timer owns the beat. */
  videoPlaybackFailed: boolean;
  /** The trim transport's status when the segment owns this beat, else null. */
  trimStatus: VideoTrimSeekStatus | null;
}): PlaybackHoldReason {
  const { stepKind, asset, gate } = input;
  if (!asset) return "none";
  // A stop step waits only for its first image to be decodable, so the frame it
  // hands to the media step is never blank.
  if (stepKind === "stop") return gate === "waiting" ? "decode" : "none";
  if (stepKind !== "media") return "none";
  if (input.videoPlaybackFailed) return "none";
  if (input.trimStatus) return videoTrimHoldsStep(input.trimStatus) ? "trim" : "none";
  switch (playbackMediaWaitPolicy(asset, gate)) {
    case "decode":
      return "decode";
    case "video-ended":
      return "video";
    case "none":
      return "none";
  }
}

export function playbackMediaGate(
  read: MediaRead | null | undefined,
  decodeReadiness: DecodedReadiness | undefined,
  isImage: boolean,
): PlaybackMediaGate {
  if (!read || read.status === "loading") return "waiting";
  if (read.status === "error") return "error";
  if (!isImage) return "ready";
  if (decodeReadiness?.status === "error") return "error";
  return decodeReadiness?.status === "decoded" ? "ready" : "waiting";
}

export function playbackChapterOpeningUrl(
  stepKind: PlaybackStep["kind"] | undefined,
  asset: Pick<JourneyMediaAsset, "mimeType"> | null,
  read: MediaRead | null | undefined,
  decodeReadiness: DecodedReadiness | undefined,
): string | null {
  if (stepKind !== "stop" || !asset?.mimeType.startsWith("image/")) return null;
  if (playbackMediaGate(read, decodeReadiness, true) !== "ready") return null;
  return read?.status === "ready" ? read.url : null;
}
