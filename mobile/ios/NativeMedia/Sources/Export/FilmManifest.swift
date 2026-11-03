import Foundation

public struct FilmNarrativeSnapshot: Codable, Equatable, Sendable {
    public struct VisualMedia: Codable, Equatable, Sendable { public let mediaAssetId: String; public let routePointId: String? }
    public let routePointIds: [String]
    public let visualMedia: [VisualMedia]
}
public struct FilmOutput: Codable, Equatable, Sendable { public let width: Int; public let height: Int }
public struct FilmPrivacy: Codable, Equatable, Sendable { public let artifactVisibility: String; public let mediaResolution: String }
public struct FilmCover: Codable, Equatable, Sendable {
    public let derivativeId: String
    public let sourceMediaAssetId: String
    public let recipeId: String
    public let recipeVersion: Int
}
public struct FilmShot: Codable, Equatable, Sendable {
    public struct Caption: Codable, Equatable, Sendable { public let id: String; public let startFrame: Int; public let endFrame: Int }
    public let sourceSceneIndex: Int
    public let startFrame: Int
    public let endFrame: Int
    public let openingDerivativeId: String?
    public let captionCues: [Caption]
}
/// Wire-compatible with keepsakeMemoryFilm.ts MemoryFilmManifest (version 2).
public struct FilmManifest: Codable, Equatable, Sendable {
    public let version: Int
    public let exportKind: String
    public let journeyId: String
    public let journeyRevision: Int
    public let narrativeSnapshot: FilmNarrativeSnapshot
    public let privacy: FilmPrivacy
    public let fps: Int
    public let output: FilmOutput
    public let reducedMotion: Bool
    public let totalFrames: Int
    public let actualDurationMs: Double
    public let sourceDurationMs: Double
    public let cover: FilmCover?
    public let shots: [FilmShot]

    public func validate(plan: FilmSourcePlan, captions: [String: String]) throws {
        guard version == 2, exportKind == "journey_memory_film", journeyRevision >= 0,
              privacy.artifactVisibility == "private",
              ["authorized-owner-fetch", "authorized-server-fetch"].contains(privacy.mediaResolution),
              [24, 30].contains(fps), totalFrames > 0, totalFrames <= fps * 60 * 60 * 4,
              actualDurationMs.isFinite, abs(actualDurationMs - Double(totalFrames) * 1000 / Double(fps)) <= 1,
              sourceDurationMs.isFinite, sourceDurationMs > 0,
              output.width > 0, output.height > 0, output.width <= 4096, output.height <= 4096,
              output.width % 2 == 0, output.height % 2 == 0,
              plan.version == 1, plan.journeyId == journeyId, plan.journeyRevision == journeyRevision,
              plan.output == output, plan.narrativeSnapshot == narrativeSnapshot,
              !shots.isEmpty, shots.count == plan.scenes.count,
              Set(narrativeSnapshot.routePointIds).count == narrativeSnapshot.routePointIds.count,
              Set(narrativeSnapshot.visualMedia.map(\.mediaAssetId)).count == narrativeSnapshot.visualMedia.count else { throw MediaFailure.invalidManifest }
        var cursor = 0
        var sourceCursor = 0.0
        for (index, shot) in shots.enumerated() {
            guard shot.sourceSceneIndex == index, shot.startFrame == cursor, shot.endFrame > cursor,
                  shot.endFrame <= totalFrames, plan.scenes[index].index == index,
                  plan.scenes[index].startMs == sourceCursor,
                  plan.scenes[index].endMs == sourceCursor + plan.scenes[index].scene.durationMs,
                  plan.scenes[index].scene.durationMs.isFinite, plan.scenes[index].scene.durationMs > 0 else { throw MediaFailure.invalidManifest }
            sourceCursor = plan.scenes[index].endMs
            let scene = plan.scenes[index].scene
            if scene.kind == "media" {
                guard let assetID = scene.mediaAssetId, ["image", "video"].contains(scene.mediaType ?? ""),
                      narrativeSnapshot.visualMedia.contains(where: { $0.mediaAssetId == assetID && $0.routePointId == scene.routePointId }) else { throw MediaFailure.invalidManifest }
            } else {
                guard scene.kind == "map", ["intro", "outro", "travel", "arrival"].contains(scene.role ?? "") else { throw MediaFailure.invalidManifest }
                let ids = [scene.routePointId, scene.fromRoutePointId, scene.toRoutePointId].compactMap { $0 }
                guard ids.allSatisfy({ narrativeSnapshot.routePointIds.contains($0) }) else { throw MediaFailure.invalidManifest }
            }
            if let derivative = shot.openingDerivativeId {
                guard let cover, cover.derivativeId == derivative, cover.recipeVersion == 1,
                      ["ink-wash-memory", "poetic-line-memory", "paper-collage-memory"].contains(cover.recipeId),
                      scene.mediaType == "image",
                      cover.sourceMediaAssetId == scene.mediaAssetId else { throw MediaFailure.invalidManifest }
            }
            var previousEnd = shot.startFrame
            for cue in shot.captionCues {
                guard cue.startFrame >= previousEnd, cue.endFrame > cue.startFrame, cue.endFrame <= shot.endFrame,
                      let text = captions[cue.id], !text.isEmpty else { throw MediaFailure.invalidManifest }
                previousEnd = cue.endFrame
            }
            cursor = shot.endFrame
        }
        guard cursor == totalFrames, sourceCursor == sourceDurationMs, plan.actualDurationMs == sourceDurationMs else { throw MediaFailure.invalidManifest }
    }

    public func sample(frame: Int) throws -> FilmFrame {
        guard frame >= 0, frame < totalFrames,
              let shot = shots.first(where: { frame >= $0.startFrame && frame < $0.endFrame }) else { throw MediaFailure.invalidManifest }
        let local = frame - shot.startFrame, span = shot.endFrame - shot.startFrame
        let progress = span == 1 ? 1 : Double(local) / Double(span - 1)
        let revealFrames = max(1, min(Int((1.2 * Double(fps)).rounded()), (span - 1) / 2))
        let reveal = min(1, Double(local) / Double(revealFrames))
        let opacity = shot.openingDerivativeId != nil && !reducedMotion && span > 1 ? (1 + cos(.pi * reveal)) / 2 : 0
        return FilmFrame(sourceSceneIndex: shot.sourceSceneIndex, progress: progress,
                         openingDerivativeID: shot.openingDerivativeId, openingOpacity: opacity,
                         captionID: shot.captionCues.first { frame >= $0.startFrame && frame < $0.endFrame }?.id)
    }
}
public struct FilmFrame: Equatable, Sendable {
    public let sourceSceneIndex: Int
    public let progress: Double
    public let openingDerivativeID: String?
    public let openingOpacity: Double
    public let captionID: String?
}
public struct FilmScene: Codable, Equatable, Sendable {
    public let kind: String
    public let role: String?
    public let durationMs: Double
    public let routePointId: String?
    public let fromRoutePointId: String?
    public let toRoutePointId: String?
    public let mediaAssetId: String?
    public let mediaType: String?
}
public struct FilmSourcePlan: Codable, Equatable, Sendable {
    public struct TimedScene: Codable, Equatable, Sendable {
        public let index: Int
        public let startMs: Double
        public let endMs: Double
        public let scene: FilmScene
    }
    public let version: Int
    public let journeyId: String
    public let journeyRevision: Int
    public let narrativeSnapshot: FilmNarrativeSnapshot
    public let output: FilmOutput
    public let actualDurationMs: Double
    public let scenes: [TimedScene]
}

extension FilmNarrativeSnapshot {
    public func matches(_ journey: MediaJourney) -> Bool {
        routePointIds == journey.routePoints.map(\.id) && visualMedia == journey.storySequence(includeCover: false).compactMap { entry in
            entry.asset.map { VisualMedia(mediaAssetId: $0.id, routePointId: $0.routePointId) }
        }
    }
}
