# Visited imprint V1 — restrained accumulated Journey trace

Issue: #88 / ST-020

## Form

The imprint is ambient history, not another map layer. V1 modifies only the
brightness and temporal stability of the **existing geographic surface
particles**. It does not create a heatmap, glow blob, fog layer, GPS track,
second particle shell, travelling highlight, pulse, radar, beam, or Home Base
signal. Particle coordinates, coastline geometry, route geometry, and the
Quiet Core route sequence remain authoritative and unchanged.

Home Base and imprint remain separate concepts: Home is an explicit clickable
life-period anchor; imprint is background accumulation derived only from the
Journey routes already present for the current viewer.

## Gain policy

A coarse spatial region receives at most one effective contribution from each
Journey. Dense Route Points and repeated corridor samples from the same Journey
therefore cannot stack without bound.

The owner-approved gain is used directly:

`gain(x,t) = 0.15 * (1 - exp(-n(x,t)/3))`

`0.15` is a relative base-particle brightness cap, not overlay opacity. `3` is
the saturation scale. Route Points contribute the primary value. Route
corridors contribute a weaker `0.35` value sampled sparsely (18° target spacing,
at most 8 interior samples per leg), so a sparse itinerary reads as a broad
association rather than a precise GPS trace.

All numeric policy values are named in `src/scene/visitedImprint.ts`.

## Spatial field and cache

The CPU derives one 60×30 field (6° cells) from `journeyRoutes`. Per cell it
keeps a map of `Journey id -> strongest contribution`, sums that deduplicated
set, then applies the gain curve. The result is encoded into one tiny RGBA data
texture and sampled by the existing particle shader using the same geographic
direction convention as terrain relief.

There is no per-frame `routes × particles` loop. The field is rebuilt only when
route or temporal-reveal inputs change; byte upload is skipped when the
resulting field is unchanged. Particle frames sample one cached texture.

## Time authority / rewind

`temporalReveal` is the only time authority. A Route Point uses its existing
`routeId:pointIndex` reveal value (falling back to Journey reveal, then fully
visible outside rewind/focus mode). Corridor contribution follows the
destination Route Point, matching the existing route-leg reveal contract.

Rewinding therefore removes future contributions deterministically; replaying
forward restores them. No clock, easing timeline, or autonomous imprint
animation is added.

## Visibility, privacy, and route hiding

The field is built only from the `journeyRoutes` supplied to
`ParticleEarthScene`. Owner views therefore use owner-allowed routes; guest/share
views can only imprint routes already admitted to that viewer. No owner-lifetime
field is computed and later hidden, and no new persisted location history is
introduced.

Imprint is independent of SVG route-stroke visibility. Hiding route strokes
does not remove the cached particle field.

## Semantic zoom and composition

Decorative gain attenuates with the existing semantic-zoom authority:
planet `1.00`, macro `0.82`, regional `0.48`, local `0.18`, with a further
75% reduction across local-band progress. Close geography therefore wins.

The shader applies imprint after existing Journey-proximity dimming and reduces
imprint gain near active route context. Existing route strokes, Route Points,
selected-Journey emphasis, Home presence, labels, coastline depth policy, and
canonical projection remain above the ambient field. The imprint changes no
point size or position. It lightly stabilizes twinkle toward neutral only where
history exists, keeping idle behavior quiet and preserving #312 Quiet Core's
route-grows → leader-arrives → destination-responds ownership.

## Performance / evidence

The fixed field is 1,800 texels (7,200 RGBA bytes) regardless of particle count
or route density. `__particleEarthDebug` exposes active region count,
deduplicated Journey-region contribution count, max gain, texture-update count,
and semantic-zoom attenuation so the existing globe render-budget CI lane can
assert bounded updates without adding a new render loop.

Browser evidence is captured from the existing `journey-routes` QA fixture at
the same camera for first-Journey, mid-timeline, now, and route-strokes-hidden
states. Those captures are CI artifacts; they are not generated locally.
