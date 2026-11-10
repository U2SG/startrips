import XCTest

final class AtlasUITests: XCTestCase {
    @MainActor
    func testFirstLaunchUsesStartripsServerWithoutUserConfiguration() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["登录并选择图谱"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["打开图谱"].exists)
        XCTAssertTrue(app.textFields["分享链接"].exists)
        XCTAssertFalse(app.textFields["https://your-startrips.example"].exists)
        XCTAssertFalse(app.textFields["调试服务器（仅开发版）"].exists)
        XCTAssertFalse(app.alerts["图谱暂不可用"].exists)
    }

    @MainActor
    func testMobileWordmarkTriggersBrandInteraction() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let logo = app.webViews.buttons["播放 Startrips 动画"]
        XCTAssertTrue(logo.waitForExistence(timeout: 20))
        XCTAssertTrue(logo.isHittable)
        logo.tap()
        // The Web brand moment is an in-place interaction, not a dead label
        // or a navigation away from the Atlas.
        XCTAssertTrue(logo.exists)
        XCTAssertTrue(app.webViews.buttons["切换账户或分享"].exists)
    }

    @MainActor
    func testMobileJourneyChipSwipesBetweenRealJourneys() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture", "-atlas-multi-journey-fixture"]
        app.launch()
        let coast = app.webViews.buttons[
            "查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        let valley = app.webViews.buttons[
            "查看当前旅程详情：山谷旅程。左右滑动切换旅程"]
        XCTAssertTrue(coast.waitForExistence(timeout: 30))

        // Actual iPhone drag on the upper Journey row, not a synthetic
        // React callback or the lower time-scrubber track.
        coast.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.5))
            .press(forDuration: 0.08,
                   thenDragTo: coast.coordinate(withNormalizedOffset: CGVector(dx: 0.14, dy: 0.5)))
        XCTAssertTrue(valley.waitForExistence(timeout: 15))
        XCTAssertFalse(app.webViews.buttons["返回地球"].exists)

        // Match Mobile V2 boundary behavior: don't wrap at the last Journey.
        valley.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.5))
            .press(forDuration: 0.08,
                   thenDragTo: valley.coordinate(withNormalizedOffset: CGVector(dx: 0.14, dy: 0.5)))
        XCTAssertTrue(valley.exists)

        valley.coordinate(withNormalizedOffset: CGVector(dx: 0.14, dy: 0.5))
            .press(forDuration: 0.08,
                   thenDragTo: valley.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.5)))
        XCTAssertTrue(coast.waitForExistence(timeout: 15))
        XCTAssertTrue(app.webViews.sliders["时间轴"].exists)

        // A real tap after swiping must still open the details sheet.
        coast.tap()
        XCTAssertTrue(app.webViews.buttons["返回地球"].waitForExistence(timeout: 10))
    }
    @MainActor
    func testNativeSceneRecoveryDoesNotDependOnWebViewControls() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture", "-atlas-scene-recovery-probe"]
        app.launch()
        let dialog = app.alerts["图谱暂不可用"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 20))
        let retry = dialog.buttons["重新加载地球"]
        XCTAssertTrue(retry.exists)
        retry.tap()
        XCTAssertTrue(app.webViews.buttons[
            "查看当前旅程详情：海岸旅程。左右滑动切换旅程"
        ].waitForExistence(timeout: 30))
        XCTAssertFalse(dialog.exists)
    }

    @MainActor
    func testMobileV2HeaderJourneySheetAndPicker() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        XCTAssertTrue(app.webViews.buttons["切换账户或分享"].waitForExistence(timeout: 20))
        let logo = app.webViews.buttons["播放 Startrips 动画"]
        XCTAssertTrue(logo.waitForExistence(timeout: 20))
        logo.tap()
        XCTAssertTrue(logo.exists)
        let picker = app.webViews.buttons["打开全部旅程"]
        XCTAssertTrue(picker.waitForExistence(timeout: 20))
        let chip = app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        XCTAssertTrue(chip.waitForExistence(timeout: 30))
        chip.tap()
        let initialPoint = app.webViews.switches["起点"]
        XCTAssertTrue(initialPoint.waitForExistence(timeout: 10))
        initialPoint.tap()
        chip.tap()
        XCTAssertTrue(app.webViews.buttons["打开故事：起点"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.switches["海岸"].waitForExistence(timeout: 10))
        let sheet = XCTAttachment(screenshot: app.screenshot())
        sheet.name = "native-mobile-v2-journey-sheet"
        sheet.lifetime = .keepAlways
        add(sheet)
        app.webViews.buttons["返回地球"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        picker.tap()
        XCTAssertTrue(app.webViews.buttons["切换到旅程：海岸旅程"].waitForExistence(timeout: 10))
        let journeys = XCTAttachment(screenshot: app.screenshot())
        journeys.name = "native-mobile-v2-journey-picker"
        journeys.lifetime = .keepAlways
        add(journeys)
        app.webViews.buttons["关闭全部旅程"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
    }
    @MainActor
    func testGlobePointSelectionAndStoryRoundTrip() async throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let picker = app.webViews.buttons["打开全部旅程"]
        XCTAssertTrue(picker.waitForExistence(timeout: 20))
        let chip = app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        XCTAssertTrue(chip.waitForExistence(timeout: 30))
        chip.tap()
        let entryPoint = app.webViews.switches["起点"]
        XCTAssertTrue(entryPoint.waitForExistence(timeout: 10))
        entryPoint.tap()
        chip.tap()
        let opening = app.webViews.buttons["打开故事：起点"]
        XCTAssertTrue(opening.waitForExistence(timeout: 10))
        opening.tap()
        let storyTitle = app.staticTexts["story.title"]
        XCTAssertTrue(storyTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(storyTitle.label, "海岸旅程")
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
        app.buttons["story.close"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        chip.tap()
        let start = app.webViews.switches["起点"]
        XCTAssertTrue(start.waitForExistence(timeout: 10)); start.tap()
        chip.tap()
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
        chip.tap()
        XCTAssertTrue(coast.waitForExistence(timeout: 10)); coast.tap()
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForExistence(timeout: 30))
        XCTAssertGreaterThan(try XCTUnwrap(Int(count.label)), beforeDrag)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "production-globe-after-consecutive-selection"; screenshot.lifetime = .keepAlways
        add(screenshot)
        let cursor = app.webViews.sliders["时间轴"]
        XCTAssertTrue(cursor.waitForExistence(timeout: 10))
        let center = cursor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 0.1, thenDragTo: cursor.coordinate(withNormalizedOffset: CGVector(dx: -0.03, dy: 0.5)))
        chip.tap()
        XCTAssertTrue(app.webViews.buttons["打开故事：起点"].waitForExistence(timeout: 10))
        app.webViews.buttons["返回地球"].tap()
        center.press(forDuration: 0.1, thenDragTo: cursor.coordinate(withNormalizedOffset: CGVector(dx: 1.03, dy: 0.5)))
        chip.tap()
        let coastStory = app.webViews.buttons["打开故事：海岸"]
        XCTAssertTrue(coastStory.waitForExistence(timeout: 10))
        coastStory.tap()
        XCTAssertTrue(storyTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(storyTitle.label, "海岸旅程")
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
        app.buttons["story.close"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        verifyNativeMediaRoundTrip(in: app)
    }
}
