import Foundation

public struct PlaybackPosition: Equatable, Sendable {
    public let journeyId: String
    public let routePointId: String?
    public let assetId: String?
    public init(journeyId: String, routePointId: String?, assetId: String?) {
        self.journeyId = journeyId; self.routePointId = routePointId; self.assetId = assetId
    }
}

public struct MediaReturn: Equatable, Sendable {
    public enum Reason: String, Sendable { case exited, completed }
    public enum Surface: String, Sendable { case story, atlas }
    public enum Fallback: String, Sendable { case none, assetUnavailable, routePointUnavailable, journeyUnavailable }
    public let surface: Surface
    public let reason: Reason
    public let fallback: Fallback
    public let journeyId: String?
    public let routePointId: String?
    public let assetId: String?
    public let expanded: Bool
    public let requestId: String
    public let revision: Int
}

public func resolveMediaReturn(entry: StoryIntent, committed: PlaybackPosition?, reason: MediaReturn.Reason,
                               currentRequestID: String, currentIntentRevision: Int,
                               journey: MediaJourney?, expanded: Bool) -> MediaReturn? {
    guard entry.requestId == currentRequestID, entry.revision >= currentIntentRevision else { return nil }
    func result(_ surface: MediaReturn.Surface, _ fallback: MediaReturn.Fallback,
                _ journeyID: String?, _ pointID: String? = nil, _ assetID: String? = nil) -> MediaReturn {
        MediaReturn(surface: surface, reason: reason, fallback: fallback, journeyId: journeyID,
                    routePointId: pointID, assetId: assetID, expanded: surface == .story && expanded, requestId: entry.requestId, revision: entry.revision)
    }
    guard let journey, journey.id == entry.journeyId else { return result(.atlas, .journeyUnavailable, nil) }
    if reason == .completed { return result(.atlas, .none, journey.id) }
    let target = committed.flatMap { value in
        value.journeyId == journey.id && (value.routePointId != nil || value.assetId != nil) ? value : nil
    } ?? PlaybackPosition(journeyId: entry.journeyId, routePointId: entry.routePointId, assetId: entry.assetId)
    if let id = target.assetId, let asset = journey.media.first(where: { $0.id == id }) {
        if let owner = asset.routePointId, !journey.routePoints.contains(where: { $0.id == owner }) {
            return result(.story, .routePointUnavailable, journey.id)
        }
        return result(.story, .none, journey.id, asset.routePointId, asset.id)
    }
    if let point = target.routePointId {
        guard journey.routePoints.contains(where: { $0.id == point }) else { return result(.story, .routePointUnavailable, journey.id) }
        return result(.story, target.assetId == nil ? .none : .assetUnavailable, journey.id, point)
    }
    return result(.story, target.assetId == nil ? .none : .assetUnavailable, journey.id)
}
