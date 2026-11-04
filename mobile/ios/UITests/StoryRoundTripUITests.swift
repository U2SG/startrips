import XCTest

extension AtlasUITests {
    // Continue from the same live Atlas, after its initial Story round trip and foreground restore.
    @MainActor func verifyNativeMediaRoundTrip(in app: XCUIApplication) {
        let chip = app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        chip.tap()
        let point = app.webViews.switches["起点"]
        XCTAssertTrue(point.waitForExistence(timeout: 10))
        point.tap()
        chip.tap()
        let story = app.webViews.buttons["打开故事：起点"].firstMatch
        XCTAssertTrue(story.waitForExistence(timeout: 10))
        story.tap()
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
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        // Assert the real Atlas navigation state after native Story returns,
        // not only that a selectable point is rendered again.
        XCTAssertEqual(app.staticTexts["atlas.selection.point"].label, "point-a")
        XCTAssertEqual(app.staticTexts["atlas.selection.asset"].label, "asset-fixture")
    }
}
