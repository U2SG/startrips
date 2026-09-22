# Hotspot authority map

This map records the authority boundaries established in issue #269 and the subsequent core refactor. Pure decisions may move into reusable modules while every current intent retains one writer.

The rule used below is: **state may move only when its writer moves with it.** Read-only helpers may move freely. A -> B -> C remains owned by the composition root that can prove C is current.

## `src/scene/ParticleEarthScene.tsx`

`ParticleEarthScene` remains the renderer, camera/focus and gesture composition root. The new `src/scene/globePointerIntent.ts` is deliberately not an authority: it owns no current state, imports neither React nor Three, and returns decisions from values supplied by this root.

| Authoritative state / ref | Single writer | Read-only consumers | Cancellation / revision token | Async completion may write back only when |
| --- | --- | --- | --- | --- |
| `latestMode`, `latestQuality`, `latestFocusPoint`, `latestFocusRoute`, `latestFocusRevision`, `latestFocusFlightProfile`, `latestFocusColor`, `latestCenterFocusPoint`, `latestJourneyRoutes`, `latestActiveJourneyRouteId`, `latestTemporalReveal`, `latestZoomIntent`, `latestDragToRotate`, `latestWheelToZoom`, `latestRotationYOverride`, `latestCompactMobileLayout` | the React render of `ParticleEarthScene`, which copies the latest props into the refs | the persistent Three scene controller and render loop | React render order; focus-specific consumers additionally use `latestFocusRevision` | not applicable; these refs are snapshots, not async destinations |
| `latestOnFocusPointActivate`, `latestOnJourneyRouteActivate`, `latestOnJourneyRoutePointActivate`, `latestOnReady`, `latestOnSemanticZoomSnapshot`, `latestOnParticleAnchorFrame`, `latestOnGlobePointPick` | the React render of `ParticleEarthScene` | renderer/event handlers call the latest callback without rebuilding the scene | latest-render snapshot | callback invocation is allowed only through the current ref, never a callback captured by an older async task |
| `activeFocusRevision` | `setFocusIntent()` in the scene controller | focus solver, focus-flight QA and handoff logic | `shouldApplyFocusIntentRevision(activeFocusRevision, incomingRevision)` | an incoming focus intent is newer than the active revision |
| `manualFocusRevision` | `claimManualInteraction()` claims it; `setFocusIntent()` releases it when a newer accepted focus intent takes ownership | focus solver, wheel anchoring, route-focus settling | `shouldFocusRevisionOwnState(manualFocusRevision, incomingRevision)` | a programmatic focus revision is newer than the manual interaction revision |
| `routeFocusFrame` and `focusTarget` | `setFocusIntent()`; manual interaction clears `focusTarget` | camera solver, semantic Earth Dive anchor publication, wheel anchor selection | same focus revision ownership above | the accepted focus intent is current; stale focus cannot recreate the frame |
| `interactiveRotationX`, `interactiveRotationY`, `interactiveZoom`, `rotationVelocityX`, `rotationVelocityY` | the scene interaction/camera owner: pointer/wheel handlers, accepted focus settling, then idle/inertia in the render loop | model matrix, shared geographic projection, semantic zoom, route/label/coastline rendering | manual interaction claims focus ownership and zeroes velocities; pointer lifecycle / accepted focus revision selects the active writer | not applicable; these values are updated synchronously by the current interaction/camera owner |
| `activePointers`, `rejectedPointerIds`, `dragPointerId`, `dragLastX`, `dragLastY`, `dragLastTime`, `dragTravel`, `dragStarted`, `gestureConsumed`, `pinchDistance`, `pinchAnchor`, `pinchAnchorErrorPx` | DOM pointer/wheel handlers inside the one scene instance | gesture handlers plus the render loop's “manual interaction active” checks | pointer id + pointer capture lifecycle; rejected ids live until matching up/cancel/lost-capture | not applicable; `globePointerIntent.ts` only receives snapshots and cannot mutate these values |
| `semanticZoomState` / the per-frame `SemanticZoomSnapshot` | the render loop derives it from `interactiveZoom`, quality and the shared semantic-zoom resolver | coastline tiers, city labels, terrain/particle effects, `onSemanticZoomSnapshot` | current render frame; no second zoom thresholds in the extracted module | not applicable; semantic zoom remains synchronous derived state |
| `geoFrame` (`GeoProjectionFrame`) | only `updateGeoProjectionFrame()` calls in this scene root mutate the frame | route, label, coastline, focus and Earth Dive projection readers | current camera + globe matrix + viewport dimensions | not applicable; consumers never write a competing projection |
| `qualityBuildRevision` | quality rebuild scheduling in the scene root increments the revision | async low/high land-data builders | numeric `qualityBuildRevision` plus `currentQuality` and `disposed` | `revision === qualityBuildRevision`, `currentQuality === requestedQuality`, and the scene is not disposed |
| `refinementBuildGuard`, `requestedRefinementCacheKey`, refinement build state | particle refinement scheduler in this scene root | regional land refinement builder and render loop | `ParticleRefinementBuildGuard` ticket/generation, visibility, requested cache key | `refinementBuildGuard.isCurrent(ticket)` and the scene remains visible/current; hide/mode/quality changes invalidate the ticket |
| `publishedAnchorFrame` | render-loop Earth Dive publisher | `onParticleAnchorFrame` / `LivingAtlasGlobe` handoff | current focus/route anchor plus current projection; disappearance invalidates by publishing `null` | a current centered focus has a current `diveAnchor`, finite scale and a materially changed frame; otherwise the prior frame is cleared |
| `disposed`, `animationFrame`, renderer/scene resources | `useThreeScene` setup/cleanup | all renderer effects and async builders | `disposed` and animation-frame lifecycle | every async renderer completion checks its local revision/guard and `disposed` before touching resources |

### Extracted renderer boundaries

Before this change, pointer capacity, activation eligibility, drag threshold, zoom clamp, projected-radius rotation, pinch-anchor reliability, inertia limits/retention and drag-sample rebasing were **pure functions declared inside `ParticleEarthScene.tsx`** next to the current gesture state. After this change those rules live in `globePointerIntent.ts`.

The authority did **not** move: `activePointers`, drag/pinch samples, `interactiveZoom`, camera rotations, velocities, focus revisions and the canonical `GeoProjectionFrame` all remain in `ParticleEarthScene.tsx`. The extracted module receives numbers / points and returns values; it has no setter, ref, event listener, effect, clock, renderer or viewport read.

`globeMode.ts` owns the four mode names and their presentation constants; `renderBudget.ts` owns the quality profiles and drawing-buffer calculation. Both production and legacy consumers import these contracts directly. Projection helpers remain in `projection.ts`; the renderer does not re-export them. None of these modules owns a live scene, camera, viewport or quality revision.

## `src/journey/JourneyStory.tsx`

`JourneyStory` remains the Story composition root. `storyMediaPolicy.ts` owns media identity, scope, navigation and autoplay decisions; `storySurfacePolicy.ts` owns surface, history-layer and control descriptions. They receive snapshots and do not own the state described below. Signed-read decisions live in `mediaReadRefresh.ts`, while the cache and request lifecycle remain in the consuming root.

| Authoritative state / ref | Single writer | Read-only consumers | Cancellation / revision token | Async completion may write back only when |
| --- | --- | --- | --- | --- |
| `selectedRoutePointId` | Story chapter/scope navigation in `JourneyStory` | `storyMediaForScope`, chapter UI, wrap rules and media controls | current Journey + requested Route Point scope | no async writer; a Journey/scope reset reselects from the current props |
| `assetIndex` | Story media navigation (`navigateToMedia`, overview selection, scope reset) | active asset, controls, grids and fullscreen counter | current scoped-media list and latest requested target | async readiness may advance it only for the still-current pending target |
| `shownAssetId` | presentation settlement (`settleIncoming`, failed-target settlement, direct ready overview selection) | the persistent visible media layer and navigation anchor | `incomingMediaRef` / latest requested target | `settleIncoming(assetId)` requires `incomingMediaRef.current === assetId`; an abandoned handoff cannot replace the visible frame |
| `incomingAssetId` + `incomingMediaRef` | `navigateToMedia` / readiness effect starts a handoff; `settleIncoming` or failure clears it | persistent page compositor, autoplay readiness and transition UI | current requested asset id | only the currently incoming asset may settle; reverse/new navigation clears or replaces the id first |
| `pendingTargetRef` + `pendingMediaId` | `setPendingMediaTarget` / `navigateToMedia` | readiness effect and UI pending state | exact pending asset id | read/decode readiness is applied only after re-reading `pendingTargetRef.current`; missing/replaced targets are discarded |
| `requestedMediaRef` + `mediaNavigationDirection` | latest navigation command | next/back/autoplay navigation and transition direction | latest requested asset id | not an async destination; later navigation overwrites the ref before earlier readiness can promote a target |
| `mediaReads` + `mediaReadsRef` | `loadMediaRead` completion is the only signed-read cache writer | stage, prefetch window, organizer/grid and decode scheduler | `mediaReadScope` object identity + `protectedPlaybackRead` | the Journey/Route Point scope object is still identical **and** a late refresh is not replacing a ready asset currently protected by video playback ownership |
| `pendingReads` | `loadMediaRead` request lifecycle | duplicate-request suppression | asset id inside the current `mediaReadScope` | completion removes the id only if the original scope object is still current |
| `mediaReadScope` | Journey/Route Point scope-change effect | every signed-read completion | object identity `{ journeyId, routePointId }` | a completion captured under an older object identity cannot update `mediaReads` |
| `protectedPlaybackRead` | current `playing` + current video asset calculation in `JourneyStory` | signed-read refresh decision and refresh completion | current visible video playback owner | a late success/error may replace cache state only when that asset is not the protected ready video owner |
| `decodeRegistryRef` + `decodeSettleRevision` | decode registry; its settle callback increments the revision | pending-target readiness effect and prefetch memory window | registry entry keyed by asset id/url; scope reset calls `reset()` | a decode result can influence navigation only if the same pending target is still current when the readiness effect re-runs |
| `playing` + `playingRef`, `stagePlaybackReady`, `storyVideoRef`, `fullscreenVideoRef` | Story playback gesture/autoplay owner | inline/fullscreen persistent video stages, soundtrack sampler, controls | current visible asset + inline/fullscreen stage readiness | video play/ready work is accepted only for the current stage/current asset; navigation or pause releases protection before refresh can replace it |
| `fullscreen` | `enterFullscreen` / `exitFullscreen` and the mobile-history owner | fullscreen stage, keyboard, focus trap, controls | `story-media-surface` history layer; newer history intent replaces menu/delete/fullscreen on the same layer | no async state write; handoff animation may finish only while its target surface/media remains current |
| `mobileStoryExpanded`, `mobileManageMode`, `mobileMediaMenuOpen`, `mediaDeleteState`, `deleteState` | Story's mobile surface/history command handlers | Viewer/Manage rendering, Escape, focus traps and Browser Back | ordered `useMobileSurfaceHistory` layers (`story-expanded`, `story-manage`, `story-media-surface`, `story-journey-delete`) | no async completion may reopen an older layer; Browser Back closes the currently registered top owner |
| `mediaDragRef`, `mediaDragSettlingRef`, `mediaDragSettleCancelRef`, `mediaDragSettleFinishRef`, `mediaDragSprings`, `mediaTapTimerRef`, gesture-consumed refs | Story media pointer handlers | persistent media compositor and navigation commands | pointer id + explicit settle cancel handle; newer navigation calls `cancelPendingMediaDragSettle()` | a settling animation may commit navigation only if it was not cancelled/reclaimed by a newer gesture/navigation intent |
| notes authority: `journeyNoteDraft`, `routePointNoteDrafts`, `notesDirty`, `notesDirtyRef`, `notesDraftJourneyRef`, `notesSaveState` | Story note editor/save command | close guard and note UI | current Journey id + dirty ref + save state | a draft reset/save completion applies only to the current Journey/draft; dirty current edits are not overwritten by prop refresh |
| media mutation authority: upload/retry/placement state, delete state, order/cover pending, move selection/pending/message/`moveUndo` | Story mutation command handlers | Manage UI and close guard | current Journey/media ids plus each pending command state | mutation completion updates UI only for the command still represented by the current pending state; undo records the completed move rather than a second media owner |

## Composer and Playback contracts

| Read-only owner | Contract | Writer that remains in the composition root |
| --- | --- | --- |
| `routeDraft.ts` | Route Point draft conversion, coordinate input, removal focus and globe-pick shape | `JourneyComposer` owns the current draft, focus and editing intent |
| `journeyDraftMedia.ts` | Pending-media shape, summary and draft-to-persisted Route Point mapping | `JourneyComposer` owns files, upload attempts and pending media changes |
| `journeySaveRecovery.ts` | Save-result and uncertain-create shapes plus recovery copy | Composer's async save/reconcile command owns continuation and reconciliation |
| `journeyPlayback.ts` | Playback sequence and step/hold-target media selection | The playback director owns the current run, step and clock |
| `playbackMediaPresentation.ts` | Media readiness, hold reason and chapter-opening decisions | `JourneyPlaybackOverlay` owns presentation, decode, video and trim settlement |
| `mediaReadRefresh.ts` | Shared read-state shape and caller-specific freshness decisions | Story and Playback each retain their own signed-read cache and scope guards |

Story's 60-second refresh margin and protected-video rule remain distinct from Playback's read-reuse policy. Sharing a contract does not merge their request lifecycles. Shell consumers import public types from their model owners instead of importing a UI root to obtain them.

## Server background services and HTTP adapters

| Owner | Responsibility and preserved ordering |
| --- | --- |
| `server/media/upload-protocol.ts` | Pure request validation, limits and protocol types; no database, storage or HTTP framework ownership |
| `server/services/multipart-uploads.ts` | The complete upload lifecycle: creation, parts, completion, abort, finalize claims/heartbeats, reconciliation and cleanup. Existing-upload/replay checks precede completion body parsing. |
| `server/services/journey-media.ts` | Media lookup, signing, reorder and cross-Journey move/undo transactions |
| `server/repositories/journey-repository.ts` | Shared active-Journey locking. Atlas/lease/ Journey lock order and sorted cross-Journey locks remain unchanged. |
| `server/services/map-style-cache.ts` | Upstream map fetches, URL rewriting, disk cache and cache sweeper; provider requests retain an independent timeout signal |
| `server/routes/uploads.ts`, `server/routes/mapstyle.ts` | HTTP permission and request/response adaptation; background startup imports services directly |

`server/app.ts` composes routers. Bootstrap, services and repositories must not import router implementations. Upload and media services use the existing preview/delete services directly; HTTP extraction does not introduce a second status writer or change transaction scope.

## Production and development entry boundaries

`app.css` contains shared reset, scene and accessibility styles. Legacy shell rules live in `styles/legacy-shell.css` and load only with the explicit legacy preview family. Product fixtures must not load `App.tsx` or the legacy styles. Development fixture selection finishes before the single React root mounts; the existing Earth Experience provider remains the provider owner.

The production Vite boundary check rejects legacy modules/styles in emitted chunks. The entry-boundary browser suite checks both product isolation and a functioning explicit legacy entry. `src/architecture/moduleBoundaries.test.ts` checks literal runtime import cycles, HTTP dependency direction and pure-owner imports in CI. These checks complement the existing behavior tests; they do not prove asynchronous authority by themselves.

## Guardrails for later phases

- Do not move a `latest*` ref, revision, current media id, playback owner, history owner or projection frame merely to make a child module autonomous.
- Do not mirror one of the rows above with a second `useState`, reducer, timer or viewport read.
- A future extracted adapter may receive a readonly snapshot plus explicit commands; the composition root remains the sole writer until a separate issue deliberately moves the complete authority contract.
- `globePointerIntent.ts` is the model for Phase B: pure inputs, pure outputs, no authority to reclaim current state.
