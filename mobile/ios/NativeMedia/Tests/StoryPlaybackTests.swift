import XCTest
import UIKit
@testable import StartripsMedia

enum MediaFixtures {
    static func decode<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
    static func journey() throws -> MediaJourney { try decode("journey") }
    static func intent(asset: String? = "photo-one", point: String? = "point-one") -> StoryIntent {
        StoryIntent(journeyId: "journey-one", routePointId: point, assetId: asset, revision: 7, requestId: "request-one")
    }
}

final class StoryPlaybackTests: XCTestCase {
    func testCoverPresentationDoesNotStealCanonicalSelectionOrDuplicateAssetIdentity() throws {
        let journey = try MediaFixtures.journey()
        let cursor = try StoryCursor(journey: journey, intent: MediaFixtures.intent())
        XCTAssertEqual(cursor.current?.id, "media:photo-one")
        XCTAssertEqual(cursor.current?.routePointId, "point-one")
        XCTAssertEqual(cursor.entries.map(\.id), ["journey-cover:journey-one:photo-one", "media:intro-photo", "media:photo-one", "note:point-via", "media:video-two"])
        XCTAssertEqual(cursor.entries[0].asset?.id, cursor.entries[2].asset?.id)
        XCTAssertNil(cursor.entries[0].routePointId)
    }
    func testCancelledPagingAndLateSettlesCannotCommitAnotherAsset() throws {
        var cursor = try StoryCursor(journey: MediaFixtures.journey(), intent: MediaFixtures.intent())
        let first = cursor.propose(4)
        cursor.settle(first, completed: false)
        XCTAssertEqual(cursor.current?.asset?.id, "photo-one")
        let stale = cursor.propose(4)
        let latest = cursor.propose(1)
        cursor.settle(stale, completed: true)
        XCTAssertEqual(cursor.current?.asset?.id, "photo-one")
        cursor.settle(latest, completed: true)
        XCTAssertEqual(cursor.current?.asset?.id, "intro-photo")
        let exit = cursor.propose(4); cursor.cancel(); cursor.settle(exit, completed: true)
        XCTAssertEqual(cursor.current?.asset?.id, "intro-photo")
    }
    func testGroupedViaKeepsOwnNoteAndMediaOrder() throws {
        var journey = try MediaFixtures.journey()
        var child = journey.media[1]; child.id = "child"; child.routePointId = "point-via"; child.sortOrder = -1
        journey.media.append(child)
        let sequence = journey.storySequence(includeCover: false)
        XCTAssertEqual(sequence.map { $0.asset?.id }, ["intro-photo", "photo-one", "child", "video-two"])
        XCTAssertEqual(sequence[2].routePointId, "point-via")
        XCTAssertEqual(sequence[2].chapterRoutePointId, "point-one")
    }
    func testExitFollowsMovedAssetCompletionReturnsAtlasAndNewIntentWins() throws {
        var journey = try MediaFixtures.journey()
        journey.media[1].routePointId = "point-two"
        let entry = MediaFixtures.intent()
        let result = resolveMediaReturn(entry: entry, committed: nil, reason: .exited,
                                        currentRequestID: entry.requestId, currentIntentRevision: 7, journey: journey, expanded: true)
        XCTAssertEqual(result?.surface, .story); XCTAssertEqual(result?.routePointId, "point-two")
        let completed = resolveMediaReturn(entry: entry, committed: nil, reason: .completed,
                                           currentRequestID: entry.requestId, currentIntentRevision: 7, journey: journey, expanded: true)
        XCTAssertEqual(completed?.surface, .atlas); XCTAssertNil(completed?.assetId); XCTAssertEqual(completed?.expanded, false)
        XCTAssertNil(resolveMediaReturn(entry: entry, committed: nil, reason: .exited, currentRequestID: "new", currentIntentRevision: 7, journey: journey, expanded: true))
        XCTAssertNil(resolveMediaReturn(entry: entry, committed: nil, reason: .exited, currentRequestID: entry.requestId, currentIntentRevision: 8, journey: journey, expanded: true))
    }
    func testDeletedAssetPointAndJourneyHaveDistinctFallbacks() throws {
        var journey = try MediaFixtures.journey(); journey.media.removeAll { $0.id == "photo-one" }
        let entry = MediaFixtures.intent()
        func resolve(_ value: MediaJourney?) -> MediaReturn? {
            resolveMediaReturn(entry: entry, committed: nil, reason: .exited, currentRequestID: entry.requestId,
                               currentIntentRevision: 7, journey: value, expanded: false)
        }
        XCTAssertEqual(resolve(journey)?.fallback, .assetUnavailable)
        journey.routePoints.removeAll { $0.id == "point-one" }
        XCTAssertEqual(resolve(journey)?.fallback, .routePointUnavailable)
        XCTAssertEqual(resolve(nil)?.fallback, .journeyUnavailable)
    }
    @MainActor func testOldReturnCannotCloseRefreshedStoryAndAcceptedRefreshCanExit() throws {
        var journey = try MediaFixtures.journey()
        var live = MediaFixtures.intent()
        let session = ScopedMediaSession(scopeID: "owner", access: .owner,
            read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in Data() }, revalidate: {})
        var exits: [MediaReturn] = []
        let model = try StoryModel(journey: journey, intent: live, session: session,
            currentIntent: { live }, latestJourney: { journey }, onReturn: { exits.append($0) })
        live.revision += 1; journey.revision = live.revision
        model.finish()
        XCTAssertTrue(exits.isEmpty)
        try model.update(journey)
        model.finish()
        XCTAssertEqual(exits.map(\.revision), [live.revision])
        XCTAssertEqual(exits.first?.assetId, "photo-one")
    }

    @MainActor func testRefreshAtSamePageIndexReplacesCachedPagesAndRejectsOldSwipeCompletion() throws {
        var journey = try MediaFixtures.journey()
        let entry = MediaFixtures.intent(asset: nil, point: nil)
        let scope = ScopedMediaSession(scopeID: "owner", access: .owner,
            read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in Data() }, revalidate: {})
        let model = try StoryModel(journey: journey, intent: entry, session: scope,
            currentIntent: { entry }, latestJourney: { journey }, onReturn: { _ in })
        defer { model.disappear() }
        let old = StoryPager.Coordinator(model: model)
        let ui = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
        let neighbor = try XCTUnwrap(old.page(1))
        old.pageViewController(ui, willTransitionTo: [neighbor])
        XCTAssertEqual(model.cursor.index, 0)
        XCTAssertEqual(model.cursor.current?.asset?.id, "photo-one")

        // Removing the current cover picks a different cover at the same index.
        journey.media.removeAll { $0.id == "photo-one" }
        try model.update(journey)
        XCTAssertEqual(model.cursor.index, 0)
        XCTAssertEqual(model.cursor.current?.asset?.id, "intro-photo")
        XCTAssertNil(old.page(0))
        let fresh = StoryPager.Coordinator(model: model)
        fresh.pageViewController(ui, willTransitionTo: [try XCTUnwrap(fresh.page(1))])
        old.pageViewController(ui, didFinishAnimating: true, previousViewControllers: [], transitionCompleted: true)
        XCTAssertEqual(model.cursor.index, 0)
        XCTAssertEqual(model.cursor.proposedIndex, 1)
        fresh.pageViewController(ui, didFinishAnimating: true, previousViewControllers: [], transitionCompleted: false)
        XCTAssertEqual(model.cursor.index, 0)
        XCTAssertNil(model.cursor.proposedIndex)
    }

    @MainActor func testOnePlaybackOwnerAndStaleRelease() {
        let owner = PlaybackOwnership()
        var stopped: [String] = []
        let first = owner.claim { stopped.append("first") }
        let second = owner.claim { stopped.append("second") }
        XCTAssertEqual(stopped, ["first"]); XCTAssertFalse(owner.owns(first)); XCTAssertTrue(owner.owns(second))
        owner.release(first); XCTAssertEqual(stopped, ["first"])
        owner.release(second); XCTAssertEqual(stopped, ["first", "second"])
    }
    @MainActor func testReplacingStoryOwnerAlsoSuspendsOldDirector() throws {
        let journey = try MediaFixtures.journey(), intent = MediaFixtures.intent()
        let owner = PlaybackOwnership()
        let session = ScopedMediaSession(scopeID: "owner", access: .owner,
            read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in Data() }, revalidate: {})
        let first = try StoryModel(journey: journey, intent: intent, session: session, ownership: owner,
            currentIntent: { intent }, latestJourney: { journey }, onReturn: { _ in })
        let second = try StoryModel(journey: journey, intent: intent, session: session, ownership: owner,
            currentIntent: { intent }, latestJourney: { journey }, onReturn: { _ in })
        first.playJourney()
        XCTAssertFalse(first.paused)
        second.foreground.takeOwnership()
        XCTAssertTrue(first.paused)
        XCTAssertEqual(first.playback?.paused, true)
        first.disappear(); second.disappear()
    }
    @MainActor func testTempoChosenBeforePlaybackShapesTheFirstPlanAndCanStillChange() throws {
        let journey = try MediaFixtures.journey(), intent = MediaFixtures.intent()
        let session = ScopedMediaSession(scopeID: "owner", access: .owner,
            read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in Data() }, revalidate: {})
        let model = try StoryModel(journey: journey, intent: intent, session: session, ownership: PlaybackOwnership(),
            currentIntent: { intent }, latestJourney: { journey }, onReturn: { _ in })
        model.changeTempo(.immersive)
        XCTAssertNil(model.playback)
        model.playJourney()
        XCTAssertEqual(model.playback?.beats, JourneyPlaybackPlan.build(journey, tempo: .immersive))
        model.changeTempo(.fast)
        XCTAssertEqual(model.tempo, .fast)
        XCTAssertEqual(model.playback?.beats, JourneyPlaybackPlan.build(journey, tempo: .fast))
        model.disappear()
    }
    func testFullPlanKeepsTransitNoteAndLiteralTempoValues() throws {
        let journey = try MediaFixtures.journey()
        let beats = JourneyPlaybackPlan.build(journey)
        XCTAssertEqual(beats.map(\.id), ["intro", "arrival:point-one", "media:photo-one", "note:point-via", "travel:point-two", "arrival:point-two", "media:video-two", "outro"])
        XCTAssertEqual(NarrativeTiming.duration(.media, tempo: .fast), 1700)
        XCTAssertEqual(NarrativeTiming.duration(.media, tempo: .standard), 2800)
        XCTAssertEqual(NarrativeTiming.duration(.media, tempo: .immersive, video: true), 8000)
        XCTAssertEqual(NarrativeTiming.note("😀"), 3536) // JS counts UTF-16, not Swift Character.
        XCTAssertEqual(NarrativeTiming.note(String(repeating: "字", count: 400)), 9000)
    }
    func testVideoBuffersWithoutSpendingTimeAndTempoKeepsFraction() throws {
        let journey = try MediaFixtures.journey()
        var clock = PlaybackClock(beats: JourneyPlaybackPlan.build(journey))
        clock.tick(milliseconds: 550, mediaReady: true, videoOwnsCompletion: false)
        clock.changeTempo(to: JourneyPlaybackPlan.build(journey, tempo: .fast))
        XCTAssertEqual(clock.elapsedMS, 400)
        clock.seek(6)
        clock.tick(milliseconds: 60_000, mediaReady: false, videoOwnsCompletion: true)
        XCTAssertEqual(clock.index, 6); XCTAssertEqual(clock.elapsedMS, 0)
        clock.tick(milliseconds: 60_000, mediaReady: true, videoOwnsCompletion: true)
        XCTAssertEqual(clock.index, 6)
        clock.advance(); XCTAssertEqual(clock.current?.kind, .outro)
        clock.paused = true; clock.tick(milliseconds: 60_000, mediaReady: true, videoOwnsCompletion: false)
        XCTAssertFalse(clock.completed)
    }
    func testTrimClampsOutPointAndRejectsUnreachableInPoint() {
        XCTAssertEqual(VideoTrim(inMs: 2000, outMs: 8000).resolved(sourceSeconds: 5), 2...5)
        XCTAssertNil(VideoTrim(inMs: 8000, outMs: 9000).resolved(sourceSeconds: 5))
        XCTAssertNil(VideoTrim(inMs: 0, outMs: 100).resolved(sourceSeconds: 5))
        XCTAssertNil(VideoTrim(inMs: 0, outMs: 1000).resolved(sourceSeconds: .infinity))
    }
    func testDuckingUsesCurrentBaselineAndWallTime() {
        XCTAssertEqual(SoundtrackGain.target(baseline: 0.8, audible: true), 0.24, accuracy: 0.001)
        XCTAssertEqual(SoundtrackGain.ramp(from: 0.8, to: 0.24, elapsed: 0.11), 0.52, accuracy: 0.001)
        XCTAssertEqual(SoundtrackGain.ramp(from: 0.24, to: 0.5, elapsed: 0.45), 0.5, accuracy: 0.001)
    }
}
