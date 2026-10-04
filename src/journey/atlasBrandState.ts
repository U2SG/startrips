import type { StartripsBrandState } from "../brand/StartripsBrandMark";
import { motionTokens } from "../motion/tokens";

/** One-shot brand moments the Atlas wordmark plays at meaningful nodes. */
export type AtlasBrandMoment = "travel" | "arrived";

/**
 * Durations mirror `src/styles/brand-mark.css`: enter runs content * 1.9 and
 * arrive runs content * 1.25, so the reset lands as the keyframes finish.
 */
export function atlasBrandMomentDuration(moment: AtlasBrandMoment) {
  return motionTokens.tiers.content * (moment === "travel" ? 1.9 : 1.25);
}

/**
 * Reduced motion keeps the wordmark at rest. An in-flight Journey mutation
 * breathes; a one-shot moment plays only once nothing is pending, so a slow
 * refresh after a save cannot swallow the arrive motion.
 */
export function resolveAtlasBrandState({
  reduceMotion,
  pending,
  moment,
}: {
  reduceMotion: boolean;
  pending: boolean;
  moment: AtlasBrandMoment | null;
}): StartripsBrandState {
  if (reduceMotion) return "rest";
  if (pending) return "waiting";
  return moment ?? "rest";
}
