// Semantic motion tokens for the Living Atlas motion language.
// CSS mirrors these values in `:root` (see living-atlas.css "Motion tokens");
// keep the two in sync.

export const motionTokens = {
  durations: {
    microReveal: 240,
    panelEntry: 560,
    morph: 760,
    clusterPulse: 1900,
    arrival: 2400,
    kenburns: 5200,
  },
  easings: {
    // Long ease-out tails for spatial motion.
    easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
    easeSoft: "cubic-bezier(0.2, 0.75, 0.15, 1)",
  },
  stagger: {
    base: 140,
  },
  parallax: {
    cardOriginScale: 0.94,
    cardTravelX: 22,
    cardTravelY: 26,
  },
} as const;
