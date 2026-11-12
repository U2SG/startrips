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
}
