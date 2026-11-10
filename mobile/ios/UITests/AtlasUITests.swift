import XCTest

final class AtlasUITests: XCTestCase {
    @MainActor
    func testFirstLaunchShowsDarkFullBleedWelcome() throws {
        let app = XCUIApplication()
        app.launch()
        let signIn = app.buttons["welcome.sign-in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["welcome.paste-share"].exists)
        XCTAssertTrue(app.staticTexts["atlas.wordmark"].exists)
        // No server URL, share text field or helper copy on the product entry.
        XCTAssertEqual(app.textFields.count, 0)
        XCTAssertFalse(app.staticTexts["登录 Startrips，查看已经保存的旅程。"].exists)
        XCTAssertFalse(app.alerts["图谱暂不可用"].exists)
        assertDarkFullBleed(capture(app, "shell-first-launch"))
    }

    @MainActor
    func testBrandedLoadingIsFullBleed() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-loading-probe"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["atlas.loading"].waitForExistence(timeout: 15))
        assertDarkFullBleed(capture(app, "shell-loading"))
    }

    @MainActor
    func testConnectedAndEmptyAtlasAreFullBleed() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let chip = app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        XCTAssertTrue(chip.waitForExistence(timeout: 30))
        XCTAssertTrue(chip.isHittable)
        assertDarkFullBleed(capture(app, "shell-connected-atlas"))
        app.terminate()

        app.launchArguments = ["-atlas-fixture", "-atlas-empty-fixture"]
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["图谱里还没有旅程"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.webViews.staticTexts["登录后可在 Startrips 中记录第一段旅程。"].exists)
        XCTAssertTrue(app.webViews.buttons["切换账户或分享"].exists)
        assertDarkFullBleed(capture(app, "shell-empty-atlas"))
    }

    @MainActor
    func testLandscapeAtlasIsFullBleed() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let chip = app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
        XCTAssertTrue(chip.waitForExistence(timeout: 30))
        addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .landscapeLeft
        // Capture only after the window has rotated and the rotation animation settled.
        let window = app.windows.firstMatch
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !(window.frame.width > window.frame.height) {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertGreaterThan(window.frame.width, window.frame.height)
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.buttons["切换账户或分享"].isHittable)
        assertDarkFullBleed(capture(app, "shell-landscape", screen: true), checkSides: true)
    }

    @MainActor
    func testLargestAccessibilityTextKeepsEntryAndAtlasUsable() throws {
        let app = XCUIApplication()
        let largest = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launchArguments = largest
        app.launch()
        let signIn = app.buttons["welcome.sign-in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        XCTAssertTrue(signIn.isHittable)
        XCTAssertTrue(app.buttons["welcome.paste-share"].isHittable)
        assertDarkFullBleed(capture(app, "shell-ax5-welcome"))
        app.terminate()

        app.launchArguments = ["-atlas-fixture"] + largest
        app.launch()
        XCTAssertTrue(app.webViews.buttons["查看当前旅程详情：海岸旅程。左右滑动切换旅程"]
            .waitForExistence(timeout: 30))
        assertDarkFullBleed(capture(app, "shell-ax5-atlas"))
    }

    @MainActor
    func testAccountMenuOffersSwitchShareAndSignOut() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let account = app.webViews.buttons["切换账户或分享"]
        XCTAssertTrue(account.waitForExistence(timeout: 30))
        account.tap()
        XCTAssertTrue(app.buttons["切换图谱"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["粘贴分享链接"].exists)
        let signOut = app.buttons["退出登录"]
        XCTAssertTrue(signOut.exists)
        capture(app, "shell-account-menu")
        signOut.tap()
        XCTAssertTrue(app.buttons["welcome.sign-in"].waitForExistence(timeout: 15))
    }

    @MainActor
    @discardableResult
    private func capture(_ app: XCUIApplication, _ name: String, screen: Bool = false) -> XCUIScreenshot {
        // The screen capture follows the device orientation; used for landscape evidence.
        let screenshot = screen ? XCUIScreen.main.screenshot() : app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        return screenshot
    }

    /// Regression guard for the white status-bar / home-indicator bands: the
    /// outermost pixel rows (and, in landscape, columns) must be the dark shell.
    @MainActor
    private func assertDarkFullBleed(_ screenshot: XCUIScreenshot, checkSides: Bool = false,
                                     file: StaticString = #filePath, line: UInt = #line) {
        guard let image = screenshot.image.cgImage else { return XCTFail("No screenshot pixels", file: file, line: line) }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return XCTFail("Cannot read screenshot pixels", file: file, line: line) }
        func luminance(_ x: Int, _ y: Int) -> Double {
            let i = (y * width + x) * 4
            return (0.2126 * Double(pixels[i]) + 0.7152 * Double(pixels[i + 1]) + 0.0722 * Double(pixels[i + 2])) / 255
        }
        func row(_ y: Int) -> Double { (0..<width).reduce(0) { $0 + luminance($1, y) } / Double(width) }
        func column(_ x: Int) -> Double { (0..<height).reduce(0) { $0 + luminance(x, $1) } / Double(height) }
        let inset = 3
        var edges = [("top", row(inset)), ("bottom", row(height - 1 - inset))]
        if checkSides { edges += [("left", column(inset)), ("right", column(width - 1 - inset))] }
        for (edge, value) in edges {
            XCTAssertLessThan(value, 0.3, "\(edge) safe-area edge is not the dark shell (mean luminance \(value))",
                              file: file, line: line)
        }
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
