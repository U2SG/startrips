import XCTest

extension AtlasUITests {
    // Continue from the same live Atlas, after its initial Story round trip and foreground restore.
    @MainActor func verifyNativeMediaRoundTrip(in app: XCUIApplication) {
        let point = app.webViews.switches["起点"]
        XCTAssertTrue(point.waitForExistence(timeout: 10))
        point.tap()
        app.webViews.buttons["打开故事：起点"].firstMatch.tap()
        let close = app.buttons["story.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["story.title"].label, "海岸旅程")

        let first = app.descendants(matching: .any).matching(identifier: "story.photo.media:asset-fixture").firstMatch
        let second = app.descendants(matching: .any).matching(identifier: "story.photo.media:asset-second").firstMatch
        let cover = app.descendants(matching: .any)
            .matching(identifier: "story.photo.journey-cover:journey-fixture:asset-fixture").firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertFalse(cover.exists)
        let center = first.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.50))
        center.press(forDuration: 0.05, thenDragTo: first.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.50)),
                     withVelocity: .slow, thenHoldForDuration: 0.5)
        // The source asset is also the Journey cover. Only the fully committed
        // logical entry is exposed; a mistaken turn to the cover cannot pass.
        XCTAssertTrue(first.isHittable)
        XCTAssertFalse(cover.exists)
        first.swipeLeft()
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertTrue(second.isHittable)
        XCTAssertFalse(first.exists)
        app.buttons["story.previous"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        app.buttons["story.play"].tap()
        XCTAssertTrue(app.buttons["story.pause"].waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(app.buttons["story.play"].waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(point.waitForExistence(timeout: 10))
    }
}
