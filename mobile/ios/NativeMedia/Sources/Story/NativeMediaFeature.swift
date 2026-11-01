import Combine
import CryptoKit
import SwiftUI
import UIKit

/// The production composition boundary. #767 supplies its captured AtlasSession
/// capabilities and StoryHandoff fields; AppRouter remains the navigation owner.
@MainActor public final class NativeMediaFeatureModel: ObservableObject {
    public let story: StoryModel
    public private(set) var importer: PhotosImportModel?
    public private(set) var mover: MediaMoveModel?
    @Published public private(set) var exporter: FilmExportModel?
    private let session: ScopedMediaSession
    private let directory: URL
    private let readJourney: () async throws -> MediaJourney
    private let refresh: (MediaJourney, MediaJourney) -> Void
    private var soundtrackRead: (() async throws -> URL)?

    private static func soundtrackID(in journey: MediaJourney) -> String? {
        journey.media.filter { $0.routePointId == nil && $0.mimeType.hasPrefix("audio/") }
            .min { $0.sortOrder < $1.sortOrder }?.id
    }

    public init(journey: MediaJourney, intent: StoryIntent, session: ScopedMediaSession,
                directory: URL, uploader: PartUploading,
                currentIntent: @escaping () -> StoryIntent,
                latestJourney: @escaping () -> MediaJourney?,
                readJourney: @escaping () async throws -> MediaJourney,
                refresh: @escaping (MediaJourney, MediaJourney) -> Void,
                onBeat: @escaping (PlaybackBeat) -> Void = { _ in },
                onReturn: @escaping (MediaReturn) -> Void) throws {
        self.session = session; self.directory = directory; self.readJourney = readJourney; self.refresh = refresh
        // Audio remains an ordinary scoped asset read. A guest's projected Journey cannot
        // acquire an owner-only soundtrack through a separate endpoint.
        let readSoundtrack: (() async throws -> URL)? = Self.soundtrackID(in: journey).map { id in { try await session.mediaURL(id) } }
        self.soundtrackRead = readSoundtrack
        story = try StoryModel(journey: journey, intent: intent, session: session, currentIntent: currentIntent,
                               latestJourney: latestJourney, soundtrackRead: readSoundtrack, onBeat: onBeat, onReturn: onReturn)
        if session.access == .owner {
            exporter = FilmExportModel(session: session, directory: directory.appendingPathComponent("exports"),
                expectedJourney: journey, currentJourney: readJourney, soundtrackRead: readSoundtrack)
            let transfer = try MultipartImporter(session: session, directory: directory.appendingPathComponent("imports"), uploader: uploader)
            importer = PhotosImportModel(importer: transfer, journeyID: journey.id, routePointID: intent.routePointId,
                currentPointID: { [story] in story.committedRoutePointID }) { [weak self] _ in
                guard let self else { return }
                let fresh = try await readJourney()
                try self.updated(fresh, fresh)
            }
            mover = MediaMoveModel(session: session, journey: journey) { [weak self] source, destination in
                guard let self else { return }
                do { try self.updated(source, destination) } catch { self.story.invalidate() }
            }
        }
    }
    /// Existing prepared v2 manifests (including authorized cover derivatives) can replace
    /// the default 60-second preset without changing the renderer or navigation contract.
    public func usePreparedFilm(_ film: PreparedNativeFilm, derivativeRead: @escaping (FilmCover) async throws -> URL) throws {
        guard session.access == .owner else { throw MediaFailure.readOnly }
        try film.manifest.validate(plan: film.plan, captions: film.captions)
        exporter?.invalidate()
        exporter = FilmExportModel(session: session, manifest: film.manifest, plan: film.plan, captions: film.captions,
            directory: directory.appendingPathComponent("exports"), expectedJourney: story.journey, currentJourney: readJourney,
            derivativeRead: derivativeRead, soundtrackRead: soundtrackRead)
    }
    public func invalidate() { story.invalidate(); importer?.cancel(); exporter?.invalidate() }
    private func updated(_ source: MediaJourney, _ destination: MediaJourney) throws {
        try updateJourney(source)
        refresh(source, destination)
    }

    public func updateJourney(_ journey: MediaJourney) throws {
        guard journey != story.journey else { return }
        let oldSoundtrack = Self.soundtrackID(in: story.journey)
        try story.update(journey)
        let newSoundtrack = Self.soundtrackID(in: journey)
        if newSoundtrack != oldSoundtrack {
            soundtrackRead = newSoundtrack.map { [session] id in { try await session.mediaURL(id) } }
            story.replaceSoundtrack(soundtrackRead)
        }
        mover?.updateSource(journey)
        guard let previous = exporter else { return }
        previous.invalidate()
        let replacement = FilmExportModel(session: session, directory: directory.appendingPathComponent("exports"),
            expectedJourney: journey, currentJourney: readJourney, soundtrackRead: soundtrackRead)
        replacement.includeNotes = previous.includeNotes
        replacement.includeSoundtrack = previous.includeSoundtrack
        exporter = replacement
    }
    public static func scopeDirectory(root: URL, scopeID: String) -> URL {
        let digest = SHA256.hash(data: Data(scopeID.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(digest, isDirectory: true)
    }
}

public struct NativeMediaFeature: View {
    @StateObject private var model: NativeMediaFeatureModel
    public init(model: NativeMediaFeatureModel) { _model = StateObject(wrappedValue: model) }
    public var body: some View {
        NativeStoryDestination(model: model.story, importer: model.importer, exporter: model.exporter, moveModel: model.mover)
    }
}
