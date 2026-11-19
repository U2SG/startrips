import XCTest
@testable import StartripsMedia

final class StoryPresentationTests: XCTestCase {
    func testBookPagesFollowWebComposition() throws {
        let journey = try MediaFixtures.journey()
        let pages = journey.bookPages()
        // Journey note gets its own page after the cover; a note-only via point and a
        // video-first point get note pages; odd interior needs no blank before the end.
        XCTAssertEqual(pages.map(\.id), ["cover", "note:journey", "media:intro-photo", "media:photo-one",
                                         "note:point-via", "note:point-two", "media:video-two", "end"])
        XCTAssertEqual(pages[0].asset?.id, "photo-one")
        guard case .media(_, _, let overlaid) = pages[3], case .media(_, _, let videoNote) = pages[6] else {
            return XCTFail("Expected media pages")
        }
        XCTAssertEqual(overlaid, "海边")
        XCTAssertNil(videoNote)
    }

    func testLongNoteGetsItsOwnPageAndParityBlank() throws {
        var journey = try MediaFixtures.journey()
        journey.routePoints[0].note = String(repeating: "海", count: 91)
        let pages = journey.bookPages()
        XCTAssertEqual(pages.map(\.id), ["cover", "note:journey", "media:intro-photo", "note:point-one", "media:photo-one",
                                         "note:point-via", "note:point-two", "media:video-two", "blank", "end"])
        // UTF-16 length, as on the web: 45 surrogate-pair emoji are 90 units and stay overlaid.
        journey.routePoints[0].note = String(repeating: "🌊", count: 45)
        XCTAssertFalse(journey.bookPages().map(\.id).contains("note:point-one"))
    }

    func testBookStartPagePrefersAssetThenPoint() throws {
        let pages = try MediaFixtures.journey().bookPages()
        XCTAssertEqual(storyBookStartPage(pages, assetID: "video-two", routePointID: "point-one"), 6)
        XCTAssertEqual(storyBookStartPage(pages, assetID: nil, routePointID: "point-two"), 5)
        XCTAssertEqual(storyBookStartPage(pages, assetID: "missing", routePointID: nil), 0)
    }

    func testUnknownStoredStyleOpensDefaultStory() {
        XCTAssertEqual(StoryPresentationStyle.allCases.map(\.label), ["默认", "图上感想", "旅程之书", "立体之书", "旅程之流"])
        XCTAssertEqual(StoryPresentationStyle(stored: "note-overlay"), .noteOverlay)
        XCTAssertEqual(StoryPresentationStyle(stored: "book-3d"), .book3D)
        XCTAssertEqual(StoryPresentationStyle(stored: "unknown"), .classic)
    }

    func testJournalEnvelopeDecodes() throws {
        let json = #"{"journal":{"revision":2,"chapters":[{"id":"c1","date":"2026-05-01","title":"海边","source":"s","events":[{"id":"e1","source":"s","text":"看海","status":"actual","localDate":null,"localTime":"09:00","timeContext":"","routePointId":null,"mediaIds":[],"edited":false}],"suggestions":[]}]}}"#
        let chapters = try JSONDecoder().decode(StoryJournalChapter.Envelope.self, from: Data(json.utf8)).journal.chapters
        XCTAssertEqual(chapters.first?.events.first?.text, "看海")
    }
}
