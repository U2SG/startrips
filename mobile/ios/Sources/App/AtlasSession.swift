import Foundation
import Combine
import WebKit

enum SessionFailure: LocalizedError {
    case invalidOrigin, unavailable(Int), invalidPayload
    var errorDescription: String? {
        switch self {
        case .invalidOrigin: return "请输入有效的 HTTPS Startrips 地址。"
        case .unavailable(401): return "请先登录并选择图谱，然后返回刷新。"
        case .unavailable(403), .unavailable(404): return "当前图谱或分享不可用，请重新打开。"
        case .unavailable: return "暂时无法读取图谱，请重试。"
        case .invalidPayload: return "图谱响应无法读取，请更新应用后重试。"
        }
    }
}

@MainActor
final class AtlasSession: ObservableObject {
    @Published var originText = UserDefaults.standard.string(forKey: "atlas.origin") ?? ""
    @Published var shareText = ""
    @Published var busy = false
    @Published var loginPresented = false
    private(set) var origin: URL?
    private(set) var guestToken: String?
    private var generation = UUID()
    private var refreshID = UUID()
    let cookieStore = WKWebsiteDataStore.default()

    func disconnect() {
        generation = UUID(); refreshID = UUID(); origin = nil; guestToken = nil; busy = false
    }

    static func validatedOrigin(_ text: String) throws -> URL {
        guard let url = URL(string: text), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw SessionFailure.invalidOrigin }
        return url
    }

    func configureGuest(_ link: String) throws {
        guard var components = URLComponents(string: link), components.path == "/share",
              let token = components.fragment, token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              components.query == nil else { throw SessionFailure.invalidOrigin }
        components.fragment = nil; components.path = ""
        origin = try Self.validatedOrigin(components.string ?? "")
        guestToken = token; generation = UUID()
    }

    func configureOwner() throws {
        origin = try Self.validatedOrigin(originText)
        guestToken = nil; generation = UUID()
        UserDefaults.standard.set(origin?.absoluteString, forKey: "atlas.origin")
    }

    func read(_ path: String) async throws -> Data {
        guard let origin, let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host, url.scheme == "https", url.port == origin.port else { throw SessionFailure.invalidOrigin }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        if let guestToken {
            guard path.hasPrefix("/api/shared/") else { throw SessionFailure.invalidPayload }
            request.setValue("Bearer \(guestToken)", forHTTPHeaderField: "Authorization")
        } else {
            let cookies = await cookieStore.httpCookieStore.allCookies()
            let matching = cookies.filter { cookie in
                let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
                let host = url.host ?? ""
                return (host == domain || (cookie.domain.hasPrefix(".") && host.hasSuffix("." + domain)))
                    && url.path.hasPrefix(cookie.path) && (cookie.expiresDate == nil || cookie.expiresDate! > Date())
            }
            for (key, value) in HTTPCookie.requestHeaderFields(with: matching) { request.setValue(value, forHTTPHeaderField: key) }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let transport = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        defer { transport.invalidateAndCancel() }
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SessionFailure.unavailable((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return data
    }

    func refresh(_ router: AppRouter) async {
        let request = generation
        let observation = UUID()
        refreshID = observation
        busy = true
        defer { if generation == request && refreshID == observation { busy = false } }
        do {
            guard let origin else { throw SessionFailure.invalidOrigin }
            struct Payload: Decodable { let journeys: [AtlasJourney] }
            struct Session: Decodable {
                struct User: Decodable { let id: String }
                struct Active: Decodable { let activeOrganizationId: String? }
                let user: User; let session: Active
            }
            var identity: String
            var preference = "default"
            let isGuest = guestToken != nil
            if isGuest {
                identity = "guest:\(generation.uuidString)"
            } else {
                let session = try JSONDecoder().decode(Session.self, from: await read("/api/auth/get-session"))
                guard let organization = session.session.activeOrganizationId else { throw SessionFailure.unavailable(401) }
                identity = "\(origin.absoluteString)|\(session.user.id)|\(organization)"
            }
            guard generation == request && refreshID == observation else { return }
            let payload = try JSONDecoder().decode(Payload.self, from: await read(isGuest ? "/api/shared/journeys" : "/api/journeys"))
            guard generation == request && refreshID == observation else { return }
            // Preference is account-scoped. Guest mode never reads owner endpoints.
            if !isGuest {
                struct Preferences: Decodable { let earthExperience: String }
                preference = try JSONDecoder().decode(Preferences.self, from: await read("/api/account-preferences/earth-experience")).earthExperience
                guard generation == request && refreshID == observation else { return }
                let verified = try JSONDecoder().decode(Session.self, from: await read("/api/auth/get-session"))
                guard let organization = verified.session.activeOrganizationId,
                      identity == "\(origin.absoluteString)|\(verified.user.id)|\(organization)" else { throw SessionFailure.unavailable(401) }
            }
            guard generation == request && refreshID == observation else { return }
            router.install(payload.journeys, identity: identity, access: isGuest ? .guest : .owner, earthExperience: preference)
        } catch {
            guard generation == request && refreshID == observation else { return }
            router.clear(); router.error = error.localizedDescription
        }
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
