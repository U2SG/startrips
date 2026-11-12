import SwiftUI
import StartripsMedia

struct StoryDestination: View {
    let target: StoryHandoff
    @ObservedObject var router: AppRouter
    @ObservedObject var session: AtlasSession
    @State private var feature: NativeMediaFeatureModel?
    @State private var failure: String?

    var body: some View {
        Group {
            if let feature {
                NativeMediaFeature(model: feature) { model, useFlatBook in
                    let journey = router.journeys.first { $0.id == target.journeyId }
                    return AnyView(StoryBook3DView(model: model, startedOn: journey?.startedOn ?? "",
                                                   endedOn: journey?.endedOn, useFlatBook: useFlatBook))
                }
            } else if let failure {
                VStack {
                    Text(failure)
                    Button("重试") { build() }
                    Button("返回图谱") { router.returnToAtlas() }
                }
            } else {
                ProgressView("正在打开故事…")
            }
        }
        .navigationBarBackButtonHidden(feature != nil)
        .task(id: target.requestId) { build() }
        .onChange(of: session.mediaJourneys[target.journeyId]) { _, fresh in
            guard let fresh, let feature, fresh != feature.story.journey else { return }
            Self.reconcileRefresh(fresh, feature: feature, target: target, router: router)
        }
    }

    // A late refresh can outlive its Story destination. Never let request A
    // dismiss or invalidate request B after navigation has already moved on.
    @MainActor static func reconcileRefresh(_ fresh: MediaJourney, feature: NativeMediaFeatureModel,
                                            target: StoryHandoff, router: AppRouter) {
        guard let active = router.path.last,
              active.journeyId == target.journeyId, active.requestId == target.requestId,
              feature.story.intent.requestId == target.requestId else { return }
        // An older Atlas response can be published after a newer local media
        // update. It is not an invalid Story request and must not dismiss it.
        guard fresh.revision >= feature.story.intent.revision else { return }
        do {
            try feature.updateJourney(fresh)
        } catch {
            // Only the destination that rejected this refresh may return to Atlas.
            // In particular, a superseded callback must not pop a replacement Story.
            guard let stillActive = router.path.last,
                  stillActive.journeyId == target.journeyId,
                  stillActive.requestId == target.requestId else { return }
            feature.invalidate()
            router.returnToAtlas()
        }
    }

    // Return through one scope-checked production boundary. The media projection
    // can already contain an imported or moved asset while Atlas still holds
    // its older scene; only the matching active request may commit that asset.
    @MainActor static func completeReturn(_ result: MediaReturn, target: StoryHandoff,
                                          scope: String, session: AtlasSession, router: AppRouter) {
        guard session.activeIdentity == scope,
              let active = router.path.last,
              active.journeyId == target.journeyId, active.requestId == target.requestId,
              active.requestId == result.requestId, active.revision == result.revision else { return }
        if let journeyID = result.journeyId, journeyID == active.journeyId {
            router.commitStoryPosition(StoryHandoff(journeyId: journeyID, routePointId: result.routePointId,
                assetId: result.assetId, revision: result.revision, requestId: result.requestId),
                mediaJourney: session.mediaJourneys[journeyID])
        }
        router.returnToAtlas()
    }

    // The media projection can advance between the Atlas tap and the first
    // destination task. Synchronize the real Router before StoryModel starts,
    // or close and playback would reject the initial intent as stale.
    @MainActor static func authorizeInitialStory(_ journey: MediaJourney,
                                                 target: StoryHandoff, router: AppRouter) -> StoryHandoff? {
        guard let active = router.path.last,
              active.journeyId == target.journeyId, active.requestId == target.requestId,
              journey.id == target.journeyId, journey.revision >= active.revision,
              let projected = router.current(active),
              router.acceptStoryRevision(journeyId: active.journeyId, requestId: active.requestId,
                                         from: active.revision, to: journey.revision) else { return nil }
        return StoryHandoff(journeyId: active.journeyId, routePointId: projected.routePointId,
                            assetId: projected.assetId, revision: journey.revision, requestId: active.requestId)
    }

    @MainActor private func build() {
        guard let scope = session.activeIdentity,
              let journey = session.mediaJourneys[target.journeyId],
              let current = Self.authorizeInitialStory(journey, target: target, router: router) else {
            failure = "旅程已不可用或正在刷新，请返回图谱重试。"; return
        }
        let intent = StoryIntent(journeyId: current.journeyId, routePointId: current.routePointId,
                                 assetId: current.assetId, revision: journey.revision, requestId: target.requestId)
        do {
            let access: ScopedMediaSession.Access = router.access == .guest ? .guest : .owner
            let mediaSession = session.mediaScope(scope: scope, access: access)
            let directory = try TransferRegistry.directory(for: scope)
            let uploader: PartUploading
            if access == .owner { uploader = try TransferRegistry.shared.uploader(at: directory) }
            else { uploader = ReadOnlyTransfer() }
            let model = try NativeMediaFeatureModel(journey: journey, intent: intent, session: mediaSession,
                directory: directory, uploader: uploader, currentIntent: {
                    let live = router.path.last
                    return StoryIntent(journeyId: live?.journeyId ?? "", routePointId: live?.routePointId,
                        assetId: live?.assetId, revision: live?.revision ?? -1, requestId: live?.requestId ?? "")
                }, latestJourney: { session.mediaJourneys[current.journeyId] },
                acceptRevision: { old, new in
                    guard session.activeIdentity == scope else { return false }
                    return router.acceptStoryRevision(journeyId: current.journeyId, requestId: target.requestId,
                                                      from: old, to: new)
                }, readJourney: { try await session.mediaJourney(current.journeyId, scope: scope) },
                refresh: { source, destination in
                    guard session.activeIdentity == scope else { return }
                    session.replaceMedia(source); session.replaceMedia(destination)
                    router.onInvalidation?()
                }, onBeat: { beat in
                    guard let point = beat.routePointId, session.activeIdentity == scope else { return }
                    router.commitStoryPosition(StoryHandoff(journeyId: journey.id, routePointId: point,
                        assetId: beat.asset?.id, revision: journey.revision, requestId: target.requestId),
                        mediaJourney: session.mediaJourneys[journey.id])
                }, onReturn: { result in
                    Self.completeReturn(result, target: target, scope: scope, session: session, router: router)
                })
            feature = model; failure = nil
            model.importer?.recover()
        } catch { failure = error.localizedDescription }
    }
}

extension AtlasSession {
    @MainActor func mediaScope(scope: String, access: ScopedMediaSession.Access) -> ScopedMediaSession {
        let shared = access == .guest
        let generation = self.generation
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        #if DEBUG
        if origin == nil && scope == "synthetic-ci" { config.protocolClasses = [FixturePhotoProtocol.self] }
        #endif
        return ScopedMediaSession(scopeID: scope, access: access, imageTransport: URLSession(configuration: config),
            read: { assetID in
                guard self.generation == generation, self.activeIdentity == scope else { throw MediaFailure.accessChanged }
                #if DEBUG
                if self.origin == nil && scope == "synthetic-ci",
                   self.mediaJourneys.values.contains(where: { $0.media.contains(where: { $0.id == assetID }) }) {
                    return URL(string: "https://fixture.invalid")!.appendingPathComponent(assetID)
                }
                #endif
                let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
                guard let id = assetID.addingPercentEncoding(withAllowedCharacters: allowed), !id.isEmpty else { throw MediaFailure.unavailable }
                let prefix = shared ? "/api/shared/assets/" : "/api/uploads/assets/"
                struct Signed: Decodable { let url: URL }
                let bytes = try await self.api(prefix + id + "/read-url", method: "GET", body: nil, scope: scope)
                return try JSONDecoder().decode(Signed.self, from: bytes).url
            }, request: { path, method, body in
                guard self.generation == generation else { throw MediaFailure.accessChanged }
                guard !shared else { throw MediaFailure.readOnly }
                return try await self.api(path, method: method, body: body, scope: scope)
            }, revalidate: {
                guard self.generation == generation else { throw MediaFailure.accessChanged }
                try await self.revalidate(scope)
            })
    }
}

#if DEBUG
private final class FixturePhotoProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let encoded = request.url?.lastPathComponent == "asset-second"
            ? "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGPYHKYFRwzEcQD7sxMxr8Y+1QAAAABJRU5ErkJggg=="
            : "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGOQjt8PRwzEcQDyoxOR7RnTPQAAAABJRU5ErkJggg=="
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "image/png"]),
            let png = Data(base64Encoded: encoded) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: png)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif
