import Foundation
import Combine
import CryptoKit
import WebKit
import StartripsMedia

enum SessionFailure: LocalizedError {
    case invalidOrigin, unavailable(Int), invalidPayload
    var errorDescription: String? {
        switch self {
        case .invalidOrigin: return "Startrips 服务地址或分享链接无效，请检查后重试。"
        case .unavailable(401): return "请先登录并选择图谱，然后返回刷新。"
        case .unavailable(403), .unavailable(404): return "当前图谱或分享不可用，请重新打开。"
        case .unavailable: return "暂时无法读取图谱，请重试。"
        case .invalidPayload: return "图谱响应无法读取，请更新应用后重试。"
        }
    }
}

@MainActor
final class AtlasSession: ObservableObject {
    // Public, first-party deployment origin. Never ship a user-entered server or
    // credentials; Release always connects to the deployed Startrips backend.
    static let productionOrigin = "https://106.53.130.142"
    #if DEBUG
    @Published var originText = ProcessInfo.processInfo.arguments.contains("-allow-server-override")
        ? (UserDefaults.standard.string(forKey: "atlas.debug.origin") ?? AtlasSession.productionOrigin)
        : AtlasSession.productionOrigin
    #else
    @Published private(set) var originText = AtlasSession.productionOrigin
    #endif
    @Published var shareText = ""
    @Published var busy = false
    @Published var loginPresented = false
    // Set when the owner session is missing or expired; the shell returns to sign-in
    // instead of showing an Atlas error.
    @Published var signInRequired = false
    private(set) var origin: URL?
    private(set) var guestToken: String?
    private(set) var activeIdentity: String?
    @Published private(set) var mediaJourneys: [String: MediaJourney] = [:]
    private(set) var generation = UUID()
    private var refreshID = UUID()
    @Published private(set) var cookieStore = WKWebsiteDataStore.nonPersistent()

    #if DEBUG
    // Unit tests opt into a synthetic HTTPS site on this session instance only.
    // The override cannot be persisted or compiled into a Release app.
    private var testOriginOverride: URL?

    func configureTestOrigin(_ url: URL) throws {
        let value = try Self.validatedOrigin(url.absoluteString)
        testOriginOverride = value
        originText = value.absoluteString
    }
    #endif

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

    // A restored owner profile is only worth an Atlas request when it still holds
    // a cookie for the pinned origin; otherwise first launch goes straight to sign-in.
    func hasOwnerCredentials() async -> Bool {
        guard guestToken == nil, let origin else { return false }
        return !(await credentials(for: origin)).isEmpty
    }

    // Ends the server session when reachable, then removes every cookie from the
    // active owner profile so the next launch cannot restore it.
    func signOut() async {
        if guestToken == nil, origin != nil {
            _ = try? await api("/api/auth/sign-out", method: "POST", body: Data("{}".utf8), scope: nil)
            let store = cookieStore.httpCookieStore
            for cookie in await store.allCookies() { await store.deleteCookie(cookie) }
        }
        disconnect()
    }

    func disconnect() {
        activeIdentity = nil; mediaJourneys = [:]
        generation = UUID(); refreshID = UUID(); origin = nil; guestToken = nil; busy = false
        cookieStore = .nonPersistent()
    }

    static func isProductionOrigin(_ url: URL) -> Bool {
        guard let trusted = URL(string: productionOrigin) else { return false }
        return url.scheme == "https"
            && url.host?.lowercased() == trusted.host?.lowercased()
            && (url.port ?? 443) == (trusted.port ?? 443)
            && url.user == nil && url.password == nil
            && url.query == nil && url.fragment == nil
            && (url.path.isEmpty || url.path == "/")
    }

    static func validatedOrigin(_ text: String) throws -> URL {
        guard let url = URL(string: text), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw SessionFailure.invalidOrigin }
        #if !DEBUG
        // Shared links and restored settings must never move Release to another host.
        guard isProductionOrigin(url) else { throw SessionFailure.invalidOrigin }
        #endif
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
        #if DEBUG
        let selected = try Self.validatedOrigin(
            testOriginOverride?.absoluteString ?? (ProcessInfo.processInfo.arguments.contains("-allow-server-override") ? originText : Self.productionOrigin))
        #else
        let selected = try Self.validatedOrigin(Self.productionOrigin)
        #endif
        let site = Self.ownerStoreID(selected)
        let storeID = storeRecord(for: site).active
        Task { await cleanUnusedStores(for: site) }
        if cookieStore.identifier != storeID { cookieStore = WKWebsiteDataStore(forIdentifier: storeID) }
        origin = selected
        guestToken = nil; generation = UUID()
        #if DEBUG
        // Explicit debug-only overrides do not alter the Release server.
        if testOriginOverride == nil && ProcessInfo.processInfo.arguments.contains("-allow-server-override") { UserDefaults.standard.set(selected.absoluteString, forKey: "atlas.debug.origin") }
        #endif
    }

    private struct Login: Decodable {
        struct User: Decodable { let id: String }
        struct Active: Decodable { let activeOrganizationId: String? }
        let user: User
        let session: Active

        func identity(at origin: URL) throws -> String {
            guard let organization = session.activeOrganizationId else { throw SessionFailure.unavailable(401) }
            return "\(origin.absoluteString)|\(user.id)|\(organization)"
        }
    }

    private func credentials(for url: URL) async -> [String: String] {
        if let guestToken { return ["Authorization": "Bearer \(guestToken)"] }
        let cookies = await cookieStore.httpCookieStore.allCookies()
        let matching = cookies.filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            let host = url.host ?? ""
            let matchesPath = url.path == cookie.path || url.path.hasPrefix(cookie.path.hasSuffix("/") ? cookie.path : cookie.path + "/")
            return (host == domain || (cookie.domain.hasPrefix(".") && host.hasSuffix("." + domain)))
                && matchesPath && (cookie.expiresDate.map { $0 > Date() } ?? true)
        }
        return HTTPCookie.requestHeaderFields(with: matching)
    }

    private func perform(_ url: URL, method: String, body: Data?, headers: [String: String]) async throws -> Data {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method
        request.allHTTPHeaderFields = headers
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if method != "GET", let origin {
            var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)
            parts?.path = ""; request.setValue(parts?.string, forHTTPHeaderField: "Origin")
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        let transport = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { transport.finishTasksAndInvalidate() }
        let (data, response) = try await transport.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw MediaFailure.http(status) }
        return data
    }

    func read(_ path: String) async throws -> Data {
        do { return try await api(path, method: "GET", body: nil, scope: nil) }
        catch MediaFailure.http(let status) { throw SessionFailure.unavailable(status) }
    }

    func api(_ path: String, method: String, body: Data?, scope: String?) async throws -> Data {
        let ticket = generation
        guard let origin, path.hasPrefix("/api/"), !path.contains(".."),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host, url.scheme == "https", url.port == origin.port else { throw SessionFailure.invalidOrigin }
        let guest = guestToken != nil
        if guest && (method != "GET" || !path.hasPrefix("/api/shared/")) { throw MediaFailure.readOnly }
        if let scope, scope != activeIdentity { throw MediaFailure.accessChanged }
        let headers = await credentials(for: url)
        guard ticket == generation else { throw MediaFailure.accessChanged }
        // Reuse exactly the credentials verified here for this operation, including writes.
        if let scope, !guest {
            let loginData = try await perform(origin.appendingPathComponent("api/auth/get-session"), method: "GET", body: nil, headers: headers)
            let login = try JSONDecoder().decode(Login.self, from: loginData)
            guard try login.identity(at: origin) == scope, ticket == generation, activeIdentity == scope else { throw MediaFailure.accessChanged }
        }
        let data = try await perform(url, method: method, body: body, headers: headers)
        guard ticket == generation, scope == nil || scope == activeIdentity else { throw MediaFailure.accessChanged }
        return data
    }

    func revalidate(_ scope: String) async throws {
        guard activeIdentity == scope else { throw MediaFailure.accessChanged }
        #if DEBUG
        if scope == "synthetic-ci" && origin == nil { return }
        #endif
        let ticket = generation
        if guestToken != nil {
            _ = try await api("/api/shared/journeys", method: "GET", body: nil, scope: scope)
        } else {
            guard let origin else { throw MediaFailure.accessChanged }
            let data = try await read("/api/auth/get-session")
            let login = try JSONDecoder().decode(Login.self, from: data)
            guard try login.identity(at: origin) == scope else { throw MediaFailure.accessChanged }
        }
        guard ticket == generation, activeIdentity == scope else { throw MediaFailure.accessChanged }
    }

    func mediaJourney(_ id: String, scope: String) async throws -> MediaJourney {
        #if DEBUG
        if scope == "synthetic-ci", origin == nil, activeIdentity == scope, let result = mediaJourneys[id] { return result }
        #endif
        let data = try await api(guestToken == nil ? "/api/journeys" : "/api/shared/journeys", method: "GET", body: nil, scope: scope)
        guard let value = try Self.mediaProjection(data, guest: guestToken != nil)[id] else { throw MediaFailure.unavailable }
        return value
    }

    static func mediaProjection(_ data: Data, guest: Bool) throws -> [String: MediaJourney] {
        struct Payload: Decodable { let journeys: [MediaJourney] }
        var normalized = data
        if guest {
            // The share API expresses ordering by array position and omits each asset's parent.
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  var journeys = object["journeys"] as? [[String: Any]] else { throw SessionFailure.invalidPayload }
            for i in journeys.indices {
                guard let parent = journeys[i]["id"] as? String, var assets = journeys[i]["media"] as? [[String: Any]] else { throw SessionFailure.invalidPayload }
                for j in assets.indices { assets[j]["journeyId"] = parent; assets[j]["sortOrder"] = j }
                journeys[i]["media"] = assets
            }
            normalized = try JSONSerialization.data(withJSONObject: ["journeys": journeys])
        }
        let values = try JSONDecoder().decode(Payload.self, from: normalized).journeys
        var result: [String: MediaJourney] = [:]
        for journey in values {
            guard result[journey.id] == nil, journey.media.allSatisfy({ $0.journeyId == journey.id }) else { throw SessionFailure.invalidPayload }
            result[journey.id] = journey
        }
        return result
    }

    // A delayed server response must not overwrite a newer import/move result.
    // Only keys present in the authoritative response survive, so deletions still apply.
    static func preservingNewerMedia(_ incoming: [String: MediaJourney],
                                    previous: [String: MediaJourney]) -> [String: MediaJourney] {
        var merged = incoming
        for (id, candidate) in incoming {
            if let known = previous[id], known.revision > candidate.revision {
                merged[id] = known
            }
        }
        return merged
    }

    func replaceMedia(_ journey: MediaJourney) {
        guard (mediaJourneys[journey.id]?.revision ?? Int.min) <= journey.revision else { return }
        mediaJourneys[journey.id] = journey
    }

    #if DEBUG
    func installFixture(_ data: Data, scope: String) throws {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let snapshot = object["snapshot"] else { throw SessionFailure.invalidPayload }
        mediaJourneys = try Self.mediaProjection(JSONSerialization.data(withJSONObject: snapshot), guest: false)
        activeIdentity = scope
    }
    #endif

    func refresh(_ router: AppRouter) async {
        let request = generation
        let observation = UUID()
        refreshID = observation
        busy = true
        defer { if generation == request && refreshID == observation { busy = false } }
        let isGuest = guestToken != nil
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
            if isGuest {
                identity = "guest:\(generation.uuidString)"
            } else {
                // A signed-out profile receives `null`, not an HTTP 401.
                guard let session = try JSONDecoder().decode(Session?.self, from: await read("/api/auth/get-session")),
                      let organization = session.session.activeOrganizationId else { throw SessionFailure.unavailable(401) }
                identity = "\(origin.absoluteString)|\(session.user.id)|\(organization)"
            }
            guard generation == request && refreshID == observation else { return }
            let data = try await read(isGuest ? "/api/shared/journeys" : "/api/journeys")
            let payload = try JSONDecoder().decode(Payload.self, from: data)
            let media = try Self.mediaProjection(data, guest: isGuest)
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
            // Preserve later local media mutations only inside the same identity.
            // A different account/share always receives its own fresh projection.
            let projected = activeIdentity == identity
                ? Self.preservingNewerMedia(media, previous: mediaJourneys)
                : media
            activeIdentity = identity; mediaJourneys = projected
            router.install(payload.journeys, identity: identity, access: isGuest ? .guest : .owner,
                           earthExperience: preference, mediaJourneys: projected)
        } catch {
            guard generation == request && refreshID == observation else { return }
            activeIdentity = nil; mediaJourneys = [:]
            router.clear()
            if !isGuest, case SessionFailure.unavailable(401) = error { signInRequired = true }
            else { router.error = error.localizedDescription }
        }
    }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
