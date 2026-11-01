import SwiftUI
import WebKit

// Sensitive remote pages have their own persistent cookie store and NO native
// message handler. The bundled scene never receives the cookie store.
struct PrivateWebView: UIViewRepresentable {
    let url: URL
    let store: WKWebsiteDataStore
    func makeCoordinator() -> Coordinator { Coordinator(origin: url) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url)); return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate {
        let origin: URL
        init(origin: URL) { self.origin = origin }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            decisionHandler(url?.scheme == "https" && url?.host == origin.host && url?.port == origin.port ? .allow : .cancel)
        }
    }
}
