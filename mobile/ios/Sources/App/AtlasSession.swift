import Foundation
import Combine
import CryptoKit
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
    private(set) var generation = UUID()
    private var refreshID = UUID()
    @Published private(set) var cookieStore = WKWebsiteDataStore.nonPersistent()

    // HTTP cookies do not distinguish ports; a private store isolates each configured HTTPS origin.
    static func ownerStoreID(_ url: URL) -> UUID {
        let key = "startrips.owner.https|\(url.host?.lowercased() ?? "")|\(url.port ?? 443)"
        var bytes = Array(SHA256.hash(data: Data(key.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x80
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return bytes.withUnsafeBytes { UUID(uuid: $0.loadUnaligned(as: uuid_t.self)) }
    }

    // Publication is one main-actor operation. An asynchronous WebKit write always targets an
    // unpublished profile, so cancelling or replacing a login cannot modify the active account.
    private struct StoreRecord: Codable {
        var active: UUID
        var unused: Set<UUID> = []
    }

    private static var writingStores = Set<UUID>()

    private func storeRecord(for site: UUID) -> StoreRecord {
        guard let data = UserDefaults.standard.data(forKey: "atlas.stores." + site.uuidString),
              let record = try? JSONDecoder().decode(StoreRecord.self, from: data) else { return StoreRecord(active: site) }
        return record
    }

    private func save(_ record: StoreRecord, for site: UUID) {
        // StoreRecord contains only profile identifiers, never cookies or credentials.
        UserDefaults.standard.set(try? JSONEncoder().encode(record), forKey: "atlas.stores." + site.uuidString)
    }

    private func cleanUnusedStores(for site: UUID) async {
        for id in storeRecord(for: site).unused {
            // Another login can finish while WebKit removes a preceding entry.
            let latest = storeRecord(for: site)
            guard id != latest.active, latest.unused.contains(id), !Self.writingStores.contains(id) else { continue }
            do {
                try await WKWebsiteDataStore.remove(forIdentifier: id)
                var current = storeRecord(for: site)
                current.unused.remove(id)
                save(current, for: site)
            } catch {
                // An old sheet may still own its WKWebView. Reopening this origin retries cleanup.
            }
        }
    }

    func publishGoogleSession(_ cookie: HTTPCookie, at url: URL, generation captured: UUID,
                              pending: () -> Bool,
                              write: (HTTPCookie, WKWebsiteDataStore) async -> Void = {
                                  await $1.httpCookieStore.setCookie($0)
                              }) async -> Bool {
        guard isOwnerLoginCurrent(captured, at: url), pending() else { return false }
        let site = Self.ownerStoreID(url)
        let id = UUID()
        var record = storeRecord(for: site)
        record.unused.insert(id)
        save(record, for: site)
        Self.writingStores.insert(id)
        let candidate = WKWebsiteDataStore(forIdentifier: id)
        await write(cookie, candidate)
        Self.writingStores.remove(id)
        guard isOwnerLoginCurrent(captured, at: url), pending() else {
            await cleanUnusedStores(for: site)
            return false
        }
        // Fresh profile: neither old session_data nor the other Better Auth token name is present.
        record = storeRecord(for: site)
        record.unused.insert(record.active)
        record.unused.remove(id)
        record.active = id
        save(record, for: site)
        generation = UUID()
        cookieStore = candidate
        Task { await cleanUnusedStores(for: site) }
        return true
    }

    func isOwnerLoginCurrent(_ captured: UUID, at url: URL) -> Bool {
        loginPresented && generation == captured && origin == url && guestToken == nil
    }

    func disconnect() {
        generation = UUID(); refreshID = UUID(); origin = nil; guestToken = nil; busy = false
        cookieStore = .nonPersistent()
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
        cookieStore = .nonPersistent()
    }

    func configureOwner() throws {
        let selected = try Self.validatedOrigin(originText)
        let site = Self.ownerStoreID(selected)
        let storeID = storeRecord(for: site).active
        Task { await cleanUnusedStores(for: site) }
        if cookieStore.identifier != storeID { cookieStore = WKWebsiteDataStore(forIdentifier: storeID) }
        origin = selected
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

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
