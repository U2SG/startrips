import XCTest

final class AtlasUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

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
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 30))
        XCTAssertTrue(peek.isHittable)
        XCTAssertEqual(peek.label, "旅程：海岸旅程")
        assertDarkFullBleed(capture(app, "shell-connected-atlas"))
        app.terminate()

        app.launchArguments = ["-atlas-fixture", "-atlas-empty-fixture"]
        app.launch()
        let empty = app.staticTexts["atlas.empty"]
        XCTAssertTrue(empty.waitForExistence(timeout: 30))
        XCTAssertEqual(empty.label, "图谱里还没有旅程")
        XCTAssertFalse(app.staticTexts["登录后可在 Startrips 中记录第一段旅程。"].exists)
        XCTAssertFalse(card(app).exists)
        XCTAssertTrue(app.buttons["atlas.account"].exists)
        assertDarkFullBleed(capture(app, "shell-empty-atlas"))
    }

    @MainActor
    func testLandscapeAtlasIsFullBleed() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 30))
        addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
        rotate(app, to: .landscapeLeft)
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["atlas.account"].isHittable)
        assertDarkFullBleed(capture(app, "shell-landscape", screen: true), checkSides: true)
    }

    @MainActor
    func testJourneyCardHasPeekMediumAndLargeDetents() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 30))
        addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
        let grabber = app.buttons["atlas.card.grabber"]
        XCTAssertEqual(grabber.value as? String, "预览")
        XCTAssertTrue(app.descendants(matching: .any)["atlas.ribbon"].exists, "peek keeps the time ribbon")
        capture(app, "card-peek")

        peek.tap()
        XCTAssertTrue(waitForValue(grabber, "半屏"))
        XCTAssertTrue(app.buttons["atlas.card.cover"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["atlas.card.story"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["atlas.ribbon"].exists, "medium hides the ribbon")
        capture(app, "card-medium")

        drag(grabber, by: -6)
        XCTAssertTrue(waitForValue(grabber, "全屏"))
        XCTAssertTrue(app.buttons["atlas.journeys.journey-fixture"].waitForExistence(timeout: 10))
        capture(app, "card-large")

        drag(grabber, by: 4)
        XCTAssertTrue(waitForValue(grabber, "半屏"), "large must step down to medium")

        rotate(app, to: .landscapeLeft)
        XCTAssertTrue(grabber.waitForExistence(timeout: 10))
        assertDarkFullBleed(capture(app, "card-medium-landscape", screen: true), checkSides: true)
        rotate(app, to: .portrait)
        drag(grabber, by: 4)
        XCTAssertTrue(waitForValue(grabber, "预览"), "medium steps down to peek, never closes")
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
    }

    @MainActor
    func testLargestAccessibilityTextKeepsEntryAndAtlasUsable() throws {
        continueAfterFailure = false
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
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 30))
        XCTAssertTrue(peek.isHittable)
        XCTAssertTrue(app.buttons["atlas.account"].isHittable)
        assertDarkFullBleed(capture(app, "shell-ax5-atlas"))
        peek.tap()
        XCTAssertTrue(app.buttons["atlas.card.story"].waitForExistence(timeout: 10))
        capture(app, "card-ax5-medium")
    }

    @MainActor
    func testAccountMenuOffersSwitchShareAndSignOut() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let account = app.buttons["atlas.account"]
        XCTAssertTrue(account.waitForExistence(timeout: 30))
        XCTAssertEqual(account.label, "账户")
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
    func testGlobeOnlySceneLeavesAllChromeToNative() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        XCTAssertTrue(card(app).waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["atlas.wordmark"].exists)
        // The bundled scene renders only the globe: no Web header, chip, time
        // scrubber, sheet or picker is left inside the web view.
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
        for label in ["切换账户或分享", "打开全部旅程", "播放 Startrips 动画"] {
            XCTAssertFalse(app.webViews.buttons[label].exists, label)
        }
        XCTAssertFalse(app.webViews.sliders["时间轴"].exists)
    }

    @MainActor
    func testJourneyCardSwipesBetweenRealJourneys() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture", "-atlas-multi-journey-fixture"]
        app.launch()
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 30))
        XCTAssertEqual(peek.label, "旅程：海岸旅程")
        swipe(peek, from: 0.86, to: 0.14)
        XCTAssertTrue(waitForLabel(peek, "旅程：山谷旅程"))
        XCTAssertEqual(app.buttons["atlas.card.grabber"].value as? String, "预览", "a swipe never opens the card")

        // Match the Web boundary rule: never wrap past the last Journey.
        swipe(peek, from: 0.86, to: 0.14)
        XCTAssertTrue(waitForLabel(peek, "旅程：山谷旅程"))
        swipe(peek, from: 0.14, to: 0.86)
        XCTAssertTrue(waitForLabel(peek, "旅程：海岸旅程"))

        // The time ribbon flies across Journeys by date and commits on release.
        let ribbon = app.descendants(matching: .any)["atlas.ribbon"]
        XCTAssertTrue(ribbon.exists)
        ribbon.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: ribbon.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)))
        XCTAssertTrue(waitForLabel(peek, "旅程：山谷旅程"))
        XCTAssertEqual(ribbon.value as? String, "2025年2月")
        ribbon.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: ribbon.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.5)))
        XCTAssertTrue(waitForLabel(peek, "旅程：海岸旅程"))
        capture(app, "ribbon-scrubbed")

        // The large detent lists every Journey; picking one returns to peek on it.
        peek.tap()
        let grabber = app.buttons["atlas.card.grabber"]
        XCTAssertTrue(waitForValue(grabber, "半屏"))
        drag(grabber, by: -6)
        let valley = app.buttons["atlas.journeys.journey-fixture-valley"]
        XCTAssertTrue(valley.waitForExistence(timeout: 10))
        XCTAssertEqual(valley.label, "切换到旅程：山谷旅程")
        capture(app, "card-large-journeys")
        valley.tap()
        XCTAssertTrue(waitForValue(grabber, "预览"))
        XCTAssertTrue(waitForLabel(peek, "旅程：山谷旅程"))
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
        XCTAssertTrue(card(app).waitForExistence(timeout: 30))
        XCTAssertFalse(dialog.exists)
    }

    @MainActor
    func testGlobePointSelectionAndStoryRoundTrip() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["-atlas-fixture"]
        app.launch()
        let peek = card(app)
        XCTAssertTrue(peek.waitForExistence(timeout: 30))
        choosePoint(app, "point-a")
        let opening = openCard(app)
        XCTAssertEqual(opening.label, "打开故事：起点")
        opening.tap()
        let storyTitle = app.staticTexts["story.title"]
        XCTAssertTrue(storyTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(storyTitle.label, "海岸旅程")
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
        app.buttons["story.close"].tap()
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
        choosePoint(app, "point-a")
        choosePoint(app, "point-b")
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForExistence(timeout: 30))
        let count = app.staticTexts["atlas.focus.count"]
        let beforeDrag = try XCTUnwrap(Int(count.label))
        XCTAssertGreaterThan(beforeDrag, 0)
        let earth = app.webViews.firstMatch
        earth.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.32))
            .press(forDuration: 0.1, thenDragTo: earth.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.4)))
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForNonExistence(timeout: 5))
        // Every acknowledged focus transition is counted, including one that would
        // finish and disappear between snapshots. Leave the real idle timer alone.
        try await Task.sleep(for: .seconds(22))
        XCTAssertEqual(Int(count.label), beforeDrag)
        XCTAssertFalse(app.staticTexts["earth-rendered"].exists)
        choosePoint(app, "point-b")
        XCTAssertTrue(app.staticTexts["earth-rendered"].waitForExistence(timeout: 30))
        XCTAssertGreaterThan(try XCTUnwrap(Int(count.label)), beforeDrag)
        capture(app, "production-globe-after-consecutive-selection")
        let coastStory = openCard(app)
        XCTAssertEqual(coastStory.label, "打开故事：海岸")
        coastStory.tap()
        XCTAssertTrue(storyTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(storyTitle.label, "海岸旅程")
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10))
        app.buttons["story.close"].tap()
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
        verifyNativeMediaRoundTrip(in: app)
    }
}

/// Native Atlas chrome helpers, shared by the Atlas and Story UI tests.
extension XCTestCase {
    @MainActor func card(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "atlas.card.peek").firstMatch
    }

    /// Opens the card to medium and returns its Story button.
    @MainActor @discardableResult
    func openCard(_ app: XCUIApplication) -> XCUIElement {
        let story = app.buttons["atlas.card.story"]
        if !story.exists || !story.isHittable {
            let peek = card(app)
            XCTAssertTrue(peek.waitForExistence(timeout: 10))
            peek.tap()
        }
        XCTAssertTrue(story.waitForExistence(timeout: 10))
        return story
    }

    /// Picks a Route Point from the medium card; the card returns to peek.
    @MainActor func choosePoint(_ app: XCUIApplication, _ id: String) {
        openCard(app)
        let point = app.buttons["atlas.card.point." + id]
        XCTAssertTrue(point.waitForExistence(timeout: 10))
        point.tap()
        XCTAssertTrue(waitForValue(app.buttons["atlas.card.grabber"], "预览"))
    }

    @MainActor func drag(_ handle: XCUIElement, by multiple: CGFloat) {
        let from = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5 + multiple)))
    }

    @MainActor func swipe(_ element: XCUIElement, from: CGFloat, to: CGFloat) {
        element.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.5))
            .press(forDuration: 0.08, thenDragTo: element.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.5)))
    }

    @MainActor func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 10) -> Bool {
        let predicate = NSPredicate(format: "value == %@", value)
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout) == .completed
    }

    @MainActor func waitForLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval = 15) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout) == .completed
    }

    @MainActor func rotate(_ app: XCUIApplication, to orientation: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = orientation
        // Capture only after the window has rotated and the rotation animation settled.
        let window = app.windows.firstMatch
        let landscape = orientation.isLandscape
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && (window.frame.width > window.frame.height) != landscape {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertEqual(window.frame.width > window.frame.height, landscape)
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    }
}
