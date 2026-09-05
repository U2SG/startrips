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
11. **A public capability carries its own budget** — abuse protection belongs to the
    specific public or costly endpoint that needs it, sized from that endpoint's own
    traffic shape, and is charged to the subject that actually holds the capability
    rather than to whichever address happens to present it (#200, #217).
12. **Closer means more confidence** — moving closer yields more geographic confidence, never
    larger decorative error or lower language and data confidence (#16, #79).
13. **Single Projection Space** — one geographic point has exactly one world position, every layer
    that represents that point derives its screen anchor from the same projection frame, and visual
    priority is expressed as depth, render order or a screen-space pixel offset, never as another
    geographic radius (#237, extending #193/#196). A layer may appear above another; it may not live
    on a different Earth to achieve that.
14. **Faithful Path** — exact endpoints do not prove a faithful path. The whole visible curve must
    satisfy a bounded screen-space approximation error, and decorative lift must be restrained
    relative to the leg it decorates, so a sample budget is solved from the curve that is actually
    displayed rather than from angular distance on the underlying sphere (#242, extending
    #193/#196). Every consumer of a path — stroke, glow, rewind, playback — reads the same
    evaluator, and when a budget cannot carry the decoration the decoration is reduced rather than
    the path being truncated.

### Automated QA coverage

Prefer measurable assertions over screenshots, and encode an invariant into the targeted QA that
already exercises its subsystem rather than building one large end-to-end suite. Current coverage:

| Invariant | Automated QA that encodes it |
| --- | --- |
| 1. One product mode per viewport | **partial** — `scripts/qa-media-controls.mjs` drives a real phone viewport and asserts the shared `data-mobile-mode` contract on `.journey-story` across its viewer, manage, back and fullscreen-exit checks. That is Story layout state only: nothing asserts the repository-wide half of the invariant, that no other subsystem re-derives posture from a raw width threshold. See the gaps below |
| 2. One geographic anchor across layers | **partial, route layer only** — `scripts/qa-route-anchoring.mjs` runs as its own `browser-qa` lane and measures, on the reported US Southwest fixture at 1x, 2x and 3x zoom, the screen distance between every rendered route-line end and the rendered Route Point marker it should meet, failing above 1.5 CSS px; it also asserts that the decorative arc attenuates with zoom and stays inside its screen ceiling. `src/scene/geo.test.ts` proves a leg endpoint resolves to the canonical anchor at every lift strength and `src/scene/routeArcLift.test.ts` covers the attenuation, the screen cap and the near-plane budget. The place-label layer (#196) is still unmeasured. See the gaps below |
| 3. One tempo, one consumption rate | `src/journey/narrativeTiming.test.ts` for the shared resolver, `src/journey/quickRecapPlayback.test.ts` for recap chapter booking, `src/journey/playbackPrefetchPlan.test.ts` for tempo-aware prefetch distance, plus the `story-mobile-viewer-playback-video-completion` and `playback-runtime-errors` checks in `scripts/qa-media-controls.mjs` |
| 4. A meaningful route point survives every projection | `src/journey/autoEditPlan.test.ts` validates the plan grammar without narrowing media type, and `src/journey/quickRecapPlayback.test.ts` covers the recap production handoff |
| 5. Newer intent wins | **none targeted** — see the gaps below |
| 6. Low chrome removes redundancy, not capability | `scripts/qa-media-controls.mjs` asserts the phone Story viewer keeps a discoverable media-playback affordance and that viewer and manage responsibilities stay separated |
| 7. Credentials never travel in a URL path or query string | **partial, redaction only** — `server/request-log.test.ts` asserts the logger writes the matched route pattern instead of the raw path, so a credential that reaches the log layer in a path is not written out, including on the throw and unmatched-path branches. It deliberately sends a token in a path itself, so it cannot fail if application code starts putting credentials in paths or query strings. See the gaps below |
| 8. Share scope closure | **covered** — the server half below, plus the `browser-qa / guest-share` lane, which drives the real guest document at three viewport postures and asserts the globe renders no route outside the granted set, that Story previous/next is shut at both ends, and that Playback cannot follow outside it. Server half: `server/authorization/share-access.test.ts` covers token generation, SHA-256 hashing, `Authorization: Bearer` parsing and grant-state evaluation; `server/repositories/shared-journey-repository.test.ts` asserts that the guest payload's previous/next references stay inside the granted set and that rows belonging to an unshared journey are dropped; the `guest journey read` block in `server/tests/share-grants.integration.test.ts` reads `GET /api/shared/journeys` for a single-journey and a multi-journey grant and asserts that no unshared journey id, title, storage key or owner field appears anywhere in the response text. The `share hardening` block adds the stale-payload case: an asset id a guest legitimately learned from an earlier payload stops authorizing the moment the owner moves it, because membership is re-derived rather than cached |
| 9. Read-only stays read-only | **covered** — the grant primitives establish that a grant evaluates as read-only; the `guest journey read` block additionally sends POST, PATCH, PUT and DELETE at the guest read route and replays the bearer token against the owner journey routes, which answer 401. The `guest media read` block replays the bearer at the owner read-url and delete routes, and the `share hardening` block replays it at `/api/atlases/bootstrap` and at every share-management route; all answer 401. The `guest-share` lane additionally asserts that no owner affordance is rendered anywhere in the guest document at three viewport postures |
| 10. Expiry propagates | **covered** — the grant primitives evaluate expiry, the expiry instant itself, revocation ahead of a later expiry and an atlas that starts deleting as a pure function; the `guest journey read` block drives all four causes plus an unknown and a malformed token at `GET /api/shared/journeys` and asserts one byte-identical unavailable body for every cause, and asserts that a grant withdrawn after it was authorized but before the payload was assembled is refused by the read's own snapshot. `server/repositories/shared-media-repository.test.ts` sweeps every remaining lifetime from 1 to 600 seconds and asserts the issued presign TTL never reaches past `expiresAt`, and the `guest media read` block asserts the cap, the owner ceiling, the sub-second refusal, and that a moved, deleting or revoked asset stops being signed. Propagation to an already-open page is covered on both sides: the `guest-share` lane revokes a grant under a live session and asserts the viewer reaches the polished unavailable state without a reload, and the `share hardening` block asserts the server half for concurrent revoke-and-read, expire-and-presign and delete-and-read, in each case as an invariant that holds for every interleaving rather than as a schedule. `src/journey/mediaReadRefresh.test.ts` covers the client consumer: every refresh margin is derived from the `expiresAt` the server returned |
| 11. A public capability carries its own budget | `server/share-rate-limit.test.ts` for the budget arithmetic and the subject each class is charged to, and the `share hardening` block for the same three budgets through the mounted app, including the assertion that the owner and product API stay unthrottled |
| 12. Closer means more confidence | `src/scene/semanticZoom.test.ts` for tier monotonicity and `src/scene/cityLabels.test.ts` for label completeness and stability |
| 13. Single Projection Space | **covered for the layers that exist today** — `src/scene/projection.test.ts` asserts that one latitude/longitude yields byte-identical screen coordinates through the Place Label / Route Point path, the Journey connector path and the focus solver's candidate-placement path, and that the candidate model matrix is the matrix `Object3D` composes. `src/scene/geo.test.ts` and `src/scene/coastlineSpatialLod.test.ts` assert every coastline vertex, global and regional, lands on `GEOGRAPHIC_SURFACE_RADIUS`; `src/scene/ParticleEarthScene.test.tsx` asserts the coastline's depth policy, that its clip-space bias moves z and nothing else, that the module retains exactly one direct `.project(camera)` (the drag interaction centre, which is not a geographic anchor), and that the decorative shells named out of scope keep their radii. The `browser-qa / city-label-anchoring` lane measures a drawn coastline vertex against the projected geographic silhouette at 1x, 2x and max zoom and compares its per-step screen motion during a continuous Pearl River Delta drag against a place label in the same vicinity. The GPU SDF/billboard symbol layer (#237 Phase D) is deferred by the issue and unmeasured |
| 14. Faithful Path | **covered for route geometry** — `src/scene/geo.test.ts` asserts that a lifted leg is never drawn as fewer than four straight segments across 1.86, 1.90, 2, 3 and 5 degrees, that the count only grows with the leg and that crossing the old one-segment threshold changes it by at most one segment; that peak lift over endpoint chord length is non-increasing as a leg shortens and at most 0.25 at 1.90 degrees, against the retired sqrt policy's 1.181; and that every stored Route Point survives sampling, including under a budget too small for the curve every leg asked for. `src/scene/ParticleEarthScene.test.tsx` asserts that the whole-route samples and the per-leg rewind samples are vertex-for-vertex identical, that a projected path stays within 1 CSS pixel of a high-resolution reference sampling of the same lifted curve at two lift strengths and for a dense route inside the vertex budget, and that no visible fragment is joined across an occluded span. The `browser-qa / route-anchoring` lane rotates a synthetic short-leg chain from globe centre out to the limb at 1x, 2x and 3x and grades every intermediate frame for per-leg bulge relative to that leg's own projected length and for bridged fragments. Journey Playback reveal reads the same per-leg samples, so it inherits the geometry rather than asserting it separately |

Known gaps, and the ones that have since been closed. A row above that reads **partial** is
listed here for the part it does not cover, because a coverage claim a reviewer cannot rely on
is worse than an admitted gap. A gap is marked **closed** rather than deleted, with the work
that closed it named, so a later reader can tell an assertion that exists from one that was
only ever promised.

- **Child viewport classifiers** (invariant 1). Nothing asserts that a subsystem resolves posture
  through the shared `COMPACT_MOBILE_MEDIA_QUERY` contract in `src/journey/mobileLayout.ts` rather
  than its own width test. `src/scene/ParticleEarthScene.tsx` still reads `window.innerWidth <= 760`
  for the route-label safe area, the journey connector and the route-label budget, so a coarse-pointer
  landscape phone at 844x390 resolves compact in Story and desktop in the globe. That divergence is
  tracked in #194; the missing assertion is what let it survive the #58 fix.
- **High-zoom anchor error, place-label half** (invariant 2). The route-endpoint-to-marker distance
  is measured now (`scripts/qa-route-anchoring.mjs`), but nothing measures a place label or its
  leader against the point it annotates at maximum zoom, which is the #196 half of the family. #193
  and #196 were both found by eye.
- **Focus revision ownership** (invariant 5). Nothing asserts that a late async result is rejected
  after a newer focus intent has already won; the ownership rule is currently enforced only by
  reading the code.
- **Credential transport** (invariant 7). Nothing asserts where a credential is allowed to travel.
  The guarded half is the log line; the unguarded half is the rule that a share or bearer token
  appears only in an `Authorization` header or a URL fragment, never in a path or a query string.
- **Downstream share surfaces** (invariants 8, 9 and 10). **Closed by #200 phases D
  and F.** Scope closure through the timeline, the globe and playback under a grant is
  measured by the `browser-qa / guest-share` lane, which drives the real `/share#<token>`
  document at desktop, portrait-phone and phone-landscape sizes and asserts that the
  globe renders no route outside the granted set, that Story previous/next is shut at
  both ends of it, and that Playback mounts with no edit affordance. A share identity is
  now replayed at every owner surface it could try — the journey routes, the upload
  read-url and delete routes, `/api/atlases/bootstrap` and the share-management routes —
  and each answers 401. Revocation and expiry reaching an already-open page are covered
  on both sides: the lane revokes a grant under a live session and asserts the polished
  unavailable state, and the `share hardening` block asserts the server half, including
  the concurrent cases.
- **Signed-read lifetime consumers** (invariants 3 and 10). **Closed by #200 phase D.**
  All three refresh strategies now derive the margin from the read's own `expiresAt`
  through `src/journey/mediaReadRefresh.ts`: `mediaReadRefreshAt` never refreshes before
  the read is half spent and never later than its margin before expiry, so an owner read
  keeps its previous numbers and a short guest read falls to the half-life rule.
  `LivingAtlasApp` schedules through `mediaReadRefreshDelayMs`, `JourneyStory`'s
  `shouldRefreshStoryMediaRead` and `soundtrackReadCache`'s `isFreshSignedRead` both go
  through `mediaReadIsFresh`, and `src/journey/mediaReadRefresh.test.ts` pins the rule.
  The literal margins that remain (60 s in the story dialog, 30 s elsewhere) are now
  ceilings handed to that function rather than the decision itself.

## Worked audit: expiring read-only sharing (#200)

This is the CFAA the sharing capability carries, recorded here rather than in one pull
request body because #200 shipped across six of them and the composition risk is the
whole feature rather than any one phase. The changed dimension is **9, authorization
identity and lifetime**: before #200 exactly one identity — a member session resolving
an Atlas through `session.session.activeOrganizationId` — reached any Journey surface,
and every subsystem downstream of that was written under it. A share grant is a second,
narrower identity with its own lifetime, its own scope, and no mutation authority.

The matrix is the risk-driven selection for that dimension, not a Cartesian product:
each row is a subsystem that was previously correct under the single-identity
assumption, the assumption sharing invalidated for it, and what was actually checked.

| Sibling | Assumption it held | What sharing made variable | Outcome |
| --- | --- | --- | --- |
| **#194 mobile mode** — one shared phone/landscape contract for the app shell | The shell resolving posture is the owner shell, mounted by `AuthGateway` | The guest shell mounts `LivingAtlasApp` with no auth gateway under it, so the posture contract has a second entry point | **Checked, holds.** `SharedAtlasView` provides the capability set and mounts the same shell, so posture is resolved by the same `COMPACT_MOBILE_MEDIA_QUERY`. The `guest-share` lane copies that query literally and asserts the guest document resolves `compact` at 390x844 and 932x430 and not at 1280x800, so a drift between the app's query and the guest's would fail the lane |
| **#126 Playback** | A playback run happens inside an owner session that may write | Playback now runs under a capability with `mutations: null`, so anything it wrote would have no client to write through | **Checked, holds.** The lane starts a full Playback run in the shared viewer and asserts the overlay mounts with no forbidden owner copy and no file input. Guest playback state is ephemeral and local by construction: with `mutations: null` the writing surfaces are never constructed rather than hidden |
| **#197 tempo-aware prefetch** | Prefetch distance and a media read's lifetime are independent, because a read lived an effectively fixed ~15 minutes | A guest presign is capped at 90 s and shrinks toward zero as the grant nears expiry, and a fast tempo consumes media faster than the window it prefetches | **Checked, one fix landed earlier.** `mediaReadRefresh.ts` (phase D) derives every refresh margin from the read's own lifetime, which is what stopped a 30-60 s constant from declaring a short guest read stale on arrival. Phase F adds the second half: the guest media budget is sized against `MAX_PREFETCH_ASSETS` and the 90 s half-life rather than against a request count, and is charged per grant so a prefetch burst is never measured against whichever address a recipient shares |
| **#195 chapter topology / mixed and video-only recap** | A production projection may narrow the media model it is given | The guest payload is a narrower projection again: only granted journeys, and only their current media | **Checked, holds, and it is the safe direction.** The guest DTO omits fields rather than filtering by media type: `shared-journey-repository.ts` returns every asset of a granted journey with its `mimeType` intact, so an image-only narrowing cannot be reintroduced by the share path. The AutoEdit and Quick Recap grammar is unchanged and untouched by the capability set |
| **#137 signed media reads** | A signed read is issued to a member of the Atlas and lives a fixed lifetime | The same storage objects are now signed for a bearer capability, for a lifetime bounded by a grant that can be revoked | **Checked, holds.** `resolveSharedMediaRead` re-derives membership from the asset's current `journey_id` on every call, so no cached authorization exists to go stale; `signSharedMediaRead` takes `min(share ceiling, owner ceiling, remaining grant lifetime)` from the clock immediately before the presign and refuses a signature that came back reaching past the deadline. The owner route is untouched and refuses the bearer with 401 |
| **#199 media playback discoverability** | The phone Story viewer's media-playback affordance exists nowhere else, so a reduced view must keep it | The guest Story is a further reduced view, and the Manage entry sharing its action cluster IS removed for a guest | **Checked, holds, and it is now asserted.** `showMobileStoryPlayControl` reads only layout and media count, never a capability. The `guest-share` lane opens a shared Story on a portrait phone with two assets and asserts the control renders in the viewer cluster, is enabled, keeps its 44 px target, toggles `aria-pressed` both ways, and that no management sheet or Manage trigger exists beside it |
| **Journey deletion and media move lifecycle** | A journey inside its 7-day deletion grace window is invisible to the only identity that could ask for it | A second identity asks for it, and asks on a schedule the owner does not control | **Checked, holds.** Deletion is a filter in the guest read and in the media resolver rather than a cascade, so a soft-deleted journey leaves the guest payload immediately while the restore path is unaffected. An emptied grant answers 200 with an empty set, which is a different product state from the unavailable 404 |
| **Request logging and telemetry (#201)** | A credential in a URL is an implementation detail | The share token is a bearer credential a recipient's browser holds for the life of the link | **Checked, holds by construction.** The token lives in the URL fragment, which is never transmitted, and is replayed only as `Authorization: Bearer`, which Caddy redacts by default. No guest route takes a token in a path or query string, and the lane asserts the token appears in `location.hash` and in neither the path, the query, `localStorage`, `sessionStorage` nor `history.state` |

Two dimensions sharing did **not** move, recorded so a later reader does not re-audit
them: scale/zoom/projection (dimension 1) and rendering layers (dimension 7). The guest
viewer renders the same globe with the same anchors from the same components; it changes
which journeys are in the scene, not where anything is drawn.

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
| #16, #79 | A sparse localized-name gap in lower-rank rows was invisible | semantic zoom reveals many more place labels | An old coverage gap became a visible language regression at close zoom | 12 |
| #237 | #196 moved place labels onto the geographic surface, and the coastline they are read against stayed on its own 1.405 shell | maximum zoom, where a 0.015 radial delta becomes tens of screen pixels | The annotation became correct relative to a sphere the viewer never sees while still drifting against the map they do see, so the fix read as only partly effective | 13 |
| #199 | Reduced chrome in the phone Story view mode removes only redundancy | low-chrome viewer mode | The media-playback affordance existed nowhere else, so removing it removed the capability rather than a duplicate of it | 6 |
| #201 | A bearer credential in a request URL is an implementation detail | edge and API request logging | The credential was written into request logs, turning a transport choice into a durable credential leak | 7 |
| #200 | One member session is the only identity that reaches a journey surface | expiring read-only share grants | Every read path, navigation surface and presigned read now serves a narrower identity with its own lifetime | 8, 9, 10 |
| #200 phase C | A signed media read lives an effectively fixed ~15 minutes, long enough that any refresh margin measured in tens of seconds is safe | a guest presign capped by the grant's remaining lifetime | A media URL's lifetime became a variable that shrinks toward zero, so a constant refresh margin can exceed the whole lifetime it is meant to pre-empt | 3, 10 |
| #200 phase F | Every `/api/*` route sat behind one blanket per-IP budget, so no endpoint needed its own | #217 removed that budget, and #200 added the product's only public unauthenticated prefix | The one surface that most needed abuse control was left with none, and the acceptance that described it as "silently consuming the anonymous budget" was describing a budget that no longer existed | 11 |
| #200 phase F, second | An address identifies a caller closely enough to be the subject of a rate limit | a link designed to be forwarded to many people | Charging a forwarded link's recipients by address throttles exactly the sharing the feature exists for, while an attacker rotating tokens is charged nothing at all — so the subject has to differ per request class | 11 |
| #242 | #193 gave a route exact endpoints and zoom-attenuated lift, and an angular segment budget was assumed to describe the curve between them | decorative radial lift, and rotation toward the limb at overview scale | Lift added curvature the sample budget could not see, so a short leg was drawn as two straight segments through one elevated midpoint — a literal triangular peak whose height grew without bound relative to the leg it decorated as legs shortened | 14 |

## Standing north-star

> Every new capability changes the environment that old code lives in. Review the changed
> environment, not only the new feature.
