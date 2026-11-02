import SwiftUI
import StartripsMedia

@MainActor
final class AppRouter: ObservableObject {
    @Published private(set) var scopeId = UUID().uuidString
    @Published private(set) var revision = 0
    @Published private(set) var journeys: [AtlasJourney] = []
    @Published private(set) var selection: StoryHandoff?
    @Published var path: [StoryHandoff] = [] {
        didSet {
            if access == .owner && identity != nil { defaults.set(!path.isEmpty, forKey: "atlas.navigation.story") }
        }
    }
    @Published var error: String?
    @Published var rendered = false
    #if DEBUG
    private(set) var completedFocusCount = 0
    #endif
    private(set) var access: AtlasAccess = .owner
    private(set) var earthExperience = "default"
    private var identity: String?
    private var seen = Set<String>()
    private let defaults: UserDefaults
    var onInvalidation: (() -> Void)?

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var snapshot: SceneSnapshot {
        SceneSnapshot(version: 1, scopeId: scopeId, revision: revision, access: access,
                      earthExperience: earthExperience, journeys: journeys, selection: selection, active: path.isEmpty)
    }

    func clear() {
        journeys = []; selection = nil; path = []; identity = nil; seen.removeAll()
        scopeId = UUID().uuidString; revision += 1; rendered = false
    }

    func install(_ records: [AtlasJourney], identity newIdentity: String, access: AtlasAccess,
                 earthExperience: String, mediaJourneys: [String: MediaJourney] = [:]) {
        let sameIdentity = identity == newIdentity
        if !sameIdentity { clear() }
        identity = newIdentity; self.access = access
        journeys = records; self.earthExperience = earthExperience == "particle-only" ? "particle-only" : "default"
        revision += 1; seen.removeAll(); error = nil
        if !sameIdentity && access == .owner,
           defaults.string(forKey: "atlas.navigation.identity") == newIdentity,
           let data = defaults.data(forKey: "atlas.navigation.selection"),
           let saved = try? JSONDecoder().decode(StoryHandoff.self, from: data) {
            selection = current(saved, mediaJourney: mediaJourneys[saved.journeyId])
            if defaults.bool(forKey: "atlas.navigation.story"), let selection { path = [selection] }
        }
        // A server Atlas snapshot may lag behind a locally accepted Story/media
        // refresh. Keep the live request's position and revision until the
        // Atlas projection catches up; otherwise playback and close go stale.
        let activeStory = sameIdentity ? path.last : nil
        selection = selection.flatMap {
            projectForInstalledAtlas($0, activeStory: activeStory, mediaJourney: mediaJourneys[$0.journeyId])
        }
        path = path.compactMap {
            projectForInstalledAtlas($0, activeStory: activeStory, mediaJourney: mediaJourneys[$0.journeyId])
        }
    }

    private func projectForInstalledAtlas(_ target: StoryHandoff, activeStory: StoryHandoff?,
                                          mediaJourney: MediaJourney?) -> StoryHandoff? {
        guard let projected = current(target, mediaJourney: mediaJourney) else { return nil }
        guard let activeStory, activeStory.journeyId == target.journeyId,
              activeStory.requestId == target.requestId,
              projected.revision < activeStory.revision else { return projected }
        return StoryHandoff(journeyId: target.journeyId, routePointId: target.routePointId,
                            assetId: target.assetId, revision: activeStory.revision, requestId: target.requestId)
    }

    func current(_ target: StoryHandoff, mediaJourney: MediaJourney? = nil) -> StoryHandoff? {
        guard let journey = journeys.first(where: { $0.id == target.journeyId }) else { return nil }
        // A successful local import/move can advance the scoped media source before
        // the separately fetched Atlas scene. Use that newer projection only for
        // the matching Journey; the old scene must not discard its new asset ID.
        if let mediaJourney, mediaJourney.id == journey.id,
           mediaJourney.revision > journey.revision,
           mediaJourney.revision >= target.revision {
            let point = target.routePointId.flatMap { id in
                mediaJourney.routePoints.contains(where: { $0.id == id }) ? id : nil
            }
            let asset = target.assetId.flatMap { id in
                mediaJourney.media.contains(where: { candidate in
                    candidate.id == id && candidate.journeyId == journey.id &&
                    (target.routePointId == nil || (point != nil && candidate.routePointId == point)) &&
                    (candidate.routePointId == nil ||
                     mediaJourney.routePoints.contains(where: { $0.id == candidate.routePointId }))
                }) ? id : nil
            }
            return StoryHandoff(journeyId: journey.id, routePointId: point, assetId: asset,
                                revision: mediaJourney.revision, requestId: target.requestId)
        }
        let point = target.routePointId.flatMap { id in journey.routePoints.contains(where: { $0.id == id }) ? id : nil }
        let asset = target.assetId.flatMap { id in journey.media.contains(where: { $0.id == id && (point == nil || $0.routePointId == point) }) ? id : nil }
        return StoryHandoff(journeyId: journey.id, routePointId: point, assetId: asset,
                            revision: journey.revision, requestId: target.requestId)
    }

    // Accept one authoritative media refresh while Story is still the current
    // navigation destination. A different request or newer navigation must not
    // be retargeted by a late refresh.
    func acceptStoryRevision(journeyId: String, requestId: String, from oldRevision: Int, to newRevision: Int) -> Bool {
        guard newRevision >= oldRevision, let live = path.last,
              live.journeyId == journeyId, live.requestId == requestId,
              live.revision == oldRevision || live.revision == newRevision else { return false }
        guard live.revision != newRevision else { return true }
        let advanced = StoryHandoff(journeyId: live.journeyId, routePointId: live.routePointId,
                                    assetId: live.assetId, revision: newRevision, requestId: live.requestId)
        path[path.count - 1] = advanced
        selection = advanced
        if access == .owner, let identity {
            defaults.set(identity, forKey: "atlas.navigation.identity")
            defaults.set(try? JSONEncoder().encode(advanced), forKey: "atlas.navigation.selection")
        }
        return true
    }

    func receive(_ event: SceneEvent) {
        do { try validateSceneEvent(event, snapshot: snapshot) } catch { return }
        guard seen.insert(event.requestId).inserted else { return }
        if seen.count > 256 { seen = [event.requestId] }
        switch event.kind {
        case .select, .story:
            guard path.isEmpty else { return }
            guard let journey = journeys.first(where: { $0.id == event.journeyId }) else { return }
            selection = StoryHandoff(journeyId: journey.id, routePointId: event.routePointId,
                                     assetId: event.assetId, revision: journey.revision, requestId: event.requestId)
            rendered = false
            if access == .owner, let selection {
                defaults.set(identity, forKey: "atlas.navigation.identity")
                defaults.set(try? JSONEncoder().encode(selection), forKey: "atlas.navigation.selection")
            }
            if event.kind == .story, let selection { path = [selection] }
        case .invalidate: onInvalidation?()
        case .rendered:
            #if DEBUG
            if !rendered { completedFocusCount += 1 }
            #endif
            rendered = true
        case .cameraInterrupted: rendered = false
        case .ready: break
        }
    }

    func commitStoryPosition(_ target: StoryHandoff, mediaJourney: MediaJourney? = nil) {
        guard let live = path.last, live.requestId == target.requestId,
              live.journeyId == target.journeyId,
              let resolved = current(target, mediaJourney:
                  (mediaJourney?.revision ?? Int.min) >= live.revision ? mediaJourney : nil) else { return }
        // The Atlas projection can lag behind the media refresh. Keep the
        // revision accepted by the active navigation destination.
        let committed = StoryHandoff(journeyId: resolved.journeyId, routePointId: resolved.routePointId,
                                     assetId: resolved.assetId, revision: live.revision, requestId: live.requestId)
        selection = committed
        if access == .owner, let identity {
            defaults.set(identity, forKey: "atlas.navigation.identity")
            defaults.set(try? JSONEncoder().encode(committed), forKey: "atlas.navigation.selection")
        }
    }

    func returnToAtlas() { path = []; revision += 1; onInvalidation?() }
    func sceneRestarted() { rendered = false; revision += 1; seen.removeAll() }
}
