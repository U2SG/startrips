import SwiftUI
import StartripsMedia

/// Layout and time state the native chrome hands to the globe-only scene.
struct ScenePresentation: Equatable {
    var globeOnly = false
    var insets = SceneInsets(top: 0, bottom: 0)
    var window: SceneTimeWindow?
}

/// A ribbon scrub preview: camera only, never persisted and never acknowledged.
struct ScenePreview: Equatable {
    let journeyId: String
    let routePointId: String?
    let requestId: String
}

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
    @Published var presentation = ScenePresentation()
    @Published private(set) var preview: ScenePreview?
    /// Bumped on every scene `ready`; the scene view re-sends presentation state.
    @Published private(set) var sceneReadyCount = 0
    #if DEBUG
    private(set) var completedFocusCount = 0
    #endif
    private(set) var access: AtlasAccess = .owner
    private(set) var earthExperience = "default"
    private var identity: String?
    private var seen = Set<String>()
    private let defaults: UserDefaults
    var onInvalidation: (() -> Void)?
    var onSwitchAccess: (() -> Void)?

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// True once an owner or guest Atlas has been installed for the current scope.
    var installed: Bool { identity != nil }

    var snapshot: SceneSnapshot {
        SceneSnapshot(version: SceneContract.version, scopeId: scopeId, revision: revision, access: access,
                      earthExperience: earthExperience, journeys: journeys, selection: selection, active: path.isEmpty)
    }

    func clear() {
        journeys = []; selection = nil; path = []; identity = nil; seen.removeAll()
        scopeId = UUID().uuidString; revision += 1; rendered = false
        preview = nil; presentation.window = nil
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
            guard let journeyId = event.journeyId else { return }
            commit(journeyId: journeyId, routePointId: event.routePointId, assetId: event.assetId,
                   requestId: event.requestId, story: event.kind == .story)
        case .invalidate: onInvalidation?()
        case .rendered:
            #if DEBUG
            if !rendered { completedFocusCount += 1 }
            #endif
            rendered = true
        case .cameraInterrupted: rendered = false
        case .switchAccess:
            // Only the active, trusted local Atlas may release this identity.
            guard path.isEmpty else { return }
            onSwitchAccess?()
        case .sceneFailed:
            // The scene could not read its snapshot; surface the native reload,
            // which does not depend on the WKWebView's own controls.
            guard path.isEmpty else { return }
            error = "地球数据无法读取，请刷新重试。"
        case .ready: sceneReadyCount += 1
        }
    }

    /// Native chrome selection (card swipe, route point, ribbon release). It
    /// shares the scene event's guards and persistence and mints its own request.
    @discardableResult
    func select(journeyId: String, routePointId: String? = nil) -> Bool {
        commit(journeyId: journeyId, routePointId: routePointId, assetId: nil,
               requestId: UUID().uuidString, story: false)
    }

    @discardableResult
    func openStory(journeyId: String, routePointId: String? = nil) -> Bool {
        commit(journeyId: journeyId, routePointId: routePointId, assetId: nil,
               requestId: UUID().uuidString, story: true)
    }

    /// Fly the camera to a Journey while the ribbon is being dragged.
    func previewFocus(journeyId: String?) {
        guard path.isEmpty else { return }
        guard let journeyId, journeys.contains(where: { $0.id == journeyId }) else { preview = nil; return }
        guard preview?.journeyId != journeyId else { return }
        preview = ScenePreview(journeyId: journeyId, routePointId: nil, requestId: UUID().uuidString)
    }

    func command(_ kind: SceneCommandKind, journeyId: String? = nil, routePointId: String? = nil,
                 window: SceneTimeWindow? = nil, globeOnly: Bool? = nil, insets: SceneInsets? = nil) -> SceneCommand {
        SceneCommand(version: SceneContract.version, kind: kind, scopeId: scopeId, revision: revision,
                     requestId: UUID().uuidString, journeyId: journeyId, routePointId: routePointId,
                     window: window, globeOnly: globeOnly, insets: insets)
    }

    @discardableResult
    private func commit(journeyId: String, routePointId: String?, assetId: String?,
                        requestId: String, story: Bool) -> Bool {
        guard path.isEmpty, let journey = journeys.first(where: { $0.id == journeyId }) else { return false }
        if let routePointId, !journey.routePoints.contains(where: { $0.id == routePointId }) { return false }
        preview = nil
        selection = StoryHandoff(journeyId: journey.id, routePointId: routePointId,
                                 assetId: assetId, revision: journey.revision, requestId: requestId)
        rendered = false
        if access == .owner, let selection {
            defaults.set(identity, forKey: "atlas.navigation.identity")
            defaults.set(try? JSONEncoder().encode(selection), forKey: "atlas.navigation.selection")
        }
        if story, let selection { path = [selection] }
        return true
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
