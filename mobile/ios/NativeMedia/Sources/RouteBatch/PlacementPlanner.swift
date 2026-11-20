import Foundation

/// Normalized capture evidence for one picked file, the same shape as the web
/// `MediaPlacementSignal`. Raw EXIF never leaves `PlacementSignalReader`.
public struct PlacementSignal: Codable, Equatable, Sendable {
    public var latitude: Double?
    public var longitude: Double?
    /// ISO instant with an explicit offset or `Z`.
    public var capturedAt: String?
    /// Wall clock without a timezone.
    public var capturedLocal: String?
    public var spatialSource: String?
    public var spatialGranularity: String?
    public var accuracyMeters: Double?
    public var captureTimeSource: String?
    public var timezoneState: String?
    public var offsetMinutes: Int?

    public init(latitude: Double? = nil, longitude: Double? = nil, capturedAt: String? = nil, capturedLocal: String? = nil,
                spatialSource: String? = nil, spatialGranularity: String? = nil, accuracyMeters: Double? = nil,
                captureTimeSource: String? = nil, timezoneState: String? = nil, offsetMinutes: Int? = nil) {
        self.latitude = latitude; self.longitude = longitude; self.capturedAt = capturedAt; self.capturedLocal = capturedLocal
        self.spatialSource = spatialSource; self.spatialGranularity = spatialGranularity; self.accuracyMeters = accuracyMeters
        self.captureTimeSource = captureTimeSource; self.timezoneState = timezoneState; self.offsetMinutes = offsetMinutes
    }

    var hasCoordinateEvidence: Bool {
        guard let latitude, let longitude, latitude.isFinite, longitude.isFinite else { return false }
        if spatialSource == nil && spatialGranularity == nil { return true }
        return spatialGranularity == "coordinate" && spatialSource != nil && spatialSource != "unknown"
    }
}

/// The parts of a Journey the planner reads.
public struct PlacementJourney: Codable, Equatable, Sendable {
    public struct Point: Codable, Equatable, Sendable {
        public var id: String
        public var latitude: Double
        public var longitude: Double
        public var occurredAt: String?
        public init(id: String, latitude: Double, longitude: Double, occurredAt: String?) {
            self.id = id; self.latitude = latitude; self.longitude = longitude; self.occurredAt = occurredAt
        }
    }
    public var id: String
    public var revision: Int
    public var startedOn: String?
    public var endedOn: String?
    public var routePoints: [Point]
    public init(id: String, revision: Int, startedOn: String?, endedOn: String?, routePoints: [Point]) {
        self.id = id; self.revision = revision; self.startedOn = startedOn; self.endedOn = endedOn; self.routePoints = routePoints
    }
    public init(_ journey: MediaJourney) {
        self.init(id: journey.id, revision: journey.revision, startedOn: journey.startedOn, endedOn: journey.endedOn,
                  routePoints: journey.routePoints.map {
                      Point(id: $0.id, latitude: $0.latitude, longitude: $0.longitude, occurredAt: $0.occurredAt)
                  })
    }
}

/// One picked file. `id` is the stable file identity; the array position only
/// breaks ties deterministically, exactly as the web selection order does.
public struct PlacementInput: Equatable, Sendable {
    public var id: String
    public var signal: PlacementSignal?
    public init(id: String, signal: PlacementSignal?) { self.id = id; self.signal = signal }
}

public struct PlacementBasis: Codable, Equatable, Sendable {
    public var reason: String
    public var evidence: [String]
    public var uncertainty: [String]
    public init(reason: String, evidence: [String], uncertainty: [String]) {
        self.reason = reason; self.evidence = evidence; self.uncertainty = uncertainty
    }
}

public struct PlacementPlan: Equatable, Sendable {
    public struct Existing: Equatable, Sendable { public var routePointId: String; public var files: [String]; public var basis: PlacementBasis }
    public struct Candidate: Equatable, Sendable {
        public var candidateId: String
        public var files: [String]
        public var representative: String
        public var latitude: Double
        public var longitude: Double
        public var basis: PlacementBasis
    }
    public struct Pending: Equatable, Sendable { public var files: [String]; public var basis: PlacementBasis }
    public var algorithmVersion: String
    public var batchId: String
    public var journeyId: String
    public var routeRevision: Int
    public var matchExisting: [Existing]
    public var suggestNew: [Candidate]
    public var pendingConfirmation: [Pending]
}

public enum PlacementPlanError: Error, Equatable { case missingBatch, tooManyInputs, duplicateFile }

/// Swift port of `planMediaPlacementProposals` (src/journey/mediaPlacement.ts,
/// `route-point-proposal-v1`). Both ports run the shared fixture
/// `Tests/Fixtures/route-point-proposals.json`; change them together.
public enum PlacementPlanner {
    public static let algorithmVersion = "route-point-proposal-v1"
    static let neighborDistanceKm = 2.0
    static let timeWindowHours = 12.0
    static let maxClusterDiameterKm = 5.0
    static let maxAutomaticAccuracyMeters = 500.0
    static let maxPlausibleSpeedKmh = 1_200.0
    public static let maxInputs = 1_000
    static let gpsStrongDistanceKm = 25.0
    static let timeStrongDeltaHours = 24.0
    static let minRouteScore = 0.58
    static let minJourneyScore = 0.5
    static let minScoreMargin = 0.09

    // MARK: Existing-destination scoring (suggestMediaPlacement)

    struct Suggestion {
        var routePointId: String?
        var score: Double
        var evidence: [String]
        var distanceKm: Double?
        var timeDeltaHours: Double?
        var strongGps = false
        var strongTime = false
    }

    static func spatialScore(_ km: Double) -> Double {
        if km <= 1 { return 0.68 }
        if km <= 5 { return 0.62 }
        if km <= 20 { return 0.5 }
        if km <= 75 { return 0.32 }
        if km <= 150 { return 0.18 }
        return 0
    }

    static func signalDateKey(_ signal: PlacementSignal) -> String? {
        PlacementTime.dateKey(signal.capturedLocal) ?? PlacementTime.dateKey(signal.capturedAt)
    }

    static func journeyContainsDate(_ journey: PlacementJourney, _ captureDate: String?) -> Bool {
        guard let captureDate, let capture = PlacementTime.dateOrdinal(captureDate),
              let startedOn = journey.startedOn, let start = PlacementTime.dateOrdinal(startedOn),
              let end = PlacementTime.dateOrdinal(journey.endedOn ?? startedOn) else { return false }
        return capture >= start && capture <= end
    }

    static func absoluteTime(_ signal: PlacementSignal, _ point: PlacementJourney.Point) -> (score: Double, hours: Double)? {
        guard let capture = PlacementTime.instantMillis(signal.capturedAt),
              let occurred = PlacementTime.instantMillis(point.occurredAt) else { return nil }
        let hours = abs(capture - occurred) / 3_600_000
        let score: Double
        if hours <= 2 { score = 0.48 } else if hours <= 8 { score = 0.42 } else if hours <= 24 { score = 0.34 }
        else if hours <= 72 { score = 0.2 } else if hours <= 168 { score = 0.1 } else { score = 0 }
        return (score, hours)
    }

    static func localDateTimeScore(_ signal: PlacementSignal, _ point: PlacementJourney.Point) -> Double {
        guard signal.capturedAt == nil || signal.capturedAt == "", let local = signal.capturedLocal, !local.isEmpty,
              point.occurredAt != nil,
              let captureDate = PlacementTime.dateKey(local), let pointDate = PlacementTime.dateKey(point.occurredAt),
              let captureOrdinal = PlacementTime.dateOrdinal(captureDate),
              let pointOrdinal = PlacementTime.dateOrdinal(pointDate) else { return 0 }
        switch abs(captureOrdinal - pointOrdinal) {
        case 0: return 0.28
        case 1: return 0.1
        default: return 0
        }
    }

    static func routeCandidate(_ signal: PlacementSignal, _ journey: PlacementJourney, _ point: PlacementJourney.Point) -> Suggestion? {
        let distanceKm = signal.hasCoordinateEvidence
            ? haversineKm(signal.latitude!, signal.longitude!, point.latitude, point.longitude) : nil
        let gpsScore = distanceKm.map(spatialScore) ?? 0
        let absolute = absoluteTime(signal, point)
        let timeScore = absolute?.score ?? localDateTimeScore(signal, point)
        let containsDate = journeyContainsDate(journey, signalDateKey(signal))
        // The planner always scores inside its own Journey: the context bonus applies.
        let contextBonus = 0.04
        let score = gpsScore + timeScore + (containsDate ? 0.12 : 0) + contextBonus
        if gpsScore == 0 && timeScore == 0 { return nil }
        var evidence: [String] = []
        if gpsScore > 0 { evidence.append("gps") }
        if timeScore > 0 { evidence.append("time") }
        if containsDate { evidence.append("journey-date") }
        evidence.append("current-context")
        return Suggestion(routePointId: point.id, score: score, evidence: evidence, distanceKm: distanceKm,
                          timeDeltaHours: absolute?.hours,
                          strongGps: distanceKm.map { $0 <= gpsStrongDistanceKm } ?? false,
                          strongTime: absolute.map { $0.hours <= timeStrongDeltaHours } ?? false)
    }

    static func journeyCandidate(_ signal: PlacementSignal, _ journey: PlacementJourney) -> Suggestion? {
        guard journeyContainsDate(journey, signalDateKey(signal)) else { return nil }
        return Suggestion(routePointId: nil, score: 0.52 + 0.04, evidence: ["journey-date", "current-context"])
    }

    private static func strongest(_ candidates: [Suggestion], _ include: (Suggestion) -> Bool,
                                  by key: (Suggestion) -> Double?) -> Suggestion? {
        candidates.filter { $0.routePointId != nil && include($0) }.min { left, right in
            let l = key(left) ?? .infinity, r = key(right) ?? .infinity
            return l != r ? l < r : (left.routePointId ?? "") < (right.routePointId ?? "")
        }
    }

    static func evidenceConflict(_ candidates: [Suggestion]) -> Bool {
        guard let spatial = strongest(candidates, { $0.strongGps }, by: { $0.distanceKm }),
              let temporal = strongest(candidates, { $0.strongTime }, by: { $0.timeDeltaHours }) else { return false }
        return spatial.routePointId != temporal.routePointId
    }

    static func routeCandidates(_ signal: PlacementSignal, _ journey: PlacementJourney) -> [Suggestion] {
        journey.routePoints.compactMap { routeCandidate(signal, journey, $0) }
    }

    static func suggest(_ signal: PlacementSignal, _ journey: PlacementJourney) -> Suggestion? {
        let hasTime = !(signal.capturedAt ?? "").isEmpty || !(signal.capturedLocal ?? "").isEmpty
        guard signal.hasCoordinateEvidence || hasTime else { return nil }
        let routes = routeCandidates(signal, journey)
        // Strong GPS and strong absolute time pointing at different places is a
        // conflict, not permission to average two contradictory facts.
        if evidenceConflict(routes) { return nil }
        let candidates = (routes + [journeyCandidate(signal, journey)].compactMap { $0 }).sorted { left, right in
            if left.score != right.score { return left.score > right.score }
            if (left.routePointId != nil) != (right.routePointId != nil) { return left.routePointId != nil }
            return (left.routePointId ?? "") < (right.routePointId ?? "")
        }
        guard let best = candidates.first else { return nil }
        if best.score < (best.routePointId != nil ? minRouteScore : minJourneyScore) { return nil }
        // A Route Point and its parent Journey are not competing destinations.
        let second = candidates.first { candidate in
            candidate.routePointId != best.routePointId && !(best.routePointId != nil && candidate.routePointId == nil)
        }
        if let second, best.score - second.score < minScoreMargin { return nil }
        return best
    }

    // MARK: Proposal plan

    private struct Identity {
        var file: String
        var order: Int
        var signal: PlacementSignal?
        var time: PlacementTime.Proposal
    }

    private static func compare(_ left: Identity, _ right: Identity) -> Bool {
        if left.time.rank != right.time.rank { return left.time.rank < right.time.rank }
        let l = left.time.value ?? .infinity, r = right.time.value ?? .infinity
        if l != r { return l < r }
        return left.order < right.order
    }

    private static func evidence(_ identity: Identity) -> [String] {
        var values: [String] = []
        if let signal = identity.signal, signal.hasCoordinateEvidence {
            values.append("coordinate:" + (signal.spatialSource ?? "normalized"))
        }
        if identity.time.kind == .absolute { values.append("time:absolute") }
        if identity.time.kind == .local { values.append("time:local-only") }
        return values
    }

    private static func uncertainty(_ identity: Identity) -> [String] {
        var values: [String] = []
        if identity.time.kind == .local { values.append("local-time-no-offset") }
        if identity.time.kind == .unknown { values.append("capture-time-unknown") }
        if let accuracy = identity.signal?.accuracyMeters, accuracy.isFinite {
            if accuracy > maxAutomaticAccuracyMeters { values.append("accuracy-too-coarse") }
        } else {
            values.append("accuracy-unknown")
        }
        return values
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    private static func distance(_ left: Identity, _ right: Identity) -> Double {
        haversineKm(left.signal!.latitude!, left.signal!.longitude!, right.signal!.latitude!, right.signal!.longitude!)
    }

    private static func implausibleSpeed(_ identities: [Identity]) -> Set<String> {
        let timed = identities.filter { identity in
            guard let signal = identity.signal, signal.hasCoordinateEvidence,
                  let accuracy = signal.accuracyMeters, accuracy.isFinite, accuracy >= 0 else { return false }
            return identity.time.kind == .absolute
        }.sorted(by: compare)
        var invalid = Set<String>()
        for index in timed.indices.dropFirst() {
            let previous = timed[index - 1], current = timed[index]
            let deltaHours = (current.time.value! - previous.time.value!) / 3_600_000
            let adjusted = max(0, distance(previous, current)
                - ((previous.signal!.accuracyMeters ?? 0) + (current.signal!.accuracyMeters ?? 0)) / 1_000)
            let implausible = deltaHours <= 0
                ? adjusted > maxClusterDiameterKm
                : adjusted / deltaHours > maxPlausibleSpeedKmh
            if implausible { invalid.insert(previous.file); invalid.insert(current.file) }
        }
        return invalid
    }

    private static func pending(_ identity: Identity, _ reason: String, _ extra: [String] = []) -> PlacementPlan.Pending {
        PlacementPlan.Pending(files: [identity.file], basis: PlacementBasis(
            reason: reason, evidence: evidence(identity), uncertainty: unique(uncertainty(identity) + extra)))
    }

    private static func compatibleTimes(_ left: Identity, _ right: Identity) -> Bool {
        guard left.time.kind != .unknown, left.time.kind == right.time.kind,
              let l = left.time.value, let r = right.time.value else { return false }
        return abs(l - r) / 3_600_000 <= timeWindowHours
    }

    private static func canJoin(_ cluster: [Identity], _ candidate: Identity) -> Bool {
        if cluster.isEmpty { return true }
        var withinNeighbor = false
        for member in cluster {
            let km = distance(member, candidate)
            if km > maxClusterDiameterKm || !compatibleTimes(member, candidate) { return false }
            if km <= neighborDistanceKm { withinNeighbor = true }
        }
        return withinNeighbor
    }

    private static func candidate(_ cluster: [Identity]) -> PlacementPlan.Candidate {
        let ordered = cluster.sorted(by: compare)
        let representative = ordered.min { left, right in
            let l = left.signal?.accuracyMeters.flatMap { $0.isFinite ? $0 : nil } ?? .infinity
            let r = right.signal?.accuracyMeters.flatMap { $0.isFinite ? $0 : nil } ?? .infinity
            return l != r ? l < r : compare(left, right)
        }!
        let files = ordered.sorted { $0.order < $1.order }.map(\.file)
        var doubt = unique(ordered.flatMap(uncertainty))
        if ordered.count == 1 { doubt.append("single-observation-candidate") }
        return PlacementPlan.Candidate(
            candidateId: "new:" + files[0], files: files, representative: representative.file,
            latitude: representative.signal!.latitude!, longitude: representative.signal!.longitude!,
            basis: PlacementBasis(reason: ordered.count == 1 ? "single-observation-candidate" : "spatiotemporal-cluster",
                                  evidence: unique(ordered.flatMap(evidence)), uncertainty: unique(doubt)))
    }

    /// Build a proposal only from normalized evidence. It never persists a
    /// Route Point and never turns uncertain time or precision into fact.
    public static func plan(_ inputs: [PlacementInput], journey: PlacementJourney, batchId: String) throws -> PlacementPlan {
        guard !batchId.isEmpty else { throw PlacementPlanError.missingBatch }
        guard inputs.count <= maxInputs else { throw PlacementPlanError.tooManyInputs }
        guard Set(inputs.map(\.id)).count == inputs.count, !inputs.contains(where: { $0.id.isEmpty }) else {
            throw PlacementPlanError.duplicateFile
        }
        let identities = inputs.enumerated().map { order, input in
            Identity(file: input.id, order: order, signal: input.signal, time: PlacementTime.proposal(input.signal))
        }
        let speed = implausibleSpeed(identities)
        var existing: [PlacementPlan.Existing] = []
        var pendingGroups: [PlacementPlan.Pending] = []
        var eligible: [Identity] = []
        for identity in identities.sorted(by: compare) {
            guard let signal = identity.signal, signal.hasCoordinateEvidence else {
                pendingGroups.append(pending(identity, "missing-coordinate-evidence")); continue
            }
            guard let accuracy = signal.accuracyMeters, accuracy.isFinite, accuracy >= 0 else {
                pendingGroups.append(pending(identity, "accuracy-unknown")); continue
            }
            if accuracy > maxAutomaticAccuracyMeters { pendingGroups.append(pending(identity, "accuracy-too-coarse")); continue }
            if identity.time.kind == .unknown { pendingGroups.append(pending(identity, "missing-time-evidence")); continue }
            if speed.contains(identity.file) {
                pendingGroups.append(pending(identity, "implausible-speed", ["speed-conflict"])); continue
            }
            let routes = routeCandidates(signal, journey)
            if evidenceConflict(routes) {
                pendingGroups.append(pending(identity, "conflicting-route-evidence", ["gps-time-conflict"])); continue
            }
            if let suggestion = suggest(signal, journey), let point = suggestion.routePointId,
               let km = suggestion.distanceKm, km <= gpsStrongDistanceKm {
                existing.append(PlacementPlan.Existing(routePointId: point, files: [identity.file], basis: PlacementBasis(
                    reason: "existing-route-point-evidence",
                    evidence: unique(evidence(identity) + suggestion.evidence.map { "placement:" + $0 }),
                    uncertainty: uncertainty(identity))))
                continue
            }
            if routes.contains(where: { $0.routePointId != nil && $0.strongGps }) {
                pendingGroups.append(pending(identity, "ambiguous-existing-route")); continue
            }
            eligible.append(identity)
        }
        var clusters: [[Identity]] = []
        for identity in eligible.sorted(by: compare) {
            if let index = clusters.firstIndex(where: { canJoin($0, identity) }) { clusters[index].append(identity) }
            else { clusters.append([identity]) }
        }
        return PlacementPlan(algorithmVersion: algorithmVersion, batchId: batchId, journeyId: journey.id,
                             routeRevision: journey.revision, matchExisting: existing,
                             suggestNew: clusters.map(candidate), pendingConfirmation: pendingGroups)
    }

    public static func haversineKm(_ latA: Double, _ lonA: Double, _ latB: Double, _ lonB: Double) -> Double {
        let radians = Double.pi / 180
        let a1 = latA * radians, a2 = latB * radians
        let sinLat = sin((latB - latA) * radians / 2), sinLon = sin((lonB - lonA) * radians / 2)
        let a = sinLat * sinLat + cos(a1) * cos(a2) * sinLon * sinLon
        return 6371.0088 * 2 * atan2(a.squareRoot(), max(0, 1 - a).squareRoot())
    }
}

/// Exact, timezone-free calendar arithmetic shared by the planner and reader.
enum PlacementTime {
    enum Kind { case absolute, local, unknown }
    struct Proposal {
        var kind: Kind
        var value: Double?
        var rank: Int { kind == .absolute ? 0 : kind == .local ? 1 : 2 }
    }

    static func groups(_ pattern: String, _ text: String?) -> [String?]? {
        guard let text, let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<match.numberOfRanges).map { Range(match.range(at: $0), in: text).map { String(text[$0]) } }
    }

    static func isValidDate(_ year: Int, _ month: Int, _ day: Int) -> Bool {
        guard year > 0, (1...12).contains(month), day >= 1 else { return false }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        return day <= days
    }

    /// Days since 1970-01-01 in the proleptic Gregorian calendar.
    static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    static func civil(_ days: Int) -> (year: Int, month: Int, day: Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        return (yoe + era * 400 + (month <= 2 ? 1 : 0), month, day)
    }

    static func dateKey(_ value: String?) -> String? {
        guard let parts = groups(#"^(\d{4})-(\d{2})-(\d{2})(?=$|T)"#, value),
              let y = Int(parts[1] ?? ""), let m = Int(parts[2] ?? ""), let d = Int(parts[3] ?? ""),
              isValidDate(y, m, d) else { return nil }
        return "\(parts[1]!)-\(parts[2]!)-\(parts[3]!)"
    }

    static func dateOrdinal(_ value: String) -> Int? {
        guard let key = dateKey(value), key == value else { return nil }
        let parts = key.split(separator: "-").compactMap { Int($0) }
        return daysFromCivil(parts[0], parts[1], parts[2])
    }

    static func millis(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int, _ s: Int, _ ms: Int) -> Double {
        Double(daysFromCivil(y, mo, d)) * 86_400_000 + Double(h * 3_600_000 + mi * 60_000 + s * 1_000 + ms)
    }

    static func fractionMillis(_ fraction: String?) -> Int {
        Int(String((fraction ?? "").prefix(3)).padding(toLength: 3, withPad: "0", startingAt: 0)) ?? 0
    }

    /// An ISO instant with an explicit offset; strings without one are not instants.
    static func instantMillis(_ value: String?) -> Double? {
        guard let p = groups(#"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$"#, value),
              let y = Int(p[1]!), let mo = Int(p[2]!), let d = Int(p[3]!), let h = Int(p[4]!), let mi = Int(p[5]!),
              isValidDate(y, mo, d), h <= 23, mi <= 59 else { return nil }
        let s = Int(p[6] ?? "0") ?? 0
        guard s <= 59 else { return nil }
        var offset = 0
        if p[8] == nil, let sign = p[9], let oh = Int(p[10]!), let om = Int(p[11]!) {
            guard oh <= 23, om <= 59 else { return nil }
            offset = (sign == "-" ? -1 : 1) * (oh * 60 + om)
        }
        return millis(y, mo, d, h, mi, s, fractionMillis(p[7])) - Double(offset) * 60_000
    }

    static func localMillis(_ value: String?) -> Double? {
        guard let p = groups(#"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$"#, value),
              let y = Int(p[1]!), let mo = Int(p[2]!), let d = Int(p[3]!),
              let h = Int(p[4]!), let mi = Int(p[5]!), let s = Int(p[6]!),
              isValidDate(y, mo, d), h <= 23, mi <= 59, s <= 59 else { return nil }
        return millis(y, mo, d, h, mi, s, fractionMillis(p[7]))
    }

    static func proposal(_ signal: PlacementSignal?) -> Proposal {
        guard let signal else { return Proposal(kind: .unknown, value: nil) }
        if signal.timezoneState != "local-only", signal.timezoneState != "unknown",
           let capturedAt = signal.capturedAt,
           capturedAt.range(of: #"(?:Z|[+-]\d{2}:\d{2})$"#, options: [.regularExpression, .caseInsensitive]) != nil,
           let value = instantMillis(capturedAt) {
            return Proposal(kind: .absolute, value: value)
        }
        if let value = localMillis(signal.capturedLocal) { return Proposal(kind: .local, value: value) }
        return Proposal(kind: .unknown, value: nil)
    }

    /// `Date.prototype.toISOString` for an exact millisecond instant.
    static func isoString(_ millis: Double) -> String {
        let total = Int(millis.rounded(.down))
        let days = Int((Double(total) / 86_400_000).rounded(.down))
        var rest = total - days * 86_400_000
        let date = civil(days)
        let h = rest / 3_600_000; rest %= 3_600_000
        let mi = rest / 60_000; rest %= 60_000
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", date.year, date.month, date.day, h, mi, rest / 1000, rest % 1000)
    }
}
