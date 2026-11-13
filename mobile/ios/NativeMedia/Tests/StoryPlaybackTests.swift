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
    @MainActor func testLeavingTheStreamMidPlaybackLoadsTheCurrentPicture() async throws {
        let journey = try MediaFixtures.journey(), intent = MediaFixtures.intent()
        let model = try StoryModel(journey: journey, intent: intent, session: StubPictures.session(), ownership: PlaybackOwnership(),
            currentIntent: { intent }, latestJourney: { journey }, onReturn: { _ in })
        defer { model.disappear() }
        model.streamPlayback = true
        model.playJourney()
        for _ in 0..<6 where model.activeAsset?.id != "photo-one" { model.skip(1) }
        XCTAssertEqual(model.activeAsset?.id, "photo-one")
        // The stream asked for its library copy and its row went away before it arrived.
        try await waitFor { StubPictures.requested.contains("photo-one") }
        model.cancelLibraryImage("photo-one")
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertNil(model.image(for: "photo-one"), "the cancelled stream read never lands")
        model.setPaused(true)
        model.streamPlayback = false   // 旅程之流 → 默认 while paused
        try await waitFor { model.image(for: "photo-one") != nil }
        model.streamPlayback = true    // and back: the stream reads the same picture
        XCTAssertNotNil(model.image(for: "photo-one"))
    }
    @MainActor func testTappingAnotherClipSeeksPlaybackAndPlaysItEvenWhenPaused() throws {
        let journey = try MediaFixtures.journey(), intent = MediaFixtures.intent()
        let session = ScopedMediaSession(scopeID: "owner", access: .owner,
            read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in Data() }, revalidate: {})
        let model = try StoryModel(journey: journey, intent: intent, session: session, ownership: PlaybackOwnership(),
            currentIntent: { intent }, latestJourney: { journey }, onReturn: { _ in })
        defer { model.disappear() }
        model.playJourney()
        model.setPaused(true)
        let clip = try XCTUnwrap(model.cursor.entries.firstIndex { $0.asset?.id == "video-two" })
        XCTAssertEqual(model.playback?.beatIndex(for: "video-two"), 6)
        model.play(entry: clip)
        XCTAssertEqual(model.playback?.current?.asset?.id, "video-two")
        XCTAssertEqual(model.activeAsset?.id, "video-two")
        XCTAssertFalse(model.paused)
        XCTAssertEqual(model.playback?.paused, false)
    }
    func testClockTicksAreNotViewChangesButBeatsPausesAndTempoAre() throws {
        let journey = try MediaFixtures.journey()
        let clock = PlaybackClock(beats: JourneyPlaybackPlan.build(journey))
        var ticked = clock
        ticked.tick(milliseconds: 50, mediaReady: true, videoOwnsCompletion: false)
        XCTAssertNotEqual(ticked.elapsedMS, clock.elapsedMS)
        XCTAssertTrue(PlaybackClock.sameForViews(clock, ticked), "a 50ms tick never re-renders the Story")
        var advanced = clock; advanced.advance()
        XCTAssertFalse(PlaybackClock.sameForViews(clock, advanced))
        var paused = clock; paused.paused = true
        XCTAssertFalse(PlaybackClock.sameForViews(clock, paused))
        var faster = clock; faster.changeTempo(to: JourneyPlaybackPlan.build(journey, tempo: .fast))
        XCTAssertFalse(PlaybackClock.sameForViews(clock, faster))
        XCTAssertFalse(PlaybackClock.sameForViews(nil, clock))
        XCTAssertTrue(PlaybackClock.sameForViews(nil, nil))
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

/// Serves a small PNG for every https://media.test read, so model image loads run without a network.
final class StubPictures: URLProtocol {
    static let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 3)).pngData { context in
        UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 4, height: 3))
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "media.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    nonisolated(unsafe) static var requested: Set<String> = []
    override func startLoading() {
        Self.requested.insert(request.url!.lastPathComponent)
        // Answer a little later, so a test can cancel a read while it is in flight.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [self] in self.answer() }
    }
    private func answer() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.png)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    @MainActor static func session() -> ScopedMediaSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubPictures.self]
        return ScopedMediaSession(scopeID: "owner", access: .owner, imageTransport: URLSession(configuration: configuration),
            read: { URL(string: "https://media.test/" + $0)! }, request: { _, _, _ in Data() }, revalidate: {})
    }
}

@MainActor func waitFor(timeout: TimeInterval = 3, _ condition: () -> Bool,
                        file: StaticString = #filePath, line: UInt = #line) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    XCTAssertTrue(condition(), "condition not met in \(timeout)s", file: file, line: line)
}
