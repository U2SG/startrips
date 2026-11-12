import XCTest

/// Native Story presentation styles (默认 / 图上感想 / 旅程之书 / 旅程之流) with screenshot evidence.
final class StoryPresentationUITests: XCTestCase {
    @MainActor
    func testNativeStoryPresentationStyles() throws {
        continueAfterFailure = false
        addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        XCTAssertTrue(card(app).waitForExistence(timeout: 30))
        choosePoint(app, "point-a")
        let story = openCard(app)
        XCTAssertEqual(story.label, "打开故事：起点")
        story.tap()
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
        assertStoryChromeIsCentred(app)
        let style = app.buttons["story.style"]
        XCTAssertEqual(style.label, "展示方式")
        XCTAssertEqual(style.value as? String, "默认")

        let photo = element(app, "story.photo.media:asset-fixture")
        XCTAssertTrue(photo.waitForExistence(timeout: 10))
        let note = app.staticTexts["Synthetic bridge fixture"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        XCTAssertFalse(photo.frame.intersects(note.frame), "默认 keeps the note below the picture")
        capture(app, "story-style-classic")

        choose(app, "图上感想")
        XCTAssertTrue(element(app, "story.overlay").waitForExistence(timeout: 10))
        XCTAssertTrue(photo.waitForExistence(timeout: 10))
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        XCTAssertTrue(photo.frame.intersects(note.frame), "图上感想 lays the note on the picture")
        capture(app, "story-style-note-overlay")

        choose(app, "旅程之书")
        let opened = element(app, "story.book.media:asset-fixture")
        XCTAssertTrue(opened.waitForExistence(timeout: 10))
        XCTAssertTrue(app.images["synthetic.jpg"].waitForExistence(timeout: 10))
        capture(app, "story-style-book")
        app.buttons["story.next"].tap()
        XCTAssertTrue(element(app, "story.book.media:asset-second").waitForExistence(timeout: 10))
        app.buttons["story.previous"].tap()
        XCTAssertTrue(opened.waitForExistence(timeout: 10))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(opened.waitForExistence(timeout: 10))
        capture(app, "story-style-book-landscape", screen: true)
        XCUIDevice.shared.orientation = .portrait

        choose(app, "旅程之流")
        let streamed = element(app, "story.stream.media:asset-fixture")
        XCTAssertTrue(streamed.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["story.next"].exists)
        // One thread down the centre, running through every picture (web journey-stream).
        let thread = element(app, "story.stream.thread")
        XCTAssertTrue(thread.waitForExistence(timeout: 10))
        XCTAssertEqual(thread.frame.midX, app.windows.firstMatch.frame.midX, accuracy: 1)
        XCTAssertLessThanOrEqual(thread.frame.minY, streamed.frame.minY)
        XCTAssertGreaterThanOrEqual(thread.frame.maxY, streamed.frame.maxY)

        // Play flows down the stream itself: no pager, the content keeps moving, pause freezes it.
        app.buttons["story.play"].tap()
        XCTAssertTrue(app.buttons["story.pause"].waitForExistence(timeout: 5))
        var samples: [CGFloat] = []
        for _ in 0..<16 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            XCTAssertTrue(element(app, "story.stream").exists, "the stream stays on screen while playing")
            XCTAssertFalse(element(app, "story.photo.media:asset-fixture").exists, "no page-by-page player")
            samples.append(thread.frame.minY)
        }
        XCTAssertGreaterThan((samples.max() ?? 0) - (samples.min() ?? 0), 40, "the stream flows while playing")
        capture(app, "story-style-stream-playing")
        app.buttons["story.pause"].tap()
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        let frozen = thread.frame.minY
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        XCTAssertEqual(thread.frame.minY, frozen, accuracy: 1, "pause freezes the flow")
        // The first close ends playback and stays in Story, as in every style.
        app.buttons["story.close"].tap()
        XCTAssertTrue(app.buttons["story.play"].waitForExistence(timeout: 5))
        capture(app, "story-style-stream")

        // The choice is remembered: closing and reopening the Story keeps the stream.
        app.buttons["story.close"].tap()
        XCTAssertTrue(card(app).waitForExistence(timeout: 10))
        choosePoint(app, "point-a")
        openCard(app).tap()
        XCTAssertTrue(element(app, "story.stream").waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["story.style"].value as? String, "旅程之流")
        choose(app, "默认")
        XCTAssertTrue(photo.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["story.next"].exists)
    }

    /// Title and play sit on the screen axis; the header's outer icons mirror each other.
    @MainActor private func assertStoryChromeIsCentred(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let window = app.windows.firstMatch.frame
        let title = app.staticTexts["story.title"].frame
        let play = app.buttons["story.play"].frame
        let close = app.buttons["story.close"].frame
        let expand = app.buttons["story.expand"].frame
        XCTAssertEqual(title.midX, window.midX, accuracy: 1, "title is centred", file: file, line: line)
        XCTAssertEqual(play.midX, window.midX, accuracy: 1, "play is centred", file: file, line: line)
        XCTAssertEqual(close.minX - window.minX, window.maxX - expand.maxX, accuracy: 1, "header slots mirror", file: file, line: line)
        for frame in [play, close, expand, app.buttons["story.previous"].frame, app.buttons["story.next"].frame] {
            XCTAssertGreaterThanOrEqual(min(frame.width, frame.height), 44, file: file, line: line)
        }
        XCTAssertEqual(app.buttons["story.previous"].frame.minX - window.minX,
                       window.maxX - app.buttons["story.next"].frame.maxX, accuracy: 1, "controls mirror", file: file, line: line)
    }

    @MainActor private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @MainActor private func choose(_ app: XCUIApplication, _ label: String) {
        // A SwiftUI Menu label rejects XCUITest's scroll-to-visible AX action; tap its frame instead.
        let control = app.buttons["story.style"]
        XCTAssertTrue(control.waitForExistence(timeout: 5))
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        // Menu items live outside the Atlas web view, which may reuse the same labels.
        let menuItem = app.collectionViews.buttons[label]
        let item = menuItem.waitForExistence(timeout: 5) ? menuItem
            : app.buttons.matching(NSPredicate(format: "label == %@ AND elementType != %d", label,
                                               XCUIElement.ElementType.link.rawValue)).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5), "Missing style \(label)")
        item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["story.style"].waitForExistence(timeout: 5))
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String, screen: Bool = false) {
        let attachment = XCTAttachment(screenshot: screen ? XCUIScreen.main.screenshot() : app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
