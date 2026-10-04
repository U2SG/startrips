import { motionTokens } from "../motion/tokens";

/**
 * A one-shot playback of the `full` signature clip at a brand node (the Atlas
 * wordmark, an accepted invitation). It never owns input: the clip runtime's
 * own pointerdown/keydown interruption is the only skip path, and the product
 * stays usable underneath the whole time.
 *
 * - `playing`: the clip is mounted and running.
 * - `leaving`: the clip ended, was skipped, or was released because the
 *   product it accompanied is ready; it fades for one Tier 1 beat. A second
 *   `play` in this window is ignored, so the click that follows the
 *   pointerdown which skipped the clip does not immediately replay it.
 */
export type SignatureMomentPhase = "idle" | "playing" | "leaving";

export type SignatureMomentEvent =
  | { type: "play"; reducedMotion: boolean }
  | { type: "end" }
  | { type: "release" }
  | { type: "faded" };

export const SIGNATURE_MOMENT_FADE_MS = motionTokens.tiers.ui;

export function signatureMomentReducer(
  phase: SignatureMomentPhase,
  event: SignatureMomentEvent,
): SignatureMomentPhase {
  switch (event.type) {
    case "play":
      // Reduced motion does not play the clip at all; the static mark stays.
      return phase === "idle" && !event.reducedMotion ? "playing" : phase;
    case "end":
    case "release":
      return phase === "playing" ? "leaving" : phase;
    case "faded":
      return phase === "leaving" ? "idle" : phase;
  }
}
