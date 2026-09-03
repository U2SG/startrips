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

## 2026-09-03

### PR #191 - Stabilize initial login QA layout scan

- **Source head:** `276035f1aeb64beee60e5b74904cdd6522580c36`
- **Scope:** Stabilizes the login browser QA harness so layout measurements wait for the application's global CSS reset (`body margin: 0`, `html overflow: hidden`) before scanning, and records a per-scan `failed` flag for direct diagnostics.
- **User-visible change:** None. This prevents false-red CI caused by measuring the browser's transient default 8px body margin before Vite-loaded styles apply.
- **Review fixes:** Root-cause analysis of main run `33713614844` showed core, post-login, and final-acceptance green; only `desktop-sign-in` reported `overflowX=8` / `overflowY=8`, while every subsequent auth viewport reported 0. The fix preserves strict overflow thresholds instead of weakening assertions.
- **Follow-up:** None known. Current main run `33717735658` is already green, confirming the #190 failure was a transient QA timing race rather than a product regression.
- **Validation:** `node --check scripts/qa-login-v3.mjs` and `git diff --check` green. GitHub CI is authoritative for final browser validation.

### PR #182 - Reject empty Quick Recap chapters

- **Source head:** `0d844ce3f1b94a49e502bcd38d384013c91bd663`
- **Scope:** Tightens the Quick Recap V1 trust boundary so every accepted Quick Recap chapter must contain at least one media item, closing the remaining topology gap where a model-authored plan could inject a camera-only Journey/route chapter without changing deterministic selected-asset identity.
- **User-visible change:** Malformed Quick Recap plans can no longer add dead-air travel/arrival choreography or display place/note UI for a route that has no recap media, even when camera/arrival vocabulary is valid and `plannedDurationMs` is forged to reconcile exactly.
- **Review fixes:** The guard is intentionally scoped to Quick Recap and mirrors the existing Full Playback empty-chapter rejection without constraining Keepsake. Regression coverage uses canonical route travel/arrival values and recomputes total duration, proving the plan fails for empty topology rather than timing arithmetic.
- **Follow-up:** None known at source review time. Local verification was intentionally limited to `git diff --check`; this isolated worktree has no `node_modules`, so dependencies were not installed and no full suite, production build, or other high-memory local validation was run. Full tests, TypeScript, build and browser QA are delegated to GitHub CI.
### PR #180 - Enforce Journey intro chronology in auto-edit plans

- **Source head:** `ca7dbed270dbf7e550ac92ade9674634dc520e37`
- **Scope:** Tightens the shared Auto Edit V1 chronology gate for Full Playback and Quick Recap so an optional Journey-intro chapter may appear only before route chapters. Once a route chapter has been observed, any later `routePointId: null` chapter fails validation.
- **User-visible change:** External JSON / AI-authored plans can no longer move canonical Journey-intro media into the middle or end of playback while keeping route order and total duration internally consistent. Keepsake chronology is intentionally unchanged by this patch.
- **Review fixes:** Self-review kept the new guard orthogonal to existing route-order checks and added forged Full/Quick Recap cases that recompute `plannedDurationMs`, proving rejection is based on chronology rather than arithmetic mismatch. Canonical intro-first plans remain covered by existing tests.
- **Follow-up:** None known at source review time. Local verification was intentionally limited to `git diff --check`; the isolated worktree has no local `node_modules`, so no dependency installation, full suite, production build, or other high-memory local validation was run. Targeted/full tests, TypeScript, build and browser QA are delegated to GitHub CI.

### PR #176 - Enforce canonical Full Playback chapter topology

- **Source head:** `ef53df0c943f7ec611ccaca3a6504cd1fb089126`
- **Scope:** Tightens Full Playback V1 validation so each Journey-intro/route scope can appear at most once and every Full chapter must contain media. This closes the gap where an otherwise preservation-complete plan could inject camera-only or split-scope chapters that repeat/inflate choreography.
- **User-visible change:** Full Playback can no longer contain invisible camera-only detours or replay the same place through multiple chapters while still claiming a valid plan. Detailed Full camera primitive/duration grammar remains intentionally separate.
- **Review fixes:** Self-review kept the rule scoped to Full mode and tested forged `plannedDurationMs` values that still reconcile, proving topology rather than arithmetic is what rejects the plan. A canonical populated one-chapter-per-scope Full plan remains valid.
- **Follow-up:** Full camera/arrival semantics may be constrained separately once that grammar is finalized. Local validation was intentionally limited to `git diff --check`; this isolated worktree has no dependencies installed, so no dependency installation, full suite, production build, or other high-memory local validation was run. Targeted/full tests, TypeScript, build and browser QA are delegated to GitHub CI.

## 2026-09-02

### PR #174 - Enforce Full Playback plan preservation

- **Source head:** `2678dcdd5a93264c70deff35fd94514bbda3f939`
- **Scope:** Adds Full-mode preservation gates to `validateAutoEditPlanV1()`: every current canonical visual digest must be selected exactly once, the omission ledger must be empty, selected items must use the faithful `all-media` reason, and videos with known duration must span the complete source range instead of inheriting recap-style trims. Foreign, stale, and deleted-route digests are excluded from the canonical required set.
- **User-visible change:** A Full Playback plan can no longer silently drop Journey media or cut a long video down to a recap excerpt while still presenting itself as the faithful full experience.
- **Review fixes:** The required Full asset set remains scoped to current Journey/revision and canonical route membership. The latest P2 defines supported semantics for canonical videos without a trusted positive intrinsic duration: they remain mandatory in Full mode, may omit `trim`, and contribute 0 to planned arithmetic while live Playback owns completion through the real video `ended` event. Videos with known duration still require an exact full-source trim. Regression coverage includes undefined, zero, NaN, and infinite durations plus omission rejection.
- **Follow-up:** Persist trusted intrinsic video duration so Full plan timeline arithmetic can include real video runtime instead of 0 for unknown-duration videos; live playback behavior is already faithful via media `ended`. After rebasing onto main with PR #163 and the stricter Quick Recap timing validator, `git diff --check` is green; GitHub CI is authoritative for targeted/full/typecheck/browser validation on the final head.

### PR #172 - Enforce deterministic Quick Recap asset selection

- **Source head:** `797c1e5c2241995aab674ab3cb8873484f5fed7c`
- **Scope:** Tightens Quick Recap V1 validation by rebuilding the deterministic baseline selection from trusted digests, canonical route order, candidate target duration, and tempo, then requiring the candidate plan to preserve the exact selected asset identity/order. Quick Recap now also requires a positive target duration so deterministic selection can be reconstructed.
- **User-visible change:** External JSON / AI-authored Quick Recap plans can no longer substitute a weaker duplicate-cluster member or a different eligible optional photo while keeping omission bookkeeping and durations internally consistent. Full and Keepsake selection policy remains unconstrained.
- **Review fixes:** Self-review added an explicit target-duration requirement instead of silently skipping deterministic comparison when the field is missing/invalid. Regression coverage demonstrates both weaker duplicate replacement and duration-budget optional substitution fail even when the omission ledger is forged consistently.
- **Follow-up:** None known at source review time. Local verification intentionally used only the single `autoEditPlan.test.ts` suite (39/39 green with one worker) plus `git diff --check`; no full suite, production build, dependency install, or other high-memory local validation was run. Full TypeScript/build/browser coverage is delegated to GitHub CI.

### PR #170 - Enforce Quick Recap item behavior semantics

- **Source head:** `fd097cb1f5751e12f15d7f114c86467123f8de0f`
- **Scope:** Tightens Quick Recap V1 validation so vocabulary-valid item behavior still has to match the deterministic builder contract: `contain` framing, `direct` transition, and selection-reason precedence derived from pinned/cover/video/eligible duplicate-cluster/source semantics.
- **User-visible change:** External JSON / AI-authored Quick Recap plans can no longer pass validation while misrepresenting why an asset was selected or substituting a different supported framing/transition behavior. Full and Keepsake behavior grammar remains unconstrained.
- **Review fixes:** Self-review verified duplicate-cluster reasoning is computed from eligible source digests, matching the builder's duplicate-size semantics rather than trusting plan-selected items. Added coverage for pinned-over-cover precedence, cover, video, duplicate representatives, and vocabulary-valid framing/transition forgery.
- **Follow-up:** None known at source review time. Local verification was intentionally limited to `git diff --check` because this isolated worktree has no dependencies installed; targeted/full tests, TypeScript, build and browser QA are delegated to GitHub CI to avoid high local resource use.

### PR #165 - Reject duplicate auto-edit chapter ownership

- **Source head:** `1a12523c19b5cf0ceaebf57b10570be9c4cd7cdf`
- **Scope:** Tightens Quick Recap runtime validation so a plan can contain at most one journey-intro chapter and at most one chapter for each route point, matching the deterministic builder topology.
- **User-visible change:** Malformed AI/JSON plans can no longer replay the same place's camera/arrival choreography by splitting distinct media across duplicate chapters while keeping total duration internally consistent.
- **Review fixes:** Post-merge audit reproduced the gap with distinct assets split across duplicate route chapters and duplicate intro chapters; both cases now fail closed without changing canonical builder output.
- **Follow-up:** Continue validating chapter-level grammar as new planner primitives are introduced; this PR intentionally does not constrain non-Quick-Recap modes that may need different chapter topology. Validation on source: autoEditPlan 32/32 green, full `src` 38 files / 417 tests green, client TypeScript green, production build green, and `git diff --check` green.

### PR #159 - Validate auto-edit media source order

- **Source head:** `b44995dd015b9daeb12f47fd178346cc0a1a5a25`
- **Scope:** Hardens `validateAutoEditPlanV1()` so every selected media item must carry a finite non-negative integer `sourceIndex` matching its authoritative `MediaDigestV1`, and each chapter must preserve nondecreasing authoritative source order. Structural validation also rejects non-number source-index leaves before semantic traversal.
- **User-visible change:** Invalid external/AI Quick Recap plans can no longer silently reorder memories or lie about their canonical source positions; valid equal-index stable ordering remains accepted.
- **Review fixes:** Self-review explicitly preserved equal-source-index input stability instead of adding an asset-id tie-breaker, avoiding a new validator/builder ordering mismatch.
- **Follow-up:** If `MediaDigestV1` itself becomes an untyped external boundary later, validate digest source indexes at ingestion as a separate contract. Validation on the reviewed source: `autoEditPlan.test.ts` 30/30 green, full `src` 38 files / 415 tests green, client TypeScript green, production build green, and `git diff --check` green.

### PR #156 - Validate Quick Recap omission ledger

- **Source head:** `30a302019de491383678e55a6870ffd98e620738`
- **Scope:** Hardens the V1 auto-edit runtime validator so Quick Recap `omittedAssetIds` must exactly match eligible media not selected by the plan. Structural validation now fails closed on malformed/sparse omission entries, and semantic validation rejects duplicate, selected, noneligible, missing, extra, or re-ordered omissions.
- **User-visible change:** Quick Recap/AI-generated plans can no longer validate while falsely reporting which memories were omitted, keeping selection bookkeeping trustworthy for downstream playback/export/audit surfaces.
- **Review fixes:** Self-review caught that adding an asset-id tie-breaker would diverge from the existing builder when `sourceIndex` values tie; validation was corrected to reuse the builder's stable source-order semantics, with regression coverage.
- **Follow-up:** If Full Playback begins consuming `omittedAssetIds`, define and validate its own explicit omission contract rather than inheriting Quick Recap semantics. Validation on the reviewed source: targeted `autoEditPlan.test.ts` 27/27 green, full `src` 38 files / 412 tests green, client TypeScript green, production build green, and `git diff --check` green.

### PR #152 - Fail closed on malformed auto-edit plan shapes

- **Source head:** `07f700c9fd25125e66420ab68908493537107b3c`
- **Scope:** Hardens `validateAutoEditPlanV1()` as an untyped trust boundary so malformed JSON-shaped plan roots, chapter collections, camera/items/arrival records, trim shapes, and duration leaves return structured validation errors instead of throwing during traversal or duration arithmetic. The branch preserves the vocabulary and timing validation already merged through PRs #150 and #148.
- **User-visible change:** Malformed external or AI-generated auto-edit plans are rejected safely before playback or keepsake consumers can execute them; valid deterministic plans behave unchanged.
- **Review fixes:** The latest Codex P2 fixes replace hole-skipping `forEach` traversal with explicit numeric-slot inspection for sparse chapter/item arrays, and reject hostile non-number camera, arrival, dwell, and trim duration leaves during structural validation before any arithmetic can coerce or throw on them. Regression cases verify both paths return invalid results without throwing.
- **Follow-up:** Keep future runtime plan fields covered by the structural trust-boundary pass before semantic traversal or arithmetic. Validation on the reviewed source: targeted `autoEditPlan.test.ts` green, client TypeScript green, production build green, and `git diff --check` green.

### PR #150 - Reject unknown auto-edit behavioral vocabulary

- **Source head:** `8b6c0fd4b3523782f665bde7622a41e112f2f1a9`
- **Scope:** Adds runtime validation for auto-edit behavioral vocabulary so unknown `mode`, `tempo`, camera primitive, framing, transition, selection reason, and Quick Recap photo-role values cannot bypass the TypeScript boundary when plans come from JSON or AI-generated input. The rebase semantically preserves #148's finite/non-negative timing validation alongside this vocabulary validation.
- **User-visible change:** Malformed or unsupported auto-edit plans are rejected before execution instead of silently entering the playback/keepsake pipeline with unknown behavior tokens.
- **Review fixes:** No unresolved GitHub review findings at the rebased source. Rebase conflict with #148 was resolved by retaining both timing-shape checks and vocabulary checks rather than choosing either side.
- **Follow-up:** Keep future schema vocabulary additions centralized in the validator allowlists so planner producers and runtime consumers evolve together. Validation on the rebased source: `autoEditPlan.test.ts` 21/21 green, client TypeScript green, production build green, and `git diff --check` green.

### PR #148 - Reject malformed auto-edit timing plans

- **Source head:** `34436c61d3d6126f4f55c58e111098b649ecf65e`
- **Scope:** Hardens `validateAutoEditPlanV1()` as the trust boundary for deterministic/AI-generated plans by enforcing finite phase durations and media-type timing shape: still images require positive finite dwell with no trim; videos require a bounded trim with no dwell; camera/arrival/planned/target durations are range-checked.
- **User-visible change:** Malformed recap/keepsake timing plans are rejected before they can reach Playback V2 or export consumers; normal deterministic plans remain unchanged.
- **Review fixes:** Post-merge audit found that a forged `plannedDurationMs` could make negative/NaN or wrong-media timing shapes pass validation. Regression tests explicitly forge the aggregate duration and verify the validator still rejects each malformed item. Codex P2 review found that non-finite video source durations could pass eligibility but fail validation; eligibility now excludes them so the builder and validator agree.
- **Follow-up:** None known. Validation on the reviewed source: targeted `autoEditPlan.test.ts` 19/19 green, full `src` 38 files / 403 tests green, client TypeScript green, production build green, and `git diff --check` green.

### PR #146 - Add photo-first recap beat roles

- **Source head:** `140413848d436af5761c34f7abd18e7f9fb91d0f`
- **Scope:** Extends #127's deterministic Quick Recap planner with explicit photo beat roles (`hero`, `representative`, `supporting`, reserved `burst`), role-specific tempo dwell budgets, and role-aware optional-media admission so the target-duration budget reflects the actual still-image rhythm.
- **User-visible change:** Future Quick Recap playback can distinguish chapter-opening photos from supporting detail photos instead of assigning every still image one identical hold; this slice changes the validated plan contract, not the live playback UI.
- **Review fixes:** Self-review caught that role-specific dwell could otherwise make optional selections exceed the recap budget, so optional admission recomputes role-aware chapter duration. Codex P2 review also caught that external/loaded plans could omit `photoRole`; Quick Recap validation now requires a role on image items and rejects photo roles on videos.
- **Follow-up:** Live Playback V2 should consume `photoRole` rather than inventing a second photo-rhythm heuristic. `burst` is intentionally reserved for a later explicit Quick Recap burst policy. Validation on the reviewed source: `autoEditPlan.test.ts` 14/14 green, client TypeScript green, production build green, and `git diff --check` green.

### PR #145 - Make mobile Journey focus one continuous globe turn

- **Source head:** `01b89a5d98edaf5d928508c5acced1fa594e0085`
- **Scope:** Makes mobile Journey selection hand one continuous focus intent to the particle globe, preserving the selected Journey/route target through the camera turn instead of issuing competing intermediate focus commands. Playback camera commands now continue the same monotonic focus-revision sequence.
- **User-visible change:** Selecting a Journey on mobile produces one continuous globe turn toward that Journey; starting Journey Playback can still take camera ownership for route/point choreography instead of being silently rejected by an older higher revision.
- **Review fixes:** Fixes the P1 review finding that Playback used an independent revision counter starting at 1 while normal Journey focus revisions are much larger. `nextPlaybackCameraCommand` now advances above the current focus baseline, with regression coverage for a 100k-range normal focus revision.
- **Follow-up:** None known at merge time. Validation on the reviewed source: LivingAtlasApp + ParticleEarthScene targeted suites 63/63 green, client typecheck green, production build and `git diff --check` green; focused real-browser transient Journey focus QA passes in both reduced-motion and animated modes after making the QA route activation advance the same focus revision contract.

### PR #143 - Add deterministic auto-edit plan foundation

- **Source head:** `5391f7cd0f97e7641d4980da2b77e1487031196b`
- **Scope:** Begins #127 Phase A with versioned `MediaDigestV1` and `AutoEditPlanV1` contracts, a deterministic Quick Recap baseline selector, and a hard validator. This slice stays entirely in the planning layer: no LLM/VLM calls, no Journey mutation, no playback/runtime wiring, and no keepsake rendering changes.
- **User-visible change:** None yet; this establishes the safe deterministic foundation future Quick Recap UI can consume. The baseline preserves canonical route chronology, keeps pinned/cover media, excludes recap-excluded media, reduces duplicate clusters using stable technical-quality tie-breaking without collapsing coverage across route points, represents every eligible route point, and uses source-bounded video highlight trims.
- **Review fixes:** Self-review removed an implicit fixed outro duration that was not represented by the plan schema and tightened route-coverage validation so stale/foreign digests cannot create false omissions. Latest review fixes exclude videos with unknown or non-positive duration from Quick Recap eligibility, preserve exact sub-second source trims, and scope duplicate representatives to the route-point/Journey-level context so a shared cluster ID cannot erase another route point's coverage. The validator now shares that eligibility rule, so noneligible videos do not create false pinned or route-coverage errors. Validation recomputes duration independently and rejects identity/revision drift, unknown/out-of-order route points, duplicate/missing/chapter-mismatched assets, excluded selections, invalid trims, omitted eligible pins, and omitted eligible route points.
- **Follow-up:** #127 remains open for broader Phase A analysis signals, stronger duration budgeting, full-mode plan generation, pin/exclude persistence/UI, cache invalidation/race handling, and later local semantic/optional AI phases. Latest final-source validation is green: targeted auto-edit tests 10/10, non-DB `src` suite 38 files / 389 tests, typecheck, production build, and `git diff --check`. GitHub CI on the reviewed source/final-ledger line also passed core, login-media browser QA, post-login browser QA, final-acceptance browser QA, and verify.

### PR #110 - Make globe interaction QA self-contained

- **Source head:** `cb79f8dfa2c6fb247176fc5eefd0bf35d2eca00b`
- **Scope:** Rebases the self-contained globe-interaction browser QA onto current main. The runner owns an ephemeral loopback Vite server by default, preserves explicit external `QA_BASE_URL` behavior, and now treats both ordinary exits and signal termination as terminal child-process states.
- **User-visible change:** None directly; the QA can no longer validate a stale server on a fixed port, leak its shutdown fallback, or wait the full readiness/shutdown timeout after its owned Vite child has already died from a signal.
- **Review fixes:** Preserves the prior shutdown-timer cleanup review fix after rebase, then fixes the remaining P2 by centralizing child liveness in `hasChildExited()` (`exitCode` or `signalCode`) for readiness, startup cleanup, normal close, and SIGKILL fallback. Added a signal-terminated-child regression.
- **Follow-up:** None known for the QA ownership slice. Validation on current main: lifecycle tests 6/6 green, broader src/scripts suite 39 files / 390 tests green, client typecheck and production build green, `git diff --check` green, and the real self-owned `pnpm qa:globe-interaction` passed on an ephemeral port with all mobile/desktop gesture assertions and zero console/page errors.

### PR #112 - Apply grouped media placement suggestions

- **Source head:** `ce50b22ebedafd3c3469c3855c8c8362b429d99c`
- **Scope:** Rebases grouped EXIF/capture-time placement uploads onto current main and preserves the existing grouped destination plan while restoring the same post-upload refresh/selection guarantees as the single-destination upload path.
- **User-visible change:** Accepting a single grouped suggestion into another route point now opens the newly uploaded media instead of leaving an older item selected; if upload succeeds but the Journey refresh is null, throws, or cannot yet find the uploaded asset, Story reports that the upload succeeded and tells the user to reopen rather than upload again.
- **Review fixes:** Fixes both open P2 findings by resolving the newly uploaded asset from the refreshed accepted scope using returned asset IDs, and by treating null/throw/stale refresh results as explicit refresh failure. Partial-upload messaging also preserves the non-retry warning for already-uploaded media. Added regressions for selecting a new asset beside existing destination media and for null/stale refresh results.
- **Follow-up:** #86 remains the broader media-placement feature tracker. Validation on current main: grouped placement/JourneyStory targeted tests 69/69 green, full `src` suite 37 files / 379 tests green, client typecheck green, production build green, and `git diff --check` green. Full server typecheck in the shared local install remains blocked only by the existing six `S3Client.send` errors in `server/storage/s3-compatible-storage.ts`; GitHub CI is authoritative for the clean dependency environment.

### PR #121 - Bound EXIF TIFF reads to APP1 segment

- **Source head:** `56ff9cc37711f0facd8ea7d046ef5e11adac4f6a`
- **Scope:** Constrains all TIFF/IFD reads to the declared EXIF APP1 payload after rebasing onto current main, while preserving the newer date validation/fallback and GPS DMS correctness already merged in #123/#125.
- **User-visible change:** Malformed JPEG metadata can no longer borrow bytes beyond its declared EXIF segment and accidentally produce placement signals from unrelated trailing data.
- **Review fixes:** Semantically merged the newer EXIF test fixtures instead of replacing them; all scalar, entry, ASCII, rational, and indirect TIFF reads now share the APP1-local `tiffEnd` bound, with a regression proving a truncated APP1 cannot follow offsets into bytes that remain later in the JPEG.
- **Follow-up:** None known for the APP1-boundary change; PR #119 remains the separate Digitized-offset pairing lane. Validation on current main: targeted media-placement tests 21/21 green, full `src` suite 35 files / 362 tests green, typecheck green, production build green, and `git diff --check` green.

### PR #123 - Validate EXIF capture dates before placement scoring

- **Source head:** `253657ffad1b7fa501ac7a243fefa9091213f3d3`
- **Scope:** Validates EXIF calendar/clock values before they influence media-placement scoring and preserves valid fallback metadata after rebasing onto the latest main, including the already-merged GPS DMS validation from #125.
- **User-visible change:** Malformed capture dates no longer roll into another calendar date or suppress a usable fallback timestamp; year `0000` placeholders are ignored and a valid Digitized timestamp can still be used.
- **Review fixes:** Semantically merged main's newer GPS tests with this PR's date-validation coverage; fixed the outstanding P2 by rejecting year zero and normalizing DateTimeOriginal before deciding whether to fall back to DateTimeDigitized, with a dedicated `0000:01:01` fallback regression.
- **Follow-up:** PR #119 still owns correct pairing of Digitized timestamps with their own EXIF offset tag. Validation on current main: targeted media-placement tests 20/20 green, full `src` suite 35 files / 361 tests green, typecheck green, production build green, and `git diff --check` green.

## 2026-09-01

### PR #104 - Prototype opt-in particle-globe terrain relief

- **Source head:** `f5a5d9b3ffeb923f6ff0b5379afb171901ca7783`
- **Scope:** Rebases the opt-in terrain-relief experiment onto current main while preserving all intervening globe interaction, CI/mobile, playback, EXIF, and city-label fixes. Terrain remains disabled by default behind `?terrainRelief=1`.
- **User-visible change:** When explicitly enabled, shaded relief adds restrained geographic depth that increases with zoom without replacing the particle globe or loading the relief texture for default users. The relief layer now renders explicitly behind the primary particle field so near-zoom shading cannot wash out or darken the particle surface.
- **Review fixes:** Removed the stale duplicate globe-QA selector change from this PR because #109/#110 owns that harness follow-up; replaced the previous `coastline - 0.5` relief order with an explicit render hierarchy `relief < particle < coastline < signals < routes < personal points`, and assigned the primary particle layer an explicit render order instead of relying on Three.js defaults.
- **Follow-up:** #82 remains an experiment until same-location global/regional/near visual captures and representative-device frame-time/texture-memory measurements are recorded. Current-main validation: terrain/ParticleEarth/semantic/LivingAtlasGlobe targeted tests 44/44; non-DB src/scripts suite 37 files / 371 tests; production build and `git diff --check` green. Full typecheck is blocked only by the six pre-existing `S3Client.send` errors in `server/storage/s3-compatible-storage.ts` on current main.

### PR #116 - Suppress secondary city-label contact activation

- **Source head:** `1369a63625aa465b96578c4d892136bf295eaf39`
- **Scope:** Closes the remaining sibling-SVG activation gap after PR #108 by remembering a city-label contact whenever another globe pointer is already tracked, while preserving latest-main gesture, EXIF, and playback changes.
- **User-visible change:** A second finger that starts directly on a city label can no longer turn into an accidental city selection merely because the first canvas finger lifts earlier. Ordinary one-finger city taps remain unchanged.
- **Review fixes:** Preserves the prior post-merge correction that starts the sibling-layer guard at one tracked pointer; regression coverage keeps 0 tracked as an ordinary tap and 1/2/3 tracked as remembered contacts after the latest-main rebase.
- **Follow-up:** ParticleEarth targeted tests are 33/33; the broader local run reached 414 passing tests before 9 server suites hit the shared local `@aws-sdk/core/client` installation gap. Typecheck, production build, and `git diff --check` are green; clean-environment GitHub browser/verify gates remain authoritative before merge.

### PR #119 - Pair EXIF digitized timestamps with their offset

- **Source head:** `18e449b020f28453390b29306383869d3c2ef775`
- **Scope:** Corrects the local JPEG EXIF placement parser so each capture timestamp uses its matching EXIF timezone-offset tag: DateTimeOriginal/OffsetTimeOriginal first, then DateTimeDigitized/OffsetTimeDigitized as the fallback pair, rebased on the latest EXIF validation, APP1-boundary, and GPS-range fixes already in main.
- **User-visible change:** Photos that carry only a digitized capture timestamp plus an explicit timezone no longer lose that offset and risk being matched to the wrong Journey date or route point around timezone/day boundaries.
- **Review fixes:** Preserved main's calendar/range validation so malformed Original timestamps do not suppress a valid Digitized fallback; the existing invalid-Original regression remains green, and the Digitized-only `+08:00` case now verifies the matching `OffsetTimeDigitized` tag is used.
- **Follow-up:** Targeted media-placement tests are 22/22, typecheck, production build, and `git diff --check` are green on the rebased source head.

### PR #128 - Add Playback V2 tempo timeline foundation

- **Source head:** `d0bac51b121b815b7d89442b4d97674ce20d3945`
- **Scope:** Introduces the Playback V2 elapsed-time planning layer for #126: deterministic contiguous segments, phase-specific fast/standard/immersive tempo profiles, scrub lookup primitives, meaningful navigation indexes, and explicit plan-only representation of Journey-scoped visual media without changing the stable legacy playback step grammar.
- **User-visible change:** Primarily architectural foundation. The plan now preserves every canonical Full Journey visual, including `routePointId=null` opening media, so future scrubbing/tempo UI cannot silently omit Journey-level images or videos.
- **Review fixes:** Rebased onto current main, preserving newer seek and meaningful-navigation behavior. Fixed the P1 review by inserting Journey-scoped visual segments into the elapsed-time plan with image/video-specific durations, stable asset identities, and source-step mapping; added regressions proving those assets are ordered and individually reachable by elapsed-time lookup.
- **Follow-up:** #126 remains open for runtime tempo replanning and remaining Playback V2 integration. Validation on current main: planner + legacy playback/navigation tests 29/29 green, client typecheck green, production build green, and `git diff --check` green.

### PR #130 - Navigate Journey Playback by meaningful beats

- **Source head:** `886afce3139243e1989206770fd7ae903d2ace78`
- **Scope:** Separates automatic cinematic advancement from manual transport navigation so user controls skip internal `travel` bookkeeping while timer-driven playback still preserves the full travel/stop/media stream; rebased onto latest main while retaining the merged seek API.
- **User-visible change:** Next/Back land directly on meaningful visible beats instead of requiring an extra press through internal travel phases. Back remains usable while paused and keeps playback paused on the selected prior beat.
- **Review fixes:** Semantically resolved the rebase conflict by preserving main's `seek` transport while keeping this PR's `next`/`previous` controls. Fixed the P2 paused-Back regression and added a paused-navigation regression.
- **Follow-up:** Issue #126 still tracks the remaining Playback V2 work. Validation on current main: targeted playback/navigation/director tests 26/26 green, client typecheck green, production build green, and `git diff --check` green.

### PR #132 - Keep playback controls visible for keyboard focus

- **Source head:** `b020b62d44aa3d7929b1da2eb8bd04e48f3a2d1b`
- **Scope:** Refines Journey Playback chrome idle ownership without changing playback order, timer budgets, media synchronization, or the separate Playback V2 timeline/navigation work. The overlay tracks pointer/touch versus keyboard input modality across automatic step changes and gates the existing idle fade accordingly.
- **User-visible change:** Playback controls still fade after 2.5 seconds of uninterrupted pointer/touch viewing, but they stay visible while playback is paused and no longer disappear underneath a keyboard user's active focus.
- **Review fixes:** Self-review kept input modality persistent across playback steps; the final review fix also keeps pointer/touch/keyboard modality listeners attached while playback is paused, so clicking Play after a keyboard pause correctly restores pointer ownership and normal idle auto-hide instead of leaving focused chrome pinned indefinitely.
- **Follow-up:** #126 still owns tempo re-planning, scrub timeline, cinematic spatial grammar, and the remaining Playback V2 work. Revalidated on latest main: targeted playback/control tests 25/25 green, production build and `git diff --check` green; the broader test run passed 397 tests with only the existing 9 AWS SDK load failures, and server typecheck remains blocked only by the existing six `S3Client.send` errors in `server/storage/s3-compatible-storage.ts`.

### PR #125 - Reject malformed EXIF GPS DMS components

- **Source head:** `f691f46d5a2b56d80cde081aa0a05c3d8e24705d`
- **Scope:** Hardens the local JPEG EXIF placement parser so corrupt degree/minute/second coordinates cannot be normalized into plausible but incorrect decimal GPS values.
- **User-visible change:** Photos with malformed EXIF GPS minutes/seconds or coordinates beyond the pole/antimeridian no longer produce a false high-confidence Journey/route-point suggestion; valid capture-time evidence from the same photo is still preserved.
- **Review fixes:** Validates minutes and seconds as `[0, 60)`, caps latitude/longitude degrees at 90/180 before conversion, and only accepts exact pole/antimeridian degrees when both lower-order components are zero. Rebase review verified the feature patch remains patch-equivalent to the previously reviewed implementation, so no prior fix was lost.
- **Follow-up:** None known in this parser slice. Rebased onto `main@0a21787`; targeted media-placement tests are 16/16, client TypeScript, production build, and `git diff --check` are green.

### PR #134 - Add seekable Journey Playback timeline

- **Source head:** `50dc8384ff5ec9e19347d69d6319cb32f1e84292`
- **Scope:** Adds an atomic seek primitive to the existing Journey Playback director and upgrades the read-only progress line into a 44px interactive slider with route-point chapter ticks. Seeking reuses the current camera/media effects instead of introducing a second synchronization path, and paused playback remains paused at the selected target until resumed.
- **User-visible change:** The playback progress control can now be tapped, dragged, or adjusted with the keyboard to jump directly through the current expanded playback sequence while the globe focus and media stage follow the selected step.
- **Review fixes:** Preserves atomic seek and keyboard ownership, and fixes the latest P2 by including enabled input controls in the dialog focus-trap selector so the native range slider is reachable by Tab instead of being skipped.
- **Follow-up:** #126 still owns remaining Playback V2 work. Rebased onto current main; playback/director targeted tests are 21/21, client TypeScript, production build, and `git diff --check` are green.

### PR #136 - Add distance-aware playback camera choreography

- **Source head:** {source}
- **Scope:** Adds deterministic distance-aware Journey Playback camera grammar. Travel legs are classified by spherical angular distance into nearby, regional, and long-haul profiles and that profile is carried through the persistent globe focus path without changing playback ordering, seek semantics, tempo planning, or media transport.
- **User-visible change:** Nearby legs settle more quickly and directly; regional/long-haul legs use a restrained pullback before approaching the next route point, so intercontinental travel no longer uses exactly the same camera sentence as same-city movement. Stop/media chapters at the same point retain the existing stable camera key and do not retrigger travel motion.
- **Review fixes:** Preserves the deterministic particle-globe distance choreography and fixes the latest P2 by forwarding the same flight profile into the visible `DetailedEarthMap`; detail mode now maps nearby/regional/long-haul legs to distinct focus durations instead of flattening every leg to 900 ms. Added regression coverage for duration ordering and the default.
- **Follow-up:** #126 still owns remaining Playback V2 work. Rebased onto current main; Journey Playback + detailed-earth targeted tests are 27/27, production build and `git diff --check` are green. Repository typecheck remains blocked only by the same six pre-existing `S3Client.send` errors in `server/storage/s3-compatible-storage.ts`.

### PR #138 - Avoid near-expiry soundtrack signed reads

- **Source head:** `d9a728308c13794d88a1f1b336c0d5de23cd3a4c`
- **Scope:** Rebases the soundtrack signed-read freshness hardening onto current main and preserves the 30-second freshness margin while carrying the exact read snapshot accepted by the initiating playback click into the overlay.
- **User-visible change:** Journey Playback no longer treats a near-expiry soundtrack URL as ready, and a read that was accepted during the user's click cannot be invalidated by a second render-time freshness check before the overlay starts audio.
- **Review fixes:** The current P2 is addressed by storing the `cachedSoundtrackRead()` result accepted in `startPlayback()` and passing that snapshot directly as `initialSoundtrackRead`; preparation paths clear the snapshot and closing playback releases it. This keeps the first `audio.play()` on the same user-activation path instead of forcing a later async refetch.
- **Follow-up:** #137 remains the tracking issue. Rebased onto `main@8fc24be`; soundtrack cache targeted tests are 5/5, production build and `git diff --check` are green. Repository typecheck remains blocked only by the same six pre-existing `S3Client.send` errors in `server/storage/s3-compatible-storage.ts`.

### PR #141 - Cancel stale carousel settle after Story scope changes

- **Source head:** `c6442f0c35298fabba6c96076e07762f3eda5ca2`
- **Scope:** Rebases the cancellable mobile Story/fullscreen carousel settle lifecycle onto `main@5a078ac` after the parallel-CI baseline. Pending settle timers and active drag visuals are cancelled for external Journey/route-point changes, Story unmount, and internal media-scope changes before the new scope can accept stale settle work.
- **User-visible change:** Switching Journey or route-point during the 220 ms mobile swipe settle can no longer let a delayed callback from the previous scope select an old asset/index or restore stale drag visuals. This now also covers route-point scope changes initiated inside Story and placement-confirmation flows.
- **Review fixes:** The existing single-run cancellable settle scheduler is preserved. The current P2 review is addressed by synchronously calling the shared pending-drag cancellation helper before `selectMediaScope()` and `confirmPlacementUpload()` update `selectedRoutePointId`, while the Journey/prop reset and unmount paths reuse the same helper.
- **Validation:** Rebased onto `main@7869146`; `JourneyStory.test.ts` 38/38, full `src` 32 files / 322 tests, TypeScript, production build, and `git diff --check` are green. GitHub final-head CI remains authoritative before merge.
- **Follow-up:** None known for this stale-settle cancellation slice.

### PR #139 - fix-deploy-utf8-console

- **Source head:** `afd5b9def0f69422725e95cee0f6dc149e46898c`
- **Scope:** Configures `scripts/deploy-main.py` stdout/stderr as UTF-8 with replacement fallback when the active Python streams support `reconfigure`, leaving deployment transport, server selection, host-key verification, and command execution unchanged.
- **User-visible change:** Windows deployments can stream Unicode/Chinese deploy output without failing on a legacy console code page; unencodable characters degrade to replacement output instead of aborting the deployment process.
- **Review fixes:** Rebased the single-purpose change onto current main and re-reviewed the resulting one-file diff; there are no unresolved review threads and no additional review-fix commits to preserve.
- **Validation:** `python -m py_compile scripts/deploy-main.py` and `git diff --check origin/main...HEAD` pass on the rebased source head. GitHub CI on the final ledger head remains authoritative before merge.
- **Follow-up:** None known.

### PR #142 - Parallelize browser QA in CI

- **Source head:** `cac74af85f7d15d4186c653b81e83dcd31369d62`
- **Scope:** Splits the previously serial browser acceptance block into three parallel browser-QA lanes while keeping schema generation, PostgreSQL migrations, typecheck, full tests, and build in a core lane. A final job named exactly `verify` remains the merge-readiness gate and succeeds only when both core and the aggregate browser matrix succeed.
- **User-visible change:** None; this is CI wall-clock optimization only. No acceptance coverage is removed.
- **Review fixes:** `qa:login-v3` and `qa:media-controls` share one balanced lane, while `qa:post-login-controls` and the distinct `qa:final-acceptance` mode each keep dedicated lanes. Matrix fail-fast is disabled so failures remain diagnosable, and the final `verify` job uses `if: always()` plus explicit dependency-result checks to prevent failed, cancelled, or skipped validation from producing a false green gate. Superseded runs are cancelled through workflow concurrency.
- **Follow-up:** Compare PR and merge-to-main wall-clock time against the pre-optimization ~6m56s baseline (browser QA ~4m55s serial). GitHub CI is authoritative for timing and correctness.

### PR #135 - Fix mobile carousel settle continuity

- **Source head:** `0530c0206595774733cdd8bd05dc5d501d6dcba7`
- **Scope:** Fixes the remaining mobile direct-manipulation carousel settle boundary where the imperative drag cleanup could restore the old base frame before React committed the newly landed semantic media owner. The change is limited to committed, already-ready swipe landings and leaves pointermove tracking, slow-target spring-back, desktop crossfade, playback ordering, and media decode policy unchanged.
- **User-visible change:** After a successful mobile swipe finishes sliding the next image into place, the old image can no longer briefly reappear during the semantic slot handoff; the centered target remains the visible owner continuously through settle.
- **Review fixes:** The final implementation synchronously commits the new media identity with `flushSync` before hiding the centered drag peek/resetting the old base transform, and shares that ordering with reduced-motion landings. A regression locks the commit-before-cleanup contract.
- **Follow-up:** #65 stays open for broader real-device acceptance across delayed decode, mixed image/video, route-point boundary crossing, rapid reversal, inline Story and true fullscreen. Targeted JourneyStory/media swipe tests are 41/41, the full `src` suite is 32 files / 320 tests, TypeScript and production build are green, and `git diff --check` is green.

### PR #133 - Upgrade CI actions to Node 24 runtimes

- **Source head:** `5cc3b9be1af0712624c3cfd43f6ac79b9db8b82a`
- **Scope:** Upgrades the JavaScript action runtimes used by CI from `actions/checkout@v4`, `pnpm/action-setup@v4`, and `actions/setup-node@v4` to `checkout@v7`, `pnpm/action-setup@v6`, and `setup-node@v7`. The project test/runtime target remains pinned to Node.js 22.
- **User-visible change:** None; this is CI maintenance only.
- **Review fixes:** Separates GitHub Action runtime compatibility from the application's Node.js runtime so the Node 20 deprecation warning can be removed without changing the app's Node.js 22 test/build baseline.
- **Follow-up:** Merge only after PR #133 GitHub `verify` is green and review has no blocker; then validate the merge-to-main push run before rebasing the remaining open PRs onto the new baseline.

### PR #131 - Stabilize gateway refetch recovery QA

- **Source head:** `78b890d4de1da60f7213526e65a4f1c0af9a5ed6`
- **Scope:** Makes the `gateway-refetch-failure-recovery` browser QA wait on the two facts the scenario actually owns: at least one post-sign-in `/get-session` failure response has completed, and the recovered Login V3 card is visible/interactable. This replaces fixed-delay and cross-layer timing assumptions with deterministic network + UI readiness gates.
- **User-visible change:** None; this only makes the CI recovery gate deterministic. Production authentication and playback flows are unchanged.
- **Review fixes:** The main push after PR #129 first exposed a mount-order race where `.auth-continuity.is-login` could be observable before `.auth-card--login-v3` mounted. PR CI then exposed the inverse ordering: the card could already be visible while the intended failed post-sign-in session refetch had not completed. The QA now records completed failed session responses and waits for that metric before asserting the recovered interactive login card, while retaining the requirement that a post-sign-in session request occurred.
- **Follow-up:** Main CI run `33495049599` / job `99815180594` was the motivating failure; PR #131 run `33499818600` exposed the second ordering race (`postSignInSessionRequests=0`). GitHub PR verify remains authoritative before merge.

### PR #129 - Preserve playback progress across pause and resume

- **Source head:** `296b27c8ade25daa07d208ad36be3beeece1afa9`
- **Scope:** Makes the existing Journey Playback director preserve the active step's elapsed-time budget across pause/resume and media decode holds, without depending on the separate Playback V2 tempo/timeline planner.
- **User-visible change:** Pausing partway through a playback beat and resuming no longer restarts that beat's full wait; playback continues with only the remaining time. Slow-media readiness holds likewise freeze rather than reset the current timer budget.
- **Review fixes:** Timer state is keyed to Journey/expanded-step identity, active elapsed time is consumed with a monotonic clock, completed/manual step transitions cannot leak old budget into the next step, and Journey changes explicitly reset all timer refs.
- **Follow-up:** #126 still owns tempo re-planning, meaningful next/back, scrub UI, and cinematic grammar. After rebasing onto `main@d22673b`, targeted legacy playback + timer tests are 16/16, the full test suite and production build are green, and `git diff --check` is green. Local typecheck remains blocked only by the existing six `S3Client.send` errors in `server/storage/s3-compatible-storage.ts`.

### PR #118 — Restore CI integration and mobile pointer baselines

- **Source head:** `d7a049cbc45687401654810998aeeb81d8c5feef`
- **Scope:** Restores the CI baseline uncovered after GitHub Actions quota recovery. The PostgreSQL integration scenario restores both destination route-point placement and exact destination ordering before retrying a stale cross-Journey Undo descriptor. Mobile Story restores Escape ownership for nested management surfaces and real pointer ownership for fullscreen media. Post-login QA follows the rendered account host contract: Mobile V2 trigger/sheet in the Atlas shell and standalone dock fallback in focused globe-control previews. Mobile modal layering now gives Story declarative ownership of the parent Journey sheet inert state while the real-map modal keeps its existing `useModalFocus` ownership.
- **User-visible change:** Mobile fullscreen media now receives real touch/pointer input instead of passing hit-testing through to inline Story media. Escape closes the active nested media-management surface before unwinding Manage mode. Globe point-picking hides the Mobile V2 account trigger. Opening Story from the mobile Journey sheet now removes the underlying sheet from the interaction/accessibility tree and restores it after Back without leaving stale inert state.
- **Review fixes:** Kept the production stale-Undo guard unchanged and corrected the integration test to restore the full state it claims to restore. Fixed mobile fullscreen pointer-event ownership, commit-driven Journey-delete focus restoration, Mobile V2 account-host QA selection, account collision measurement against real sibling controls instead of its containing nav, and the Story-vs-map inert ownership race that could leave the Journey sheet permanently inert after closing the real map.
- **Validation:** GitHub CI run `33490802390` on code head `d7a049c` passed migrations, Typecheck, full Test/PostgreSQL integration, Chromium login/media/post-login QA, Build, and job cleanup.
- **Follow-up:** After this ledger-only head is re-reviewed and CI remains green, #65 can be audited for closure and the other open PRs can update to the repaired main baseline before rerunning their own CI.


### PR #108 - Bound particle-globe gestures to two pointers

- **Source head:** `b105c76ffa1f2ae51799d61d557d7f1465765097`
- **Scope:** Rebases the post-#105 two-pointer gesture bound onto current main and closes the remaining sibling-SVG lifecycle gap when an overflow contact begins directly on a city label instead of the canvas.
- **User-visible change:** An accidental third touch, mouse, or stylus contact can no longer activate a city label after the two tracked gesture contacts end, even when that extra contact started directly on the overlaid city-label SVG. Normal city taps, one-finger drag and two-finger anchored pinch remain unchanged.
- **Review fixes:** Capacity-rejected canvas pointers remain suppressed for their full lifecycle; city-label pointer-up independently applies the same suppression contract; and the city SVG layer now records pointer-downs that begin while two tracked pointers already own the globe, so direct label-origin overflow contacts cannot escape suppression when the first two contacts release earlier.
- **Follow-up:** None known. ParticleEarth targeted tests are 33/33, the non-DB suite is 47 files / 438 tests, typecheck, production build and `git diff --check` are green. The existing #105 mobile/desktop globe-interaction browser QA is green with 1x/2x/3x 30px drag equivalence, anchored pinch, zero pinch-to-drag rebase jump, manual focus ownership, and zero console/page errors.

### PR #111 - Suggest media placement from local capture metadata

- **Source head:** `00ccb22b1f95fa51f458984bdec3b73edebf8a4d`
- **Scope:** Adds privacy-preserving local EXIF/capture-time placement suggestions for Journey and route-point upload destinations, plus the Story review flow that lets the user accept or override the proposed scope before upload.
- **User-visible change:** Photos with reliable location/time metadata can be suggested into the most plausible Journey point without uploading raw EXIF. After accepting a different route-point destination, the uploaded media is immediately selected from that new scope instead of falsely reporting a refresh failure.
- **Review fixes:** Decoupled strong-signal conflict detection from the combined recommendation score: strong GPS chooses the nearest eligible route point using spatial evidence only, while strong absolute time chooses the closest timestamp independently, so contradictory nearby GPS/time signals correctly suppress a suggestion. The post-upload refresh now filters with the accepted `targetRoutePointId` explicitly rather than the stale pre-click React state closure. Added regressions for same-city conflicting strong signals and stale-scope refresh selection.
- **Follow-up:** Broader cross-Journey placement UX and metadata coverage remain product follow-up; raw metadata stays browser-local. Targeted placement/Story tests are 46/46, the non-DB suite is 47 files / 435 tests, typecheck, production build, and `git diff --check` are green.

## 2026-09-01

### PR #103 - Add server-backed undo for media reassignment

- **Source head:** `52982c42ea54c17b07b59072dcfc79b2dac4f2e8`
- **Scope:** Rebases same-Journey media reassignment Undo onto `main@9d74a69`, preserving the merged carousel-settle, CI/deploy, grouped-placement, playback, and cross-Journey Undo behavior while keeping PR #103's server-backed same-Journey restore contract.
- **User-visible change:** Same-Journey media moves remain safely undoable with exact ownership/order restoration. Rejected cross-chapter drag attempts no longer erase a still-valid Undo, and an ambiguous retry that returns `MEDIA_MOVE_UNDO_STALE` now reconciles the Journey from the server before retiring the action so the UI cannot remain on a stale moved state.
- **Review fixes:** Preserved the 10,000-item pre-mutation undo-safe guard, soundtrack/media invalidation, complete same-Journey media-row `FOR UPDATE` locking, retryable descriptor retention, and nullable refresh handling across rebase. Final P2 fixes defer Undo invalidation until drag reorder validation has passed and force a server refresh on stale 409 after a retained retry. Regression helpers cover cross-chapter rejection and stale-retry reconciliation.
- **Follow-up:** Cross-Journey destination-picker UX remains tracked separately. Final validation on rebased source: JourneyStory 43/43; server uploads validation 33/33; full `src` suite 32 files / 328 tests green on the final source; typecheck, production build, and `git diff --check` green. Tenant integration is locally blocked before tests by PostgreSQL not listening on `127.0.0.1:5432`; GitHub CI remains authoritative for DB integration.


### PR #106 — Add spatial particle LOD for high zoom

- **Source head:** `6cde48fd1d5951999307c70eb21b923aba4f2a99`
- **Scope:** Rebases spatial particle LOD onto current `main@0043fda`, preserving the newly merged opt-in terrain-relief hierarchy and all intervening globe/mobile/playback/EXIF fixes while retaining bounded 50m regional particle refinement, semantic-zoom integration, cooperative cancellation, caching, and debug observability.
- **User-visible change:** Zooming into Hong Kong/Shenzhen and other supported local views now progressively reveals denser geographic particle detail instead of magnifying the same sparse global distribution, without multiplying the whole-Earth particle budget or changing close-range drag/pinch behavior.
- **Review fixes:** Preserves all earlier focus-flight, stale-build, retry/backoff, and failed-request release fixes. Current review also fixes both open P2s: reduced-motion now snaps refinement opacity/LOD transitions instead of damping, and the refinement-only 50m land-mask loader no longer retains expanded GeoJSON rings after rasterization.
- **Follow-up:** Terrain relief is now present on main via #104 and remains opt-in; #81 continues to own geographic-fidelity acceptance. Current-main validation: targeted ParticleEarth/spatial/semantic/relief 49/49; non-DB src/scripts suite 38 files / 380 tests; production build and `git diff --check` green. Full typecheck is blocked only by the six pre-existing `S3Client.send` errors in `server/storage/s3-compatible-storage.ts` on current main.

### PR #105 — Stabilize high-zoom globe drag and pinch

- **Source head:** `7596ebf21e7946e631ea2f187c83fb8e28ffe3a9`
- **Scope:** Replaces fixed mobile globe drag sensitivity with projected-surface screen-space mapping, calibrates inertia from the same interaction radius, anchors pinch zoom to the visible geographic surface, rebases pinch-to-drag handoff, and prevents stale focus revisions from retaking manual camera ownership. Adds detailed interaction debug state and a dedicated real-browser QA runner.
- **User-visible change:** Close-range globe manipulation now stays precise instead of becoming hypersensitive: the same finger movement produces comparable visual displacement from whole-Earth to max zoom, off-center pinch keeps the inspected geography under the fingers, and small high-zoom flicks no longer throw the target away.
- **Review fixes:** None yet; pre-review integration preserved the merged semantic-zoom/coastline behavior from #98/#97 while layering the new interaction model on latest main. Browser QA measured ~30px equivalent displacement for a 30px drag at 1x/2x/3x, 0.013px pinch-anchor error, zero pinch-to-drag rebase jump, and no console/page errors.
- **Follow-up:** #81 remains the complementary high-zoom geographic-fidelity lane. Targeted scene/semantic tests (34/34), non-DB suite (46 files / 418 tests), typecheck, production build, `git diff --check`, and branch-local mobile/desktop browser interaction QA are green.

### PR #102 ? Add cross-Journey media move foundation

- **Source head:** `b73e47be1254992b295ce46110eab4c6608cf92e`
- **Scope:** Extends the existing media reassignment mutation with same-Atlas cross-Journey ownership transfer, deterministic source/destination locking, canonical source/destination refresh payloads, server-generated undo descriptors, and a real undo mutation that restores Journey ownership, route-point placement, source ordering, and moved source-cover state while rejecting stale/conflicting replay.
- **User-visible change:** This backend/API foundation enables photos and videos to move between Journeys without re-uploading bytes and gives the upcoming UI a safe server-backed Undo path; no new cross-Journey destination picker is exposed by this PR itself.
- **Review fixes:** Rebased the branch onto latest `main@44e200c`; fixed both stale-Undo P1 races. Undo now verifies the expected post-move source order and a server-generated destination snapshot (`targetRoutePointId + targetOrder`) before mutating either Journey. Newer source reorder/upload/delete or destination reclassify/reorder/upload/delete therefore return 409 instead of being overwritten. Integration regressions cover source reorder and destination route-point reclassification while preserving the newer state.
- **Follow-up:** #75 remains open for the hierarchical Journey/route-point destination picker and user-facing Undo notice/history wiring. Targeted parser/API tests (41/41), the non-DB suite (46 files / 415 tests), typecheck, production build, and `git diff --check` are green. The tenant integration suite includes the new stale-reorder regression but cannot execute locally because PostgreSQL is not listening on `127.0.0.1:5432`.

### PR #101 ? Correct PR 99 review ledger

- **Source head:** `f8bb5b43c9805dc7233d3b44d8bc3ccabad3a5b9`
- **Scope:** Repairs the durable PR ledger after PR #99 merged from a later reviewed source head than the SHA recorded in its in-branch history entry.
- **User-visible change:** None; this is a documentation/governance correction so future audits point to the exact #99 head that was reviewed against latest main before merge.
- **Review fixes:** Verified the corrected #99 source head `d5c22e5` included latest main / PR #100 without modifying #99's media-management logic; recorded the executed branch-local Chromium acceptance and latest-main validation evidence; confirmed the correction commit changes only `docs/pr-history.md`.
- **Follow-up:** No product follow-up from this docs-only repair. The pre-existing Issue #65 media velocity-flick QA timeout remains tracked separately.

### PR #100 ? Define deterministic Journey keepsake render manifest

- **Source head:** `23c7eb2f6dbfff5d9573b05902897feb316646ac`
- **Scope:** Defines the phase-1 deterministic keepsake render manifest and hybrid authorized-server-render contract, reusing live Journey Playback ordering while encoding private media references as stable IDs and supporting portrait-first 15/30/60-second pacing presets.
- **User-visible change:** Establishes the export contract for future private Journey reels so route arrivals, travel, opening media, point media, and outro scenes can render in the same semantic order as live playback without embedding signed URLs or exposing storage coordinates.
- **Review fixes:** Replaced index-only geography with role-specific required stable route-point IDs on arrival/travel scenes; made `journeyId + journeyRevision` an explicit hard render precondition; added a stable-ID narrative snapshot of route order and canonical visual-media placement/order so queued manifests also reject media move, reorder, upload, or deletion paths that do not bump Journey revision; added missing-ID/placement validation and regressions for route reorder plus same-revision media mutations.
- **Follow-up:** The next #87 slice remains the dedicated render harness and deterministic 3-stop output experiment with encode-time, peak-memory, file-size, and visual-quality measurements. GitHub-hosted verify/readiness checks on the reviewed code head were zero-step runner failures; targeted keepsake/playback tests (19/19), the non-DB suite (46 files / 410 tests), typecheck, production build, and `git diff --check` were green.

### PR #99 — Make mobile media reassignment discoverable

- **Source head:** `d5c22e55d9f11b5aa3ca3be3510a5bd30095f33e`
- **Scope:** Adds a first-level mobile media-management action for reassignment/reclassification, enters the existing multi-select move flow directly, and adds a dedicated Chromium QA runner for discoverability, 44px touch targets, Back/Escape ownership, focus restoration, and pending-mutation behavior.
- **User-visible change:** On mobile, users can move or reclassify media directly from the first management sheet instead of first entering an unrelated organize/select path; normal Escape and Browser Back restore Viewer/focus predictably, while an in-flight move cannot be dismissed by Escape.
- **Review fixes:** Split the #74 acceptance coverage into an independently runnable browser QA so the pre-existing #65 velocity-flick timeout cannot hide the new checks; synchronized the collapsed-mobile Escape handler with current `mutationPending` state and added a held-request regression proving pending Escape stays in Manage with the move UI intact.
- **Follow-up:** The broader `qa:media-controls` runner still has the pre-existing Issue #65 velocity-flick timeout on current main. After merging latest `main` / PR #100 into the reviewed source head, the dedicated `qa:media-reclassification` Chromium acceptance passed on an isolated branch-local Vite origin, JourneyStory was 34/34, the non-DB suite was 46 files / 410 tests, typecheck, production build, and diff-check were green. GitHub-hosted verify/readiness checks remained zero-step runner failures.

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

### PR #188 — Preserve media-less Full Playback route points

- **Source head:** `7b166052d5c6085af824ef3994ca4b32927187af`
- **Scope:** Restores Full Playback route coverage by requiring every canonical route point to have one chapter while permitting an empty camera/arrival-only route chapter only when that route owns no current-revision visual media.
- **User-visible change:** Full Playback can still visit and present a place/note even when that stop has no photo or video, instead of forcing the route point to disappear from the validated plan.
- **Review fixes:** Keeps empty chapters forbidden for routes that do own canonical media and leaves Quick Recap's stricter non-empty topology unchanged.
- **Follow-up:** Re-review after the open Full camera/preservation PRs rebase because they touch adjacent validation semantics.

### PR #190 — Reject duplicate MediaDigest asset identities

- **Source head:** `be6b59b9ac58f136b22dcd4904a5b94ccfa9dbf1`
- **Scope:** Rejects duplicate `MediaDigestV1.assetId` identities before constructing the validator lookup map, so canonical ownership, source index, revision, and preservation checks cannot depend on last-write-wins digest ordering.
- **User-visible change:** No intentional UI change; malformed/ambiguous auto-edit analysis input now fails closed instead of potentially validating against the wrong digest facts.
- **Review fixes:** Kept the guard mode-agnostic and limited to identity uniqueness; no new MediaDigest product semantics were introduced.
- **Follow-up:** Full test/typecheck/build/browser verification remains delegated to GitHub CI.

### PR #160 - Release stale playback ownership when Journey disappears

- **Source head:** `e6975359de2a4158694ac9794ff822151b5eb8dc`
- **Scope:** Releases stale Journey Playback ownership only after Journey loading settles, clears stale soundtrack/camera state, and hands normal globe focus a revision above the last playback camera revision so Three.js accepts the ownership transfer.
- **User-visible change:** If the currently playing Journey disappears after refresh/concurrent deletion, the cinematic overlay/isolation closes and the globe returns to the normal current focus instead of remaining stuck on the deleted Journey.
- **Review fixes:** Final P2 review identified that nulling the React camera command alone could leave `ParticleEarthScene` rejecting the lower normal focus revision. The fix publishes a monotonic release revision and uses it as the baseline for the next playback camera command; focused unit coverage verifies the handoff revision outranks stale playback ownership. Timeline play, seek, autoplay steps, and scrub previews now also advance a monotonic timeline revision so post-release focus intents cannot be rejected for reusing the release-floor revision.
- **Follow-up:** None known at source review time.
- **Validation:** Rebased onto `main@f665df5`; `git diff --check` green. The isolated finalization worktree has no Vitest executable, so GitHub CI is authoritative for targeted tests, TypeScript, build, and browser QA on the final docs-only head.

### PR #168 - Enforce Quick Recap media timing semantics

- **Source head:** `eed2cdd64edb30bc1b432f6d5b524201640b9240`
- **Scope:** Tightens Quick Recap V1 validation so photo roles follow deterministic chapter order/pin-cover semantics, image dwell matches tempo + role policy, and video trims start at zero and end at the tempo-capped source duration.
- **User-visible change:** Malformed AI/JSON recap plans can no longer stretch still images or choose arbitrary in-range video slices and hide the change by forging a matching planned duration.
- **Review fixes:** Replayed the validated code onto the latest main while dropping the stale conflicting ledger commit; scope remains deliberately limited to `quick-recap`, preserving Full/Keepsake evolution. Builder-generated fast/standard/immersive plans remain the reference grammar.
- **Follow-up:** Keepsake-specific timing semantics and future semantic video-highlight selection remain separate follow-up work under #127/#87; this PR does not define them.
- **Validation:** Rebased onto `main@0600361`; `git diff --check` is green. The earlier exact-head CI failure was a real executed browser-QA failure, so the rebased head must pass fresh GitHub CI before merge; no unrelated source workaround was added.

### PR #163 - Let Full Journey videos own playback completion

- **Source head:** `36128fcfcb27763bd02030df1e8cced11639675b`
- **Scope:** Lets healthy Full Journey videos own playback completion via media-ended semantics, with bounded stall/failure fallback and transport synchronization.
- **User-visible change:** Full Playback no longer silently advances long healthy videos on the legacy fixed timer; failed/stalled playback degrades without trapping the Journey.
- **Review fixes:** Keeps `play()` failures sticky across download `progress`/`timeupdate`, clears them only on actual `playing`, and resynchronizes transport when a signed video read becomes ready so a newly mounted element is explicitly played or paused.
- **Follow-up:** Persisted intrinsic video duration remains separate follow-up work.

### PR #184 - Fail closed on malformed auto-edit identity fields

- **Source head:** `40313a2b350711f708352f6b74754162f6f87344`
- **Scope:** Hardens AutoEditPlan V1 structural validation for top-level, chapter, camera, item, photo-role, and arrival primitive shapes before semantic validation.
- **User-visible change:** No intentional product behavior change; malformed external/AI edit plans fail closed before typed execution.
- **Review fixes:** Keeps enum membership and mode-specific semantics in the semantic validator and aligns malformed photo-role coverage with the stricter structural gate.
- **Follow-up:** None known; `git diff --check` is green after rebasing onto the latest main and GitHub CI is authoritative for final validation.


### PR #186 - Reject duplicate auto-edit chapter identities

- **Source head:** `994373728c0f03766f21cfca3e8537ee000f419b`
- **Scope:** Requires `AutoEditPlanV1` chapter identities to be unique after structural type validation, preventing ambiguous chapter identity while preserving existing scope, chronology, camera, media, and timing semantics.
- **User-visible change:** No intentional UI change; malformed edit plans that reuse a chapter identity now fail closed instead of reaching playback/render with ambiguous chapter keys.
- **Review fixes:** Preserved the existing structural `chapterId` type gate before deduplication and retained the main-branch route-point shape validation while replaying onto the latest main.
- **Follow-up:** None known; GitHub CI remains authoritative after the final docs-only head update.


### PR #178 - Enforce Full Playback camera and arrival semantics

- **Source head:** `1bf7a0fdfc6bb1ac818de4228a2b3ce71a3969b3`
- **Scope:** Enforces canonical Full Playback V1 choreography: intro chapters hold with zero camera duration and no arrival, while route chapters travel for the canonical camera duration and require canonical arrival label/note semantics.
- **User-visible change:** Full Playback plans can no longer silently remove or alter the spatial arrival rhythm while remaining arithmetically valid.
- **Review fixes:** Updated canonical Full fixtures to include required arrival timing/flags and replayed both reviewed source commits cleanly onto the latest main with no code conflict.
- **Follow-up:** None known; GitHub CI remains authoritative after the final docs-only head update.


### PR #162 - Add runtime Journey Playback tempo control

- **Source head:** `9c1d64d4648aee451b9783ef4a38b52b4f95d071`
- **Scope:** Adds runtime playback tempo switching, preserved-progress replanning in the director, accessible tempo controls, reduced-motion handling, and layout adjustments for mobile transport/soundtrack coexistence.
- **User-visible change:** Users can change Journey Playback pace without restarting the Journey or soundtrack, while mobile controls remain within the transport grid and do not overlap soundtrack UI.
- **Review fixes:** Includes the reviewed keyboard/reduced-motion fix, mobile grid containment, and soundtrack clearance fixes; all four source commits replayed cleanly onto the latest main.
- **Follow-up:** None known; GitHub CI remains authoritative after the final docs-only head update.


### PR #161 - Add spatial coastline refinement foundation

- **Source head:** `918306b9f9ceb8be2d6bc624b301ef0bc93af092`
- **Scope:** Adds bounded spatial coastline refinement primitives and integrates them into the particle Earth scene, including focus/interaction deferral and reviewed lifecycle safeguards.
- **User-visible change:** Close-zoom coastline refinement can allocate detail by active region while avoiding stale refinement during focus flights or active interaction.
- **Review fixes:** Includes the reviewed focus-flight deferral, interaction deferral, and final coastline refinement blocker fixes; all four source commits replayed cleanly onto the latest main.
- **Follow-up:** This remains a foundation toward the full #154 high-detail local coastline acceptance criteria; GitHub CI is authoritative for final validation.

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
