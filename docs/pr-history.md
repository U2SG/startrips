# Startrips Pull Request History

This file is the durable product/engineering ledger for pull requests merged into `main`.

## Maintenance rule

For every PR that is ready to merge:

1. Review the latest head and resolve only verified review threads.
2. Before merge, add or update that PR's entry in this file on the PR branch.
3. Record the PR number/title, source head SHA, scope, user-visible behavior, important review fixes, and any known follow-up.
4. Re-check the final docs-only head change, then squash-merge with an exact expected-head lock.
5. Do not merge if the history entry is missing, stale, or describes behavior not actually present in the reviewed head.

The source head SHA is recorded instead of the squash merge SHA so the ledger can ship atomically inside the same PR being merged.

---

## 2026-08-31

### PR #100 ? Define deterministic Journey keepsake render manifest

- **Source head:** `42d783883462894d66d2a6e9594bb88e40644f12`
- **Scope:** Defines the phase-1 deterministic keepsake render manifest and hybrid authorized-server-render contract, reusing live Journey Playback ordering while encoding private media references as stable IDs and supporting portrait-first 15/30/60-second pacing presets.
- **User-visible change:** Establishes the export contract for future private Journey reels so route arrivals, travel, opening media, point media, and outro scenes can render in the same semantic order as live playback without embedding signed URLs or exposing storage coordinates.
- **Review fixes:** Replaced index-only geography with stable route-point IDs on arrival/media scenes and stable from/to route-point IDs on travel scenes; made `journeyId + journeyRevision` an explicit hard render precondition; added missing-ID validation and a regression proving a reordered, revised Journey is rejected instead of silently resolving old indexes to new geography.
- **Follow-up:** The next #87 slice remains the dedicated render harness and deterministic 3-stop output experiment with encode-time, peak-memory, file-size, and visual-quality measurements. GitHub-hosted verify/readiness checks on the reviewed code head were zero-step runner failures; targeted keepsake/playback tests (18/18), the non-DB suite (46 files / 409 tests), typecheck, production build, and `git diff --check` were green.

## 2026-08-30

### PR #98 — Unify globe layers under semantic zoom

- **Source head:** `80f93650cf9d8d0e6e335ca5b0746a6ec023a167`
- **Scope:** Introduces a shared four-band semantic-zoom resolver with hysteresis and routes the particle globe's city-label tier and coastline detail through one semantic context, including mobile/low-quality coastline caps and debug state for QA.
- **User-visible change:** Zooming from planet to local view now reveals city and coastline context as one more coherent hierarchy, while programmatic Journey focus flights keep a stable information state during travel and reveal destination detail only on arrival instead of popping through intermediate LOD bands.
- **Review fixes:** Fixed focus-flight semantic churn by freezing the complete semantic snapshot during `routeFocusSettling`—state, city tier, coastline weights and active coastline LOD—and resolving the destination semantic state only after arrival; added a planet-to-local regression crossing multiple semantic bands.
- **Follow-up:** Spatial particle LOD (#81) and relief/terrain exploration (#82) remain separate consumers to integrate with the shared semantic contract. GitHub-hosted verify/readiness checks on the reviewed code head were zero-step runner failures; targeted semantic/scene tests, the non-DB suite, typecheck and production build were reported green, while the local tenant integration suite could not start because Postgres was unavailable at `127.0.0.1:5432`.

### PR #97 — Add adaptive coastline LOD

- **Source head:** `c02e732d5045a4bf8c9a4668ae0af77bfeb7da8d`
- **Scope:** Adds multi-resolution coastline geometry for the particle globe, keeping the Natural Earth 110m outline as the far/global layer and asynchronously upgrading mid/near zoom to 50m detail under bounded GPU vertex budgets with smooth LOD crossfades.
- **User-visible change:** Coastlines remain globally present while zooming in and gain noticeably more geographic detail at closer zoom levels without hard popping or blocking the base globe when detailed data is slow or unavailable.
- **Review fixes:** Replaced prefix truncation with globally distributed path budgets; preserved connected coastline runs instead of sampled dashes; decoupled the optional 50m fetch from base-scene readiness with stale-result guards; and fixed quota-one closed rings so they retain a real nonzero source edge instead of collapsing to an invisible first-to-last segment.
- **Follow-up:** GitHub-hosted `verify` / merge-readiness jobs on the reviewed code head were still affected by the repository's zero-step runner failure; local targeted tests (47/47), full suite (45 files / 423 tests), tenant integration, typecheck, production build, and `git diff --check` were green.

### PR #96 — Unify mobile control grammar

- **Source head:** `253233778b910aa6c92710dd5db1d9fd6bc5febe`
- **Scope:** Establishes a shared mobile control grammar for Atlas, Journey Story, fullscreen and picker surfaces, including common 44px hit geometry, cluster spacing, radius tokens, icon-only Story close behavior, and documented shape/motion rules.
- **User-visible change:** Mobile controls now use a more consistent compact visual language: idle Story close is a single icon-only X, related icon actions share sizing/spacing, and transient upload/delete status remains text-forward when needed.
- **Review fixes:** Moved shared control custom properties from `.living-atlas` to `:root` so body-portaled Journey Story/fullscreen controls inherit the same tokens instead of silently falling back and drifting from Atlas geometry; rebased onto the merged mobile Story sheet work and re-reviewed the resulting cross-surface diff.
- **Follow-up:** `qa:media-controls` still has a pre-existing velocity-flick timeout before this PR's new close-geometry assertion; the PR's focused/unit/full suite, typecheck, production build and static checks were otherwise reported green, while GitHub-hosted workflow failures on the reviewed head were zero-step runner failures rather than executed test failures.

### PR #95 — Make mobile Story collapsible and spatial

- **Source head:** `6431c51efede9abca22dc97162ef3b84a6b74321`
- **Scope:** Reworks compact-mobile Journey Story into a two-state spatial sheet with an in-context collapsed presentation and an expanded modal presentation, shared mobile-surface history ownership, and gesture handling for expand/collapse without stealing media navigation or Story scrolling.
- **User-visible change:** Mobile Story now opens as a lower in-context sheet that keeps the globe available, can be expanded with the handle or vertical swipe, and collapses predictably with Browser Back while fullscreen returns to the prior Story snap state.
- **Review fixes:** Raised the sheet handle to the 44px mobile touch-target contract; clears stale expanded state when leaving compact layout; made collapsed Story explicitly non-modal while expanded Story restores modal focus/inert semantics; and added Chromium QA across 320/360/390/430 portrait plus phone landscape for handle geometry, modal/inert transitions, Browser Back, vertical sheet gestures, media horizontal ownership, Story scrolling, and fullscreen snap restoration.
- **Follow-up:** None known at merge time.

### PR #90 — Separate mobile experience and Journey management modes

- **Source head:** `b47dbe0e72efe4cf280ad6db66c65d40094eacce`
- **Scope:** Separates compact-mobile Story viewing from mutation-heavy Journey management, with explicit Manage mode ownership for upload, media organization, soundtrack changes, edit/delete actions, and same-document browser history.
- **User-visible change:** Mobile Story opens as a cleaner viewer; editing and destructive controls live behind a single “管理旅程” entry, while Browser Back unwinds nested management surfaces before leaving Story and focus is handed between Viewer, Manage, media/delete confirmation, and fullscreen controls.
- **Review fixes:** Kept Manage reachable for empty media scopes; prevented destructive confirmation leakage into Viewer; preserved focus entering/exiting Manage and dismissing Journey deletion; removed stale media-menu history entries; preserved parent/child history ordering across breakpoint migration; blocked Back while mutations are pending; retained delete history through pending requests; preserved upload-close feedback; carried desktop-started mutations into compact Manage; and ensured the focused Done control is actually revealed in the viewport.
- **Follow-up:** None known at merge time.

### PR #83 — Stabilize particle globe city labels across zoom

- **Source head:** `9b526fd6061fb1c7318ac1bd154cd92ed3ffee8f`
- **Scope:** Reworks Particle Earth city-label candidate selection so zoom tiers reveal useful nearby cities with bounded per-frame work and stable label persistence.
- **User-visible change:** Zooming into the globe reveals denser nearby city context without dropping already visible labels unnecessarily, letting off-screen labels consume the label budget, or favoring distant administrative capitals over nearby cities.
- **Review fixes:** Reduced administrative-rank dominance, made persistence explicit across crowded tier transitions, removed off-screen labels from persistence and candidate budgets, bounded selection with a fixed-capacity heap, eliminated per-city candidate/closure allocation, applied viewport filtering before the 72-label budget, and replaced thousands of per-frame Three.js projections with a precomputed scalar local-to-clip frustum test.
- **Follow-up:** None known at merge time.

### PR #78 — Make whole-Journey Story playback continuous

- **Source head:** `2674f99d0e0d10d7e80909c16d68aafa05c13e16`
- **Scope:** Makes whole-Journey playback traverse route-point sections as one continuous Story instead of stopping at the current section.
- **User-visible change:** Playing an entire Journey now advances naturally across Journey points and preserves the final asset's full playback interval before stopping.
- **Review fixes:** Corrected deduplicated-upload section targeting, final-frame early stop, aggregate organizer destinations, and section-local neighbor ordering.
- **Follow-up:** None known at merge time.

### PR #77 — Add velocity flicks to mobile media swipes

- **Source head:** `5fdd8c366dccfbd96b44868f073f73b202760366`
- **Scope:** Completes velocity-aware direct manipulation for mobile media navigation.
- **User-visible change:** A short fast 36–47px flick can change media while slow sub-threshold jitter remains a tap; edge flicks spring back without opening fullscreen.
- **Review fixes:** Expired velocity samples are discarded after the sampling window so old fast movement cannot turn a later tiny motion into a false flick.
- **Follow-up:** None known at merge time.

### PR #73 — Stabilize authenticated login gateway QA

- **Source head:** `838189d6cc14c37c5c28906d163400bd6dfe170e`
- **Scope:** Stabilizes authenticated direct-route browser QA.
- **User-visible change:** No intentional product behavior change.
- **Review/QA change:** Increases the direct-gate readiness budget from 4s to 8s for cold Vite/React hydration and adds diagnostics while retaining the substantive stage, pointer and hit-target assertions.
- **Follow-up:** A zero-step GitHub Actions failure is not treated as executed-test evidence.

### PR #72 — Fix Mobile V2 account sheet integration

- **Source head:** `7a5bcec4c112c19a4f4c014e86bcba182dc9035d`
- **Scope:** Rebuilds the Mobile V2 account entry and account actions as part of the mobile navigation system.
- **User-visible change:** The account trigger now lives in the same top action cluster as the other Mobile V2 controls; the desktop-style popover becomes a full-width bottom sheet with invite/edit drill-ins and shared browser-Back behavior.
- **Review fixes:** Restored pointer events on the sheet, preserved account/sign-out access during Atlas loading/error, and restarted focus-trap/inert ownership after Atlas reload/remount.
- **Follow-up:** Desktop keeps its existing popover model.

### PR #71 — Fix mobile media pointer capture lifecycle

- **Source head:** `57d7bb49a94bb9bd054bb31abf8f87d25e3a15b4`
- **Scope:** Hardens the real-touch pointer ownership lifecycle for inline and fullscreen media swipes.
- **User-visible change:** Mobile drags remain stable when the finger leaves the stage; small image jitter still behaves like a tap; boundary overscroll does not unexpectedly open fullscreen; native video tap/control behavior is preserved.
- **Review fixes:** Filtered descendant `lostpointercapture`, fixed QA false positives, limited tap restoration to sub-threshold movement, and preserved native video capture for non-committed gestures.
- **Follow-up:** Velocity-based flick behavior was completed in PR #77.

### PR #70 — Living Atlas UX polish

- **Source head:** `fb8da9fc8f3e0b18d437dba6f476c2a46cab20b3`
- **Scope:** Additive Living Atlas interaction, accessibility and feedback polish.
- **User-visible change:** Real overflow hints, 8-second ordinary notice dismissal, repeated-notice timer reset, `aria-current`, stronger focus-visible fallback, refined hover/press feedback, dark autofill treatment, and reduced-motion-aware transitions.
- **Review fixes:** Reworked the journey-rail overflow observer so it follows the current DOM node and content changes instead of staying attached to a detached rail.
- **Follow-up:** None known at merge time.

## 2026-08-29

### PR #69 — Add batch move of media between route points

- **Source head:** `7e7050fe52541f5793b6802ff2b9eb59e6f65f23`
- **Scope:** Adds atomic reassignment of one or many visual media assets between Journey-wide media and route points.
- **User-visible change:** Users can correct media uploaded to the wrong Journey point without deleting and re-uploading; singleton scopes can also enter manage/move mode.
- **Review fixes:** Clears hidden selections on scope/overview/Journey changes, preserves existing slideshow order independent of click order, reserves space for the move bar, and adds an accessible destination label.
- **Follow-up:** Cross-Journey media transfer remains separate work.

### PR #68 — Fix mobile media flicker/swipe and dock account menu

- **Source head:** `85de9f563b9733fdb2f7e3e71f667422553e9a94`
- **Scope:** Reworks Mobile Story media transitions and swipe interaction while moving the account trigger closer to the mobile header.
- **User-visible change:** Fullscreen crossfades stay centered, media follows the finger during swipe, decode-pending navigation waits for spring-back, and vertical fullscreen gestures remain coherent.
- **Review fixes:** Fixed stale peek state after direction reversal, blocked second drags during settle, avoided black stages when video neighbors are not rendered, changed fullscreen touch-action ownership, and deferred navigation until settle completes.
- **Follow-up:** Account integration was completed in PR #72; pointer capture lifecycle in PR #71.

### PR #64 — Fix Journey focus release continuity

- **Source head:** `ca8319694b00e3d65fed80caf9fcee916a6702e7`
- **Scope:** Makes the globe's transition from Journey focus back to idle motion continuous.
- **User-visible change:** Upright recovery and longitude idle rotation blend through one release phase rather than producing an obvious speed seam or resume jump.
- **Review fixes:** Added a large-frame advancement cap so tab resume/low-FPS frames cannot skip the blend; QA measures angular-velocity continuity instead of encoding the old seam.
- **Follow-up:** None known at merge time.

### PR #63 — Fix shared mobile browser Back stack

- **Source head:** `8c12804efb720157fb260defc4920be82ddab507`
- **Scope:** Introduces a composable same-URL history stack for Mobile V2 sheets, picker, map, Story and fullscreen.
- **User-visible change:** Browser Back unwinds fullscreen → Story → sheet → Atlas in a native-mobile order, and breakpoint cleanup does not navigate away from the document.
- **Review fixes:** Clears stale session-owned history after reload and prevents Story edit/delete transitions from leaving a retained sheet/focus trap underneath.
- **Follow-up:** Account-sheet Back integration was later added in PR #72.

### PR #62 — Fix mobile Story compositor continuity

- **Source head:** `b283885f8ce2332c0a4f7b88c2206bb62b19aae2`
- **Scope:** Keeps settled/base Story media absolutely positioned and preserves compositor ownership across transition settle.
- **User-visible change:** Mobile media changes no longer expose a flash caused by replacing the incoming decoded media node after the crossfade.
- **Review fixes:** Delayed-read QA now blocks the actual target asset and verifies old-frame coverage plus same-DOM-node settle rather than accidentally preloading the neighbor.
- **Follow-up:** Direct manipulation and capture behavior were expanded in PRs #68, #71 and #77.

### PR #61 — Fix Mobile V2 touch targets

- **Source head:** `0283db620f6f3ba17a41d83b9e53fccd2f39f5c9`
- **Scope:** Standardizes major Mobile V2 interaction targets to at least 44px while preserving compact visual density.
- **User-visible change:** Header, timeline, Story management/fullscreen, picker and map-close controls are easier and safer to tap.
- **Review fixes:** Added browser QA for the key target groups.
- **Follow-up:** None known at merge time.

### PR #60 — Keep phone landscape in Mobile V2

- **Source head:** `d44fb96c482688d97ae6081108032f098caeee70`
- **Scope:** Aligns JS and CSS compact-mobile breakpoint semantics.
- **User-visible change:** Short coarse-pointer phone landscape remains in Mobile V2 while wide desktop/tablet layouts do not accidentally inherit mobile CSS.
- **Review fixes:** Added explicit portrait, landscape and wide-short-touch control coverage.
- **Follow-up:** None known at merge time.

### PR #59 — Fix fullscreen mixed-media settle

- **Source head:** `fab0095a2e1083b745810cea15c7ccbb079659d8`
- **Scope:** Brings fullscreen video settle behavior in line with the Story-stage mixed-media transition contract.
- **User-visible change:** Image → video → image fullscreen transitions settle cleanly without leaving an incoming layer behind.
- **Review fixes:** Fullscreen incoming video now settles only on its own `motionMediaIn` animation end, with the image handler similarly scoped to its own event.
- **Follow-up:** Compositor continuity was further hardened in PR #62.

---

## Entry template

```md
### PR #N — Title

- **Source head:** `sha`
- **Scope:** What the PR changes technically.
- **User-visible change:** What a real user will notice, or "No intentional product behavior change."
- **Review fixes:** Important review findings fixed before merge.
- **Follow-up:** Known remaining work, or "None known at merge time."
```
