// Semantic motion tokens for the Living Atlas motion language.
// Canonical principles and acceptance: docs/motion-language.md.
// Spatial interactions require interruptible springs with position/velocity
// continuity; the durations/easings here serve timeline/fade and legacy callers,
// and do not themselves implement a spring or impose its completion time.
// CSS mirrors these values in `:root` (see src/styles/tokens.css);
// keep the two in sync.
//
// The language has four motion tiers describing semantic pace. A feature
// picks a tier by what it is, not by tuning a number:
//
//   Tier 0 — instant feedback    (hover / press / focus)      80–160ms
//   Tier 1 — UI re-layout        (sidebar / reorder / controls) 200–320ms
//   Tier 2 — content transition  (card -> story / tile -> fullscreen) 450–700ms
//   Tier 3 — journey / globe narrative (camera fly-to / route draw) 700–1600ms
//
// Everything else is composed from the motion primitives listed in
// docs/motion-language.md plus these tokens — no per-feature magic numbers.

export const motionTokens = {
  /** Unit-mass spring response shared by DOM motion and its scalar integrator. */
  spring: { stiffness: 300, damping: 28 },
  /** Shared timeline/fade durations; not fixed completion times for springs. */
  tiers: {
    /** Tier 0: instant feedback for hover / press / focus. */
    instant: 120,
    /** Tier 1: UI re-layout (sidebar collapse, grid reorder, controls). */
    ui: 260,
    /** Tier 2: content transitions where the media itself is the transition object. */
    content: 560,
    /** Tier 3: journey / globe narrative — slow start, steady cruise, soft settle. */
    journey: 980,
  },
  easings: {
    // Long ease-out tails for spatial motion (Tier 1–2).
    easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
    easeSoft: "cubic-bezier(0.2, 0.75, 0.15, 1)",
    // #17 spec: soft ease-out for lift / micro feedback (Tier 0–1).
    easeOutSoft: "cubic-bezier(0.22, 0.72, 0.24, 1)",
    // #17 spec: spatial in-out for journey camera and route drawing (Tier 3).
    easeInOutSpatial: "cubic-bezier(0.65, 0, 0.35, 1)",
  },
  /** Glow is a state, not a decorative border: active core + halo, idle near-zero. */
  glow: {
    coreOpacity: 0.9,
    haloOpacity: 0.35,
    idleOpacity: 0.08,
  },
} as const;
