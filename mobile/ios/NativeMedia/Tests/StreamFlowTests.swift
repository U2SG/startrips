import XCTest
@testable import StartripsMedia

/// 旅程之流 playback: beats map onto rows of the stream and the reading point
/// travels continuously between them (no page-by-page jumps).
final class StreamFlowTests: XCTestCase {
    func testEveryMediaBeatLandsOnItsStreamRowAndIntroStaysAtTheTop() throws {
        let journey = try MediaFixtures.journey()
        let entries = journey.storySequence(includeCover: false)
        let beats = JourneyPlaybackPlan.build(journey)
        for beat in beats where beat.kind == .media {
            let row = try XCTUnwrap(StreamFlow.row(for: beat, in: entries), beat.id)
            XCTAssertEqual(entries[row].asset?.id, beat.asset?.id)
        }
        for beat in beats where beat.asset == nil && beat.routePointId != nil {
            if let row = StreamFlow.row(for: beat, in: entries) {
                let point = beat.routePointId
                XCTAssertTrue(entries[row].routePointId == point || entries[row].chapterRoutePointId == point)
            }
        }
        if let intro = beats.first(where: { $0.kind == .intro }) { XCTAssertNil(StreamFlow.row(for: intro, in: entries)) }
        if let outro = beats.last(where: { $0.kind == .outro }) {
            XCTAssertEqual(StreamFlow.row(for: outro, in: entries), entries.count - 1)
        }
        // The flow always heads to a different row, never to the one being read.
        for index in beats.indices {
            if case .some(let next) = StreamFlow.nextRow(after: index, beats: beats, entries: entries) {
                XCTAssertNotEqual(next, StreamFlow.row(for: beats[index], in: entries))
            }
        }
        XCTAssertNil(StreamFlow.nextRow(after: beats.count, beats: beats, entries: entries))
    }

    func testReadingPointMovesContinuouslyAndArrivesExactlyAtTheNextRow() {
        XCTAssertEqual(StreamFlow.reading(from: 100, to: 500, fraction: 0), 100)
        XCTAssertEqual(StreamFlow.reading(from: 100, to: 500, fraction: 1), 500)
        XCTAssertEqual(StreamFlow.reading(from: 100, to: 500, fraction: 0.5), 300, accuracy: 0.001)
        XCTAssertEqual(StreamFlow.reading(from: 100, to: nil, fraction: 0.7), 100, "the last row holds")
        var previous: CGFloat = 100
        for step in 1...20 {
            let value = StreamFlow.reading(from: 100, to: 500, fraction: Double(step) / 20)
            XCTAssertGreaterThanOrEqual(value, previous, "never runs backwards")
            XCTAssertLessThan(value - previous, 40, "no jump bigger than a smooth step")
            previous = value
        }
        XCTAssertEqual(StreamFlow.ease(-1), 0); XCTAssertEqual(StreamFlow.ease(2), 1)
    }

    func testOffsetKeepsTheReadingLineAndStaysInsideTheContent() {
        XCTAssertEqual(StreamFlow.offset(reading: 1000, viewport: 600, content: 3000), 1000 - 600 * StreamFlow.readingLine)
        XCTAssertEqual(StreamFlow.offset(reading: 50, viewport: 600, content: 3000), 0)
        XCTAssertEqual(StreamFlow.offset(reading: 2950, viewport: 600, content: 3000), 2400)
        XCTAssertEqual(StreamFlow.offset(reading: 200, viewport: 600, content: 300), 0)
    }

    func testSeeksGlideAndReduceMotionSteps() {
        XCTAssertEqual(StreamFlow.glide(from: 0, to: 800, elapsed: 0, reduceMotion: false), 0)
        XCTAssertEqual(StreamFlow.glide(from: 0, to: 800, elapsed: StreamFlow.seekSeconds, reduceMotion: false), 800)
        XCTAssertEqual(StreamFlow.glide(from: 0, to: 800, elapsed: 10, reduceMotion: false), 800)
        let mid = StreamFlow.glide(from: 0, to: 800, elapsed: StreamFlow.seekSeconds / 2, reduceMotion: false)
        XCTAssertTrue(mid > 0 && mid < 800)
        XCTAssertEqual(StreamFlow.glide(from: 0, to: 800, elapsed: 0, reduceMotion: true), 800, "Reduce Motion steps")
    }

    func testLookaheadPrefetchesUpcomingStillsOnly() throws {
        let entries = try MediaFixtures.journey().storySequence(includeCover: false)
        let all = StreamFlow.lookahead(from: nil, entries: entries, count: 99)
        XCTAssertTrue(all.allSatisfy { !$0.isVideo && $0.isVisual })
        XCTAssertEqual(all.map(\.id), entries.compactMap(\.asset).filter { !$0.isVideo }.map(\.id))
        XCTAssertEqual(StreamFlow.lookahead(from: nil, entries: entries, count: 1).count, min(1, all.count))
        let last = entries.count - 1
        XCTAssertEqual(StreamFlow.lookahead(from: last, entries: entries).map(\.id),
                       [entries[last].asset].compactMap { $0 }.filter { !$0.isVideo }.map(\.id))
        XCTAssertTrue(StreamFlow.lookahead(from: entries.count, entries: entries).isEmpty)
    }

    func testPerFrameExtrapolationIsBoundedAndHoldsForAWaitingClock() {
        // Between 50ms clock samples the flow advances with the display...
        XCTAssertEqual(StreamFlow.elapsed(sampled: 1000, sinceSampleMS: 16, duration: 4000, paused: false), 1016)
        // ...but never more than maxLead ahead of a clock that is waiting for a picture.
        XCTAssertEqual(StreamFlow.elapsed(sampled: 1000, sinceSampleMS: 900, duration: 4000, paused: false),
                       1000 + StreamFlow.maxLeadMS)
        XCTAssertEqual(StreamFlow.elapsed(sampled: 3990, sinceSampleMS: 100, duration: 4000, paused: false), 4000)
        XCTAssertEqual(StreamFlow.elapsed(sampled: 1000, sinceSampleMS: 500, duration: 4000, paused: true), 1000)
        XCTAssertEqual(StreamFlow.elapsed(sampled: 1000, sinceSampleMS: -5, duration: 4000, paused: false), 1000)
        // Successive display frames never move the reading point backwards within a beat.
        var last: CGFloat = 0
        for frame in 0...120 {
            let elapsed = StreamFlow.elapsed(sampled: Double(frame / 3) * 50, sinceSampleMS: Double(frame % 3) * 16.7,
                                             duration: 2000, paused: false)
            let reading = StreamFlow.reading(from: 0, to: 600, fraction: elapsed / 2000)
            XCTAssertGreaterThanOrEqual(reading, last - 0.001)
            last = reading
        }
    }

    // MARK: Even flow and time-based prefetch

    func testTimeLookaheadIsNearestFirstAndCoversTheHorizon() throws {
        let journey = try MediaFixtures.journey()
        let beats = JourneyPlaybackPlan.build(journey)
        let starts = StreamFlow.beatStarts(beats)
        XCTAssertEqual(starts.first, 0)
        XCTAssertTrue(zip(starts, starts.dropFirst()).allSatisfy { $0 <= $1 })
        let ahead = StreamFlow.lookahead(beats: beats, index: 0, elapsedMS: 0, horizonMS: .infinity, minimum: 0, maximum: 99)
        // Videos are included: their poster is prefetched like a picture.
        let expected = beats.compactMap(\.asset).filter { $0.isVisual }
            .reduce(into: [MediaAsset]()) { list, asset in if !list.contains(where: { $0.id == asset.id }) { list.append(asset) } }
        XCTAssertEqual(ahead.map(\.id), expected.map(\.id), "in playback order, nearest first, no duplicates")
        XCTAssertEqual(ahead.contains(where: \.isVideo), expected.contains(where: \.isVideo))
        // A zero horizon still keeps the minimum; the maximum bounds memory.
        XCTAssertEqual(StreamFlow.lookahead(beats: beats, index: 0, elapsedMS: 0, horizonMS: 0, minimum: 1, maximum: 9).count,
                       min(1, expected.count))
        XCTAssertLessThanOrEqual(StreamFlow.lookahead(beats: beats, index: 0, elapsedMS: 0, maximum: 1).count, 1)
        XCTAssertTrue(StreamFlow.lookahead(beats: beats, index: beats.count, elapsedMS: 0).isEmpty)
    }

    func testKnotsMakeSharedRowsOneRunAndHitEveryRowWhenItsFirstBeatStarts() throws {
        let journey = try MediaFixtures.journey()
        let entries = journey.storySequence(includeCover: false)
        let beats = JourneyPlaybackPlan.build(journey)
        let starts = StreamFlow.beatStarts(beats)
        let rows = beats.map { StreamFlow.row(for: $0, in: entries) }
        let knots = StreamFlow.knots(index: 0, beats: beats, entries: entries, count: 99) { row in CGFloat((row ?? -1) + 1) * 500 }
        XCTAssertFalse(knots.isEmpty)
        XCTAssertTrue(zip(knots, knots.dropFirst()).allSatisfy { $0.time < $1.time }, "one knot per run")
        for knot in knots {
            let beat = try XCTUnwrap(starts.firstIndex(of: knot.time))
            XCTAssertTrue(beat == 0 || rows[beat - 1] != rows[beat], "a knot opens a run")
        }
        // Mid-run, the knots still start at the run's first beat.
        if let shared = rows.indices.dropFirst().first(where: { rows[$0] == rows[$0 - 1] }) {
            let mid = StreamFlow.knots(index: shared, beats: beats, entries: entries) { row in CGFloat((row ?? -1) + 1) * 500 }
            XCTAssertLessThan(try XCTUnwrap(mid.first).time, starts[shared])
        }
        // Unknown rows end the list instead of inventing a target.
        XCTAssertEqual(StreamFlow.knots(index: 0, beats: beats, entries: entries) { _ in nil }, [])
        // Linear between knots, holding at both ends.
        let line = [StreamFlow.Knot(time: 0, y: 0), StreamFlow.Knot(time: 1000, y: 800)]
        XCTAssertEqual(StreamFlow.scheduled(line, at: -5), 0)
        XCTAssertEqual(StreamFlow.scheduled(line, at: 250), 200)
        XCTAssertEqual(StreamFlow.scheduled(line, at: 5000), 800)
        XCTAssertNil(StreamFlow.scheduled([], at: 0))
    }

    /// A tall photo after a short note: speeds differ 10x between runs. The follower must keep
    /// acceleration bounded, never stop while the schedule moves, and pass each row on time.
    func testFollowerIsEvenBoundedAndOnSchedule() {
        let knots = [StreamFlow.Knot(time: 0, y: 0), .init(time: 4000, y: 150), .init(time: 7000, y: 1600),
                     .init(time: 9000, y: 1750), .init(time: 14000, y: 3300), .init(time: 20000, y: 3400)]
        var follower = StreamFollower(position: 0)
        let dt = 1.0 / 60
        var previousVelocity: CGFloat = 0
        var maxAcceleration: CGFloat = 0
        var stoppedFrames = 0
        var worstMiss: CGFloat = 0
        var time = 0.0
        while time < 20000 {
            let ahead = StreamFlow.scheduled(knots, at: time + StreamFollower.lead * 1000)!
            follower.step(ahead: ahead, dt: dt)
            maxAcceleration = max(maxAcceleration, abs(follower.velocity - previousVelocity) / CGFloat(dt))
            previousVelocity = follower.velocity
            if time > 500 && time < 19_000 && follower.velocity < 1 { stoppedFrames += 1 }
            if let knot = knots.first(where: { abs($0.time - time) < 8 }) { worstMiss = max(worstMiss, abs(follower.position - knot.y)) }
            time += dt * 1000
        }
        XCTAssertLessThanOrEqual(maxAcceleration, StreamFollower.maxAcceleration + 1)
        XCTAssertEqual(stoppedFrames, 0, "a dwell is a slow drift, never a stop")
        XCTAssertLessThan(worstMiss, 160, "each row is reached on schedule within tolerance")
        XCTAssertLessThanOrEqual(follower.velocity, StreamFollower.maxSpeed)
        // Playing never runs back up the thread; a seek may (catch-up).
        var forward = StreamFollower(position: 500)
        forward.step(ahead: 0, dt: dt)
        XCTAssertGreaterThanOrEqual(forward.velocity, 0)
        var seek = StreamFollower(position: 5000)
        seek.step(ahead: 0, dt: dt, catchUp: true)
        XCTAssertLessThan(seek.velocity, 0)
    }

    // MARK: Geometry-stable targets (owner feedback: "乱转")

    func testNearKnotsOnlyTrustLaidOutRowsAndNeverInventAPositionAbove() throws {
        let journey = try MediaFixtures.journey()
        let entries = journey.storySequence(includeCover: false)
        let beats = JourneyPlaybackPlan.build(journey)
        let rows = beats.map { StreamFlow.row(for: $0, in: entries) }
        guard let index = rows.firstIndex(where: { $0 != nil }), let here = rows[index] else { return }
        // Only the current row is laid out: it anchors itself, the next row sits right after it.
        var frames = [ClosedRange<CGFloat>?](repeating: nil, count: entries.count)
        frames[here] = 1000...1600
        let knots = StreamFlow.nearKnots(index: index, beats: beats, entries: entries, frames: frames, spacing: 20)
        XCTAssertEqual(knots.first?.y, 1000)
        if knots.count > 1, case .some(.some(let next)) = StreamFlow.nextRow(after: index, beats: beats, entries: entries),
           next == here + 1 {
            XCTAssertEqual(knots[1].y, 1620, "the next row starts right after the current one")
        }
        XCTAssertLessThanOrEqual(knots.count, 2, "never anchors on rows far down the stream")
        // A row that was dropped by LazyVStack (no frame) and lies above everything laid out: no target, hold.
        var later = [ClosedRange<CGFloat>?](repeating: nil, count: entries.count)
        later[entries.count - 1] = 9000...9500
        if here < entries.count - 1 {
            XCTAssertTrue(StreamFlow.nearKnots(index: index, beats: beats, entries: entries, frames: later, spacing: 20).isEmpty)
        }
    }

    /// Targets revised mid-playback (an estimate replaced by a measured frame, a row above
    /// growing) must never move the reading point back up while playing.
    func testFollowerStaysMonotonicWhenTheTargetIsRevised() {
        var follower = StreamFollower(position: 1000)
        var last = follower.position
        let targets: [CGFloat] = Array(repeating: 1400, count: 60) + Array(repeating: 600, count: 60)
            + Array(repeating: 5000, count: 60) + Array(repeating: 200, count: 60)
        for target in targets {
            follower.step(ahead: target, dt: 1.0 / 60)
            XCTAssertGreaterThanOrEqual(follower.position, last - 0.0001)
            XCTAssertLessThanOrEqual(follower.velocity, StreamFollower.maxSpeed)
            last = follower.position
        }
    }

    // MARK: Videos, tempo and relayout

    /// A video beat's clock holds (the clip owns completion); the stream follows the clip instead.
    func testVideoBeatsFlowWithTheClipNotTheHeldClock() {
        XCTAssertEqual(StreamFlow.videoSchedule(beatStartMS: 10_000, durationMS: 6000, progress: 0.5, sampledMS: 10_000), 13_000)
        XCTAssertEqual(StreamFlow.videoSchedule(beatStartMS: 10_000, durationMS: 6000, progress: 1.4, sampledMS: 10_000), 16_000)
        XCTAssertEqual(StreamFlow.videoSchedule(beatStartMS: 10_000, durationMS: 6000, progress: nil, sampledMS: 10_000), 10_000,
                       "not started yet: hold at the row")
        XCTAssertEqual(StreamFlow.videoSchedule(beatStartMS: 10_000, durationMS: 6000, progress: .nan, sampledMS: 10_000), 10_000)
    }

    /// 沉浸 < 标准 < 轻快 in speed: the same rows are crossed over proportionally longer/shorter
    /// timelines, and a mid-run change keeps the beat and its progress (no jump).
    func testTempoScalesTheTimelineAndKeepsPositionWhenChanged() throws {
        let journey = try MediaFixtures.journey()
        func total(_ tempo: NarrativeTempo) -> Double {
            JourneyPlaybackPlan.build(journey, tempo: tempo).reduce(0) { $0 + $1.durationMS }
        }
        XCTAssertGreaterThan(total(.immersive), total(.standard))
        XCTAssertGreaterThan(total(.standard), total(.fast))
        var clock = PlaybackClock(beats: JourneyPlaybackPlan.build(journey, tempo: .standard))
        clock.tick(milliseconds: 300, mediaReady: true, videoOwnsCompletion: false)
        let beat = clock.index, fraction = clock.elapsedMS / (clock.current?.durationMS ?? 1)
        clock.changeTempo(to: JourneyPlaybackPlan.build(journey, tempo: .fast))
        XCTAssertEqual(clock.index, beat)
        XCTAssertEqual(clock.elapsedMS / (clock.current?.durationMS ?? 1), fraction, accuracy: 0.0001)
        // The follower absorbs whatever small target change remains, with bounded acceleration.
        var follower = StreamFollower(position: 400, velocity: 200)
        follower.step(ahead: 400 + 0.6 * 600, dt: 1.0 / 60)   // faster schedule: speeds up gradually
        XCTAssertLessThanOrEqual(follower.velocity - 200, StreamFollower.maxAcceleration / 60 + 0.001)
        XCTAssertGreaterThan(follower.velocity, 200)
    }

    func testRelayoutShiftMovesWithTheContent() {
        var follower = StreamFollower(position: 1000, velocity: 120)
        follower.shift(by: -340)
        XCTAssertEqual(follower.position, 660)
        XCTAssertEqual(follower.velocity, 120, "a relayout is not motion")
    }
}
