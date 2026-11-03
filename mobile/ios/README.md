# Startrips iPhone — #767

[中文开发与验收指南](README.zh-CN.md)

The `Startrips` shared scheme has an ordinary SwiftUI application entry, a hosted
XCTest/Swift Testing target and an XCUITest target. Requires Xcode 16+ and iOS 17+.
Install the repository's pinned pnpm dependencies before opening
`Startrips.xcodeproj`. The application's normal build phase invokes
`bundle-scene.sh`; CI uses that same build path. Select a signing team for a real
iPhone. No signing identity or deployment credential is committed.

The installed app connects directly to the first-party HTTPS deployment at
`https://106.53.130.142`; ordinary users never configure a server.
Only an explicit DEBUG launch with `-allow-server-override` shows a developer
test-origin field. Sign in and select the Atlas in the private WebView, then
return to the native Atlas.
Guest entry accepts the existing `/share#<token>` link. Tokens remain in native
session memory; guest requests carry only the bearer header and never owner
cookies. Switching access modes clears native navigation and the local scene.

## Scene and navigation

`Sources/App/AppRouter.swift` owns the navigation stack, selection and revision.
`Scene/main.tsx` bundles the real production `LivingAtlasGlobe` (Three.js and
MapLibre), `JourneyTimeline`, `public/earth`, production fonts, brand resources,
and the MapLibre worker. It does not import login, preview or private media
components. The server projects only the Journey/Route Point/media identity
needed for presentation; no Home Base or Everyday Fragment is included.

The read-only loopback server binds **127.0.0.1**, serves bundled resources, and
proxies only the existing public `/api/mapstyle` and sprite endpoints. It has no
session cookies or owner API. The local WKWebView uses a nonpersistent data store;
the private HTTPS WebView has no message handler. Origin and main-frame checks
guard native messages. External navigation and redirects are refused.

Snapshot/event version 1 uses `scopeId`, `revision`, `requestId`, `journeyId`,
`routePointId`, `assetId`; `StoryHandoff.revision` is the Journey's server revision.
Snapshot revision changes on data refresh/process recovery, not every point tap,
so rapid consecutive selections from one snapshot are accepted in WK message
order. Duplicate IDs, stale scopes/revisions and foreign point/media ownership
are rejected. Render acknowledgements also bind the current selection request.
Swift and TypeScript decode the same synthetic `Fixtures/bridge.json`.

The bundled GlobeTimeScrubber uses the production useGlobeTimeCursor. A scrub changes route reveal and point focus in the same scene; only the committed point crosses the bridge. The scene measures the visible controls when layout changes to keep the camera viewport above the timeline.

Manual camera input suspends commanded centering until the next selection. After about 20 seconds of inactivity, the production renderer releases to idle rotation at the current orientation. Detail-map input uses
the production controller. Card connector lines are hidden. Account Earth
preference is fetched through the existing account endpoint; guest mode does not
query account preferences. Native foreground/periodic refresh revalidates access.
Navigation reconstruction re-resolves saved IDs against freshly authorized data;
guest navigation and credentials are never saved. WK content process recovery
rebuilds the scene from the native snapshot, with two bounded automatic retries.

## Native Story and playback

The application links the local StartripsMedia package. StoryDestination constructs the viewer using the current AtlasSession and AppRouter selection. See [Native media integration](NativeMedia/INTEGRATION.md) for the owner/guest contract, background transfers and native test targets.

## CI selection

All rules use the entire PR merge-base diff, including both sides of renames.
Main push uses before..after; missing identities and manual exact-main recovery
fail closed to full coverage. The stable required `ci / verify` independently
reclassifies scope and rejects failures, cancellations, missing results and
unexpected work in lanes declared skipped.

| Change | Native | Web |
| --- | --- | --- |
| iOS-only source/design | Swift/TS bridge checks, application build, XCTest/Swift Testing, one simulator XCUITest | No browser, core or keepsake runner |
| Documentation only | No macOS runner | No product runners |
| iOS + mapped `JourneyTimeline` component | Native suite | Core, keepsake, shell-composer shard |
| Other shared runtime, unknown paths or CI rules | Native when shared/native inputs are affected | Original full eight shards / 42 suites, core, keepsake |
| Ordinary Web changes | Native only for shared inputs | Original full Web matrix |
| Legal ledger-only final | Skip only with exact Source evidence | Existing Source proof contract preserved |

This change edits CI rules, so its first Source must run **full Web and native**.
The browser command inventory is unchanged in `.github/browser-matrix.json`.
The selected matrix is computed before runner allocation. Push triggers remain
main-only, avoiding branch-push + PR duplicates; old PR heads retain cancellation.
The macOS job uses one available iPhone and disables parallel simulator clones.
pnpm and DerivedData are cached. `.xcresult` includes the screenshot attachment.

The deterministic scope tests cover native/docs/mixed/unknown paths, earlier PR
commits, renames, push ranges, missing SHAs, runner gates, Source reuse and
failure/cancellation propagation. Existing exact-main, ledger and all 42 browser
command assertions remain in CI. No heavy local tests/builds were run.

## Build and verify the integrated app

From the repository root on macOS, install the pinned pnpm dependencies with
`pnpm install --frozen-lockfile`. Open `mobile/ios/Startrips.xcodeproj`,
select the shared `Startrips` scheme and an iPhone, then Run. The build phase
bundles the same Atlas scene used by the app. For owner upload recovery, deploy
the server change in #769 before distributing the iPhone build. It adds the
authenticated `GET /api/uploads/{id}/status` endpoint used after interruptions.

1. Run `bash mobile/ios/ci-test.sh` from the repository root on an Apple runner.
   The package and the app share one simulator. Results are written under
   `artifacts/ios/`.
2. The UI tests enter the bundled Atlas and the normal Story destination. They
   exercise point selection, the time slider, interrupted and completed paging,
   Journey Playback and return to Atlas. Photo fixtures use a test-only session
   and private navigation defaults for each launch.
3. On a real iPhone, use an authorized owner Atlas: globe → consecutive Route
   Points → real Story → Back; verify the same selected point. Drag both globe
   and detail map, wait about 20 seconds, check centering and hidden connectors.
   Repeat with a guest share, background/foreground, revoked access, content
   invalidation and WK process recovery. Capture device/OS/head and screenshots.
   **No real iPhone is attached to this session; none of this is claimed passed.**
4. Independent Source review and exact Source CI precede the one ledger-only
   seal. This implementation creates no review receipt or ledger, and does not
   merge, deploy, change ONE, clear STOP or touch other owners' worktrees.
