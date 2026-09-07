import type { SemanticZoomSnapshot } from "./semanticZoom";

/**
 * The Semantic Earth Dive controller (#252 phase A).
 *
 * This module is the state, progress and ownership contract for moving from the
 * particle Earth into detailed geography. Three rules shape it:
 *
 * 1. `semanticZoom.ts` is the single zoom authority. The Dive consumes the
 *    snapshot that authority publishes and declares no zoom boundary, clamp or
 *    range of its own — the cuts below are normalized positions inside the
 *    `local` band, not zoom values.
 * 2. Readiness, never elapsed time, reveals the detail surface. Nothing in this
 *    file takes a clock, so no timeout can uncover an unready map.
 * 3. Stage and interaction owner are different state. A renderer may be mounted,
 *    or even fully visible, without owning the camera; opacity never decides
 *    ownership.
 */
export type EarthDiveStage = "particle" | "prewarm" | "blending" | "detail";

/** Who is authoritative for camera and gesture input on this frame. */
export type EarthDiveOwner = "particle" | "detail";

/**
 * How far the detail renderer has come. #252 §3: `visual-ready` — the renderer
 * can draw the handoff frame — is the gate for a safe blend. Waiting for
 * `fully-settled` would strand the Dive on a slow or retrying network.
 */
export type DetailReadiness = "unavailable" | "mounted" | "visual-ready" | "fully-settled";

const STAGE_ORDER: EarthDiveStage[] = ["particle", "prewarm", "blending", "detail"];
const READINESS_ORDER: DetailReadiness[] = [
  "unavailable",
  "mounted",
  "visual-ready",
  "fully-settled",
];

/** The readiness level at which a blend may begin. */
export const EARTH_DIVE_BLEND_READINESS: DetailReadiness = "visual-ready";

export function canBlendDetail(readiness: DetailReadiness) {
  return READINESS_ORDER.indexOf(readiness) >= READINESS_ORDER.indexOf(EARTH_DIVE_BLEND_READINESS);
}

// Normalized cuts inside the `local` band. Entry and release differ on purpose:
// a camera resting on a cut must not flip the stage back and forth.
export const EARTH_DIVE_BLEND_ENTER_PROGRESS = 0.45;
export const EARTH_DIVE_BLEND_EXIT_PROGRESS = 0.3;
export const EARTH_DIVE_DETAIL_ENTER_PROGRESS = 0.8;
export const EARTH_DIVE_DETAIL_EXIT_PROGRESS = 0.65;

// The blend is a presentation length the section publishes to CSS. Reduced
// motion shortens it; it never removes a stage or relaxes the readiness gate.
export const EARTH_DIVE_BLEND_MS = 900;
export const EARTH_DIVE_REDUCED_MOTION_BLEND_MS = 120;

export function earthDiveBlendMs(reduceMotion: boolean) {
  return reduceMotion ? EARTH_DIVE_REDUCED_MOTION_BLEND_MS : EARTH_DIVE_BLEND_MS;
}

export type EarthDiveInput = {
  /** The zoom authority's own reading: which band, and how deep inside it. */
  snapshot: SemanticZoomSnapshot;
  /** How far the detail renderer has come. */
  readiness: DetailReadiness;
  /** The focus intent this handoff was armed against. */
  handoffRevision: number;
  /** The focus intent that is current on this frame. */
  focusRevision: number;
  /**
   * The fallback command — the accessibility control — asking for the same
   * dive. It grants the zoom gate only: the readiness gate and the stage order
   * still apply, so a command can never reveal an unready map.
   */
  commandRequested?: boolean;
  /**
   * The detail owner handing the camera back. It relinquishes OWNERSHIP only;
   * whether the Dive leaves altogether is still the band's decision.
   */
  releaseRequested?: boolean;
  reduceMotion?: boolean;
};

export type EarthDiveState = {
  stage: EarthDiveStage;
  owner: EarthDiveOwner;
  blendMs: number;
};

export const INITIAL_EARTH_DIVE_STATE: EarthDiveState = {
  stage: "particle",
  owner: "particle",
  blendMs: EARTH_DIVE_BLEND_MS,
};

function stageIndex(stage: EarthDiveStage) {
  return STAGE_ORDER.indexOf(stage);
}

/**
 * The stage the inputs alone justify, before ordering is applied.
 *
 * Asymmetric release lives here: leaving the Dive entirely requires the band to
 * fall to `macro` or below, so an oscillation across the `regional`/`local` edge
 * cannot flip the stage, and each progress cut releases later than it engages.
 */
function targetStage(previous: EarthDiveStage, input: EarthDiveInput): EarthDiveStage {
  const {
    snapshot,
    readiness,
    handoffRevision,
    focusRevision,
    commandRequested = false,
    releaseRequested = false,
  } = input;

  // The one way back to `particle`. `regional` holds the prewarm rather than
  // tearing it down, which is what makes the release asymmetric. The fallback
  // command is the accessibility path into the same dive from anywhere, so it
  // stands in for the zoom gate here and nowhere else.
  if (!commandRequested && (snapshot.level === "planet" || snapshot.level === "macro")) {
    return "particle";
  }

  // A handoff still in flight and armed against an older focus intent is
  // stale: the place it was aligned to is no longer the place the user is
  // looking at, so it resolves AWAY from `detail` on this frame rather than
  // finishing first. A handoff that already committed is not torn down — the
  // map owns the view by then, and a re-focus is an ordinary map flight.
  const pending = previous === "prewarm" || previous === "blending";
  if (pending && handoffRevision < focusRevision) return "prewarm";

  // The detail owner giving the camera back: ownership ends, the prewarmed
  // renderer stays, and the band decides whether the Dive ends too.
  if (releaseRequested) return "prewarm";

  if (!canBlendDetail(readiness)) return "prewarm";

  // `regional` prewarms; only `local` — or the fallback command — is deep
  // enough to blend.
  if (snapshot.level !== "local" && !commandRequested) return "prewarm";

  const progress = commandRequested ? 1 : snapshot.localProgress;
  const inDetail = previous === "detail";
  const inBlend = previous === "blending" || inDetail;

  if (progress >= (inDetail ? EARTH_DIVE_DETAIL_EXIT_PROGRESS : EARTH_DIVE_DETAIL_ENTER_PROGRESS)) {
    return "detail";
  }
  if (progress >= (inBlend ? EARTH_DIVE_BLEND_EXIT_PROGRESS : EARTH_DIVE_BLEND_ENTER_PROGRESS)) {
    return "blending";
  }
  return "prewarm";
}

/**
 * Resolve one frame of the Dive.
 *
 * The stage advances at most one step per frame in either direction, so the
 * published progression is always `particle -> prewarm -> blending -> detail`
 * and its reverse: a frame that jumps several bands at once still passes
 * through every stage rather than skipping one.
 *
 * Ownership is separate state carried in `previous`, not a reading of the
 * stage: it transfers exactly once, on the commit edge into `detail`, and comes
 * home the moment the stage leaves `detail`. Exactly one owner is authoritative
 * on every frame.
 */
export function resolveEarthDive(
  previous: EarthDiveState,
  input: EarthDiveInput,
): EarthDiveState {
  const target = stageIndex(targetStage(previous.stage, input));
  const current = stageIndex(previous.stage);
  const stage = target === current
    ? previous.stage
    : STAGE_ORDER[current + (target > current ? 1 : -1)];

  const committing = stage === "detail" && previous.stage === "blending";
  const owner: EarthDiveOwner = stage !== "detail"
    ? "particle"
    : committing || previous.owner === "detail"
      ? "detail"
      : "particle";

  return { stage, owner, blendMs: earthDiveBlendMs(Boolean(input.reduceMotion)) };
}
