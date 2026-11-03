import Foundation

public struct MediaMoveUndo: Codable, Equatable {
    public struct Placement: Codable, Equatable { public let assetId: String; public let routePointId: String? }
    public let sourceJourneyId: String
    public let targetJourneyId: String
    public let assetIds: [String]
    public let targetRoutePointId: String?
    public let sourceOrder: [String]
    public let targetOrder: [String]
    public let sourceCoverMediaAssetId: String?
    public let placements: [Placement]
}

@MainActor public final class MediaMoveController {
    public struct Result: Decodable {
        public let sourceJourney: MediaJourney
        public let destinationJourney: MediaJourney
        public let undo: MediaMoveUndo
    }
    private struct Pair: Decodable { let sourceJourney: MediaJourney; let destinationJourney: MediaJourney }
    private struct Single: Decodable { let journey: MediaJourney }
    private let session: ScopedMediaSession
    private let refresh: (MediaJourney, MediaJourney) -> Void
    private var undoToken: Data?
    private var crossJourney = false
    private var inFlight = false
    public init(session: ScopedMediaSession, refresh: @escaping (MediaJourney, MediaJourney) -> Void) {
        self.session = session; self.refresh = refresh
    }
    public func move(source: MediaJourney, targetJourneyID: String, routePointID: String?, assetIDs: [String]) async throws {
        guard !inFlight else { throw MediaFailure.uploadPending }
        inFlight = true; defer { inFlight = false }
        guard !assetIDs.isEmpty, Set(assetIDs).count == assetIDs.count,
              assetIDs.allSatisfy({ id in source.media.contains { $0.id == id } }) else { throw MediaFailure.unavailable }
        let cross = source.id != targetJourneyID
        var object: [String: Any] = ["journeyId": source.id, "assetIds": assetIDs, "routePointId": routePointID as Any? ?? NSNull()]
        if cross { object["targetJourneyId"] = targetJourneyID }
        let data = try await session.write("/api/uploads/assets/move", body: JSONSerialization.data(withJSONObject: object))
        if cross {
            let result = try JSONDecoder().decode(Result.self, from: data)
            guard result.sourceJourney.id == source.id, result.destinationJourney.id == targetJourneyID else { throw MediaFailure.staleIntent }
            // Preserve required JSON nulls. Synthesized Swift Encodable omits nil fields,
            // but parseUndoMediaMoveInput requires explicit null placement/cover values.
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = object["undo"] as? [String: Any] else { throw MediaFailure.invalidUpload }
            undoToken = try JSONSerialization.data(withJSONObject: token)
            refresh(result.sourceJourney, result.destinationJourney)
        } else {
            let result = try JSONDecoder().decode(Single.self, from: data)
            let placements: [[String: Any]] = source.media.filter { assetIDs.contains($0.id) }.map {
                ["assetId": $0.id, "routePointId": $0.routePointId as Any? ?? NSNull()]
            }
            undoToken = try JSONSerialization.data(withJSONObject: [
                "journeyId": source.id, "expectedRoutePointId": routePointID as Any? ?? NSNull(),
                "assignments": placements, "assetOrder": source.media.sorted { $0.sortOrder < $1.sortOrder }.map(\.id)
            ])
            refresh(result.journey, result.journey)
        }
        crossJourney = cross
    }
    public func undo() async throws {
        guard !inFlight else { throw MediaFailure.uploadPending }
        inFlight = true; defer { inFlight = false }
        guard let token = undoToken else { return }
        let data = try await session.write("/api/uploads/assets/move/undo", body: token)
        if crossJourney {
            let result = try JSONDecoder().decode(Pair.self, from: data)
            refresh(result.sourceJourney, result.destinationJourney)
        } else {
            let result = try JSONDecoder().decode(Single.self, from: data); refresh(result.journey, result.journey)
        }
        undoToken = nil
    }
}
