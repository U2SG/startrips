# Startrips Motion Language

The Living Atlas has exactly one motion language. Every effect in the product
composes from the tokens and primitives below; features never introduce their
own durations, easings, or transition recipes.

Keywords: **quiet / restrained · spatial continuity · soft light ·
depth, not bounce · content carries the transition.**

## Motion tiers

A feature picks a tier by what it is — never by tuning a number.

| Tier | Purpose | Duration | Notes |
| --- | --- | --- | --- |
| **Tier 0** | Instant feedback (hover / press / focus) | 80–160ms (`--motion-instant: 120ms`) | Movement ≤ 2–4px, no overshoot |
| **Tier 1** | UI re-layout (sidebar, reorder, controls) | 200–320ms (`--motion-ui: 260ms`) | `transform + opacity`; FLIP layout changes |
| **Tier 2** | Content transitions (card→story, tile→fullscreen) | 450–700ms (`--motion-content: 560ms`) | The content is the transition object; background recedes |
| **Tier 3** | Journey / globe narrative (camera fly-to, route draw) | 700–1600ms (`--motion-journey: 980ms`) | Slow start, steady cruise, soft settle; no modal easing |

## Tokens

Shared TS tokens: `src/motion/tokens.ts` → `motionTokens.tiers.*`,
`motionTokens.easings.*`.

CSS mirrors in global `:root` of `src/styles/tokens.css`:

```css
--motion-instant: 120ms;
--motion-ui: 260ms;
--motion-content: 560ms;
--motion-journey: 980ms;

--motion-ease-out: cubic-bezier(0.16, 1, 0.3, 1);            /* spatial ease-out */
--motion-ease-soft: cubic-bezier(0.2, 0.75, 0.15, 1);        /* soft settle */
--motion-ease-out-soft: cubic-bezier(0.22, 0.72, 0.24, 1);   /* lift / micro */
--motion-ease-in-out-spatial: cubic-bezier(0.65, 0, 0.35, 1);/* camera / draw */
```

Three.js code must import the JS helpers from `src/motion/tokens.ts`
(`motionTokens.tiers.journey`, `motionTokens.easings.easeInOutSpatial`), never
repeat the numbers.

## Five motion primitives

Everything else is a combination of these five:

1. **fade-through** — small state replacement (`motion-fade-through`).
2. **lift** — card/interactive surface spatial feedback (`motion-lift`;
   hover −3px, press −1px, no scale bounce).
3. **shared-expand** — thumbnail/card expands into story/fullscreen
   (`motion-shared-expand`; View Transitions API via
   `src/motion/primitives/sharedElement.ts`).
4. **draw** — route/light trail grows 0 → 1 (`motion-draw`).
5. **focus-flight** — globe camera flies from global view to a place
   (`motion-focus-flight`; driving JS in `ParticleEarthScene`).

## Glow discipline

- Glow is a **state**, not a decorative border.
- Active state: core + halo (`motionTokens.glow.coreOpacity` /
  `haloOpacity`); idle stays at very low opacity (`idleOpacity`).
- Never more than one strong glow focal point per screen.
- Soundtrack light strip, route halo, and active point share one luminance
  rhythm.

## Motion priority

At most one Tier 2/3 main animation at a time. Example — opening a Journey:

1. The card cover becomes the transition object.
2. Sidebar / background noise drops.
3. Story text enters last.

Never animate card, route, globe, sidebar, and title simultaneously.

## Reduced motion

One unified strategy: `useReducedMotion()` (React) /
`prefersReducedMotion()` (one-shot) from `src/motion/preferences.ts`.

- Tier 2/3 degrade to a crossfade or an instant state.
- Continuous particle drift / route pulse / soundtrack strip flow stops
  (CSS `@media (prefers-reduced-motion: reduce)` block in
  `living-atlas.css`).
- Spatial relationships and affordances stay clear.

## Rules

- No new `transition: all 0.3s ease` anywhere.
- No new per-feature duration/easing literals.
- New motion composes from the five primitives and the Tier tokens.
- `motionPrimitiveClass` in `src/motion/tokens.ts` is the canonical name list.
