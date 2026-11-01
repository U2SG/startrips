import XCTest

final class StoryRoundTripUITests: XCTestCase {
    @MainActor func testStorySelectionInterruptedPagingAndReturn() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let journey = app.webViews.buttons["打开旅程：海岸旅程"]
        XCTAssertTrue(journey.waitForExistence(timeout: 30))
        journey.tap()
        let close = app.buttons["story.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        close.tap()

        let point = app.webViews.buttons["起点"]
        XCTAssertTrue(point.waitForExistence(timeout: 10))
        point.tap()
        app.webViews.buttons["打开故事"].firstMatch.tap()

        let first = app.descendants(matching: .any).matching(identifier: "story.photo.asset-fixture").firstMatch
        let second = app.descendants(matching: .any).matching(identifier: "story.photo.asset-second").firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        let center = first.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.50))
        center.press(forDuration: 0.05, thenDragTo: first.coordinate(withNormalizedOffset: CGVector(dx: 0.56, dy: 0.50)),
                     withVelocity: .slow, thenHoldForDuration: 0.5)
        XCTAssertTrue(first.isHittable)
        app.buttons["story.next"].tap()
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertTrue(second.isHittable)
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
