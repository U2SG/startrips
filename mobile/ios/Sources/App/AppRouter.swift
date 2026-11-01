import SwiftUI

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

    func install(_ records: [AtlasJourney], identity newIdentity: String, access: AtlasAccess, earthExperience: String) {
        let sameIdentity = identity == newIdentity
        if !sameIdentity { clear() }
        identity = newIdentity; self.access = access
        journeys = records; self.earthExperience = earthExperience == "particle-only" ? "particle-only" : "default"
        revision += 1; seen.removeAll(); error = nil
        if !sameIdentity && access == .owner,
           defaults.string(forKey: "atlas.navigation.identity") == newIdentity,
           let data = defaults.data(forKey: "atlas.navigation.selection"),
           let saved = try? JSONDecoder().decode(StoryHandoff.self, from: data) {
            selection = current(saved)
            if defaults.bool(forKey: "atlas.navigation.story"), let selection { path = [selection] }
        }
        selection = selection.flatMap(current)
        path = path.compactMap(current)
    }

    func current(_ target: StoryHandoff) -> StoryHandoff? {
        guard let journey = journeys.first(where: { $0.id == target.journeyId }) else { return nil }
        let point = target.routePointId.flatMap { id in journey.routePoints.contains(where: { $0.id == id }) ? id : nil }
        let asset = target.assetId.flatMap { id in journey.media.contains(where: { $0.id == id && (point == nil || $0.routePointId == point) }) ? id : nil }
        return StoryHandoff(journeyId: journey.id, routePointId: point, assetId: asset,
                            revision: journey.revision, requestId: target.requestId)
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
        case .rendered: rendered = true
        case .cameraInterrupted: rendered = false
        case .ready: break
        }
    }

    func returnToAtlas() { path = []; revision += 1; onInvalidation?() }
    func sceneRestarted() { rendered = false; revision += 1; seen.removeAll() }
}
