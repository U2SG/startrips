/**
 * #367 slice 3: the Journey cover reveal lifecycle, expressed as data.
 *
 * This module is deliberately pure — it imports nothing from `vendor/`, touches
 * no DOM and starts no timer — so the rules that matter to the product can be
 * asserted in the default node test environment. `CoverRevealStage.tsx` is the
 * only place that binds this lifecycle to the vendored renderer.
 *
 * The invariant the whole slice exists to protect: the canonical original cover
 * is the Journey's media truth, and the generated first image is a derived
 * opening asset. So `settled` always displays the original cover, and the
 * generated image can never be the terminal state — not on a reduced-motion
 * request, not when WebGL2 is missing, not when the reveal is interrupted, and
 * not when image loading fails.
 */

export type RevealPresetId =
  | "ink-bloom"
  | "guided-ribbon"
  | "brush-sweep"
  | "fiber-soak"
  | "mist-veil";

export type CoverRevealPhase = "idle" | "preparing" | "revealing" | "settled";

/** The backend the stage actually obtained, not the one it wanted. */
export type CoverRevealBackend = "webgl2" | "unavailable";

export type CoverRevealImagePair = {
  /** The generated opening asset shown first. Never terminal. */
  generatedFirst: string;
  /** The canonical original Journey cover. Always terminal. */
  originalCover: string;
};

export type CoverRevealRequest = {
  /**
   * Monotonic ownership revision. A request, a load result or a frame carrying
   * an older revision belongs to an intent the viewer has already replaced.
   */
  revision: number;
  pair: CoverRevealImagePair;
  preset: RevealPresetId;
  reducedMotion: boolean;
  backend: CoverRevealBackend;
};

export type CoverRevealEvent =
  | { type: "request"; request: CoverRevealRequest }
  | { type: "images-loaded"; revision: number }
  | { type: "frame"; revision: number; progress: number }
  | { type: "complete"; revision: number }
  | { type: "interrupt"; revision: number }
  | { type: "failed"; revision: number; reason: string }
  | { type: "renderer-failed"; revision: number; reason: string }
  | { type: "release" };

/** Why the reveal resolved straight to the cover instead of animating. */
export type CoverRevealSettleReason =
  | "reduced-motion"
  | "no-webgl2"
  | "interrupted"
  | "load-failed"
  | "renderer-failed"
  | "completed";

export type CoverRevealState = {
  phase: CoverRevealPhase;
  revision: number;
  /** The image the viewer is looking at. `null` only before anything is ready. */
  displayedImage: string | null;
  pair: CoverRevealImagePair | null;
  preset: RevealPresetId | null;
  /** True when the reveal could not run as designed and said so honestly. */
  degraded: boolean;
  reducedMotion: boolean;
  backend: CoverRevealBackend | null;
  settleReason: CoverRevealSettleReason | null;
  /** Reveal frames actually accepted. A degraded or reduced-motion reveal has none. */
  frameCount: number;
  progress: number;
  error: string | null;
};

export const initialCoverRevealState: CoverRevealState = {
  phase: "idle",
  revision: 0,
  displayedImage: null,
  pair: null,
  preset: null,
  degraded: false,
  reducedMotion: false,
  backend: null,
  settleReason: null,
  frameCount: 0,
  progress: 0,
  error: null,
};

export type CoverRevealPlan = {
  /** `reveal` runs the renderer; `immediate` resolves to the cover with no reveal. */
  mode: "reveal" | "immediate";
  degraded: boolean;
  reason: CoverRevealSettleReason | null;
  /** The image the plan ends on. Always the canonical original cover. */
  finalImage: string;
};

/**
 * Decide, before anything is loaded or painted, whether this request can be
 * revealed at all.
 *
 * A missing WebGL2 backend resolves straight to the original cover rather than
 * playing the vendored Canvas2D cross-fade: a cross-fade between a generated
 * image and the real cover would read as a reveal that the device never
 * actually rendered. Reporting `degraded` and showing the truth is honest;
 * substituting a different animation is not.
 */
export function planCoverReveal(request: CoverRevealRequest): CoverRevealPlan {
  const finalImage = request.pair.originalCover;
  if (request.backend !== "webgl2") {
    return { mode: "immediate", degraded: true, reason: "no-webgl2", finalImage };
  }
  if (request.reducedMotion) {
    return { mode: "immediate", degraded: false, reason: "reduced-motion", finalImage };
  }
  return { mode: "reveal", degraded: false, reason: null, finalImage };
}

const settle = (
  state: CoverRevealState,
  reason: CoverRevealSettleReason,
  extra: Partial<CoverRevealState> = {},
): CoverRevealState => ({
  ...state,
  phase: "settled",
  // The cover is the only terminal image there is.
  displayedImage: state.pair ? state.pair.originalCover : state.displayedImage,
  progress: 1,
  settleReason: reason,
  ...extra,
});

/** A revision older than the one the lifecycle currently owns commits nothing. */
const owns = (state: CoverRevealState, revision: number) => revision === state.revision;

export function coverRevealReducer(
  state: CoverRevealState,
  event: CoverRevealEvent,
): CoverRevealState {
  switch (event.type) {
    case "request": {
      const { request } = event;
      // A superseded intent cannot take ownership back, and a repeat of the
      // current revision cannot restart a reveal the viewer already resolved.
      if (request.revision < state.revision) return state;
      if (request.revision === state.revision && state.phase !== "idle") return state;
      const plan = planCoverReveal(request);
      const requested: CoverRevealState = {
        ...initialCoverRevealState,
        revision: request.revision,
        pair: request.pair,
        preset: request.preset,
        reducedMotion: request.reducedMotion,
        backend: request.backend,
        degraded: plan.degraded,
      };
      if (plan.mode === "immediate") {
        return settle(requested, plan.reason ?? "completed", { error: null });
      }
      return { ...requested, phase: "preparing", displayedImage: null };
    }
    case "images-loaded": {
      if (!owns(state, event.revision) || state.phase !== "preparing") return state;
      return { ...state, phase: "revealing", displayedImage: state.pair?.generatedFirst ?? null };
    }
    case "frame": {
      if (!owns(state, event.revision) || state.phase !== "revealing") return state;
      const progress = Math.min(1, Math.max(0, event.progress));
      return { ...state, frameCount: state.frameCount + 1, progress };
    }
    case "complete": {
      if (!owns(state, event.revision) || state.phase === "idle") return state;
      return settle(state, "completed");
    }
    case "interrupt": {
      if (!owns(state, event.revision) || state.phase === "idle") return state;
      // An interruption ends the reveal at the cover immediately; it does not
      // freeze the viewer on a half-dissolved generated image.
      return settle(state, "interrupted");
    }
    case "failed": {
      if (!owns(state, event.revision) || state.phase === "idle") return state;
      return settle(state, "load-failed", { degraded: true, error: event.reason });
    }
    case "renderer-failed": {
      // The renderer went away while it still owned the screen - it could not be
      // constructed at all, or its graphics context was lost mid-reveal. Either
      // way the viewer gets the canonical cover instead of an unpainted canvas
      // or a half-dissolved generated image.
      if (!owns(state, event.revision)) return state;
      // A loss arriving after the lifecycle already settled changes nothing:
      // that reveal really did finish, and it is not retroactively degraded.
      if (state.phase !== "preparing" && state.phase !== "revealing") return state;
      return settle(state, "renderer-failed", { degraded: true, error: event.reason });
    }
    case "release":
      return { ...initialCoverRevealState, revision: state.revision };
    default:
      return state;
  }
}

/** Fold a whole event sequence. Handy for tests and for replaying a session. */
export function runCoverReveal(
  events: readonly CoverRevealEvent[],
  state: CoverRevealState = initialCoverRevealState,
): CoverRevealState {
  return events.reduce(coverRevealReducer, state);
}
