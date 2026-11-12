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
        openStory(app)
        let chip = app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        let point = app.webViews.switches["起点"]
        let story = app.webViews.buttons["打开故事：起点"].firstMatch
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
        XCTAssertTrue(element(app, "story.stream.media:asset-fixture").waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["story.next"].exists)
        capture(app, "story-style-stream")

        // The choice is remembered: closing and reopening the Story keeps the stream.
        app.buttons["story.close"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        chip.tap()
        XCTAssertTrue(point.waitForExistence(timeout: 10))
        point.tap()
        chip.tap()
        XCTAssertTrue(story.waitForExistence(timeout: 10))
        story.tap()
        XCTAssertTrue(element(app, "story.stream").waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["story.style"].value as? String, "旅程之流")
        choose(app, "默认")
        XCTAssertTrue(photo.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["story.next"].exists)
    }

    @MainActor
    func test3DBookLoadsGuestPicturesAndReturnsToTurnedPage() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture", "-atlas-guest-fixture"]
        app.launch()
        openStory(app)
        choose(app, "立体之书")
        XCTAssertFalse(app.buttons["story.tools"].exists)
        let book = app.webViews.containing(.button, identifier: "目录").firstMatch
        let next = book.buttons["下一页"]
        XCTAssertTrue(next.waitForExistence(timeout: 20), "The bundled book must open before loading pictures")
        let first = book.images["synthetic.jpg"].firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        capture(app, "story-style-3d-book")
        next.tap()
        let second = book.images["second.png"].firstMatch
        XCTAssertTrue(second.waitForExistence(timeout: 10))

        XCUIDevice.shared.orientation = .landscapeLeft
        let deadline = Date().addingTimeInterval(10)
        while app.frame.width <= app.frame.height && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        XCTAssertGreaterThan(app.frame.width, app.frame.height)
        XCTAssertTrue(second.exists)
        capture(app, "story-style-3d-book-landscape", screen: true)

        XCUIDevice.shared.orientation = .portrait
        app.buttons["story.close"].tap()
        let selection = app.staticTexts["atlas.selection.asset"]
        XCTAssertTrue(selection.waitForExistence(timeout: 10))
        XCTAssertEqual(selection.label, "asset-second")
    }

    @MainActor private func openStory(_ app: XCUIApplication) {
        let chip = app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        XCTAssertTrue(chip.waitForExistence(timeout: 30))
        chip.tap()
        let point = app.webViews.switches["起点"]
        XCTAssertTrue(point.waitForExistence(timeout: 10))
        point.tap()
        chip.tap()
        let story = app.webViews.buttons["打开故事：起点"].firstMatch
        XCTAssertTrue(story.waitForExistence(timeout: 10))
        story.tap()
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
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
