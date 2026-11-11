import XCTest
import Testing
import Combine
import StartripsMedia
@testable import Startrips

@MainActor
final class AppTests: XCTestCase {
    func fixture() throws -> BridgeFixture {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        return try JSONDecoder().decode(BridgeFixture.self, from: Data(contentsOf: url))
    }

    func testProductionServerIsAValidatedFirstPartyHTTPSOrigin() throws {
        let origin = try AtlasSession.validatedOrigin(AtlasSession.productionOrigin)
        XCTAssertEqual(AtlasSession.productionOrigin, "https://106.53.130.142")
        XCTAssertTrue(AtlasSession.isProductionOrigin(origin))
        XCTAssertTrue(AtlasSession.isProductionOrigin(try AtlasSession.validatedOrigin("https://106.53.130.142/")))
        XCTAssertFalse(AtlasSession.isProductionOrigin(URL(string: "https://atlas.example")!))
        XCTAssertFalse(AtlasSession.isProductionOrigin(URL(string: "https://106.53.130.142:8443")!))
        #if !DEBUG
        XCTAssertThrowsError(try AtlasSession.validatedOrigin("https://atlas.example"))
        #endif
    }

    func testUnreadableSceneSnapshotRaisesNativeRecovery() throws {
        let data = try fixture()
        let router = AppRouter(defaults: UserDefaults(suiteName: "app.startrips.scene-failed." + UUID().uuidString)!)
        router.install(data.snapshot.journeys, identity: "scene-owner", access: .owner, earthExperience: "default")
        // The scene cannot echo a scope it failed to decode.
        let json = #"{"version":2,"kind":"sceneFailed","requestId":"\#(UUID().uuidString)"}"#
        let failed = try JSONDecoder().decode(SceneEvent.self, from: Data(json.utf8))
        XCTAssertNoThrow(try validateSceneEvent(failed, snapshot: router.snapshot))
        router.receive(failed)
        XCTAssertEqual(router.error, "地球数据无法读取，请刷新重试。")
        router.error = nil
        router.receive(failed)
        XCTAssertNil(router.error, "the same request must not raise recovery twice")

        let targeted = SceneEvent(version: SceneContract.version, kind: .sceneFailed, scopeId: "", requestId: UUID().uuidString,
                                  revision: -1, journeyId: data.snapshot.journeys[0].id)
        XCTAssertThrowsError(try validateSceneEvent(targeted, snapshot: router.snapshot))
        // Every other kind still has to carry and match the live scope and revision.
        let unscoped = #"{"version":2,"kind":"invalidate","requestId":"\#(UUID().uuidString)"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(SceneEvent.self, from: Data(unscoped.utf8)))
        let foreign = SceneEvent(version: SceneContract.version, kind: .invalidate, scopeId: "other-owner",
                                 requestId: UUID().uuidString, revision: router.revision)
        XCTAssertThrowsError(try validateSceneEvent(foreign, snapshot: router.snapshot))
    }

    func testNativeHeaderSwitchAccessIsScopeBoundAndDeduplicated() throws {
        let data = try fixture()
        let defaults = UserDefaults(suiteName: "app.startrips.header-fixture." + UUID().uuidString)!
        let router = AppRouter(defaults: defaults)
        router.install(data.snapshot.journeys, identity: "header-owner", access: .owner,
                       earthExperience: "default")
        var calls = 0
        router.onSwitchAccess = { calls += 1 }
        let event = SceneEvent(version: SceneContract.version, kind: .switchAccess, scopeId: router.scopeId,
                               requestId: UUID().uuidString, revision: router.revision,
                               journeyId: nil, routePointId: nil, assetId: nil)
        XCTAssertNoThrow(try validateSceneEvent(event, snapshot: router.snapshot))
        router.receive(event)
        router.receive(event)
        XCTAssertEqual(calls, 1)
        let foreign = SceneEvent(version: SceneContract.version, kind: .switchAccess, scopeId: "other-owner",
                                 requestId: UUID().uuidString, revision: router.revision,
                                 journeyId: nil, routePointId: nil, assetId: nil)
        router.receive(foreign)
        XCTAssertEqual(calls, 1)
        let unauthorized = SceneEvent(version: SceneContract.version, kind: .switchAccess, scopeId: router.scopeId,
                                      requestId: UUID().uuidString, revision: router.revision,
                                      journeyId: data.snapshot.journeys[0].id, routePointId: nil, assetId: nil)
        XCTAssertThrowsError(try validateSceneEvent(unauthorized, snapshot: router.snapshot))
    }

    func testSnapshotScriptTreatsTitlesAndNotesAsData() throws {
        let json = #"{"title":"海岸');throw Error('x')//","note":"\"quotes\"\nnew line"}"#
        let script = try AtlasSceneView.receiveScript(json)
        let prefix = "window.atlasNative.receive("
        XCTAssertTrue(script.hasPrefix(prefix)); XCTAssertTrue(script.hasSuffix(")"))
        let literal = script.dropFirst(prefix.count).dropLast()
        XCTAssertEqual(try JSONDecoder().decode(String.self, from: Data(literal.utf8)), json)
    }

    func testSharedFixtureAndStaleBridgeMessages() throws {
        let fixture = try fixture()
        XCTAssertNoThrow(try validateSceneEvent(fixture.event, snapshot: fixture.snapshot))
        let event = fixture.event
        let stale = SceneEvent(version: SceneContract.version, kind: .story, scopeId: event.scopeId, requestId: event.requestId,
                               revision: event.revision - 1, journeyId: event.journeyId)
        XCTAssertThrowsError(try validateSceneEvent(stale, snapshot: fixture.snapshot))
        let wrongPoint = SceneEvent(version: SceneContract.version, kind: .story, scopeId: event.scopeId, requestId: event.requestId,
                                    revision: event.revision, journeyId: event.journeyId, routePointId: "other")
        XCTAssertThrowsError(try validateSceneEvent(wrongPoint, snapshot: fixture.snapshot))
        let wrongAsset = SceneEvent(version: SceneContract.version, kind: .story, scopeId: event.scopeId, requestId: event.requestId,
                                    revision: event.revision, journeyId: event.journeyId, routePointId: "point-b", assetId: event.assetId)
        XCTAssertThrowsError(try validateSceneEvent(wrongAsset, snapshot: fixture.snapshot))
    }

    func testSharedFixtureCommandsAndStaleCommandRejection() throws {
        let fixture = try fixture()
        XCTAssertEqual(fixture.snapshot.version, SceneContract.version)
        XCTAssertEqual(fixture.commands.map(\.kind), [.focus, .timeWindow, .chrome, .insets])
        for command in fixture.commands {
            XCTAssertNoThrow(try validateSceneCommand(command, snapshot: fixture.snapshot))
        }
        let focus = fixture.commands[0]
        func rejects(_ mutate: (inout SceneCommand) -> Void, as failure: BridgeFailure,
                     _ base: SceneCommand, line: UInt = #line) {
            var command = base; mutate(&command)
            XCTAssertThrowsError(try validateSceneCommand(command, snapshot: fixture.snapshot), line: line) {
                XCTAssertEqual($0 as? BridgeFailure, failure, line: line)
            }
        }
        rejects({ $0 = SceneCommand(version: 1, kind: $0.kind, scopeId: $0.scopeId, revision: $0.revision,
                                    requestId: $0.requestId, journeyId: $0.journeyId) }, as: .invalidMessage, focus)
        rejects({ $0 = SceneCommand(version: 2, kind: $0.kind, scopeId: $0.scopeId, revision: $0.revision - 1,
                                    requestId: $0.requestId, journeyId: $0.journeyId) }, as: .stale, focus)
        rejects({ $0 = SceneCommand(version: 2, kind: $0.kind, scopeId: "guest", revision: $0.revision,
                                    requestId: $0.requestId, journeyId: $0.journeyId) }, as: .stale, focus)
        rejects({ $0.journeyId = "other" }, as: .unknownTarget, focus)
        rejects({ $0.routePointId = "point-valley" }, as: .unknownTarget, focus)
        rejects({ $0.globeOnly = true }, as: .invalidMessage, focus)
        rejects({ $0.window = SceneTimeWindow(start: "2025-02-01", end: "2025-01-01") }, as: .invalidMessage, fixture.commands[1])
        rejects({ $0.window = SceneTimeWindow(start: "2025/01/01", end: "2025-01-02") }, as: .invalidMessage, fixture.commands[1])
        rejects({ $0.journeyId = "journey-fixture" }, as: .invalidMessage, fixture.commands[1])
        rejects({ $0.globeOnly = nil }, as: .invalidMessage, fixture.commands[2])
        rejects({ $0.insets = SceneInsets(top: -1, bottom: 0) }, as: .invalidMessage, fixture.commands[3])
        rejects({ $0.insets = SceneInsets(top: 0, bottom: .infinity) }, as: .invalidMessage, fixture.commands[3])
        var cleared = fixture.commands[1]; cleared.window = nil
        XCTAssertNoThrow(try validateSceneCommand(cleared, snapshot: fixture.snapshot))
        // A script literal keeps a command as data, exactly like a snapshot.
        let script = try AtlasSceneView.commandScript(#"{"kind":"chrome');alert(1)//"}"#)
        XCTAssertTrue(script.hasPrefix("window.atlasNative.command(\""))
    }

    func testNativeSelectionSharesSceneGuardsAndMintsFreshRequests() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let router = AppRouter(defaults: defaults)
        router.install(try fixture().snapshot.journeys, identity: "native-owner", access: .owner, earthExperience: "default")
        let revision = router.revision
        XCTAssertTrue(router.select(journeyId: "journey-fixture", routePointId: "point-b"))
        let first = try XCTUnwrap(router.selection)
        XCTAssertEqual(first.routePointId, "point-b")
        XCTAssertNotNil(UUID(uuidString: first.requestId))
        XCTAssertEqual(router.revision, revision, "a selection is not a data refresh")
        XCTAssertTrue(router.select(journeyId: "journey-fixture"))
        XCTAssertNotEqual(router.selection?.requestId, first.requestId)
        XCTAssertFalse(router.select(journeyId: "journey-fixture", routePointId: "other"))
        XCTAssertFalse(router.select(journeyId: "other"))
        // Persisted for owner navigation restore, like a scene selection.
        let saved = try XCTUnwrap(defaults.data(forKey: "atlas.navigation.selection"))
        XCTAssertEqual(try JSONDecoder().decode(StoryHandoff.self, from: saved).requestId, router.selection?.requestId)

        router.previewFocus(journeyId: "journey-fixture")
        let preview = try XCTUnwrap(router.preview)
        router.previewFocus(journeyId: "journey-fixture")
        XCTAssertEqual(router.preview, preview, "the same Journey does not re-fly the camera")
        let command = router.command(.focus, journeyId: preview.journeyId)
        XCTAssertNoThrow(try validateSceneCommand(command, snapshot: router.snapshot))

        XCTAssertTrue(router.openStory(journeyId: "journey-fixture", routePointId: "point-a"))
        XCTAssertNil(router.preview, "a committed selection ends the preview")
        XCTAssertEqual(router.path.count, 1)
        XCTAssertFalse(router.select(journeyId: "journey-fixture"), "Story owns navigation")
        XCTAssertFalse(router.openStory(journeyId: "journey-fixture"))
        router.previewFocus(journeyId: "journey-fixture")
        XCTAssertNil(router.preview)
        router.returnToAtlas()
        router.presentation.window = SceneTimeWindow(start: "2025-01-01", end: "2025-01-02")
        router.clear()
        XCTAssertNil(router.presentation.window, "a new scope starts without a time window")
    }

    func testOwnerRestoreGuestIsolationInvalidationAndReturn() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let records = try fixture().snapshot.journeys
        let router = AppRouter(defaults: defaults)
        router.install(records, identity: "owner-a", access: .owner, earthExperience: "particle-only")
        let open = SceneEvent(version: SceneContract.version, kind: .story, scopeId: router.scopeId, requestId: UUID().uuidString,
                              revision: router.revision, journeyId: "journey-fixture", routePointId: "point-a")
        router.receive(open)
        XCTAssertEqual(router.path.first?.routePointId, "point-a")
        router.receive(open) // Duplicate/late callback cannot push a second destination.
        XCTAssertEqual(router.path.count, 1)
        router.returnToAtlas()
        XCTAssertTrue(router.path.isEmpty)
        XCTAssertEqual(router.selection?.journeyId, "journey-fixture")
        let recreated = AppRouter(defaults: defaults)
        recreated.install(records, identity: "owner-a", access: .owner, earthExperience: "particle-only")
        XCTAssertEqual(recreated.selection?.routePointId, "point-a")
        recreated.sceneRestarted()
        XCTAssertEqual(recreated.snapshot.selection?.journeyId, "journey-fixture")
        recreated.install(records, identity: "guest-new", access: .guest, earthExperience: "default")
        XCTAssertNil(recreated.selection)
        recreated.receive(open) // A former owner message is not guest authority.
        XCTAssertTrue(recreated.path.isEmpty)
        recreated.install([], identity: "guest-new", access: .guest, earthExperience: "default")
        XCTAssertTrue(recreated.journeys.isEmpty)
    }

    func testInitialStoryAcceptsAheadMediaProjectionAndRejectsSupersededBuild() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let router = AppRouter(defaults: defaults)
        router.install(try fixture().snapshot.journeys, identity: "synthetic-ci",
                       access: .owner, earthExperience: "default")
        let requestA = UUID().uuidString
        router.receive(SceneEvent(version: SceneContract.version, kind: .story, scopeId: router.scopeId,
            requestId: requestA, revision: router.revision, journeyId: "journey-fixture",
            routePointId: "point-a", assetId: "asset-fixture"))
        let opened = try XCTUnwrap(router.path.last)
        let session = AtlasSession()
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        try session.installFixture(Data(contentsOf: url), scope: "synthetic-ci")
        var media = try XCTUnwrap(session.mediaJourneys["journey-fixture"])
        media.revision += 1 // Media was refreshed after the scene tap but before Story builds.
        let accepted = try XCTUnwrap(StoryDestination.authorizeInitialStory(media,
            target: opened, router: router))
        XCTAssertEqual(accepted.revision, 4)
        XCTAssertEqual(router.path.last?.revision, 4)
        XCTAssertEqual(router.selection?.revision, 4)

        let scoped = ScopedMediaSession(scopeID: "synthetic-ci", access: .guest,
            read: { _ in throw MediaFailure.unavailable },
            request: { _, _, _ in Data() }, revalidate: {})
        var beats: [PlaybackBeat] = []
        var exits: [MediaReturn] = []
        let model = try NativeMediaFeatureModel(journey: media,
            intent: StoryIntent(journeyId: accepted.journeyId, routePointId: accepted.routePointId,
                                assetId: accepted.assetId, revision: accepted.revision,
                                requestId: accepted.requestId),
            session: scoped, directory: FileManager.default.temporaryDirectory,
            uploader: ReadOnlyTransfer(), currentIntent: {
                let live = router.path.last
                return StoryIntent(journeyId: live?.journeyId ?? "", routePointId: live?.routePointId,
                    assetId: live?.assetId, revision: live?.revision ?? -1,
                    requestId: live?.requestId ?? "")
            }, latestJourney: { media }, readJourney: { throw MediaFailure.unavailable },
            refresh: { _, _ in }, onBeat: { beats.append($0) },
            onReturn: { result in exits.append(result); router.returnToAtlas() })
        defer { model.story.disappear() }
        model.story.playJourney()
        XCTAssertFalse(beats.isEmpty)
        model.story.finish()
        XCTAssertEqual(exits.map(\.revision), [4])
        XCTAssertTrue(router.path.isEmpty)

        let requestB = UUID().uuidString
        router.receive(SceneEvent(version: SceneContract.version, kind: .story, scopeId: router.scopeId,
            requestId: requestB, revision: router.revision, journeyId: "journey-fixture",
            routePointId: "point-a", assetId: "asset-second"))
        let replacement = try XCTUnwrap(router.path.last)
        XCTAssertNil(StoryDestination.authorizeInitialStory(media, target: opened, router: router))
        XCTAssertFalse(router.acceptStoryRevision(journeyId: replacement.journeyId,
            requestId: requestB, from: replacement.revision, to: replacement.revision - 1))
        XCTAssertEqual(router.path.last, replacement)
        XCTAssertEqual(router.selection?.assetId, "asset-second")
    }

    func testInPlaceMediaRefreshKeepsRealRouterLiveForPlaybackAndReturn() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let bridge = try fixture()
        let router = AppRouter(defaults: defaults)
        router.install(bridge.snapshot.journeys, identity: "synthetic-ci", access: .owner, earthExperience: "default")
        let requestID = UUID().uuidString
        let event = SceneEvent(version: SceneContract.version, kind: .story, scopeId: router.scopeId, requestId: requestID,
                               revision: router.revision, journeyId: "journey-fixture",
                               routePointId: "point-a", assetId: "asset-fixture")
        router.receive(event)
        XCTAssertEqual(router.path.last?.revision, 3)
        let opened = try XCTUnwrap(router.path.last)

        let session = AtlasSession()
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        try session.installFixture(Data(contentsOf: url), scope: "synthetic-ci")
        var journey = try XCTUnwrap(session.mediaJourneys["journey-fixture"])
        let journeyID = journey.id
        let scope = ScopedMediaSession(scopeID: "synthetic-ci", access: .guest,
            read: { _ in throw MediaFailure.unavailable },
            request: { _, _, _ in Data() }, revalidate: {})
        var exits: [MediaReturn] = []
        var beats: [PlaybackBeat] = []
        let intent = StoryIntent(journeyId: journey.id, routePointId: "point-a", assetId: "asset-fixture",
                                 revision: journey.revision, requestId: requestID)
        let feature = try NativeMediaFeatureModel(journey: journey, intent: intent, session: scope,
            directory: FileManager.default.temporaryDirectory, uploader: ReadOnlyTransfer(),
            currentIntent: {
                let live = router.path.last
                return StoryIntent(journeyId: live?.journeyId ?? "", routePointId: live?.routePointId,
                    assetId: live?.assetId, revision: live?.revision ?? -1, requestId: live?.requestId ?? "")
            }, latestJourney: { session.mediaJourneys["journey-fixture"] },
            acceptRevision: { old, new in
                router.acceptStoryRevision(journeyId: journeyID, requestId: requestID, from: old, to: new)
            }, readJourney: { throw MediaFailure.unavailable },
            refresh: { source, destination in
                session.replaceMedia(source); session.replaceMedia(destination)
            }, onBeat: { beats.append($0) }, onReturn: { result in
                exits.append(result)
                guard router.path.last?.requestId == result.requestId,
                      router.path.last?.revision == result.revision else { return }
                router.returnToAtlas()
            })
        defer { feature.story.disappear() }

        // A media-only update arrives before the asynchronous Atlas projection.
        // The real Router still holds the original revision until Story accepts it.
        var published: [Int] = []
        let observation = session.$mediaJourneys.sink { value in
            if let revision = value["journey-fixture"]?.revision { published.append(revision) }
        }
        defer { observation.cancel() }
        journey.revision += 1
        session.replaceMedia(journey)
        XCTAssertEqual(published.last, journey.revision)
        XCTAssertEqual(router.path.last?.revision, 3)
        XCTAssertFalse(router.acceptStoryRevision(journeyId: journey.id, requestId: UUID().uuidString,
                                                  from: feature.story.intent.revision, to: journey.revision))
        StoryDestination.reconcileRefresh(journey, feature: feature, target: opened, router: router)
        XCTAssertEqual(router.path.last?.revision, 4)
        XCTAssertEqual(feature.story.intent.revision, 4)

        // Local import/move updates the feature before the session projection.
        journey.revision += 1
        StoryDestination.reconcileRefresh(journey, feature: feature, target: opened, router: router)
        XCTAssertEqual(router.path.last?.revision, 5)
        session.replaceMedia(journey)
        XCTAssertEqual(published.last, 5)

        // A beat can arrive before the Atlas Journey itself is refreshed.
        router.commitStoryPosition(StoryHandoff(journeyId: journey.id, routePointId: "point-a",
                                                assetId: "asset-fixture", revision: 3, requestId: requestID))
        XCTAssertEqual(router.selection?.revision, 5)
        let saved = try XCTUnwrap(defaults.data(forKey: "atlas.navigation.selection"))
        XCTAssertEqual(try JSONDecoder().decode(StoryHandoff.self, from: saved).revision, 5)

        // A slower Atlas fetch must not roll back the Story revision just
        // accepted from media. Otherwise the next beat/close becomes stale.
        router.install(bridge.snapshot.journeys, identity: "synthetic-ci",
                       access: .owner, earthExperience: "default")
        XCTAssertEqual(router.path.last?.requestId, requestID)
        XCTAssertEqual(router.path.last?.revision, 5)
        XCTAssertEqual(router.selection?.revision, 5)
        XCTAssertEqual(router.selection?.routePointId, "point-a")
        XCTAssertEqual(router.selection?.assetId, "asset-fixture")

        // The stale server media projection must not close the still-active
        // Story or reset its accepted revision after a local import/move.
        var unexpectedInvalidations = 0
        router.onInvalidation = { unexpectedInvalidations += 1 }
        var staleMedia = journey
        staleMedia.revision = 3
        StoryDestination.reconcileRefresh(staleMedia, feature: feature, target: opened, router: router)
        XCTAssertEqual(unexpectedInvalidations, 0)
        XCTAssertEqual(router.path.last?.revision, 5)
        XCTAssertEqual(feature.story.intent.revision, 5)

        // The media source of truth must also remain current: StoryModel's
        // playback/close validation reads it independently of the Router.
        session.replaceMedia(staleMedia)
        XCTAssertEqual(session.mediaJourneys[journeyID]?.revision, 5)
        let mergedMedia = AtlasSession.preservingNewerMedia(
            [journeyID: staleMedia], previous: session.mediaJourneys)
        XCTAssertEqual(mergedMedia[journeyID]?.revision, 5)
        XCTAssertTrue(AtlasSession.preservingNewerMedia([:], previous: session.mediaJourneys).isEmpty)

        feature.story.playJourney()
        XCTAssertNotNil(feature.story.playback)
        XCTAssertFalse(beats.isEmpty) // Stale router revisions suppress activateBeat().
        feature.story.finish(.completed)
        XCTAssertEqual(exits.map(\.revision), [5])
        XCTAssertTrue(router.path.isEmpty)
    }

    func testNewlyImportedStoryAssetSurvivesStaleAtlasReturnAndDeletedAssetFallsBack() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let bridge = try fixture()
        let oldAtlas = try XCTUnwrap(bridge.snapshot.journeys.first)
        XCTAssertEqual(oldAtlas.revision, 3)
        let router = AppRouter(defaults: defaults)
        router.install(bridge.snapshot.journeys, identity: "synthetic-ci",
                       access: .owner, earthExperience: "default")
        let requestID = UUID().uuidString
        router.receive(SceneEvent(version: SceneContract.version, kind: .story, scopeId: router.scopeId,
            requestId: requestID, revision: router.revision, journeyId: oldAtlas.id,
            routePointId: "point-a", assetId: "asset-fixture"))
        let target = try XCTUnwrap(router.path.last)

        let session = AtlasSession()
        let fixtureURL = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        try session.installFixture(Data(contentsOf: fixtureURL), scope: "synthetic-ci")
        var revisedMedia = try XCTUnwrap(session.mediaJourneys[oldAtlas.id])
        var imported = try XCTUnwrap(revisedMedia.media.first(where: { $0.id == "asset-fixture" }))
        imported.id = "asset-newly-imported"
        imported.sortOrder = 999
        revisedMedia.media.append(imported)
        revisedMedia.revision += 1
        session.replaceMedia(revisedMedia)
        XCTAssertFalse(oldAtlas.media.contains(where: { $0.id == imported.id }))
        let authorized = try XCTUnwrap(StoryDestination.authorizeInitialStory(
            revisedMedia, target: target, router: router))
        XCTAssertEqual(router.path.last?.revision, revisedMedia.revision)

        // A different owner or wrong point cannot authorize an identical asset ID.
        var foreignMedia = revisedMedia
        foreignMedia.media[foreignMedia.media.count - 1].journeyId = "other-owner"
        let newTarget = StoryHandoff(journeyId: oldAtlas.id, routePointId: "point-a",
            assetId: imported.id, revision: authorized.revision, requestId: requestID)
        XCTAssertNil(router.current(newTarget, mediaJourney: foreignMedia)?.assetId)
        var movedElsewhere = revisedMedia
        movedElsewhere.media[movedElsewhere.media.count - 1].routePointId = "point-b"
        XCTAssertNil(router.current(newTarget, mediaJourney: movedElsewhere)?.assetId)

        let scope = ScopedMediaSession(scopeID: "synthetic-ci", access: .guest,
            read: { _ in throw MediaFailure.unavailable },
            request: { _, _, _ in Data() }, revalidate: {})
        let feature = try NativeMediaFeatureModel(journey: revisedMedia,
            intent: StoryIntent(journeyId: authorized.journeyId, routePointId: authorized.routePointId,
                                assetId: authorized.assetId, revision: authorized.revision,
                                requestId: requestID),
            session: scope, directory: FileManager.default.temporaryDirectory,
            uploader: ReadOnlyTransfer(), currentIntent: {
                let live = router.path.last
                return StoryIntent(journeyId: live?.journeyId ?? "", routePointId: live?.routePointId,
                    assetId: live?.assetId, revision: live?.revision ?? -1,
                    requestId: live?.requestId ?? "")
            }, latestJourney: { session.mediaJourneys[oldAtlas.id] },
            readJourney: { throw MediaFailure.unavailable },
            refresh: { _, _ in }, onReturn: { result in
                StoryDestination.completeReturn(result, target: target,
                    scope: "synthetic-ci", session: session, router: router)
            })
        defer { feature.story.disappear() }
        let index = try XCTUnwrap(feature.story.cursor.entries.firstIndex {
            $0.role == .media && $0.asset?.id == imported.id
        })
        feature.story.select(index)
        XCTAssertEqual(feature.story.activeAsset?.id, imported.id)

        // Exit native Story before the independent Atlas fetch completes.
        // The production return callback must persist the newly selected asset.
        feature.story.finish()
        XCTAssertTrue(router.path.isEmpty)
        XCTAssertEqual(router.selection?.routePointId, "point-a")
        XCTAssertEqual(router.selection?.assetId, imported.id)
        let saved = try XCTUnwrap(defaults.data(forKey: "atlas.navigation.selection"))
        XCTAssertEqual(try JSONDecoder().decode(StoryHandoff.self, from: saved).assetId, imported.id)

        // A stale server Atlas projection (revision 3) cannot erase the newer,
        // scope-authorized media selection (revision 4) after Story has closed.
        router.install(bridge.snapshot.journeys, identity: "synthetic-ci",
                       access: .owner, earthExperience: "default",
                       mediaJourneys: session.mediaJourneys)
        XCTAssertEqual(router.selection?.assetId, imported.id)
        XCTAssertEqual(router.selection?.revision, revisedMedia.revision)

        let importedAtlas = AtlasAsset(id: imported.id, routePointId: imported.routePointId,
            fileName: imported.fileName, mimeType: imported.mimeType, bytes: Int(imported.bytes))
        func atlas(_ revision: Int, media: [AtlasAsset]) -> AtlasJourney {
            AtlasJourney(id: oldAtlas.id, title: oldAtlas.title, startedOn: oldAtlas.startedOn,
                endedOn: oldAtlas.endedOn, note: oldAtlas.note, lightColor: oldAtlas.lightColor,
                lightEffect: oldAtlas.lightEffect, routeSegments: oldAtlas.routeSegments,
                revision: revision, routePoints: oldAtlas.routePoints, media: media)
        }
        router.install([atlas(revisedMedia.revision, media: oldAtlas.media + [importedAtlas])],
                       identity: "synthetic-ci", access: .owner, earthExperience: "default",
                       mediaJourneys: session.mediaJourneys)
        XCTAssertEqual(router.selection?.assetId, imported.id)
        XCTAssertEqual(router.selection?.routePointId, "point-a")

        // A genuinely newer deletion overrides the formerly valid media asset.
        // Keeping it forever would turn stale-projection recovery into a leak.
        var afterDelete = revisedMedia
        afterDelete.revision += 1
        afterDelete.media.removeAll(where: { $0.id == imported.id })
        session.replaceMedia(afterDelete)
        router.install([atlas(revisedMedia.revision, media: oldAtlas.media + [importedAtlas])],
                       identity: "synthetic-ci", access: .owner, earthExperience: "default",
                       mediaJourneys: session.mediaJourneys)
        XCTAssertNil(router.selection?.assetId)
        router.install([atlas(afterDelete.revision, media: oldAtlas.media)],
                       identity: "synthetic-ci", access: .owner, earthExperience: "default",
                       mediaJourneys: session.mediaJourneys)
        XCTAssertNil(router.selection?.assetId)
    }

    func testSupersededStoryRefreshCannotCloseReplacementRoute() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let router = AppRouter(defaults: defaults)
        router.install(try fixture().snapshot.journeys, identity: "synthetic-ci",
                       access: .owner, earthExperience: "default")

        let requestA = UUID().uuidString
        router.receive(SceneEvent(version: SceneContract.version, kind: .story, scopeId: router.scopeId,
            requestId: requestA, revision: router.revision, journeyId: "journey-fixture",
            routePointId: "point-a", assetId: "asset-fixture"))
        let targetA = try XCTUnwrap(router.path.last)
        let session = AtlasSession()
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        try session.installFixture(Data(contentsOf: url), scope: "synthetic-ci")
        var journey = try XCTUnwrap(session.mediaJourneys[targetA.journeyId])
        let scope = ScopedMediaSession(scopeID: "synthetic-ci", access: .guest,
            read: { _ in throw MediaFailure.unavailable },
            request: { _, _, _ in Data() }, revalidate: {})
        let oldFeature = try NativeMediaFeatureModel(journey: journey,
            intent: StoryIntent(journeyId: targetA.journeyId, routePointId: targetA.routePointId,
                                assetId: targetA.assetId, revision: journey.revision, requestId: requestA),
            session: scope, directory: FileManager.default.temporaryDirectory,
            uploader: ReadOnlyTransfer(), currentIntent: {
                let live = router.path.last
                return StoryIntent(journeyId: live?.journeyId ?? "", routePointId: live?.routePointId,
                    assetId: live?.assetId, revision: live?.revision ?? -1, requestId: live?.requestId ?? "")
            }, latestJourney: { session.mediaJourneys[targetA.journeyId] },
            acceptRevision: { old, new in
                router.acceptStoryRevision(journeyId: targetA.journeyId,
                    requestId: requestA, from: old, to: new)
            }, readJourney: { throw MediaFailure.unavailable },
            refresh: { _, _ in }, onReturn: { _ in })
        defer { oldFeature.story.disappear() }

        // Story A is replaced by B before A's delayed media refresh arrives.
        router.returnToAtlas()
        let requestB = UUID().uuidString
        router.receive(SceneEvent(version: SceneContract.version, kind: .story, scopeId: router.scopeId,
            requestId: requestB, revision: router.revision, journeyId: "journey-fixture",
            routePointId: "point-a", assetId: "asset-second"))
        XCTAssertEqual(router.path.last?.requestId, requestB)
        XCTAssertEqual(router.selection?.assetId, "asset-second")
        // A stale callback must not invoke returnToAtlas() on B, even briefly.
        // Route equality alone could miss an unrelated navigation invalidation.
        var replacementInvalidations = 0
        router.onInvalidation = { replacementInvalidations += 1 }
        journey.revision += 1
        XCTAssertFalse(router.acceptStoryRevision(journeyId: targetA.journeyId,
            requestId: requestA, from: targetA.revision, to: journey.revision))

        // Exercise the production onChange handler, not just Router's rejection.
        StoryDestination.reconcileRefresh(journey, feature: oldFeature, target: targetA, router: router)
        XCTAssertEqual(replacementInvalidations, 0)
        XCTAssertEqual(router.path.count, 1)
        XCTAssertEqual(router.path.last?.requestId, requestB)
        XCTAssertEqual(router.path.last?.journeyId, "journey-fixture")
        XCTAssertEqual(router.path.last?.routePointId, "point-a")
        XCTAssertEqual(router.path.last?.assetId, "asset-second")
        XCTAssertEqual(router.selection?.requestId, requestB)
        XCTAssertEqual(router.selection?.journeyId, "journey-fixture")
        XCTAssertEqual(router.selection?.routePointId, "point-a")
        XCTAssertEqual(router.selection?.assetId, "asset-second")
        XCTAssertEqual(oldFeature.story.intent.revision, targetA.revision)
        XCTAssertNil(oldFeature.story.failure)
    }

    func testDetailedMapKeepsFirstPartySpriteAndTileTemplatesOnTheLocalOrigin() throws {
        let upstream = try XCTUnwrap(URL(string: "https://atlas.example/"))
        let input = ["tiles": ["https://atlas.example/api/mapstyle?path=tiles/{z}/{x}/{y}"],
                     "sprites": ["https://atlas.example/api/mapstyle/sprite/base"],
                     "external": ["https://atlas.example.invalid/api/mapstyle?path=private"]]
        let data = try JSONEncoder().encode(input)
        let output = try BundledSceneServer.localizeMapDocument(data, from: upstream, port: 4321)
        let fields = try JSONDecoder().decode([String: [String]].self, from: output)
        XCTAssertEqual(fields["tiles"], ["http://127.0.0.1:4321/api/mapstyle?path=tiles/{z}/{x}/{y}"])
        XCTAssertEqual(fields["sprites"], ["http://127.0.0.1:4321/api/mapstyle/sprite/base"])
        XCTAssertEqual(fields["external"], input["external"])
    }

    func testLocalResourceAndHTTPSBoundaries() throws {
        XCTAssertEqual(BundledSceneServer.resourcePath("/assets/worker.js"), "assets/worker.js")
        for path in ["//other-host", "/../secret", "/%2e%2e/secret", "/a%5csecret"] {
            XCTAssertNil(BundledSceneServer.resourcePath(path))
        }
        XCTAssertNoThrow(try AtlasSession.validatedOrigin("https://atlas.example"))
        for origin in ["http://atlas.example", "https://user:password@atlas.example", "https://atlas.example/path", "https://atlas.example?token=secret"] {
            XCTAssertThrowsError(try AtlasSession.validatedOrigin(origin))
        }
    }
}

@Test func bridgeProjectionContainsNoCredentials() throws {
    let url = try #require(Bundle.main.url(forResource: "bridge", withExtension: "json"))
    let fixture = try JSONDecoder().decode(BridgeFixture.self, from: Data(contentsOf: url))
    let encoded = try JSONEncoder().encode(fixture.snapshot)
    let text = String(decoding: encoded, as: UTF8.self)
    let commands = String(decoding: try JSONEncoder().encode(fixture.commands), as: UTF8.self)
    for forbidden in ["cookie", "Authorization", "shareToken", "read-url", "createdByUserId"] {
        #expect(!text.contains(forbidden))
        #expect(!commands.contains(forbidden))
    }
    #expect(!commands.contains("http"))
}
