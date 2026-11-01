import SwiftUI
import WebKit

// Sensitive remote pages have their own persistent cookie store and no script message handlers.
struct PrivateWebView: UIViewRepresentable {
    let url: URL
    let store: WKWebsiteDataStore
    var googleLogin: NativeGoogleLogin.Access? = nil

    func makeCoordinator() -> Coordinator { Coordinator(origin: url, access: googleLogin) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        if googleLogin != nil { configuration.applicationNameForUserAgent = "StartripsOwnerLogin/1" }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.login?.invalidate()
        uiView.navigationDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let origin: URL
        let access: NativeGoogleLogin.Access?
        var login: NativeGoogleLogin?

        init(origin: URL, access: NativeGoogleLogin.Access?) {
            self.origin = origin
            self.access = access
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if GoogleLoginAttempt.sameOrigin(url, as: origin) { decisionHandler(.allow); return }
            decisionHandler(.cancel)
            guard let intent = GoogleLoginAttempt.intent(url), let access, access.isCurrent(),
                  action.sourceFrame.isMainFrame, action.targetFrame?.isMainFrame == true,
                  GoogleLoginAttempt.sameOrigin(action.sourceFrame.request.url, as: origin),
                  GoogleLoginAttempt.sameOrigin(webView.url, as: origin), let anchor = webView.window else { return }
            if login == nil { login = NativeGoogleLogin(origin: origin, view: webView, anchor: anchor, access: access) }
            login?.begin(intent)
        }
    }
}
