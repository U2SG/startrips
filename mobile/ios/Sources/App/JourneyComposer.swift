import Foundation
import StartripsMedia

/// One Route Point row in the native composer. `persistedId` is the server id
/// (nil for a new point); `id` only keeps SwiftUI rows stable.
struct RouteDraftPoint: Identifiable {
    let id: String
    var persistedId: String?
    var latitude: Double
    var longitude: Double
    var label: String
    var isStop: Bool
    /// Echoed unchanged: the server clears a missing or null `occurredAt`.
    var occurredAt: String?

    init(persistedId: String? = nil, latitude: Double, longitude: Double, label: String,
         isStop: Bool, occurredAt: String? = nil) {
        id = persistedId ?? UUID().uuidString
        self.persistedId = persistedId
        self.latitude = latitude; self.longitude = longitude
        self.label = label; self.isStop = isStop; self.occurredAt = occurredAt
    }

    init(_ point: AtlasRoutePoint) {
        self.init(persistedId: point.id, latitude: point.latitude, longitude: point.longitude,
                  label: point.label, isStop: point.isStop, occurredAt: point.occurredAt)
    }
}

extension RouteDraftPoint: Equatable {
    /// Content equality; the SwiftUI row id is not part of the route.
    static func == (lhs: RouteDraftPoint, rhs: RouteDraftPoint) -> Bool {
        lhs.persistedId == rhs.persistedId && lhs.latitude == rhs.latitude && lhs.longitude == rhs.longitude
            && lhs.label == rhs.label && lhs.isStop == rhs.isStop && lhs.occurredAt == rhs.occurredAt
    }
}

/// The editable fields of `POST /api/journeys` and `PATCH /api/journeys/:id`,
/// validated like the web composer (`validateJourneyInput`).
struct JourneyDraft: Equatable {
    static let lightColors = ["#f4ce73", "#e99578", "#77c8c2", "#8ca8df", "#c49bd8"]
    static let maxRoutePoints = 64

    var title = ""
    var startedOn: String
    var endedOn: String?
    var note = ""
    var lightColor = JourneyDraft.lightColors[0]
    /// Echoed unchanged: the server clears an omitted light effect.
    var lightEffect: String?
    /// The server revision this draft was read from; nil for a new Journey.
    var revision: Int?
    var points: [RouteDraftPoint] = []

    init(startedOn: String) { self.startedOn = startedOn }

    init(_ journey: AtlasJourney) {
        title = journey.title; startedOn = journey.startedOn; endedOn = journey.endedOn
        note = journey.note; lightColor = journey.lightColor; lightEffect = journey.lightEffect
        revision = journey.revision; points = journey.routePoints.map(RouteDraftPoint.init)
    }

    static func new(today: Date = Date()) -> JourneyDraft {
        JourneyDraft(startedOn: calendarDay.string(from: today))
    }

    /// `YYYY-MM-DD` in the device calendar day, matching the web date input.
    static let calendarDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func isCalendarDate(_ value: String) -> Bool {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
              !value.hasPrefix("0000-") else { return false }
        let strict = DateFormatter()
        strict.calendar = Calendar(identifier: .gregorian)
        strict.locale = Locale(identifier: "en_US_POSIX")
        strict.timeZone = TimeZone(identifier: "UTC")
        strict.dateFormat = "yyyy-MM-dd"
        strict.isLenient = false
        return strict.date(from: value).map { strict.string(from: $0) == value } ?? false
    }

    private static func instant(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// Same rules and wording as the web composer; the first error is shown.
    var validationErrors: [String] {
        var errors: [String] = []
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        // JavaScript string length counts UTF-16 units; the server limit is in those units.
        if trimmedTitle.isEmpty || trimmedTitle.utf16.count > 80 { errors.append("旅程标题不能为空且不能超过 80 个字符") }
        if !Self.isCalendarDate(startedOn) { errors.append("开始日期无效") }
        if let endedOn {
            if !Self.isCalendarDate(endedOn) { errors.append("结束日期无效") }
            else if endedOn < startedOn { errors.append("结束日期不能早于开始日期") }
        }
        if note.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > 2000 { errors.append("旅程故事不能超过 2000 个字符") }
        if points.isEmpty || points.count > Self.maxRoutePoints { errors.append("路线必须包含 1 到 \(Self.maxRoutePoints) 个点") }
        var last: Date?
        for (index, point) in points.enumerated() {
            if !(-90...90).contains(point.latitude) { errors.append("路线点 \(index + 1) 的纬度无效") }
            if !(-180...180).contains(point.longitude) { errors.append("路线点 \(index + 1) 的经度无效") }
            let label = point.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if label.utf16.count > 120 { errors.append("路线点 \(index + 1) 的标签不能超过 120 个字符") }
            if point.isStop && label.isEmpty { errors.append("停靠点 \(index + 1) 需要地点标签") }
            if let occurredAt = point.occurredAt {
                guard let time = Self.instant(occurredAt) else { errors.append("路线点 \(index + 1) 的时间无效"); continue }
                if let last, time < last { errors.append("路线点时间必须按旅程顺序递增") }
                last = time
            }
        }
        return errors
    }

    /// The JSON body. New points carry no id; existing points omit their note,
    /// region, role, overview and stay fields so the server preserves them.
    func requestBody() throws -> Data {
        var body: [String: Any] = [
            "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
            "startedOn": startedOn,
            "endedOn": endedOn ?? NSNull(),
            "note": note.trimmingCharacters(in: .whitespacesAndNewlines),
            "lightColor": lightColor,
            "lightEffect": lightEffect ?? NSNull(),
            "routePoints": points.map { point -> [String: Any] in
                var value: [String: Any] = [
                    "latitude": point.latitude,
                    "longitude": point.longitude,
                    "label": point.label.trimmingCharacters(in: .whitespacesAndNewlines),
                    "isStop": point.isStop,
                    "occurredAt": point.occurredAt ?? NSNull(),
                ]
                if let id = point.persistedId { value["id"] = id }
                return value
            },
        ]
        if let revision { body["revision"] = revision }
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    /// Three-way merge after a stale save. Each field keeps the member's edit
    /// when they changed it and otherwise takes the newer server value. When
    /// both sides changed the route, the newer route wins and the member's new
    /// points are appended. The result is shown for review, never saved silently.
    static func merge(base: JourneyDraft, mine: JourneyDraft, theirs: JourneyDraft) -> JourneyDraft {
        var result = theirs
        if mine.title != base.title { result.title = mine.title }
        if mine.startedOn != base.startedOn { result.startedOn = mine.startedOn }
        if mine.endedOn != base.endedOn { result.endedOn = mine.endedOn }
        if mine.note != base.note { result.note = mine.note }
        if mine.lightColor != base.lightColor { result.lightColor = mine.lightColor }
        if mine.points != base.points {
            if theirs.points == base.points {
                // Points the server removed meanwhile cannot be kept by id.
                let live = Set(theirs.points.compactMap(\.persistedId))
                result.points = mine.points.filter { $0.persistedId.map(live.contains) ?? true }
            } else {
                let added = mine.points.filter { $0.persistedId == nil }
                result.points = Array((theirs.points + added).prefix(maxRoutePoints))
            }
        }
        result.revision = theirs.revision
        return result
    }
}

/// A place from `/api/locations/search` or `/api/locations/reverse`.
struct PlaceResult: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let labelLocal: String?
    let context: String
    let latitude: Double
    let longitude: Double

    init(id: String, label: String, labelLocal: String? = nil, context: String, latitude: Double, longitude: Double) {
        self.id = id; self.label = label; self.labelLocal = labelLocal; self.context = context
        self.latitude = latitude; self.longitude = longitude
    }

    /// The Chinese local name when the provider has one, like the web composer.
    var preferredLabel: String {
        if let labelLocal, labelLocal.range(of: #"\p{Han}"#, options: .regularExpression) != nil { return labelLocal }
        return label
    }
}

struct PlaceAttribution: Decodable, Equatable { let label: String }

struct PlaceSearch: Equatable {
    var results: [PlaceResult]
    var attribution: PlaceAttribution?
}

enum JourneyWriteFailure: LocalizedError, Equatable {
    /// 409 JOURNEY_ROUTE_CHANGED: the Journey changed since this draft was read.
    case routeChanged
    case invalid, missing

    var errorDescription: String? {
        switch self {
        case .routeChanged: return "旅程已在别处更新"
        case .invalid: return "旅程内容无效，请检查后重试。"
        case .missing: return "这段旅程已不存在。"
        }
    }

    /// Writes surface `MediaFailure.http`, reads `SessionFailure.unavailable`.
    static func map(_ error: Error) -> Error {
        let status: Int
        if case .http(let value)? = error as? MediaFailure { status = value }
        else if case .unavailable(let value)? = error as? SessionFailure { status = value }
        else { return error }
        switch status {
        case 409: return JourneyWriteFailure.routeChanged
        case 400: return JourneyWriteFailure.invalid
        case 404: return JourneyWriteFailure.missing
        default: return error
        }
    }
}

/// Owner Journey writes and place lookups used by the composer.
@MainActor
protocol JourneyStore {
    func create(_ draft: JourneyDraft) async throws -> AtlasJourney
    func update(_ id: String, _ draft: JourneyDraft) async throws -> AtlasJourney
    func load(_ id: String) async throws -> AtlasJourney
    func delete(_ id: String) async throws
    func restore(_ id: String) async throws -> AtlasJourney
    func search(_ query: String, near: (latitude: Double, longitude: Double)?) async throws -> PlaceSearch
    func reverse(latitude: Double, longitude: Double) async throws -> PlaceResult?
}

/// The live owner API. Every write is bound to the installed Atlas identity
/// (`AtlasSession.api` re-verifies it and adds the first-party Origin).
@MainActor
struct LiveJourneyStore: JourneyStore {
    let session: AtlasSession

    private struct Envelope: Decodable { let journey: AtlasJourney }

    static func journeyPath(_ id: String, _ suffix: String = "") -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return "/api/journeys/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id) + suffix
    }

    static func searchPath(_ query: String, near: (latitude: Double, longitude: Double)?) -> String {
        var components = URLComponents()
        components.path = "/api/locations/search"
        var items = [URLQueryItem(name: "q", value: query)]
        if let near { items += [URLQueryItem(name: "lat", value: String(near.latitude)), URLQueryItem(name: "lon", value: String(near.longitude))] }
        components.queryItems = items
        // `+` is literal in URLComponents queries but a space to the server.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.string ?? "/api/locations/search"
    }

    private func write(_ path: String, _ method: String, _ body: Data?) async throws -> Data {
        guard let scope = session.activeIdentity else { throw JourneyWriteFailure.missing }
        do { return try await session.api(path, method: method, body: body, scope: scope) }
        catch { throw JourneyWriteFailure.map(error) }
    }

    private func journey(_ data: Data) throws -> AtlasJourney {
        try JSONDecoder().decode(Envelope.self, from: data).journey
    }

    func create(_ draft: JourneyDraft) async throws -> AtlasJourney {
        var fresh = draft; fresh.revision = nil
        return try journey(await write("/api/journeys", "POST", fresh.requestBody()))
    }

    func update(_ id: String, _ draft: JourneyDraft) async throws -> AtlasJourney {
        try journey(await write(Self.journeyPath(id), "PATCH", draft.requestBody()))
    }

    func load(_ id: String) async throws -> AtlasJourney {
        do { return try journey(await session.read(Self.journeyPath(id))) }
        catch { throw JourneyWriteFailure.map(error) }
    }

    func delete(_ id: String) async throws { _ = try await write(Self.journeyPath(id), "DELETE", nil) }

    func restore(_ id: String) async throws -> AtlasJourney {
        try journey(await write(Self.journeyPath(id, "/restore"), "POST", nil))
    }

    func search(_ query: String, near: (latitude: Double, longitude: Double)?) async throws -> PlaceSearch {
        struct Payload: Decodable { let results: [PlaceResult]; let attribution: PlaceAttribution? }
        let payload = try JSONDecoder().decode(Payload.self, from: await session.read(Self.searchPath(query, near: near)))
        return PlaceSearch(results: payload.results, attribution: payload.attribution)
    }

    func reverse(latitude: Double, longitude: Double) async throws -> PlaceResult? {
        struct Payload: Decodable { let result: PlaceResult? }
        let path = "/api/locations/reverse?latitude=\(latitude)&longitude=\(longitude)"
        return try JSONDecoder().decode(Payload.self, from: await session.read(path)).result
    }
}

#if DEBUG
/// XCUITest-only store for the synthetic Atlas: no network, same contract.
/// `-atlas-composer-conflict` makes the first update answer 409.
@MainActor
final class FixtureJourneyStore: JourneyStore {
    private var journeys: [String: AtlasJourney]
    private var deleted: [String: AtlasJourney] = [:]
    private var conflictPending: Bool

    init(journeys: [AtlasJourney], conflictOnce: Bool) {
        self.journeys = Dictionary(uniqueKeysWithValues: journeys.map { ($0.id, $0) })
        conflictPending = conflictOnce
    }

    private func make(_ id: String, _ draft: JourneyDraft, revision: Int, media: [AtlasAsset]) -> AtlasJourney {
        AtlasJourney(id: id, title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
                     startedOn: draft.startedOn, endedOn: draft.endedOn,
                     note: draft.note.trimmingCharacters(in: .whitespacesAndNewlines),
                     lightColor: draft.lightColor, lightEffect: draft.lightEffect, routeSegments: nil, revision: revision,
                     routePoints: draft.points.map {
                         AtlasRoutePoint(id: $0.persistedId ?? UUID().uuidString.lowercased(), latitude: $0.latitude,
                                         longitude: $0.longitude, label: $0.label, isStop: $0.isStop, occurredAt: $0.occurredAt)
                     }, media: media)
    }

    func create(_ draft: JourneyDraft) async throws -> AtlasJourney {
        let created = make(UUID().uuidString.lowercased(), draft, revision: 1, media: [])
        journeys[created.id] = created
        return created
    }

    func update(_ id: String, _ draft: JourneyDraft) async throws -> AtlasJourney {
        guard var current = journeys[id] else { throw JourneyWriteFailure.missing }
        if conflictPending {
            // Someone else renamed the Journey meanwhile.
            conflictPending = false
            current = AtlasJourney(id: current.id, title: current.title + "（已更新）", startedOn: current.startedOn,
                                   endedOn: current.endedOn, note: current.note, lightColor: current.lightColor,
                                   lightEffect: current.lightEffect, routeSegments: current.routeSegments,
                                   revision: current.revision + 1, routePoints: current.routePoints, media: current.media)
            journeys[id] = current
        }
        guard draft.revision == current.revision else { throw JourneyWriteFailure.routeChanged }
        let updated = make(id, draft, revision: current.revision + 1, media: current.media)
        journeys[id] = updated
        return updated
    }

    func load(_ id: String) async throws -> AtlasJourney {
        guard let journey = journeys[id] else { throw JourneyWriteFailure.missing }
        return journey
    }

    func delete(_ id: String) async throws {
        guard let journey = journeys.removeValue(forKey: id) else { throw JourneyWriteFailure.missing }
        deleted[id] = journey
    }

    func restore(_ id: String) async throws -> AtlasJourney {
        guard let journey = deleted.removeValue(forKey: id) else { throw JourneyWriteFailure.missing }
        journeys[id] = journey
        return journey
    }

    func search(_ query: String, near: (latitude: Double, longitude: Double)?) async throws -> PlaceSearch {
        PlaceSearch(results: [
            PlaceResult(id: "fixture-kyoto", label: "Kyoto", labelLocal: "京都", context: "日本", latitude: 35.0116, longitude: 135.7681),
            PlaceResult(id: "fixture-nara", label: "Nara", labelLocal: "奈良", context: "日本", latitude: 34.6851, longitude: 135.8048),
        ], attribution: PlaceAttribution(label: "OpenStreetMap"))
    }

    func reverse(latitude: Double, longitude: Double) async throws -> PlaceResult? { nil }
}
#endif
