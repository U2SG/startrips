import Foundation

public struct PreparedNativeFilm: Codable, Sendable {
    public let manifest: FilmManifest
    public let plan: FilmSourcePlan
    public let captions: [String: String]
}

/// Native port of journeyKeepsake.ts + keepsakeMemoryFilm.ts. It emits the same
/// v1 source plan and v2 ID-only manifest; no web renderer or second export API.
public enum FilmPreparation {
    public static func prepare(journey: MediaJourney, presetSeconds: Int = 60, portrait: Bool = true,
                               fps: Int = 30, includeNotes: Bool = true, reducedMotion: Bool = false,
                               cover: FilmCover? = nil) throws -> PreparedNativeFilm {
        guard [15, 30, 60].contains(presetSeconds), [24, 30].contains(fps) else { throw MediaFailure.invalidManifest }
        struct Draft { let scene: FilmScene; let minimum: Double }
        var drafts: [Draft] = []
        var previousChapter = 0
        func append(kind: String, role: String? = nil, point: String? = nil, from: String? = nil,
                    to: String? = nil, asset: MediaAsset? = nil, duration: Double, minimum: Double) {
            drafts.append(Draft(scene: FilmScene(kind: kind, role: role, durationMs: duration, routePointId: point,
                fromRoutePointId: from, toRoutePointId: to, mediaAssetId: asset?.id,
                mediaType: asset.map { $0.isVideo ? "video" : "image" }), minimum: minimum))
        }
        for beat in JourneyPlaybackPlan.build(journey) {
            switch beat.kind {
            case .intro:
                append(kind: "map", role: "intro", duration: 1200, minimum: 900)
                for asset in journey.ownedMedia(nil) {
                    append(kind: "media", asset: asset, duration: asset.isVideo ? 6000 : 4500, minimum: asset.isVideo ? 1800 : 1500)
                }
            case .travel:
                guard let target = journey.routePoints.firstIndex(where: { $0.id == beat.routePointId }), target > 0 else { continue }
                let distance = (previousChapter..<target).reduce(0.0) { $0 + JourneyPlaybackPlan.angularDistance(journey.routePoints[$1], journey.routePoints[$1 + 1]) }
                append(kind: "map", role: "travel", from: journey.routePoints[previousChapter].id,
                       to: journey.routePoints[target].id, duration: min(1600, 900 + distance * 600).rounded(), minimum: 700)
                previousChapter = target
            case .arrival:
                append(kind: "map", role: "arrival", point: beat.routePointId,
                       duration: min(3000, 1500 + Double(beat.text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count) * 24), minimum: 900)
            case .media:
                if let asset = beat.asset {
                    append(kind: "media", point: asset.routePointId, asset: asset,
                           duration: asset.isVideo ? 6000 : 4500, minimum: asset.isVideo ? 1800 : 1500)
                }
            case .outro: append(kind: "map", role: "outro", duration: 1800, minimum: 1100)
            case .note, .homePrelude, .homeEpilogue: break
            }
        }
        let minimum = drafts.reduce(0) { $0 + $1.minimum }, desired = drafts.reduce(0) { $0 + $1.scene.durationMs }
        let budget = max(Double(presetSeconds * 1000), minimum) - minimum
        let flexible = max(0, desired - minimum)
        var sourceCursor = 0.0
        let scenes = drafts.enumerated().map { index, draft -> FilmSourcePlan.TimedScene in
            let extra = flexible > 0 ? budget * max(0, draft.scene.durationMs - draft.minimum) / flexible : budget / Double(max(1, drafts.count))
            let duration = (draft.minimum + extra).rounded()
            let old = draft.scene
            let scene = FilmScene(kind: old.kind, role: old.role, durationMs: duration,
                routePointId: old.routePointId, fromRoutePointId: old.fromRoutePointId, toRoutePointId: old.toRoutePointId,
                mediaAssetId: old.mediaAssetId, mediaType: old.mediaType)
            defer { sourceCursor += duration }
            return FilmSourcePlan.TimedScene(index: index, startMs: sourceCursor, endMs: sourceCursor + duration, scene: scene)
        }
        let snapshot = FilmNarrativeSnapshot(routePointIds: journey.routePoints.map(\.id),
            visualMedia: journey.storySequence(includeCover: false).compactMap { entry in
                entry.asset.map { FilmNarrativeSnapshot.VisualMedia(mediaAssetId: $0.id, routePointId: $0.routePointId) }
            })
        let output = FilmOutput(width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080)
        let plan = FilmSourcePlan(version: 1, journeyId: journey.id, journeyRevision: journey.revision,
            narrativeSnapshot: snapshot, output: output, actualDurationMs: sourceCursor, scenes: scenes)
        var noteTargets: [String: Int] = [:]
        for (index, entry) in scenes.enumerated() where entry.scene.role == "arrival" {
            if let id = entry.scene.routePointId, noteTargets[id] == nil { noteTargets[id] = index }
        }
        for (index, entry) in scenes.enumerated() where entry.scene.kind == "media" {
            if let id = entry.scene.routePointId, noteTargets[id] == nil { noteTargets[id] = index }
        }
        for (index, entry) in scenes.enumerated() where entry.scene.role == "travel" {
            if let from = journey.routePoints.firstIndex(where: { $0.id == entry.scene.fromRoutePointId }),
               let to = journey.routePoints.firstIndex(where: { $0.id == entry.scene.toRoutePointId }) {
                for rank in min(from, to)...max(from, to) where noteTargets[journey.routePoints[rank].id] == nil {
                    noteTargets[journey.routePoints[rank].id] = index
                }
            }
        }
        let overview = noteTargets.isEmpty ? scenes.firstIndex { $0.scene.role == "intro" } : scenes.lastIndex { $0.scene.role == "outro" }
        var pages: [Int: [String]] = [:]
        if includeNotes {
            for point in journey.routePoints {
                let text = (point.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard text.utf16.count <= 8000 else { throw MediaFailure.invalidManifest }
                guard !text.isEmpty, let target = noteTargets[point.id] ?? overview else { continue }
                var page = "", count = 0, breaks = 0
                for character in text {
                    page.append(character); count += 1
                    if String(character).contains("\n") { breaks += 1 }
                    if count >= 64 || breaks >= 3 { pages[target, default: []].append(page); page = ""; count = 0; breaks = 0 }
                }
                if !page.isEmpty { pages[target, default: []].append(page) }
            }
        }
        var elapsed = 0.0, nextFrame = 0, usedCover = false
        var captions: [String: String] = [:], shots: [FilmShot] = []
        for (index, entry) in scenes.enumerated() {
            let notes = pages[index] ?? []
            let lengths = notes.map { max(3000.0, Double($0.unicodeScalars.count) * 180) }
            let duration = max(entry.scene.durationMs, lengths.reduce(0, +))
            let start = nextFrame, startMS = elapsed
            elapsed += duration; nextFrame = Int((elapsed * Double(fps) / 1000).rounded())
            var cueCursor = start, cueMS = startMS
            let cues = notes.enumerated().map { page, text -> FilmShot.Caption in
                let id = "caption:\(index):\(page)"; captions[id] = text; cueMS += lengths[page]
                let end = page == notes.count - 1 ? nextFrame : Int((cueMS * Double(fps) / 1000).rounded())
                defer { cueCursor = end }
                return FilmShot.Caption(id: id, startFrame: cueCursor, endFrame: end)
            }
            let isCover = !reducedMotion && !usedCover && cover != nil && entry.scene.mediaType == "image" && entry.scene.mediaAssetId == cover?.sourceMediaAssetId
            if isCover { usedCover = true }
            shots.append(FilmShot(sourceSceneIndex: index, startFrame: start, endFrame: nextFrame,
                openingDerivativeId: isCover ? cover?.derivativeId : nil, captionCues: cues))
        }
        let manifest = FilmManifest(version: 2, exportKind: "journey_memory_film", journeyId: journey.id, journeyRevision: journey.revision,
            narrativeSnapshot: snapshot, privacy: FilmPrivacy(artifactVisibility: "private", mediaResolution: "authorized-server-fetch"),
            fps: fps, output: output, reducedMotion: reducedMotion, totalFrames: nextFrame,
            actualDurationMs: Double(nextFrame) * 1000 / Double(fps), sourceDurationMs: sourceCursor, cover: usedCover ? cover : nil, shots: shots)
        try manifest.validate(plan: plan, captions: captions)
        return PreparedNativeFilm(manifest: manifest, plan: plan, captions: captions)
    }
}
