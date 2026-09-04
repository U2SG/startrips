# Cross-Feature Assumption Audit (CFAA)

This document is the durable form of the audit policy defined in issue #198. It is versioned with
the code so review guidance, the invariant library and the audit procedures change through pull
requests rather than living only in an issue thread.

## Philosophy

Startrips has passed the point where its serious regressions come from one feature being locally
wrong. The dominant failure shape is now composition:

> Feature A was correct under an old assumption. Feature B later changed that assumption. Both
> features remain locally reasonable, and their composition is wrong.

A CFAA therefore asks two questions, and the second one is the question ordinary review misses:

> **What did this change make variable that older code assumed was fixed?**

> **Which previously-correct subsystem now receives inputs or states it was never designed for?**

Feature-level review answers "does this feature work?". A CFAA answers "what did this feature make
variable that the rest of Startrips still assumes is fixed?". The `merge-readiness` gate asks whether
a pull request satisfied its own declared checks; a CFAA asks whether it changed an assumption that
nobody declared as part of it. Those are different failure classes, and CFAA complements CI, the unit
suites, the targeted QA scripts, the pull request ledger and human review rather than replacing any
of them.

Two directions have to be covered:

- **Forward compatibility** — which existing subsystems consume the state, geometry, timing, layout
  or authority this change produces?
- **Backward assumption compatibility** — which older code assumes this dimension is fixed, bounded,
  single-mode, or owned by exactly one subsystem?

The point of the audit is to force the author and the reviewer to *name the changed assumption*. It
is not a checkbox ritual: a filled template that only restates the feature has produced no audit.

## High-risk dimensions

A pull request that materially changes one of these dimensions carries a full audit. The canonical
question is the shortest way to decide whether the dimension really moved.

| # | Dimension | Typical change | Subsystems to audit | Canonical question |
| --- | --- | --- | --- | --- |
| 1 | Scale / zoom / projection | global to regional to close zoom, world-space to screen-space presentation, differing 3D radii, camera distance or field of view, semantic level of detail | route geometry, waypoint markers, place labels, coastline, particle density, hit targets, occlusion and horizon, line width, screen-space offsets | Does a world-space constant become visually wrong when magnified? |
| 2 | Layout mode / posture / safe area | phone-landscape contract, collapsible Story, fullscreen, safe-area insets, device classification | JavaScript layout decisions, CSS media queries, globe safe area, labels and connectors, account surfaces, Playback overlay, focus composition, back and history semantics | Can two subsystems classify the same viewport differently? |
| 3 | Time / tempo / duration | runtime tempo, real media duration, seek, pause and resume, user-adjustable speed | fixed timers, animation durations, media preload and decode windows, signed URL lifetime, debounce windows, idle timeouts, auto-dismiss, transition settle timing | Did a fixed timeout or window assume the old consumption rate? |
| 4 | Media type / content topology / cardinality | photo-only to mixed photo and video, journey-scoped media, media-less route points, video-only chapters, five assets to a hundred | `isImage` / `isVideo` style filters, empty-state fallback, chapter inclusion, ordering, batch operations, cover semantics, Quick Recap, Keepsake, preload budgets | Does a broader model feed a narrower production projection? |
| 5 | Focus / ownership / async revision | one canonical focus intent, rapid A to B to C selection, seek during an async media load, journey or media changed while analysis runs | stale callbacks, late settle completion, async analysis, cache commits, route focus, playback state, media reassignment, signed reads | Can an older owner or result commit after a newer intent already won? |
| 6 | Semantic reveal / data coverage | zoom reveals lower-rank place labels, local coastline gains detail, more route points become visible, more media enters a planner | localized name completeness, source-data resolution, missing metadata, fallback behaviour, collision budgets, QA fixtures that only covered coarse tiers | Did revealing more data expose an old coverage hole that was previously invisible? |
| 7 | Rendering layers / occlusion / visual hierarchy | elevated route, coastline level of detail, labels, relief, particle refinement, shared-element media compositor | z and radius mismatch, clipping horizon, opacity stacking, double brightness, layer transition ownership, one-frame gaps, stale incoming and base layers | Do two representations of the same semantic object still share one visual anchor and one owner? |
| 8 | Quality / performance tier | low and high quality tiers, mobile GPU budget, spatial chunking, heavier media analysis | semantic differences between tiers, cache size, vertex and particle limits, main-thread work, decode concurrency, fallback behaviour | Did performance degradation accidentally become semantic degradation? |
| 9 | Authorization identity and lifetime | guest share grants alongside member sessions, read-only capability, expiry and revocation, presigned media reads | atlas derivation, route and media read paths, navigation and timeline reachability, playback prefetch, request logging and telemetry, already-open pages after revocation | Can a narrower identity reach a surface that was written assuming the owning member? |

## Invariant library

Each incident that teaches a reusable rule becomes one sentence here, with the issue that
established it. An invariant outlives the pull request that discovered it; a screenshot does not.

1. **One product mode per viewport** — one viewport resolves to exactly one product interaction
   mode, and no child subsystem re-derives phone or desktop from a raw `window.innerWidth`
   threshold of its own (#58, #194).
2. **One geographic anchor across layers** — a route point, its marker, its place label and its
   route geometry share one geographic anchor at every supported zoom, so no layer may drift by
   choosing a different radius or lift (#193, #196).
3. **One tempo, one consumption rate** — one narrative tempo drives camera flight, arrival dwell,
   media dwell and prefetch distance, so all four describe the same consumption rate (#197,
   #205 through #213).
4. **A meaningful route point survives every projection** — a route point that the domain model
   considers meaningful remains represented in every mode projection unless that mode explicitly
   permits omission, so a broader media model is never silently narrowed by an `isImage`-style
   production filter (#195, #187).
5. **Newer intent wins** — a newer focus, selection or seek intent always wins, and a stale async
   or settle result can never reassert itself after it (#144, #113).
6. **Low chrome removes redundancy, not capability** — a reduced-chrome view mode may remove
   navigation redundancy but must never remove the discoverability of a capability that exists
   nowhere else (#199).
7. **Credentials never travel in a URL path or query string** — a bearer or share credential lives
   only in an `Authorization` header or a URL fragment, never in a path or a query string, and is
   never written to a request log or telemetry (#201).
8. **Share scope closure** — navigation, timeline, globe and playback under a share grant cannot
   leave the granted set of journeys (#200).
9. **Read-only stays read-only** — a read-only capability never acquires mutation authority on any
   downstream surface it can reach (#200).
10. **Expiry propagates** — expiry and revocation propagate to everything downstream, including
    already-open pages and any presigned read whose lifetime is capped by the grant's remaining
    lifetime (#200).
11. **Closer means more confidence** — moving closer yields more geographic confidence, never
    larger decorative error or lower language and data confidence (#16, #79).

### Automated QA coverage

Prefer measurable assertions over screenshots, and encode an invariant into the targeted QA that
already exercises its subsystem rather than building one large end-to-end suite. Current coverage:

| Invariant | Automated QA that encodes it |
| --- | --- |
| 1. One product mode per viewport | **partial** — `scripts/qa-media-controls.mjs` drives a real phone viewport and asserts the shared `data-mobile-mode` contract on `.journey-story` across its viewer, manage, back and fullscreen-exit checks. That is Story layout state only: nothing asserts the repository-wide half of the invariant, that no other subsystem re-derives posture from a raw width threshold. See the gaps below |
| 2. One geographic anchor across layers | **none targeted** — see the gaps below |
| 3. One tempo, one consumption rate | `src/journey/narrativeTiming.test.ts` for the shared resolver, `src/journey/quickRecapPlayback.test.ts` for recap chapter booking, `src/journey/playbackPrefetchPlan.test.ts` for tempo-aware prefetch distance, plus the `story-mobile-viewer-playback-video-completion` and `playback-runtime-errors` checks in `scripts/qa-media-controls.mjs` |
| 4. A meaningful route point survives every projection | `src/journey/autoEditPlan.test.ts` validates the plan grammar without narrowing media type, and `src/journey/quickRecapPlayback.test.ts` covers the recap production handoff |
| 5. Newer intent wins | **none targeted** — see the gaps below |
| 6. Low chrome removes redundancy, not capability | `scripts/qa-media-controls.mjs` asserts the phone Story viewer keeps a discoverable media-playback affordance and that viewer and manage responsibilities stay separated |
| 7. Credentials never travel in a URL path or query string | **partial, redaction only** — `server/request-log.test.ts` asserts the logger writes the matched route pattern instead of the raw path, so a credential that reaches the log layer in a path is not written out, including on the throw and unmatched-path branches. It deliberately sends a token in a path itself, so it cannot fail if application code starts putting credentials in paths or query strings. See the gaps below |
| 8. Share scope closure | **partial, grant primitives only** — `server/authorization/share-access.test.ts` covers token generation, SHA-256 hashing, `Authorization: Bearer` parsing and grant-state evaluation. It never traverses navigation, timeline, globe or playback reach under a grant, so closure over the granted set is unguarded. See the gaps below |
| 9. Read-only stays read-only | **partial, grant primitives only** — the same file establishes that a grant evaluates as read-only, and nothing more. No test walks a downstream mutation surface with a share identity, so mutation-authority denial is unguarded. See the gaps below |
| 10. Expiry propagates | **partial, evaluation only** — the same file evaluates expiry, the expiry instant itself, revocation ahead of a later expiry and an atlas that starts deleting, all as a pure function at one instant. Propagation to an already-open page and the presigned-read lifetime cap are unguarded. See the gaps below |
| 11. Closer means more confidence | `src/scene/semanticZoom.test.ts` for tier monotonicity and `src/scene/cityLabels.test.ts` for label completeness and stability |

Known gaps. Each is worth targeted QA and none of them has it yet. A row above that reads
**partial** is listed here for the part it does not cover, because a coverage claim a reviewer
cannot rely on is worse than an admitted gap.

- **Child viewport classifiers** (invariant 1). Nothing asserts that a subsystem resolves posture
  through the shared `COMPACT_MOBILE_MEDIA_QUERY` contract in `src/journey/mobileLayout.ts` rather
  than its own width test. `src/scene/ParticleEarthScene.tsx` still reads `window.innerWidth <= 760`
  for the route-label safe area, the journey connector and the route-label budget, so a coarse-pointer
  landscape phone at 844x390 resolves compact in Story and desktop in the globe. That divergence is
  tracked in #194; the missing assertion is what let it survive the #58 fix.
- **High-zoom anchor error** (invariant 2). Nothing measures the screen-space distance between a
  route endpoint, its marker and its place label at maximum zoom. #193 and #196 were both found
  by eye.
- **Focus revision ownership** (invariant 5). Nothing asserts that a late async result is rejected
  after a newer focus intent has already won; the ownership rule is currently enforced only by
  reading the code.
- **Credential transport** (invariant 7). Nothing asserts where a credential is allowed to travel.
  The guarded half is the log line; the unguarded half is the rule that a share or bearer token
  appears only in an `Authorization` header or a URL fragment, never in a path or a query string.
- **Downstream share surfaces** (invariants 8, 9 and 10). Nothing exercises journey-scope closure
  across navigation, timeline, globe and playback under a grant; no test reaches a mutation endpoint
  with a share identity to prove it is refused; nothing covers revocation reaching an already-open
  page, and nothing caps a presigned read at the grant's remaining lifetime. The grant primitives
  can stay green while any of these regresses.

## Risk-driven matrix

Do not attempt the Cartesian product of these axes. The matrix exists so a pull request can pick the
few combinations that actually touch the dimension it changed. **A pull request exercises only the
combinations for the dimension it changed; it never exercises the Cartesian product of the axes.**
Testing every combination is indistinguishable from testing nothing, and it is the fastest way to
make the audit too expensive to run.

The axes are deliberately bounded:

| Axis | Values |
| --- | --- |
| Zoom | 1x, ~2x, max |
| Posture | desktop, portrait phone, landscape phone at 844x390 and at 932x430 |
| Product mode | Atlas, Story, Full Playback, Quick Recap |
| Media topology | photo-only, mixed, video-only, media-less route point |
| Interaction state | idle, focus flight, wheel, drag, seek, tempo change |
| Lifecycle | warm cache, cold media, stale async result, hidden to visible |

Worked selections, one per changed dimension:

- **A zoom or projection change** exercises max zoom against a route endpoint, against a place
  label, against the coastline, and against focus composition.
- **A tempo change** exercises fast tempo against cold media, a tempo change during active
  playback, fast tempo inside Quick Recap, and a seek against the prefetch window.
- **A posture or layout change** exercises 844x390 against Playback, 932x430 against globe route
  labels, an orientation change against Story and fullscreen, and phone layout against an
  off-centre focus.
- **A media topology change** exercises a video-only route point and a media-less route point
  against the Quick Recap and Keepsake projections.
- **An authorization change** exercises a guest grant against navigation and timeline reach, an
  expired grant against an already-open page, and a read-only grant against every mutation entry
  point it can see.

## Regression-family search

A confirmed P0 or P1 cross-feature regression **is not closed by fixing the reported component**. It
is closed only after the sibling subsystems that share the failed assumption have been enumerated
and checked. The same applies to a P2 defect that reveals a shared architectural assumption.

Before closing, answer four questions in order:

1. What old assumption failed?
2. Which other components share that same assumption?
3. Which other recently-added features changed the same dimension?
4. Is the correct fix local, or should a shared contract replace the repeated assumption?

Record the enumerated siblings and the result for each in the pull request body under
`Regression-family search:`. A search that found nothing must still name the siblings inspected.

Each **confirmed** sibling defect becomes a normal actionable issue in the same development queue —
a new issue, or a scope update on the existing issue that already covers it — rather than a note in
a report. A finding that lives only in a report or a pull request paragraph does not count as
closed, and a separate backlog that never gets fixed is the failure mode this rule exists to
prevent. A trivially in-scope sibling of the same class may instead be fixed in the same pull
request, which the body then records in place of an issue URL.

The canonical example is #193. The observation was that a route endpoint drifted from its waypoint
at high zoom. The failed assumption was that small world-space radial offsets stay visually
negligible. The family search asked which other layers place a semantic object by its own radius —
route labels, place labels, personal points, coastline annotation, focus target radius — and that
search produced #196 directly.

New issues found this way state their causal structure rather than the symptom: the original
assumption, the new capability that changed the dimension, why two individually-correct systems are
wrong together, the exact source paths, contracts or constants as evidence, the shared invariant
that must hold across both, the sibling subsystems checked, and cross-feature acceptance rather than
only a local unit test.

## Weekly recent-change interaction audit

Run a recurring audit over roughly the previous seven days. Do not re-read every diff; that is
review, not audit. Build a change graph instead:

```text
new capability -> changed dimension -> older dependent subsystem -> invariant at risk
```

Then inspect only the highest-risk intersections.

The inputs are the merged pull requests, the issues opened, closed or reopened, any new product
mode, any changed constant or contract, and the files with dense concurrent edits.

Run an extra audit immediately, without waiting for the weekly cadence, in two cases: when several
pull requests land around one subsystem in a short period — Playback with tempo and Quick Recap,
high zoom with level of detail and route focus, phone layout with Story and account surfaces, or an
AutoEdit schema change with its production handoff — and whenever a user reports a regression, which
triggers the family search above directly.

Each audit produces a short report in four buckets:

- **A. confirmed cross-feature defect** — create or reopen the issue immediately, with the source
  evidence, the interaction pair and the shared invariant.
- **B. high-confidence regression risk needing focused QA** — open an issue only when the source
  evidence is strong; otherwise add a targeted QA task or comment to the owning issue.
- **C. an existing issue whose scope must grow** — update that issue instead of duplicating it.
- **D. reviewed interaction with nothing found** — keep the evidence to a line; do not flood the
  tracker with non-findings.

Ownership is standing rather than personal: the implementer performs the first assumption-impact
pass, the reviewer independently challenges the changed assumptions, the periodic audit looks across
recently merged work, and a user-reported defect triggers a family search. Actionable findings enter
the normal P0/P1/P2 queue.

## Recent cases

These are the incidents the invariant library above was distilled from. They are recorded as cases,
not anecdotes: each one names a dimension that became variable.

| Case | Old assumption | New capability | Composition failure | Invariant |
| --- | --- | --- | --- | --- |
| #193 | Elevated world-space route arcs and slightly different route and waypoint radii read as coherent at global scale | roughly 2 to 3x zoom | World-space lift and radial offsets become large screen-space parallax and the route peels away from its waypoint markers | 2 |
| #196 | The same radial assumption, in the place-label layer | roughly 2 to 3x zoom | Place-label anchors drift from the points they annotate at close zoom; found by the #193 family search, not by a new report | 2 |
| #194 | #58 established one shared phone-landscape contract for the app shell | Playback overlay and globe route-label logic added later | New subsystems independently reintroduced a raw `window.innerWidth <= 760` width test, so one viewport can be phone in the shell and desktop inside a child subsystem | 1 |
| #195 | The AutoEdit model treats both image and video as valid visual media | Quick Recap production handoff | The handoff still filtered candidates with `isImage`, so video-only route points vanished from a recap the model considered valid | 4 |
| #187 | A route point without media contributes nothing to a plan | Full Playback plans | Media-less route points were dropped from the plan, so a meaningful part of the route disappeared from playback | 4 |
| #197 | A fixed current-and-next predecode window was reasonable at one playback speed | fast, standard and immersive tempo | Fast tempo consumes media faster while prefetch distance stayed fixed, so decode holds increased | 3 |
| #205 to #213 | Four subsystems each carried their own timing table | one shared narrative timing resolver | The timing truths were collapsed into `src/journey/narrativeTiming.ts` and the legacy pacing table removed, so camera, arrival, media and prefetch finally share one rate | 3 |
| #16, #79 | A sparse localized-name gap in lower-rank rows was invisible | semantic zoom reveals many more place labels | An old coverage gap became a visible language regression at close zoom | 11 |
| #199 | Reduced chrome in the phone Story view mode removes only redundancy | low-chrome viewer mode | The media-playback affordance existed nowhere else, so removing it removed the capability rather than a duplicate of it | 6 |
| #201 | A bearer credential in a request URL is an implementation detail | edge and API request logging | The credential was written into request logs, turning a transport choice into a durable credential leak | 7 |
| #200 | One member session is the only identity that reaches a journey surface | expiring read-only share grants | Every read path, navigation surface and presigned read now serves a narrower identity with its own lifetime | 8, 9, 10 |

## Standing north-star

> Every new capability changes the environment that old code lives in. Review the changed
> environment, not only the new feature.
