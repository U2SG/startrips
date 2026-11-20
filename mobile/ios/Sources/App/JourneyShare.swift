import Foundation
import StartripsMedia

/// The web share dialog's expiry choices (`SHARE_EXPIRY_PRESETS`). There is
/// deliberately no permanent link.
enum ShareExpiry: String, CaseIterable, Identifiable {
    case day, week, month, custom
    var id: String { rawValue }

    var label: String {
        switch self {
        case .day: return "1 天"
        case .week: return "7 天"
        case .month: return "30 天"
        case .custom: return "自定义"
        }
    }

    var days: Int? {
        switch self {
        case .day: return 1
        case .week: return 7
        case .month: return 30
        case .custom: return nil
        }
    }
}

enum ShareFailure: LocalizedError, Equatable {
    case tooSoon, tooFar, invalid, missing, invalidLink

    var errorDescription: String? {
        switch self {
        case .tooSoon: return "失效时间至少要比现在晚一分钟。"
        case .tooFar: return "失效时间最长为一年。"
        case .invalid: return "分享设置无效，请检查后重试。"
        case .missing: return "这段旅程或链接已不存在。"
        case .invalidLink: return "分享链接无法生成，请重试。"
        }
    }

    /// Writes surface `MediaFailure.http`, reads `SessionFailure.unavailable`.
    static func map(_ error: Error) -> Error {
        let status: Int
        if case .http(let value)? = error as? MediaFailure { status = value }
        else if case .unavailable(let value)? = error as? SessionFailure { status = value }
        else { return error }
        switch status {
        case 400: return ShareFailure.invalid
        case 404: return ShareFailure.missing
        default: return error
        }
    }
}

/// `POST /api/shares` for one Journey, validated like the web dialog
/// (`resolveShareExpiry`) so the owner learns which bound they crossed.
struct ShareRequest: Equatable {
    /// The server's `MAX_SHARE_LIFETIME_MS`; the client's one-minute floor.
    static let maximumLifetime: TimeInterval = 365 * 24 * 60 * 60
    static let minimumLifetime: TimeInterval = 60

    var journeyId: String
    var expiry: ShareExpiry = .week
    var customExpiry: Date
    /// nil shares every media of the Journey; a list, even an empty one, is the link's whole media scope.
    var mediaAssetIds: [String]?

    init(journeyId: String, customExpiry: Date) {
        self.journeyId = journeyId; self.customExpiry = customExpiry
    }

    /// A preset is measured from `now`, the moment of the request, never from when the sheet opened.
    func expiresAt(now: Date) throws -> Date {
        let value = expiry.days.map { now.addingTimeInterval(TimeInterval($0) * 86_400) } ?? customExpiry
        let lifetime = value.timeIntervalSince(now)
        if lifetime < Self.minimumLifetime { throw ShareFailure.tooSoon }
        if lifetime > Self.maximumLifetime { throw ShareFailure.tooFar }
        return value
    }

    func body(now: Date) throws -> Data {
        var body: [String: Any] = [
            "journeyIds": [journeyId],
            "expiresAt": ShareDates.wire.string(from: try expiresAt(now: now)),
        ]
        if let mediaAssetIds { body["mediaAssetIds"] = mediaAssetIds }
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }
}

enum ShareDates {
    /// `Date.prototype.toISOString()`: UTC with milliseconds.
    static let wire: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    static func parse(_ value: String) -> Date? {
        wire.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// The exact instant in the owner's zone, like the web `formatShareExpiry`.
    static func display(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }
}

/// One row of `GET /api/shares`. It never carries a token: the server stores only a hash.
struct ShareGrant: Decodable, Identifiable, Equatable {
    struct JourneyRef: Decodable, Equatable { let id: String; let title: String }
    let id: String
    let createdAt: String
    let expiresAt: String
    let status: String
    let journeyCount: Int
    let journeys: [JourneyRef]

    /// The server's status is the floor; the local clock may only expire a link, never revive one.
    func isActive(at now: Date) -> Bool {
        guard status == "active" else { return false }
        return ShareDates.parse(expiresAt).map { $0 > now } ?? true
    }

    /// The links that still open this Journey right now, newest first.
    static func active(_ grants: [ShareGrant], journeyId: String, now: Date) -> [ShareGrant] {
        grants.filter { grant in grant.isActive(at: now) && grant.journeys.contains { $0.id == journeyId } }
            .sorted { (ShareDates.parse($0.createdAt) ?? .distantPast) > (ShareDates.parse($1.createdAt) ?? .distantPast) }
    }
}

/// A freshly created link. The token exists only inside `link`, held in view
/// state for the system share sheet; it is never logged, persisted or listed.
struct CreatedShare: Identifiable {
    let id: String
    let link: URL

    /// Nil once its grant is revoked, so the share sheet can never send a dead link.
    func unlessRevoked(_ grantId: String) -> CreatedShare? { id == grantId ? nil : self }

    /// `<origin>/share#<token>`: the fragment never reaches a server, log or preview bot.
    static func link(origin: URL, token: String) throws -> URL {
        guard token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { throw ShareFailure.invalidLink }
        components.path = "/share"; components.query = nil; components.fragment = token
        guard let url = components.url else { throw ShareFailure.invalidLink }
        return url
    }
}

/// Owner share links for one Atlas.
@MainActor
protocol ShareStore {
    func list() async throws -> [ShareGrant]
    func create(_ request: ShareRequest) async throws -> CreatedShare
    func revoke(_ id: String) async throws
}

/// The live owner API through `AtlasSession.api`: every call is bound to the
/// installed Atlas identity and carries the first-party Origin.
@MainActor
struct LiveShareStore: ShareStore {
    let session: AtlasSession
    var now: () -> Date = Date.init

    static func revokePath(_ id: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return "/api/shares/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id) + "/revoke"
    }

    private func call(_ path: String, _ method: String, _ body: Data?) async throws -> Data {
        guard let scope = session.activeIdentity else { throw MediaFailure.accessChanged }
        do { return try await session.api(path, method: method, body: body, scope: scope) }
        catch { throw ShareFailure.map(error) }
    }

    func list() async throws -> [ShareGrant] {
        struct Payload: Decodable { let shares: [ShareGrant] }
        return try JSONDecoder().decode(Payload.self, from: await call("/api/shares", "GET", nil)).shares
    }

    func create(_ request: ShareRequest) async throws -> CreatedShare {
        struct Payload: Decodable {
            struct Share: Decodable { let id: String }
            let share: Share
            let token: String
        }
        guard let origin = session.origin else { throw SessionFailure.invalidOrigin }
        let payload = try JSONDecoder().decode(Payload.self, from: await call("/api/shares", "POST", request.body(now: now())))
        return CreatedShare(id: payload.share.id, link: try CreatedShare.link(origin: origin, token: payload.token))
    }

    func revoke(_ id: String) async throws { _ = try await call(Self.revokePath(id), "POST", nil) }
}

#if DEBUG
/// XCUITest-only store for the synthetic Atlas: no network, same contract.
@MainActor
final class FixtureShareStore: ShareStore {
    private var grants: [ShareGrant]

    /// One active link for the first fixture Journey, so revoke is reachable without a create.
    init(journey: AtlasJourney?, now: Date = Date()) {
        grants = journey.map { journey in
            [ShareGrant(id: "share-fixture", createdAt: ShareDates.wire.string(from: now.addingTimeInterval(-3600)),
                        expiresAt: ShareDates.wire.string(from: now.addingTimeInterval(7 * 86_400)), status: "active",
                        journeyCount: 1, journeys: [.init(id: journey.id, title: journey.title)])]
        } ?? []
    }

    func list() async throws -> [ShareGrant] { grants }

    func create(_ request: ShareRequest) async throws -> CreatedShare {
        let now = Date()
        let expiresAt = try request.expiresAt(now: now)
        let id = UUID().uuidString.lowercased()
        grants.append(ShareGrant(id: id, createdAt: ShareDates.wire.string(from: now),
                                 expiresAt: ShareDates.wire.string(from: expiresAt), status: "active",
                                 journeyCount: 1, journeys: [.init(id: request.journeyId, title: "")]))
        let token = String(repeating: "A", count: 43)
        return CreatedShare(id: id, link: try CreatedShare.link(origin: URL(string: "https://startrips.invalid")!, token: token))
    }

    func revoke(_ id: String) async throws {
        guard let index = grants.firstIndex(where: { $0.id == id }) else { throw ShareFailure.missing }
        let grant = grants[index]
        grants[index] = ShareGrant(id: grant.id, createdAt: grant.createdAt, expiresAt: grant.expiresAt, status: "revoked",
                                   journeyCount: grant.journeyCount, journeys: grant.journeys)
    }
}
#endif
