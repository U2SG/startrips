import XCTest

/// Owner share links on the synthetic Atlas (in-memory store, no network).
final class JourneyShareUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    @MainActor
    func testOwnerRevokesALinkOnlyAfterConfirming() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        openCard(app)
        let share = app.buttons["atlas.card.share"]
        XCTAssertTrue(share.waitForExistence(timeout: 10))
        share.tap()

        let row = app.descendants(matching: .any)["share.link.share-fixture"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["share.create"].exists)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "share-links"
        attachment.lifetime = .keepAlways
        add(attachment)

        app.buttons["share.revoke.share-fixture"].tap()
        let confirm = app.buttons["撤销链接"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(row.exists, "nothing is revoked before the owner confirms")
        confirm.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }
}
