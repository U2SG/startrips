import XCTest

/// Native Journey create/edit on the synthetic Atlas (in-memory store, no network).
final class JourneyComposerUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    @MainActor
    func testEmptyAtlasCreatesTheFirstJourney() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture", "-atlas-empty-fixture"]
        app.launch()
        let createFirst = app.buttons["atlas.create-first"]
        XCTAssertTrue(createFirst.waitForExistence(timeout: 30))
        XCTAssertFalse(card(app).exists)
        attach(app, "composer-empty-atlas")
        createFirst.tap()

        let title = app.textFields["composer.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        let save = app.buttons["composer.save"]
        // Without a Route Point the server would refuse the Journey; the form says so first.
        title.tap()
        title.typeText("Kyoto Spring\n")
        save.tap()
        XCTAssertTrue(app.staticTexts["composer.error"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["composer.error"].label, "路线必须包含 1 到 64 个点")

        app.buttons["composer.add-point"].tap()
        let search = app.textFields["composer.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("Kyoto\n")
        let kyoto = app.buttons["composer.place.fixture-kyoto"]
        XCTAssertTrue(kyoto.waitForExistence(timeout: 10))
        attach(app, "composer-place-search")
        kyoto.tap()
        XCTAssertEqual(app.textFields["composer.point-label"].value as? String, "京都")
        app.buttons["composer.point-done"].tap()

        let point = app.buttons["composer.point.0"]
        XCTAssertTrue(point.waitForExistence(timeout: 10))
        XCTAssertEqual(point.label, "停靠点：京都")
        attach(app, "composer-create")
        save.tap()

        // The sheet closes and the new Journey is the Atlas's card.
        XCTAssertTrue(title.waitForNonExistence(timeout: 10))
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 15))
        XCTAssertTrue(waitForLabel(peek, "旅程：Kyoto Spring"))
        XCTAssertFalse(app.buttons["atlas.create-first"].exists)
        XCTAssertTrue(app.buttons["atlas.compose"].exists, "the shell keeps a create entry")
        attach(app, "composer-created-card")
    }

    @MainActor
    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
