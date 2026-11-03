import AuthenticationServices
import CryptoKit
import Security
import WebKit

enum GoogleLoginError: Error, Equatable { case invalid, unavailable, cancelled }

struct GoogleLoginAttempt {
    let origin: URL
    let state: String
    let verifier: String

    init(origin: URL) throws {
        self.origin = origin
        self.state = try Self.randomValue()
        self.verifier = try Self.randomValue()
    }

    private static func randomValue() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw GoogleLoginError.unavailable
        }
        return base64url(Data(bytes))
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func sameOrigin(_ url: URL?, as origin: URL) -> Bool {
        guard let url, url.scheme == "https", origin.scheme == "https",
              let host = origin.host, url.host?.lowercased() == host.lowercased(),
              url.user == nil, url.password == nil else { return false }
        return (url.port ?? 443) == (origin.port ?? 443)
    }

    static func intent(_ url: URL) -> String? {
        guard url.scheme == "startrips-google", url.host == "login", url.port == nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
        switch url.path {
        case "/sign-in": return "sign-in"
        case "/sign-up": return "sign-up"
        default: return nil
        }
    }

    func start(_ intent: String) throws -> URLRequest {
        guard intent == "sign-in" || intent == "sign-up" else { throw GoogleLoginError.invalid }
        let challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        return try post("start", ["state": state, "codeChallenge": challenge, "intent": intent])
    }

    func authorize(_ data: Data) throws -> URL {
        struct StartResponse: Decodable { let authorizeUrl: URL }
        let url = try JSONDecoder().decode(StartResponse.self, from: data).authorizeUrl
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard Self.sameOrigin(url, as: origin), url.fragment == nil,
              url.path == "/api/native-auth/authorize", items.count == 1,
              items[0].name == "request", items[0].value?.isEmpty == false else { throw GoogleLoginError.invalid }
        return url
    }

    func exchange(_ callback: URL) throws -> URLRequest {
        guard callback.scheme == "startrips", callback.host == "auth", callback.port == nil,
              callback.user == nil, callback.password == nil, callback.path.isEmpty, callback.fragment == nil,
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              items.count == 2, items.contains(URLQueryItem(name: "state", value: state)) else {
            throw GoogleLoginError.invalid
        }
        if items.contains(URLQueryItem(name: "error", value: "access_denied")) { throw GoogleLoginError.cancelled }
        guard let code = items.first(where: { $0.name == "code" })?.value, code.utf8.count == 43,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw GoogleLoginError.invalid }
        return try post("exchange", ["state": state, "codeVerifier": verifier, "code": code])
    }

    private func post(_ action: String, _ fields: [String: String]) throws -> URLRequest {
        let url = origin.appendingPathComponent("api/native-auth").appendingPathComponent(action)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.host = origin.host?.lowercased()
        if components?.port == 443 { components?.port = nil }
        request.setValue(components?.string, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONEncoder().encode(fields)
        return request
    }

    func sessionCookie(_ response: HTTPURLResponse) throws -> HTTPCookie {
        guard response.statusCode == 204, Self.sameOrigin(response.url, as: origin),
              response.url?.path == "/api/native-auth/exchange",
              let header = response.value(forHTTPHeaderField: "Set-Cookie"),
              !header.contains("\n"), !header.contains("\r"),
              header.range(of: #"(?:^|;)\s*domain\s*="#, options: [.regularExpression, .caseInsensitive]) == nil
        else { throw GoogleLoginError.invalid }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: origin)
        guard cookies.count == 1, let cookie = cookies.first, ["__Secure-startrips.session_token", "startrips.session_token"].contains(cookie.name),
              cookie.domain.lowercased() == origin.host?.lowercased(), cookie.path == "/",
              cookie.isSecure, cookie.isHTTPOnly, !cookie.value.isEmpty,
              cookie.expiresDate.map({ $0 > Date() }) ?? true else { throw GoogleLoginError.invalid }
        return cookie
    }
}

@MainActor
final class NativeGoogleLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    struct Access {
        let isCurrent: () -> Bool
        let install: (HTTPCookie, @escaping () -> Bool) async -> Bool
        let failed: () -> Void
    }

    private let access: Access
    private let anchor: ASPresentationAnchor
    private let origin: URL
    private weak var view: WKWebView?
    private var pending: GoogleLoginAttempt?
    private var browser: ASWebAuthenticationSession?
    private var task: Task<Void, Never>?
    private let transport: URLSession

    init(origin: URL, view: WKWebView, anchor: ASPresentationAnchor, access: Access) {
        self.origin = origin
        self.view = view
        self.anchor = anchor
        self.access = access
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        self.transport = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }

    func begin(_ intent: String) {
        guard pending == nil, access.isCurrent() else { return }
        do {
            let attempt = try GoogleLoginAttempt(origin: origin)
            pending = attempt
            setPageInteractive(false)
            task = Task {
                do {
                    let (data, response) = try await transport.data(for: attempt.start(intent))
                    guard isCurrent(attempt) else { return }
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw GoogleLoginError.unavailable }
                    let session = ASWebAuthenticationSession(url: try attempt.authorize(data), callbackURLScheme: "startrips") {
                        [weak self] callback, error in
                        Task { @MainActor in self?.returned(callback, error: error, for: attempt) }
                    }
                    session.presentationContextProvider = self
                    browser = session
                    guard session.start() else { throw GoogleLoginError.unavailable }
                } catch { finish(attempt, error: error) }
            }
        } catch { access.failed() }
    }

    private func returned(_ callback: URL?, error: Error?, for attempt: GoogleLoginAttempt) {
        guard isCurrent(attempt), browser != nil else { return }
        browser = nil
        if let error { finish(attempt, error: error); return }
        guard let callback else { finish(attempt, error: GoogleLoginError.invalid); return }
        task = Task {
            do {
                let (_, response) = try await transport.data(for: attempt.exchange(callback))
                guard isCurrent(attempt) else { return }
                guard let response = response as? HTTPURLResponse else { throw GoogleLoginError.invalid }
                let cookie = try attempt.sessionCookie(response)
                // The replacement view starts on the normal first-party Atlas selector after publication.
                guard await access.install(cookie, { [weak self] in self?.isCurrent(attempt) == true }) else {
                    finish(attempt, error: GoogleLoginError.cancelled)
                    return
                }
                finish(attempt, error: nil)
            } catch { finish(attempt, error: error) }
        }
    }

    private func isCurrent(_ attempt: GoogleLoginAttempt) -> Bool {
        pending?.state == attempt.state && view != nil && access.isCurrent()
    }

    private func finish(_ attempt: GoogleLoginAttempt, error: Error?) {
        guard pending?.state == attempt.state else { return }
        pending = nil
        if access.isCurrent() { setPageInteractive(true) }
        task = nil
        browser = nil
        guard let error, access.isCurrent() else { return }
        if (error as? GoogleLoginError) == .cancelled ||
            (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { return }
        access.failed()
    }

    private func setPageInteractive(_ enabled: Bool) {
        if !enabled { view?.endEditing(true) }
        view?.isUserInteractionEnabled = enabled
        view?.accessibilityElementsHidden = !enabled
    }

    func invalidate() {
        pending = nil
        task?.cancel()
        task = nil
        browser?.cancel()
        browser = nil
        transport.invalidateAndCancel()
    }
}
