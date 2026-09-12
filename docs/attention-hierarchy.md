# Living Atlas Attention Hierarchy

Issue owner: #246 / ST-037.

This document is a **consumer contract**, not a second motion or visual system. The authoritative pace, primitive, glow and reduced-motion rules remain in [`docs/motion-language.md`](./motion-language.md). The authoritative focus distinctions remain in [`docs/design/meaningful-atlas-motion-plan.md`](./design/meaningful-atlas-motion-plan.md), especially §4 (content selection is not camera ownership; keyboard focus is not visual lead; requested target is not displayed media; scope filter is not current position) and §7 (per-module focus/failure table). This file only resolves those rules onto current Startrips product states and measurable renderer layers.

## Per-state attention contract

“Yields” means “remains available/contextual but must not compete for the visual lead”. It does **not** mean hidden or inaccessible. Every row uses existing components and existing motion/style tokens only.

| Product state | Primary object | Objects that yield | Capability that must not be lost | Current component owners | Existing motion / optical contract |
| --- | --- | --- | --- | --- | --- |
| **Atlas overview** | The spatial relationship between Journeys on the same globe | Archive clusters, particle shell/halo, city labels and persistent controls stay contextual; no ambient layer becomes a stronger moving object than the geography | Select a Journey/Route Point, free-explore the globe, keyboard-reach the available controls | `src/journey/LivingAtlasApp.tsx` (`LivingAtlasApp`), `src/scene/LivingAtlasGlobe.tsx` (`LivingAtlasGlobe`), `src/scene/ParticleEarthScene.tsx` (`ParticleEarthScene`) | Tier 0/1 UI feedback uses `motionTokens.tiers.instant` / `motionTokens.tiers.ui`; ambient glow stays under `motionTokens.glow.*`; at most one strong glow per screen per `docs/motion-language.md` |
| **Selection / focus flight** | The selected Journey/Route Point plus the camera flight toward it | Non-selected routes are visually muted, generic city labels/ambient particles do not launch competing primary animation, controls remain quiet | Interrupt immediately with drag/wheel/new selection; selection does not steal keyboard focus; free explore can override camera following | `ParticleEarthScene` focus solver and route layer in `src/scene/ParticleEarthScene.tsx`; selection state from `LivingAtlasApp` | Tier 3 `motionTokens.tiers.journey`, `motionPrimitiveClass.focusFlight`, and the existing route `draw` primitive; `motionTokens.glow.coreOpacity` is the strong-glow threshold used by measurement, not a new visual value |
| **Arrival and dwell** | The arrived Route Point or the selected whole-Journey route, with its local context | Camera motion stops owning attention; generic labels, inactive routes and ambient glow yield to the current place/route; no perpetual arrival pulse | Current place/Journey remains identifiable; user can continue to Story/Playback or choose another place without waiting for a ceremony | `ParticleEarthScene` Route Point / Quiet Core route; Route Point context in `src/journey/LivingAtlasApp.tsx` | Existing Tier 3 route draw/arrival sequence (`--motion-journey`) settles into existing static core/halo; local UI response uses `--motion-content` / `motionTokens.tiers.content`; no new timing family |
| **Story viewing** | The currently displayed media asset and concise Route Point/Journey context | Globe, route chrome, management affordances and non-current media yield; requested-but-not-ready media does not replace the displayed asset | Back/close, media navigation, fullscreen and explicit management entry remain discoverable; displayed-media identity stays truthful | `src/journey/JourneyStory.tsx` (`JourneyStory`), `src/journey/StoryMediaPages.tsx` (`StoryMediaPages`), `src/journey/StoryMediaRail.tsx` | Tier 2 `motionTokens.tiers.content`, `motionPrimitiveClass.sharedExpand`, shared-element primitive from `src/motion/primitives/sharedElement.ts`; Reduced Motion reaches the same identity without depending on completion events |
| **Fullscreen / Journey Playback media beat** | The current image/video beat | Atlas/map/title/ambient route motion and non-essential chrome yield; controls may fade but must not compete with the media | Pause/resume, exit/back and required media controls remain reachable; user input can interrupt narrative motion immediately | `src/journey/PlaybackMediaStage.tsx` (`PlaybackMediaStage`), `src/journey/JourneyPlaybackOverlay.tsx` (`JourneyPlaybackOverlay`), fullscreen branch in `JourneyStory` | Existing Tier 2 content transition (`--motion-content`) and Tier 0 control feedback (`--motion-instant`); exactly one Tier 2/3 lead at a time |
| **Return to Atlas** | The same geographic Journey/Route Point context the user came from | No second “reveal ceremony”; Story/Playback chrome yields as spatial context resumes | Current Journey/place selection survives; return target is re-measured from live layout/geography; stale completion cannot reclaim UI | Return ownership in `src/journey/LivingAtlasApp.tsx`, Story handoff in `JourneyStory`, geographic anchor in `ParticleEarthScene` | Existing shared-expand/content handoff (`motionPrimitiveClass.sharedExpand`, `--motion-content`); #315 live re-measurement and #317 same-world Earth Dive are the spatial continuity baseline |
| **Loading and failure** | Already-usable content plus the honest recovery action/status | Loading decoration, ambient globe motion and brand motion yield; failure is never disguised as empty content or success | Cancel/retry/leave remains available; keyboard focus stays with the user; an unavailable detail/media layer cannot take input ownership | Media readiness/error presentation in `StoryMediaPages` / `JourneyStory`; detail-map readiness/failure in `src/scene/DetailedEarthMap.tsx` and `LivingAtlasGlobe` | Tier 0/1 status/control feedback (`--motion-instant`, `--motion-ui`); Reduced Motion uses the same final semantics; no loading animation is allowed to become a second operation owner |

## Focus ownership invariants

The table above consumes, rather than restates, the Focus Contract in `meaningful-atlas-motion-plan.md` §4. The practical checks for this lane are:

- Content selection may stay selected while the user manually owns the camera.
- Keyboard focus remains an input/accessibility owner and is never reassigned merely because a visual camera flight begins.
- A requested media target is not “current media” until its own pixels/readiness are valid.
- Scope/filter state is not a camera coordinate and does not move merely because the user drags the globe.
- A renderer may be mounted/prewarmed without owning pointer, wheel or keyboard input.
- A successful handoff has one primary optical owner; related supporting changes may occur concurrently, but they do not start independent Tier 2/3 ceremonies.

## DPR optical measurement lane

### What is measured

In dev/QA builds, `ParticleEarthScene` publishes `data-attention-layers` on the scene host. Production builds skip this per-frame instrumentation entirely. The dataset reports every current consumer of `createParticleEarthMaterial`:

1. `base-particle-surface`
2. `spatial-lod-refinement`
3. `archive-signal`
4. `archive-cluster`
5. `cyan-cluster`
6. `particle-shell`
7. `particle-halo`
8. `personal-focus-signal`

The measurement is observational. It reads the material's **current `uPointSize` CSS-pixel value** and current `uOpacity`; it also reports the effective renderer DPR and the corresponding DPR-scaled authored input (`CSS size × renderer DPR`). No shader/material/token value is changed by ST-037. Under the fixed camera used below, all remaining shader multipliers are DPR-independent, so the CSS-pixel value is the contract that #243 is required to preserve while DPR-scaled sampling input changes.

`strongGlow` uses the existing `motionTokens.glow.coreOpacity` threshold. The QA lane fails when more than one measured layer reports that state in the same capture.

### Fixed fixture

The recorded fixture is the deterministic Living Atlas route fixture:

- `?qaState=journey-routes&qaQuality=high&qaMotion=reduce&qaFocusLat=30&qaFocusLon=110`
- viewport: `1200 × 800` CSS px
- fixed target semantic zoom: `2.7`
- spatial-LOD refinement must report `ready` and `present=true` before sampling
- device DPR captures: `1`, `2`, `3`
- high-quality renderer cap resolves renderer DPR to `1`, `2`, `2` respectively
- QA tolerances: CSS optical size `0.01px`; opacity `0.005`

### Recorded measurements

The three DPR captures resolved to the same CSS optical values and opacity values:

| Layer | DPR 1 size / opacity | DPR 2 size / opacity | DPR 3 size / opacity | Strong glow in fixture |
| --- | ---: | ---: | ---: | --- |
| base particle surface | `8.8px / 0.62` | `8.8px / 0.62` | `8.8px / 0.62` | no |
| spatial-LOD refinement | `7.2px / 0.31` | `7.2px / 0.31` | `7.2px / 0.31` | no |
| archive signal | `45px / 0.72` | `45px / 0.72` | `45px / 0.72` | no |
| archive cluster | `28px / 0` | `28px / 0` | `28px / 0` | no |
| cyan cluster | `22px / 0` | `22px / 0` | `22px / 0` | no |
| particle shell | `8px / 0.18` | `8px / 0.18` | `8px / 0.18` | no |
| particle halo | `10px / 0.05` | `10px / 0.05` | `10px / 0.05` | no |
| personal focus signal | `58px / 1` | `58px / 1` | `58px / 1` | **yes — sole owner** |

The reported DPR-scaled authored input follows the **effective renderer DPR**: at device DPR 1 the personal signal reports a DPR-scaled authored input of `58`; at device DPR 2 and device DPR 3 (renderer capped to 2) it reports `116`. The CSS optical size remains `58px` in all captures.

### Unaffected comparison references

Route SVG strokes and Place/City Labels do not use `createParticleEarthMaterial` and are intentionally outside the particle-DPR contract. They remain comparison references for optical hierarchy, not consumers of the new dataset. In the same fixed fixture the unaffected references are stable at all three device DPRs: the sampled idle Route core is `3px / 0.55`, and the rendered City/Place label is `8px / 1`. Route strokes remain owned by the existing SVG route CSS, while label typography remains owned by `.particle-earth-city` in `src/styles/living-atlas.css`; neither is altered by ST-037.

## Automated guard

`scripts/qa-attention-hierarchy.mjs` is the executable contract. It:

- creates fresh browser contexts at device DPR 1/2/3 with the same CSS viewport;
- drives the same camera to zoom 2.7 and waits for the real refinement layer;
- reads only `data-attention-layers` plus the unaffected SVG/text references;
- fails if any expected material consumer is absent;
- fails if DPR 2/3 CSS optical size differs from DPR 1 by more than `0.01px`;
- fails if opacity differs by more than `0.005` across DPR;
- fails if more than one layer reports `strongGlow` in the captured state.

This is deliberately a **measurement lane**, not an auto-retuner. If future evidence shows that a corrected DPR makes an ambient layer compete with the selected Journey, #246's human gate decides whether to lower an existing authored layer, raise the selected Journey/focus emphasis, or explicitly accept/freeze the current hierarchy. ST-037 does not make that product decision.
