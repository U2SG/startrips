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
    private let manifest: FilmManifest
    private let plan: FilmSourcePlan
    private let captions: [String: String]
    private let directory: URL
    private let currentJourney: () async throws -> MediaJourney
    private let expectedJourney: MediaJourney
    private let derivativeRead: (FilmCover) async throws -> URL
    private let soundtrackRead: (() async throws -> URL)?
    private var task: Task<Void, Never>?
    public init(session: ScopedMediaSession, manifest: FilmManifest, plan: FilmSourcePlan, captions: [String: String],
                directory: URL, expectedJourney: MediaJourney, currentJourney: @escaping () async throws -> MediaJourney,
                derivativeRead: @escaping (FilmCover) async throws -> URL,
                soundtrackRead: (() async throws -> URL)? = nil) {
        self.session = session; self.manifest = manifest; self.plan = plan; self.captions = captions
        self.directory = directory; self.currentJourney = currentJourney
        self.expectedJourney = expectedJourney
        self.derivativeRead = derivativeRead; self.soundtrackRead = soundtrackRead
    }
    public func start() {
        guard !busy else { return }
        busy = true; failure = nil; progress = 0
        if let file { try? FileManager.default.removeItem(at: file); self.file = nil }
        task = Task {
            defer { busy = false }
            let scratch = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try manifest.validate(plan: plan, captions: captions)
                let journey = try await authorizedJourney()
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
                    derivatives[cover.derivativeId] = try await download(try await derivativeRead(cover), to: scratch)
                }
                var soundtrack: URL?
                if let soundtrackRead { soundtrack = try await download(try await soundtrackRead(), to: scratch) }
                let renderer = try NativeFilmRenderer(manifest: manifest, plan: plan, journey: journey,
                                                       files: files, captions: captions, derivatives: derivatives)
                let audio = manifest.shots.compactMap { shot -> FilmAudioSource? in
                    let scene = plan.scenes[shot.sourceSceneIndex].scene
                    guard scene.mediaType == "video", let id = scene.mediaAssetId, let file = files[id] else { return nil }
                    return FilmAudioSource(file: file, startSeconds: Double(shot.startFrame) / Double(manifest.fps),
                                           sourceSeconds: scene.durationMs / 1000,
                                           outputSeconds: Double(shot.endFrame - shot.startFrame) / Double(manifest.fps))
                }
                let output = directory.appendingPathComponent(UUID().uuidString + ".mp4")
                let result = try await NativeMP4Exporter().export(manifest: manifest, renderer: renderer, destination: output,
                    foregroundAudio: audio, soundtrack: soundtrack,
                    authorize: { _ = try await self.authorizedJourney() },
                    availableBytes: {
                        let values = try self.directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                        return values.volumeAvailableCapacityForImportantUsage ?? 0
                    }, progress: { self.progress = $0 })
                file = result
            } catch is CancellationError {} catch { failure = error.localizedDescription }
        }
    }
    public func cancel() { task?.cancel() }
    public func authorizeShare() async throws -> URL {
        do {
            _ = try await authorizedJourney()
            guard let file else { throw MediaFailure.unavailable }
            return file
        } catch {
            if let file { try? FileManager.default.removeItem(at: file); self.file = nil }
            failure = error.localizedDescription; throw error
        }
    }
    private func authorizedJourney() async throws -> MediaJourney {
        try await session.revalidate()
        let journey = try await currentJourney()
        guard journey.id == manifest.journeyId, journey.revision == manifest.journeyRevision,
              manifest.narrativeSnapshot.matches(journey), journey.routePoints == expectedJourney.routePoints,
              journey.title == expectedJourney.title, journey.note == expectedJourney.note else { throw MediaFailure.staleIntent }
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
