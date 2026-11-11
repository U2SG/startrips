import SwiftUI
import WebKit

struct AtlasSceneView: UIViewRepresentable {
    @ObservedObject var router: AppRouter
    let mapOrigin: URL?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight
    @Environment(\.colorSchemeContrast) private var contrast
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 17

    struct AccessibilitySettings: Encodable, Equatable {
        let textScale: Double
        let accessibilitySize: Bool
        let boldText: Bool
        let increasedContrast: Bool
    }

    private var accessibility: AccessibilitySettings {
        AccessibilitySettings(
            textScale: Double(bodySize / 17),
            accessibilitySize: dynamicTypeSize.isAccessibilitySize,
            boldText: legibilityWeight == .bold,
            increasedContrast: contrast == .increased
        )
    }

    static func receiveScript(_ json: String) throws -> String { try script("receive", json) }
    static func commandScript(_ json: String) throws -> String { try script("command", json) }

    private static func script(_ method: String, _ json: String) throws -> String {
        // JSONEncoder produces one quoted data literal, including escaping untrusted text.
        let literal = String(decoding: try JSONEncoder().encode(json), as: UTF8.self)
        return "window.atlasNative." + method + "(" + literal + ")"
    }

    // Document-start delivery does not depend on a late WebKit message
    // acknowledgement: the snapshot is buffered until the ES module is ready.
    static let earlyReceiverScript = """
    window.atlasNative = {
      pending: null,
      commands: [],
      receive(json) { this.pending = json; },
      command(json) { this.commands.push(json); }
    };
    """

    func makeCoordinator() -> Coordinator { Coordinator(router: router, accessibility: accessibility) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.earlyReceiverScript, injectionTime: .atDocumentStart,
                         forMainFrameOnly: true))
        configuration.userContentController.add(context.coordinator, name: "atlas")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false; view.scrollView.isScrollEnabled = false
        // Full-bleed: the page receives real env(safe-area-inset-*) values instead
        // of UIKit insetting the scroll view a second time, and nothing light
        // shows before the first frame or during a WebKit restart.
        let background = NightFlight.backgroundUIColor
        view.backgroundColor = background
        view.scrollView.backgroundColor = background
        view.underPageBackgroundColor = background
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.navigationDelegate = context.coordinator
        context.coordinator.view = view
        context.coordinator.start(mapOrigin: mapOrigin)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.accessibility = accessibility
        context.coordinator.publish()
    }
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.stopLoading(); uiView.configuration.userContentController.removeScriptMessageHandler(forName: "atlas")
        coordinator.server?.stop()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let router: AppRouter
        weak var view: WKWebView?
        var server: BundledSceneServer?
        var localURL: URL?
        var loaded = false
        var restarts = 0
        var lastJSON: String?
        var lastPresentation: ScenePresentation?
        var lastPreview: String?
        var lastReady = 0
        init(router: AppRouter) { self.router = router }

        func start(mapOrigin: URL?) {
            guard let root = Bundle.main.url(forResource: "Scene", withExtension: nil) else {
                router.error = "地球资源缺失，请重新安装应用。"; return
            }
            let server = BundledSceneServer(root: root, mapOrigin: mapOrigin)
            self.server = server
            do {
                try server.start { [weak self] result in
                    Task { @MainActor in
                        guard let self else { return }
                        switch result {
                        case .success(let url): self.localURL = url; self.view?.load(URLRequest(url: url))
                        case .failure: self.router.error = "地球暂时无法启动，请重试。"
                        }
                    }
                }
            } catch { router.error = "地球暂时无法启动，请重试。" }
        }

        func publish() {
            guard loaded else { return }
            let encoder = JSONEncoder()
            // Presentation changes can arrive independently of the Atlas
            // snapshot and must not advance its identity or focus revision.
            if accessibility != lastAccessibility,
               let data = try? encoder.encode(accessibility) {
                lastAccessibility = accessibility
                evaluate("window.atlasNative.setAccessibility(" + String(decoding: data, as: UTF8.self) + ")")
            }
            encoder.outputFormatting = .sortedKeys
            guard loaded, let data = try? encoder.encode(router.snapshot), let json = String(data: data, encoding: .utf8) else { return }
            if json != lastJSON, let script = try? AtlasSceneView.receiveScript(json) {
                lastJSON = json
                evaluate(script)
            }
            sendCommands()
        }

        /// Presentation travels as commands so a layout change never rebuilds the
        /// globe's routes or bumps the revision that scene events must echo.
        private func sendCommands() {
            if router.sceneReadyCount != lastReady { lastReady = router.sceneReadyCount; lastPresentation = nil; lastPreview = nil }
            let presentation = router.presentation
            var commands: [SceneCommand] = []
            if lastPresentation?.globeOnly != presentation.globeOnly {
                commands.append(router.command(.chrome, globeOnly: presentation.globeOnly))
            }
            if lastPresentation?.insets != presentation.insets {
                commands.append(router.command(.insets, insets: presentation.insets))
            }
            if lastPresentation == nil || lastPresentation?.window != presentation.window {
                commands.append(router.command(.timeWindow, window: presentation.window))
            }
            lastPresentation = presentation
            if let preview = router.preview, preview.requestId != lastPreview {
                lastPreview = preview.requestId
                commands.append(router.command(.focus, journeyId: preview.journeyId, routePointId: preview.routePointId))
            }
            let snapshot = router.snapshot
            for command in commands {
                guard (try? validateSceneCommand(command, snapshot: snapshot)) != nil,
                      let data = try? JSONEncoder().encode(command),
                      let script = try? AtlasSceneView.commandScript(String(decoding: data, as: UTF8.self)) else { continue }
                evaluate(script)
            }
        }

        private func evaluate(_ script: String) {
            // This page-world API does not link the missing iOS 18.5 simulator Swift overlay.
            view?.evaluateJavaScript(script) { [weak self] _, error in
                if error != nil { Task { @MainActor in self?.router.error = "地球通信中断，请刷新。" } }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            // The authenticated frame origin is stable even if WebKit omits
            // frameInfo.request.url from script messages.
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, origin.protocol == "http",
                  origin.host == "127.0.0.1", origin.port == localURL?.port,
                  let body = message.body as? String, body.utf8.count <= 8192,
                  let event = try? JSONDecoder().decode(SceneEvent.self, from: Data(body.utf8)) else { return }
            router.receive(event)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            loaded = false; lastJSON = nil; lastPresentation = nil; lastPreview = nil
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true; lastJSON = nil; lastPresentation = nil; lastPreview = nil; publish()
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            decisionHandler(url?.scheme == "http" && url?.host == "127.0.0.1" && url?.port == localURL?.port
                            && url?.path == "/index.html" ? .allow : .cancel)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            loaded = false; lastJSON = nil; lastPresentation = nil; lastPreview = nil
            router.sceneRestarted(); restarts += 1
            guard restarts <= 2, let localURL else { router.error = "地球已暂停，请刷新重试。"; return }
            webView.load(URLRequest(url: localURL))
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            router.error = "地球加载失败，请刷新重试。"
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            router.error = "地球加载失败，请刷新重试。"
        }
    }
}
