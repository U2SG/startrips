# Native media integration for #767 / #768

`StartripsMedia` is an internal iOS 16+ Swift package. There is no app target,
router, web runtime, backend change or workflow in this directory. All four media
features are composed by `NativeMediaFeatureModel` / `NativeMediaFeature`.

## Normal product entry

The exact base is `806ef1399c38f6aefaf4325c2a52551b820091f9`. The locally readable
`feat/issue767-st169-20261031` ref still pointed to that base during implementation;
its uncommitted worktree was not read or changed. The following is the small
composition change for that owner, not a claim that the app target is wired yet:

1. Add the local package `mobile/ios/NativeMedia` and link its `StartripsMedia`
   product to the existing application and native test composition.
2. Replace the body of `FeatureDestinations.story` with a retained
   `NativeMediaFeatureModel`, presented through `NativeMediaFeature(model:)`.
   Key the presentation by `StoryHandoff.requestId`. Map the existing
   `journeyId`, `routePointId`, `assetId`, `revision`, `requestId` to `StoryIntent`.
   Decode the existing projected Journey into `MediaJourney`; its narrower
   decoder tolerates extra backend fields. No additional frontend request or
   alternate navigation route is needed.
3. Adapt the captured **AtlasSession** to `ScopedMediaSession`. `read(assetId)`
   must use that session's existing owner OR guest signer. `request(path, method,
   body)` must use its authenticated same-origin API transport, including Origin
   and CSRF behavior. Never install `URLSession.shared` as that API transport.
   `revalidate()` must reject an invalidated account/Atlas/share generation and
   revoked/expired guest access; there is no owner fallback. `scopeID` identifies
   the account+Atlas or guest grant across relaunch, without containing a secret;
   the captured session separately checks its live generation.
4. Pass the router's current handoff and current projected Journey as
   `currentIntent` and `latestJourney`. Pass its scoped fresh Journey read as
   `readJourney`. `refresh(source, destination)` replaces both Journey projections
   after move/undo or import. `onBeat` can forward the current route-point camera
   command to the already mounted Atlas scene. `onReturn` applies `MediaReturn`
   through the existing router: `completed` closes Story onto Atlas; `exited`
   restores the resolved asset/point and expanded state. Request/revision checks
   suppress late returns. On session invalidation call `model.invalidate()`.
5. Retain one `BackgroundPartUploader` per scope in app composition. Use
   `NativeMediaFeatureModel.scopeDirectory(root:scopeID:)` under Application
   Support; use its digest as the suffix of the app's background-session identifier.
   Use separate `receipts` and `imports` subdirectories. Forward the app delegate's
   `handleEventsForBackgroundURLSession` completion handler to that uploader's
   `finishBackgroundEvents`. Recreate the uploader with the same identifier before
   calling `PhotosImportModel.recover()`. On account switch invalidate the old
   feature; a new account cannot read or resume its journal.

The facade exposes PhotosPicker, batch move/undo and local MP4 export from the
normal Story's “素材与影片” sheet. The default export ports the existing 60-second
Keepsake fitting rules; readable minimums and note pages can extend beyond two
minutes, retaining all canonical media. `usePreparedFilm(_:derivativeRead:)`
accepts an existing v2 manifest + v1 source plan + ephemeral captions, including
an authorized opening derivative. The derivative closure must authorize the
current cover/source asset and revision in the same AtlasSession scope. Captions,
private bytes and signed URLs never go into the ID-only manifest or upload journal.

## Native CI and simulator attachment

The package scheme is `StartripsMedia`. On an Apple GitHub runner, select the one
simulator already used by #767's native workflow and run its package tests with
`xcodebuild test` (or add the package's test target to that workflow's test plan).
No macOS-only `swift test`: the sources intentionally use UIKit and PhotosUI.
Do not add a second macOS/browser matrix.

Add `UITests/StoryRoundTripUITests.swift` to #767's existing **app** UI-test target,
not the package unit-test target. Its fixture enters the normal production scene
and router with `--uitest-atlas-fixture native-media`. The existing app fixture
loader needs to project `Tests/Fixtures/journey.json`, expose the Atlas point
`atlas.route-point.point-one`, and return bundled deterministic image/video reads
through its existing fixture transport. This is a test dependency, not a new demo
application. If #767 uses different fixture flags/identifiers, adapt this one test
to its finalized harness before reporting a simulator pass.

Unit tests cover canonical cover versus media identity, grouped Route Point order,
cancelled and stale page transitions, playback lease replacement, moved/deleted
return targets, completion and intent supersession, timing, video holds and trim,
duck attack/release, guest and account isolation, server part sizes/ETags/exact
asset IDs, expired-signature retry, cancellation, unknown-start non-replay,
completion recovery, batch move/undo null fields and both list refreshes, HEIC
orientation, existing film manifests, note expansion, real MP4 encoding at 121
seconds, first/last frames, soundtrack mux, disk failure, cancellation and final
authorization failure. Media files are generated in the native tests; no private
photo, token or signed URL is committed. The upload-status fixture matches
#769 commit `0349f2d9f6a675062ccc95cf5f31e044b756a263`.

## Validation boundary

Only static file/contract inspection is authorized on the Windows implementation
host. No native compile, XCTest, simulator, PhotosPicker/iCloud interaction,
background relaunch, microphone/audio-route behavior or physical iPhone acceptance
has run here. Those remain Apple CI/device checks. The app entry and XCUITest
attachment require #767's committed ref, whose composition files belong to that
owner. Source publication does not prove integration or native CI success.

Before opening a PR, verify its actual base contains #767's iOS-only CI routing.
If it does not, publish only the source branch and hold the PR. Do not dispatch the
old browser matrix to validate these iOS-only files.
