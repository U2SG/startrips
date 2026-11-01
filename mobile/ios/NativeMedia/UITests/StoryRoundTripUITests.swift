import XCTest

/// Add this file to #767's existing app UI-test target. It drives the normal
/// scene -> AppRouter -> FeatureDestinations.story path; no media demo app.
final class StoryRoundTripUITests: XCTestCase {
    @MainActor func testStorySelectionInterruptedPagingAndReturn() throws {
        let app = XCUIApplication()
        app.launchArguments += ["--uitest-atlas-fixture", "native-media"]
        app.launch()
        let point = app.buttons["atlas.route-point.point-one"]
        XCTAssertTrue(point.waitForExistence(timeout: 15))
        point.tap()
        let photo = app.descendants(matching: .any).matching(identifier: "story.photo.photo-one").firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 10))
        let pager = app.descendants(matching: .any).matching(identifier: "story.pager").firstMatch
        // A short drag reverses before the midpoint; the selected asset remains.
        let center = pager.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 0.05, thenDragTo: pager.coordinate(withNormalizedOffset: CGVector(dx: 0.57, dy: 0.5)),
                     withVelocity: .slow, thenHoldForDuration: 0.5)
        XCTAssertTrue(photo.exists)
        photo.pinch(withScale: 2, velocity: 1)
        photo.pinch(withScale: 0.5, velocity: -1)
        app.buttons["story.next"].tap()
        app.buttons["story.previous"].tap()
        XCTAssertTrue(photo.exists)
        app.buttons["story.expand"].tap()
        app.buttons["story.close"].tap()
        XCTAssertTrue(app.buttons["atlas.route-point.point-one"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["story.close"].exists)
    }
}
