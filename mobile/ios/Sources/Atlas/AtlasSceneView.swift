import SwiftUI
import WebKit

struct AtlasSceneView: UIViewRepresentable {
    @ObservedObject var router: AppRouter
    let mapOrigin: URL?

    func makeCoordinator() -> Coordinator { Coordinator(router: router) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: "atlas")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false; view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        context.coordinator.view = view
        context.coordinator.start(mapOrigin: mapOrigin)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) { context.coordinator.publish() }
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
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            guard loaded, let data = try? encoder.encode(router.snapshot), let json = String(data: data, encoding: .utf8) else { return }
            guard json != lastJSON else { return }
            lastJSON = json
            view?.callAsyncJavaScript("window.atlasNative.receive(snapshot)", arguments: ["snapshot": json], in: nil, contentWorld: .page) { [weak self] result in
                if case .failure = result { Task { @MainActor in self?.router.error = "地球通信中断，请刷新。" } }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.host == "127.0.0.1",
                  message.frameInfo.request.url?.port == localURL?.port,
                  let body = message.body as? String, body.utf8.count <= 8192,
                  let event = try? JSONDecoder().decode(SceneEvent.self, from: Data(body.utf8)) else { return }
            router.receive(event)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true; lastJSON = nil; publish() }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            decisionHandler(url?.scheme == "http" && url?.host == "127.0.0.1" && url?.port == localURL?.port
                            && url?.path == "/index.html" ? .allow : .cancel)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            loaded = false; router.sceneRestarted(); restarts += 1
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
