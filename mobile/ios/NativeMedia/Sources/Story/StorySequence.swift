import Foundation

public struct StoryEntry: Equatable, Identifiable, Sendable {
    public enum Role: String, Sendable { case journeyCover, media, note }
    public let id: String
    public let role: Role
    public let asset: MediaAsset?
    public let routePointId: String?
    public let chapterRoutePointId: String?
    public let note: String
}

extension MediaJourney {
    func chapterID(for point: MediaRoutePoint) -> String {
        if !point.isStop, let anchor = routePoints.first(where: { $0.id == point.stayAnchorRoutePointId }), anchor.isStop {
            return anchor.id
        }
        return point.id
    }
    func ownedMedia(_ pointID: String?) -> [MediaAsset] {
        media.filter { $0.routePointId == pointID && $0.isVisual }.sorted { $0.sortOrder < $1.sortOrder }
    }
    public func storySequence(includeCover: Bool = true) -> [StoryEntry] {
        func entry(_ asset: MediaAsset, chapter: String?) -> StoryEntry {
            StoryEntry(id: "media:\(asset.id)", role: .media, asset: asset,
                       routePointId: asset.routePointId, chapterRoutePointId: chapter,
                       note: routePoints.first { $0.id == asset.routePointId }?.note ?? note)
        }
        var result = ownedMedia(nil).map { entry($0, chapter: nil) }
        if includeCover, let cover = media.first(where: { $0.id == coverMediaAssetId && $0.isVisual })
            ?? media.filter({ $0.isVisual }).sorted(by: { $0.sortOrder < $1.sortOrder }).first {
            result.insert(StoryEntry(id: "journey-cover:\(id):\(cover.id)", role: .journeyCover,
                                     asset: cover, routePointId: nil, chapterRoutePointId: nil, note: note), at: 0)
        }
        for chapter in routePoints where chapterID(for: chapter) == chapter.id {
            for member in routePoints where chapterID(for: member) == chapter.id {
                let assets = ownedMedia(member.id)
                let text = (member.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if assets.isEmpty && !text.isEmpty {
                    result.append(StoryEntry(id: "note:\(member.id)", role: .note, asset: nil,
                                             routePointId: member.id, chapterRoutePointId: chapter.id, note: text))
                }
                result += assets.map { entry($0, chapter: chapter.id) }
            }
        }
        return result
    }
}

/// Interactive gestures are proposals until UIKit reports a completed transition.
/// Cancelling or replacing a proposal cannot change the committed return position.
public struct StoryCursor: Equatable {
    public private(set) var entries: [StoryEntry]
    public private(set) var index: Int
    public private(set) var generation = 0
    public private(set) var proposedIndex: Int?
    public var current: StoryEntry? { entries.indices.contains(index) ? entries[index] : nil }
    public init(journey: MediaJourney, intent: StoryIntent) throws {
        guard journey.id == intent.journeyId, journey.revision == intent.revision else { throw MediaFailure.staleIntent }
        entries = journey.storySequence()
        index = entries.firstIndex { $0.role != .journeyCover && intent.assetId != nil && $0.asset?.id == intent.assetId }
            ?? entries.firstIndex { intent.routePointId != nil && $0.routePointId == intent.routePointId } ?? 0
    }
    @discardableResult public mutating func propose(_ next: Int) -> Int {
        generation += 1
        proposedIndex = entries.indices.contains(next) ? next : nil
        return generation
    }
    public mutating func settle(_ token: Int, completed: Bool) {
        guard token == generation else { return }
        if completed, let next = proposedIndex { index = next }
        proposedIndex = nil
    }
    public mutating func cancel() { generation += 1; proposedIndex = nil }
}
