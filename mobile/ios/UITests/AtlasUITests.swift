import XCTest

final class AtlasUITests: XCTestCase {
    @MainActor
    func testGlobePointSelectionAndStoryRoundTrip() async throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        XCTAssertTrue(app.navigationBars["图谱"].waitForExistence(timeout: 20))
        let timeline = app.webViews.buttons["打开旅程：海岸旅程"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 30))
        timeline.tap()
        let storyTitle = app.staticTexts["story.title"]
        XCTAssertTrue(storyTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(storyTitle.label, "海岸旅程")
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
        app.buttons["story.close"].tap()
        let start = app.webViews.switches["起点"]
        XCTAssertTrue(start.waitForExistence(timeout: 10)); start.tap()
        let coast = app.webViews.switches["海岸"]
        XCTAssertTrue(coast.waitForExistence(timeout: 10)); coast.tap()
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForExistence(timeout: 30))
        let count = app.staticTexts["atlas.focus.count"]
        let beforeDrag = try XCTUnwrap(Int(count.label))
        XCTAssertGreaterThan(beforeDrag, 0)
        let earth = app.webViews.firstMatch
        earth.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.28))
            .press(forDuration: 0.1, thenDragTo: earth.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.35)))
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForNonExistence(timeout: 5))
        // Every acknowledged focus transition is counted, including one that would
        // finish and disappear between snapshots. Leave the real idle timer alone.
        try await Task.sleep(for: .seconds(22))
        XCTAssertEqual(Int(count.label), beforeDrag)
        XCTAssertFalse(app.staticTexts["earth-rendered"].exists)
        coast.tap()
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForExistence(timeout: 30))
        XCTAssertGreaterThan(try XCTUnwrap(Int(count.label)), beforeDrag)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "production-globe-after-consecutive-selection"; screenshot.lifetime = .keepAlways
        add(screenshot)
        let cursor = app.webViews.sliders["时间轴"]
        XCTAssertTrue(cursor.waitForExistence(timeout: 10))
        let center = cursor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 0.1, thenDragTo: cursor.coordinate(withNormalizedOffset: CGVector(dx: -0.03, dy: 0.5)))
        XCTAssertTrue(app.webViews.buttons["打开故事：起点"].waitForExistence(timeout: 10))
        center.press(forDuration: 0.1, thenDragTo: cursor.coordinate(withNormalizedOffset: CGVector(dx: 1.03, dy: 0.5)))
        let coastStory = app.webViews.buttons["打开故事：海岸"]
        XCTAssertTrue(coastStory.waitForExistence(timeout: 10))
        coastStory.tap()
        XCTAssertTrue(storyTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(storyTitle.label, "海岸旅程")
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
        app.buttons["story.close"].tap()
        XCTAssertTrue(app.webViews.switches["海岸"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.navigationBars["图谱"].waitForExistence(timeout: 10))
        verifyNativeMediaRoundTrip(in: app)
    }
}
