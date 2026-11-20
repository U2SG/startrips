import Foundation

/// One reviewable group of picked files. A proposal is never a persisted Route
/// Point; files are named by their stable ids, never by array position.
public struct RouteBatchGroup: Codable, Equatable, Identifiable, Sendable {
    public enum Destination: String, Codable, Sendable { case existing, new, unplaced }
    public var id: String
    public var files: [String]
    public var destination: Destination
    public var routePointId: String?
    public var label: String
    public var latitude: Double?
    public var longitude: Double?
    public var occurredAt: String?
    public var spatialSource: String
    public var accuracyMeters: Double?
    public var basis: PlacementBasis
    public var representative: String?
    public var manual: Bool

    /// Unplaced media, any uncertainty, or a manual change needs the owner's eye.
    public var needsConfirmation: Bool { destination == .unplaced || manual || !basis.uncertainty.isEmpty }
}

public enum RouteBatchAction: Equatable, Sendable {
    case rename(String, String)
    case reposition(String, latitude: Double, longitude: Double)
    case assign(String, routePointId: String?)
    case split(String, file: String)
    case merge(String, other: String)
    case move(String, by: Int)
    case autoOrganize(Bool)
}

public enum RouteBatchError: Error, Equatable, LocalizedError {
    case stale, unknownGroup, invalidEdit, incompleteUpload, conflictingDuplicate, incompleteDraft, invalidOperation
    public var errorDescription: String? {
        switch self {
        case .stale: return "旅程已更新，请重新选择照片。"
        case .conflictingDuplicate: return "同一张照片被分到了不同地点。"
        case .incompleteDraft: return "新途径点需要名称和位置。"
        default: return "这项修改无效。"
        }
    }
}

/// Swift port of `routePointBatchDraft.ts`: the editable review of one plan,
/// scoped to one Journey revision and one picked selection.
public struct RouteBatchDraft: Codable, Equatable, Sendable {
    public static let newLabel = "新途径点"
    public var batchId: String
    public var journeyId: String
    public var routeRevision: Int
    /// Every picked file id in selection order.
    public var files: [String]
    public var groups: [RouteBatchGroup]
    public var nextGroupNumber: Int
    /// Only for this batch; never a preference.
    public var autoOrganize: Bool

    public init(plan: PlacementPlan, journey: MediaJourney, signals: [String: PlacementSignal], files: [String]) throws {
        guard plan.journeyId == journey.id, plan.routeRevision == journey.revision, !files.isEmpty else { throw RouteBatchError.stale }
        batchId = plan.batchId; journeyId = journey.id; routeRevision = journey.revision
        self.files = files; nextGroupNumber = 1; autoOrganize = false
        let order = Dictionary(uniqueKeysWithValues: files.enumerated().map { ($1, $0) })
        func group(_ id: String, _ members: [String], _ destination: RouteBatchGroup.Destination, _ point: String?,
                   _ latitude: Double?, _ longitude: Double?, _ label: String, _ basis: PlacementBasis,
                   _ representative: String?) -> RouteBatchGroup {
            let signal = signals[representative ?? members[0]]
            let accuracy = signal?.accuracyMeters.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
            return RouteBatchGroup(
                id: id, files: members.sorted { order[$0, default: .max] < order[$1, default: .max] },
                destination: destination, routePointId: point, label: label, latitude: latitude, longitude: longitude,
                // A local wall clock is not an instant; never coerce it through the device timezone.
                occurredAt: signal?.timezoneState == "offset-known" ? signal?.capturedAt : nil,
                spatialSource: signal?.spatialSource ?? "unknown", accuracyMeters: accuracy, basis: basis,
                representative: representative, manual: false)
        }
        var groups: [RouteBatchGroup] = []
        for match in plan.matchExisting {
            guard let point = journey.routePoints.first(where: { $0.id == match.routePointId }) else { throw RouteBatchError.stale }
            groups.append(group("existing:\(point.id):\(match.files[0])", match.files, .existing, point.id,
                                point.latitude, point.longitude, point.label, match.basis, match.files[0]))
        }
        for candidate in plan.suggestNew {
            groups.append(group(candidate.candidateId, candidate.files, .new, nil, candidate.latitude, candidate.longitude,
                                Self.newLabel, candidate.basis, candidate.representative))
        }
        for pending in plan.pendingConfirmation {
            groups.append(group("unplaced:\(pending.files[0])", pending.files, .unplaced, nil, nil, nil, "",
                                pending.basis, pending.files[0]))
        }
        self.groups = groups
        try checkCoverage()
    }

    func checkCoverage() throws {
        var seen = Set<String>()
        for group in groups {
            guard !group.files.isEmpty else { throw RouteBatchError.invalidEdit }
            for file in group.files { guard seen.insert(file).inserted else { throw RouteBatchError.invalidEdit } }
        }
        guard seen == Set(files), seen.count == files.count else { throw RouteBatchError.invalidEdit }
    }

    private func sortedFiles(_ values: [String]) -> [String] {
        let order = Dictionary(uniqueKeysWithValues: files.enumerated().map { ($1, $0) })
        return values.sorted { order[$0, default: .max] < order[$1, default: .max] }
    }

    public func editing(_ action: RouteBatchAction, journey: MediaJourney) throws -> RouteBatchDraft {
        guard journey.id == journeyId, journey.revision == routeRevision else { throw RouteBatchError.stale }
        var next = self
        if case .autoOrganize(let enabled) = action { next.autoOrganize = enabled; return next }
        let id: String
        switch action {
        case .rename(let value, _), .reposition(let value, _, _), .assign(let value, _), .split(let value, _),
             .merge(let value, _), .move(let value, _): id = value
        case .autoOrganize: return next
        }
        guard let index = next.groups.firstIndex(where: { $0.id == id }) else { throw RouteBatchError.unknownGroup }
        var group = next.groups[index]
        switch action {
        case .move(_, let step):
            let target = index + step
            guard next.groups.indices.contains(target) else { return self }
            next.groups.swapAt(index, target)
            return next
        case .rename(_, let value):
            guard group.destination == .new else { throw RouteBatchError.invalidEdit }
            // The server limit counts UTF-16 units, like JavaScript.
            var label = value
            while label.utf16.count > 120 { label.removeLast() }
            group.label = label
        case .reposition(_, let latitude, let longitude):
            guard latitude.isFinite, longitude.isFinite, abs(latitude) <= 90, abs(longitude) <= 180 else {
                throw RouteBatchError.invalidEdit
            }
            if group.destination != .new { group.label = Self.newLabel }
            group.destination = .new; group.routePointId = nil
            group.latitude = latitude; group.longitude = longitude
            group.spatialSource = "manual"
            group.accuracyMeters = nil // A manual choice cannot inherit EXIF precision.
        case .assign(_, let routePointId):
            let point = try routePointId.map { id in
                guard let point = journey.routePoints.first(where: { $0.id == id }) else { throw RouteBatchError.invalidEdit }
                return point
            }
            group.destination = point == nil ? .unplaced : .existing
            group.routePointId = point?.id
            group.latitude = point?.latitude; group.longitude = point?.longitude
            group.label = point?.label ?? ""
            group.spatialSource = "manual"; group.accuracyMeters = nil
        case .split(_, let file):
            guard group.files.count > 1, group.files.contains(file) else { throw RouteBatchError.invalidEdit }
            group.files.removeAll { $0 == file }
            // Neither half may borrow another photo's location or time.
            group.representative = nil
            group.destination = .unplaced; group.routePointId = nil; group.label = ""
            group.latitude = nil; group.longitude = nil; group.accuracyMeters = nil
            group.spatialSource = "unknown"; group.occurredAt = nil
            let basis = PlacementBasis(reason: "manual-split", evidence: [], uncertainty: ["requires-review"])
            group.basis = basis; group.manual = true
            var split = group
            split.id = "manual:\(next.nextGroupNumber)"
            split.files = [file]
            split.representative = file
            next.groups[index] = group
            next.groups.insert(split, at: index + 1)
            next.nextGroupNumber += 1
            return next
        case .merge(_, let otherId):
            guard let otherIndex = next.groups.firstIndex(where: { $0.id == otherId }), otherIndex != index else {
                throw RouteBatchError.invalidEdit
            }
            let other = next.groups[otherIndex]
            group.files = sortedFiles(group.files + other.files)
            // A merge is a grouping decision, not evidence that every file shares a place.
            if group.destination != other.destination || group.routePointId != other.routePointId
                || (group.destination == .new && (group.latitude != other.latitude || group.longitude != other.longitude)) {
                group.destination = .unplaced; group.routePointId = nil
                group.latitude = nil; group.longitude = nil; group.label = ""
            }
            group.accuracyMeters = nil
            group.occurredAt = nil
            group.spatialSource = "manual"
            group.basis = PlacementBasis(reason: "manual-merge", evidence: [], uncertainty: ["requires-review"])
            group.manual = true
            next.groups[index] = group
            next.groups.remove(at: otherIndex)
            try next.checkCoverage()
            return next
        case .autoOrganize:
            return next
        }
        group.manual = true
        next.groups[index] = group
        return next
    }

    /// Every group is complete, conflict-free, unedited and confident.
    public var canAutoOrganize: Bool {
        autoOrganize && !groups.isEmpty && groups.allSatisfy { group in
            !group.manual && group.destination != .unplaced && !group.files.isEmpty
                && group.basis.uncertainty.isEmpty && !group.basis.evidence.isEmpty
                && (group.destination == .existing || group.basis.reason == "spatiotemporal-cluster")
        }
    }

    /// Turning the per-batch opt-in on may submit at once; no other edit can.
    public func shouldAutoSubmit(after action: RouteBatchAction) -> Bool {
        action == .autoOrganize(true) && canAutoOrganize
    }

    public var isComplete: Bool {
        groups.allSatisfy { group in
            group.destination != .new || (!group.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && group.latitude != nil && group.longitude != nil)
        }
    }

    /// Drops files the server never confirmed. A new group whose representative
    /// was lost is not placed: its coordinate and time belonged to that file.
    public func removingFiles(_ lost: Set<String>) -> RouteBatchDraft {
        guard !lost.isEmpty else { return self }
        var next = self
        next.files = files.filter { !lost.contains($0) }
        next.autoOrganize = false
        next.groups = groups.compactMap { group in
            var kept = group
            kept.files = group.files.filter { !lost.contains($0) }
            guard !kept.files.isEmpty else { return nil }
            if let representative = group.representative, lost.contains(representative) {
                kept.representative = nil
                if group.destination == .new && group.spatialSource != "manual" {
                    kept.destination = .unplaced; kept.label = ""; kept.latitude = nil; kept.longitude = nil
                    kept.occurredAt = nil; kept.spatialSource = "unknown"; kept.accuracyMeters = nil; kept.manual = true
                    kept.basis = PlacementBasis(reason: "missing-coordinate-evidence", evidence: [], uncertainty: ["requires-review"])
                }
            }
            return kept
        }
        return next
    }

    /// `POST /api/journeys/:id/route-point-batches`. Nil when every file stays
    /// at Journey level, so nothing needs a batch.
    public func applyBody(assets: [String: String], operationId: String) throws -> Data? {
        try checkCoverage()
        guard operationId.range(of: #"^[A-Za-z0-9._:-]{1,120}$"#, options: .regularExpression) != nil else {
            throw RouteBatchError.invalidOperation
        }
        struct Point: Encodable {
            let candidateId: String, latitude: Double, longitude: Double, label: String, isStop = true, occurredAt: String?
        }
        struct Attachment: Encodable {
            let assetId: String, candidateId: String?, routePointId: String?, intentionalReuse = false
        }
        struct Body: Encodable { let operationId: String, baseRevision: Int, points: [Point], attachments: [Attachment] }
        var placements: [String: (destination: RouteBatchGroup.Destination, point: String?, candidate: String?)] = [:]
        var assetOrder: [String] = []
        for group in groups {
            for file in group.files {
                guard let asset = assets[file] else { throw RouteBatchError.incompleteUpload }
                let next = (destination: group.destination,
                            point: group.destination == .existing ? group.routePointId : nil,
                            candidate: group.destination == .new ? group.id : nil)
                if let prior = placements[asset] {
                    // The server can deduplicate identical files onto one asset.
                    guard prior.destination == next.destination, prior.point == next.point, prior.candidate == next.candidate else {
                        throw RouteBatchError.conflictingDuplicate
                    }
                    continue
                }
                placements[asset] = next; assetOrder.append(asset)
            }
        }
        var points: [Point] = []
        for group in groups where group.destination == .new {
            let label = group.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, let latitude = group.latitude, let longitude = group.longitude else { throw RouteBatchError.incompleteDraft }
            points.append(Point(candidateId: group.id, latitude: latitude, longitude: longitude, label: label, occurredAt: group.occurredAt))
        }
        let attachments = assetOrder.compactMap { asset -> Attachment? in
            let placement = placements[asset]!
            guard placement.destination != .unplaced else { return nil }
            return Attachment(assetId: asset, candidateId: placement.candidate, routePointId: placement.point)
        }
        guard !attachments.isEmpty else { return nil }
        return try JSONEncoder().encode(Body(operationId: operationId, baseRevision: routeRevision, points: points, attachments: attachments))
    }
}
