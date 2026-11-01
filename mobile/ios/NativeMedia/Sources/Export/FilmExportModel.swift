import Combine
import Foundation
import SwiftUI
import UIKit

@MainActor public final class FilmExportModel: ObservableObject {
    @Published public private(set) var busy = false
    @Published public private(set) var progress = 0.0
    @Published public private(set) var failure: String?
    @Published public private(set) var file: URL?
    private let session: ScopedMediaSession
    @Published public var presetSeconds = 30 { didSet { if presetSeconds != oldValue { discardResult() } } }
    @Published public var portrait = true { didSet { if portrait != oldValue { discardResult() } } }
    @Published public var includeNotes = false { didSet { if includeNotes != oldValue { discardResult() } } }
    @Published public var includeSoundtrack = true { didSet { if includeSoundtrack != oldValue { discardResult() } } }
    @Published public var includeCover = true { didSet { if includeCover != oldValue { discardResult() } } }
    private var publishedCover: OwnerFilmCover?
    public var canConfigureNotes: Bool { preparedFilm == nil }
    public var hasSoundtrack: Bool { soundtrackRead != nil }
    private let preparedFilm: PreparedNativeFilm?
    private let directory: URL
    private let currentJourney: () async throws -> MediaJourney
    private let expectedJourney: MediaJourney
    private let derivativeRead: (FilmCover) async throws -> URL
    private let soundtrackRead: (() async throws -> URL)?
    private var task: Task<Void, Never>?
    public init(session: ScopedMediaSession, directory: URL, expectedJourney: MediaJourney,
                currentJourney: @escaping () async throws -> MediaJourney,
                preparedFilm: PreparedNativeFilm? = nil,
                derivativeRead: @escaping (FilmCover) async throws -> URL = { _ in throw MediaFailure.unavailable },
                soundtrackRead: (() async throws -> URL)? = nil) {
        self.session = session; self.preparedFilm = preparedFilm
        self.directory = directory; self.currentJourney = currentJourney
        self.expectedJourney = expectedJourney
        self.derivativeRead = derivativeRead; self.soundtrackRead = soundtrackRead
    }
    public convenience init(session: ScopedMediaSession, manifest: FilmManifest, plan: FilmSourcePlan,
                            captions: [String: String], directory: URL, expectedJourney: MediaJourney,
                            currentJourney: @escaping () async throws -> MediaJourney,
                            derivativeRead: @escaping (FilmCover) async throws -> URL,
                            soundtrackRead: (() async throws -> URL)? = nil) {
        self.init(session: session, directory: directory, expectedJourney: expectedJourney, currentJourney: currentJourney,
                  preparedFilm: PreparedNativeFilm(manifest: manifest, plan: plan, captions: captions),
                  derivativeRead: derivativeRead, soundtrackRead: soundtrackRead)
    }
    func prepareForExport(cover: FilmCover? = nil, reducedMotion: Bool? = nil) throws -> PreparedNativeFilm {
        guard session.access == .owner else { throw MediaFailure.readOnly }
        if let preparedFilm { return preparedFilm }
        return try FilmPreparation.prepare(journey: expectedJourney, presetSeconds: presetSeconds, portrait: portrait, includeNotes: includeNotes,
                                            reducedMotion: reducedMotion ?? UIAccessibility.isReduceMotionEnabled, cover: cover)
    }
    func prepareForRendering(reducedMotion: Bool) async throws -> (film: PreparedNativeFilm, opening: OwnerFilmCover?) {
        guard session.access == .owner else { throw MediaFailure.readOnly }
        if let preparedFilm {
            guard let declared = preparedFilm.manifest.cover,
                  preparedFilm.manifest.shots.contains(where: { $0.openingDerivativeId != nil }) else {
                return (preparedFilm, nil)
            }
            if reducedMotion {
                return (preparedFilm.withoutArtisticOpening(), nil)
            }
            guard let current = try await OwnerFilmCover.resolve(journey: expectedJourney, session: session),
                  current.filmCover == declared else { throw MediaFailure.staleIntent }
            return (preparedFilm, current)
        }
        let opening = includeCover && !reducedMotion
            ? try await OwnerFilmCover.resolve(journey: expectedJourney, session: session) : nil
        let film = try prepareForExport(cover: opening?.filmCover, reducedMotion: reducedMotion)
        return (film, film.manifest.shots.contains(where: { $0.openingDerivativeId != nil }) ? opening : nil)
    }
    public func start() {
        guard !busy else { return }
        guard session.access == .owner else { failure = MediaFailure.readOnly.localizedDescription; return }
        discardResult()
        busy = true; progress = 0
        task = Task {
            defer { busy = false }
            let scratch = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                let journey = try await authorizedJourney()
                let (film, opening) = try await prepareForRendering(reducedMotion: UIAccessibility.isReduceMotionEnabled)
                let manifest = film.manifest, plan = film.plan, captions = film.captions
                try manifest.validate(plan: plan, captions: captions)
                try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true,
                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
                defer { try? FileManager.default.removeItem(at: scratch) }
                var files: [String: URL] = [:], derivatives: [String: URL] = [:]
                let ids = Set(plan.scenes.compactMap { $0.scene.mediaAssetId })
                for id in ids {
                    try Task.checkCancellation()
                    _ = try await authorizedJourney()
                    files[id] = try await download(try await session.mediaURL(id), to: scratch)
                }
                if let cover = manifest.cover, manifest.shots.contains(where: { $0.openingDerivativeId != nil }) {
                    guard let opening else { throw MediaFailure.staleIntent }
                    let url: URL
                    if preparedFilm == nil { url = try await opening.renewedURL(in: session) }
                    else { try await opening.verify(in: session); url = try await derivativeRead(cover) }
                    let file = try await download(url, to: scratch)
                    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize
                    guard let size, size > 0, size <= 16 * 1024 * 1024 else { throw MediaFailure.invalidManifest }
                    derivatives[cover.derivativeId] = file
                }
                var soundtrack: URL?
                if includeSoundtrack, let soundtrackRead { soundtrack = try await download(try await soundtrackRead(), to: scratch) }
                let renderer = try NativeFilmRenderer(manifest: manifest, plan: plan, journey: journey,
                                                       files: files, captions: captions, derivatives: derivatives)
                let output = directory.appendingPathComponent(UUID().uuidString + ".mp4")
                let result = try await NativeMP4Exporter().export(manifest: manifest, renderer: renderer, destination: output,
                    soundtrack: soundtrack,
                    authorize: { _ = try await self.authorizedJourney() },
                    availableBytes: {
                        let values = try self.directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                        return values.volumeAvailableCapacityForImportantUsage ?? 0
                    }, progress: { self.progress = $0 })
                do {
                    try await opening?.verify(in: session)
                    try Task.checkCancellation()
                } catch {
                    try? FileManager.default.removeItem(at: result)
                    throw error
                }
                publishedCover = opening
                file = result
            } catch is CancellationError {} catch { failure = error.localizedDescription }
        }
    }
    public func cancel() { task?.cancel() }
    public func invalidate() { cancel(); discardResult() }
    private func discardResult() {
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil; failure = nil; publishedCover = nil
    }
    public func authorizeShare() async throws -> URL {
        let candidate = file, opening = publishedCover
        do {
            _ = try await authorizedJourney()
            guard let candidate else { throw MediaFailure.unavailable }
            try await opening?.verify(in: session)
            guard file == candidate else { throw MediaFailure.staleIntent }
            return candidate
        } catch {
            if file == candidate {
                discardResult()
                failure = error.localizedDescription
            }
            throw error
        }
    }
    private func authorizedJourney() async throws -> MediaJourney {
        guard session.access == .owner else { throw MediaFailure.readOnly }
        try await session.revalidate()
        let journey = try await currentJourney()
        guard journey == expectedJourney else { throw MediaFailure.staleIntent }
        if let manifest = preparedFilm?.manifest {
            guard journey.id == manifest.journeyId, journey.revision == manifest.journeyRevision,
                  manifest.narrativeSnapshot.matches(journey) else { throw MediaFailure.staleIntent }
        }
        try Task.checkCancellation(); return journey
    }
    private func download(_ url: URL, to directory: URL) async throws -> URL {
        guard url.scheme == "https" else { throw MediaFailure.accessChanged }
        try await session.revalidate()
        let transport = URLSession(configuration: .ephemeral)
        defer { transport.finishTasksAndInvalidate() }
        let (temporary, response) = try await transport.download(from: url)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw MediaFailure.unavailable }
        try Task.checkCancellation(); try await session.revalidate()
        let result = directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: temporary, to: result)
        return result
    }
}

public struct FilmExportButton: View {
    @ObservedObject var model: FilmExportModel
    @State private var sharing = false
    @State private var shareURL: URL?
    public init(model: FilmExportModel) { self.model = model }
    public var body: some View {
        VStack {
            if model.busy {
                ProgressView("正在生成影片", value: model.progress)
                Button("取消导出") { model.cancel() }.frame(minHeight: 44)
            } else {
                if model.canConfigureNotes {
                    Picker("画面比例", selection: $model.portrait) {
                        Text("竖屏 9:16").tag(true)
                        Text("横屏 16:9").tag(false)
                    }.accessibilityIdentifier("story.export.aspect")
                    Picker("目标时长", selection: $model.presetSeconds) {
                        ForEach([15, 30, 60], id: \.self) { seconds in Text("\(seconds) 秒").tag(seconds) }
                    }.accessibilityIdentifier("story.export.duration")
                    Toggle("包含感想字幕", isOn: $model.includeNotes).accessibilityIdentifier("story.export.captions")
                    Toggle("使用已生成的艺术封面", isOn: $model.includeCover).accessibilityIdentifier("story.export.cover")
                }
                if model.hasSoundtrack {
                    Toggle("包含旅程配乐", isOn: $model.includeSoundtrack).accessibilityIdentifier("story.export.soundtrack")
                }
                Button("生成 MP4") { model.start() }.frame(minHeight: 44).accessibilityIdentifier("story.export")
                if model.file != nil {
                    Button("保存或分享影片") {
                        Task { do { shareURL = try await model.authorizeShare(); sharing = true } catch { /* Model displays the failure. */ } }
                    }.frame(minHeight: 44)
                }
            }
            if let failure = model.failure { Text(failure).font(.callout) }
        }.sheet(isPresented: $sharing) { if let shareURL { FilmShareSheet(file: shareURL) } }
    }
}
private struct FilmShareSheet: UIViewControllerRepresentable {
    let file: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [file], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private extension PreparedNativeFilm {
    func withoutArtisticOpening() -> PreparedNativeFilm {
        let shots = manifest.shots.map { FilmShot(sourceSceneIndex: $0.sourceSceneIndex, startFrame: $0.startFrame,
            endFrame: $0.endFrame, openingDerivativeId: nil, captionCues: $0.captionCues) }
        let reduced = FilmManifest(version: manifest.version, exportKind: manifest.exportKind, journeyId: manifest.journeyId,
            journeyRevision: manifest.journeyRevision, narrativeSnapshot: manifest.narrativeSnapshot, privacy: manifest.privacy,
            fps: manifest.fps, output: manifest.output, reducedMotion: true, totalFrames: manifest.totalFrames,
            actualDurationMs: manifest.actualDurationMs, sourceDurationMs: manifest.sourceDurationMs, cover: nil, shots: shots)
        return PreparedNativeFilm(manifest: reduced, plan: plan, captions: captions)
    }
}
