import XCTest

extension AtlasUITests {
    // Continue from the same live Atlas, after its initial Story round trip and foreground restore.
    @MainActor func verifyNativeMediaRoundTrip(in app: XCUIApplication) {
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
        choosePoint(app, "point-a")
        let story = openCard(app)
        XCTAssertEqual(story.label, "打开故事：起点")
        story.tap()
        let close = app.buttons["story.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["story.title"].label, "海岸旅程")
        XCTAssertEqual(app.buttons["story.previous"].label, "上一页")
        XCTAssertEqual(app.buttons["story.next"].label, "下一页")
        XCTAssertTrue(app.buttons["整理与导出"].exists)
        // The tools list leads with 素材; recovery rows only appear with an unfinished upload.
        app.buttons["整理与导出"].tap()
        let addMedia = app.descendants(matching: .any)["story.import"]
        XCTAssertTrue(addMedia.waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["story.import.recover"].exists)
        app.buttons["完成"].firstMatch.tap()
        XCTAssertTrue(addMedia.waitForNonExistence(timeout: 5))
        // Immersive reading hides the header and controls; the reflection stays, once.
        let reflections = app.staticTexts.matching(
            NSPredicate(format: "label == %@", "Synthetic bridge fixture"))
        XCTAssertEqual(reflections.count, 1)
        let first = app.descendants(matching: .any).matching(identifier: "story.photo.media:asset-fixture").firstMatch
        let immersive = app.buttons["story.expand"]
        XCTAssertEqual(immersive.label, "沉浸浏览")
        immersive.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["story.play"].exists)
        XCTAssertFalse(app.staticTexts["story.title"].exists)
        XCTAssertEqual(reflections.count, 1)
        // One tap on the content brings the chrome back.
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["story.next"].exists)

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
        // Playing goes immersive by itself; a tap shows the controls while it keeps playing.
        app.buttons["story.play"].tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
        XCTAssertTrue(app.buttons["story.pause"].waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(app.buttons["story.play"].waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
        // Assert the real Atlas navigation state after native Story returns,
        // not only that a selectable point is rendered again.
        XCTAssertEqual(app.staticTexts["atlas.selection.point"].label, "point-a")
        XCTAssertEqual(app.staticTexts["atlas.selection.asset"].label, "asset-fixture")
    }
}
