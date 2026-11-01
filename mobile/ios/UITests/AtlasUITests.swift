import XCTest

final class AtlasUITests: XCTestCase {
    @MainActor
    func testGlobePointSelectionAndStoryRoundTrip() {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        XCTAssertTrue(app.navigationBars["图谱"].waitForExistence(timeout: 20))
        let timeline = app.webViews.buttons["打开旅程：海岸旅程"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 30))
        timeline.tap()
        XCTAssertTrue(app.otherElements["story-handoff"].waitForExistence(timeout: 10))
        app.buttons["return-to-atlas"].tap()
        let start = app.webViews.buttons["起点"]
        XCTAssertTrue(start.waitForExistence(timeout: 10)); start.tap()
        let coast = app.webViews.buttons["海岸"]
        XCTAssertTrue(coast.waitForExistence(timeout: 10)); coast.tap()
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForExistence(timeout: 30))
        let earth = app.webViews.firstMatch
        earth.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.28))
            .press(forDuration: 0.1, thenDragTo: earth.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.35)))
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForNonExistence(timeout: 5))
        // Production gesture interruption and the approximately 20-second return.
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForExistence(timeout: 35))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "production-globe-after-consecutive-selection"; screenshot.lifetime = .keepAlways
        add(screenshot)
        app.webViews.buttons["打开故事"].firstMatch.tap()
        XCTAssertTrue(app.otherElements["story-handoff"].waitForExistence(timeout: 10))
        app.buttons["return-to-atlas"].tap()
        XCTAssertTrue(app.webViews.buttons["海岸"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.navigationBars["图谱"].waitForExistence(timeout: 10))
    }
}
