// Semantic motion tokens for the Living Atlas motion language.
// CSS mirrors these values in `:root` (see living-atlas.css "Motion tokens");
// keep the two in sync.
//
// The language has four motion tiers, each with a single pace. A feature
// picks a tier by what it is, not by tuning a number:
//
//   Tier 0 — instant feedback    (hover / press / focus)      80–160ms
//   Tier 1 — UI re-layout        (sidebar / reorder / controls) 200–320ms
//   Tier 2 — content transition  (card -> story / tile -> fullscreen) 450–700ms
//   Tier 3 — journey / globe narrative (camera fly-to / route draw) 700–1600ms
//
// Everything else is composed from the five primitives in
// `src/motion/primitives/` plus these tokens — no per-feature magic numbers.

export const motionTokens = {
  /** Tier durations — the only durations features should reference. */
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
  /** Named paces kept for legacy call sites; prefer the tier above. */
  durations: {
    microReveal: 240,
    panelEntry: 560,
    morph: 760,
    clusterPulse: 1900,
    arrival: 2400,
    kenburns: 5200,
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
  stagger: {
    base: 140,
  },
  parallax: {
    cardOriginScale: 0.94,
    cardTravelX: 22,
    cardTravelY: 26,
  },
  /** Interaction surface movement budget (Tier 0) — stays within 2–4px. */
  lift: {
    hover: 3,
    press: 1,
  },
  /** Glow is a state, not a decorative border: active core + halo, idle near-zero. */
  glow: {
    coreOpacity: 0.9,
    haloOpacity: 0.35,
    idleOpacity: 0.08,
  },
} as const;

/** The five motion primitives, as stable CSS class names. */
export const motionPrimitiveClass = {
  /** Small state replacement (Tier 1–2): crossfade, content carries the change. */
  fadeThrough: "motion-fade-through",
  /** Card/interactive surface spatial feedback (Tier 0–1): lift, no bounce. */
  lift: "motion-lift",
  /** Thumbnail/card expands into story/fullscreen (Tier 2). */
  sharedExpand: "motion-shared-expand",
  /** Route/light trail grows from 0 -> 1 (Tier 3). */
  draw: "motion-draw",
  /** Globe camera flies from global view to a place (Tier 3). */
  focusFlight: "motion-focus-flight",
} as const;
