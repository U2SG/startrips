import CoreTransferable
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct PickedMediaFile: Transferable {
    let url: URL
    let type: UTType
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in try copy(received.file, fallback: .movie) }
        FileRepresentation(importedContentType: .image) { received in try copy(received.file, fallback: .image) }
    }
    private static func copy(_ file: URL, fallback: UTType) throws -> PickedMediaFile {
        let type = UTType(filenameExtension: file.pathExtension) ?? fallback
        let output = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(file.pathExtension)
        try FileManager.default.copyItem(at: file, to: output)
        return PickedMediaFile(url: output, type: type)
    }
}

@MainActor public final class PhotosImportModel: ObservableObject {
    @Published public private(set) var busy = false
    @Published public private(set) var progress = 0.0
    @Published public private(set) var failure: String?
    /// This Journey has an unfinished upload in the journal, so recovery is worth offering.
    @Published public private(set) var hasPending = false
    public let importer: MultipartImporter
    private var task: Task<Void, Never>?
    private var current: ImportRecord?
    private let journeyID: String
    let pointForBatch: () -> String?
    private let onImported: ([String]) async throws -> Void
    /// Several picked photos go to Route Point review instead of a plain import.
    public var routeBatch: RoutePointBatchModel?
    public init(importer: MultipartImporter, journeyID: String, routePointID: String?,
                currentPointID: (() -> String?)? = nil, onImported: @escaping ([String]) async throws -> Void) {
        self.importer = importer; self.journeyID = journeyID; self.onImported = onImported
        self.pointForBatch = currentPointID ?? { routePointID }
        refreshPending()
    }
    public func refreshPending() {
        hasPending = (try? importer.pending().contains { $0.journeyId == journeyID }) ?? false
    }
    public func importItems(_ items: [PhotosPickerItem]) {
        guard !busy, !items.isEmpty else { return }
        let pointID = pointForBatch()
        busy = true; progress = 0; failure = nil
        task = Task {
            defer { busy = false; current = nil; refreshPending() }
            do {
                for (index, item) in items.enumerated() {
                    try Task.checkCancellation()
                    // PhotosPicker materializes iCloud files through Transferable. No broad
                    // photo-library access or assumption that localIdentifier is an assetId.
                    guard let picked = try await item.loadTransferable(type: PickedMediaFile.self) else { throw MediaFailure.unavailable }
                    defer { try? FileManager.default.removeItem(at: picked.url) }
                    try Task.checkCancellation()
                    let prepared = try Self.prepare(picked.url, type: picked.type)
                    defer { if prepared.url != picked.url { try? FileManager.default.removeItem(at: prepared.url) } }
                    let record = try importer.stage(file: prepared.url, fileName: prepared.url.lastPathComponent,
                                                    mimeType: prepared.mime, journeyId: journeyID, routePointId: pointID)
                    current = record
                    let assetID = try await importer.resume(record) { fraction in progress = (Double(index) + fraction) / Double(items.count) }
                    try await onImported([assetID]) // refresh authoritative Journey after each durable completion
                }
            } catch is CancellationError {} catch { failure = error.localizedDescription }
        }
    }
    public func recover() {
        guard !busy else { return }
        busy = true; failure = nil
        task = Task {
            defer { busy = false; current = nil; refreshPending() }
            do {
                for record in try importer.pending() where record.journeyId == journeyID {
                    current = record
                    do {
                        let id = try await importer.resume(record) { progress = $0 }
                        try await onImported([id])
                    } catch MediaFailure.uploadedAssetRemoved {
                        try await onImported([])
                    } catch MediaFailure.uploadAborted { continue }
                }
            } catch is CancellationError {} catch { failure = error.localizedDescription }
        }
    }
    public func cancel() {
        task?.cancel()
        guard let record = current else { return }
        Task { do { try await cancelAndRefresh(record) } catch { failure = error.localizedDescription }; refreshPending() }
    }
    public func cancelPending() {
        guard !busy else { return }; busy = true; failure = nil
        task = Task {
            defer { busy = false; current = nil; refreshPending() }
            do {
                for record in try importer.pending() where record.journeyId == journeyID {
                    current = record; try await cancelAndRefresh(record)
                }
            } catch { failure = error.localizedDescription }
        }
    }
    private func cancelAndRefresh(_ record: ImportRecord) async throws {
        if case .alreadyCompleted(let assetID) = try await importer.cancel(record) {
            try await onImported(assetID.map { [$0] } ?? [])
        }
    }
    static func prepare(_ file: URL, type: UTType) throws -> (url: URL, mime: String) {
        if type.conforms(to: .heic) || type.conforms(to: .heif) {
            let output = file.deletingPathExtension().appendingPathExtension("jpg")
            guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                  let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw MediaFailure.unavailable }
            // AddImageFromSource preserves EXIF orientation/capture metadata; dimensions
            // and display orientation are subsequently derived by the server preview path.
            CGImageDestinationAddImageFromSource(destination, source, 0, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw MediaFailure.diskFull }
            return (output, "image/jpeg")
        }
        guard let mime = type.preferredMIMEType, mime.hasPrefix("image/") || mime.hasPrefix("video/") else { throw MediaFailure.unavailable }
        return (file, mime)
    }
}

/// 素材 in the Story tools. Recovery rows only exist while this Journey has an
/// unfinished upload; progress replaces the picker while an import runs.
struct PhotosImportSection: View {
    @ObservedObject var model: PhotosImportModel
    @State private var selection: [PhotosPickerItem] = []
    var body: some View {
        Section("素材") {
            if model.busy {
                ProgressView(value: model.progress) { Text("正在导入") }
                    .storyToolRow()
                Button(role: .destructive) { model.cancel() } label: { Label("取消导入", systemImage: "xmark.circle") }
                    .storyToolRow()
            } else {
                // `photoLibrary` only exposes item identifiers; it never asks for library access.
                PhotosPicker(selection: $selection, maxSelectionCount: 100, matching: .any(of: [.images, .videos]),
                             preferredItemEncoding: .current, photoLibrary: .shared()) {
                    Label("添加照片或视频", systemImage: "photo.on.rectangle.angled")
                }
                .storyToolRow()
                .accessibilityIdentifier("story.import")
                .onAppear { model.refreshPending() }
                .onChange(of: selection) { items in
                    if !(items.count > 1 && model.routeBatch?.pick(items) == true) { model.importItems(items) }
                    selection = []
                }
                if model.hasPending {
                    Button { model.recover() } label: { Label("恢复上传", systemImage: "arrow.clockwise") }
                        .storyToolRow()
                        .accessibilityIdentifier("story.import.recover")
                    Button(role: .destructive) { model.cancelPending() } label: { Label("取消未完成导入", systemImage: "xmark.circle") }
                        .storyToolRow()
                        .accessibilityIdentifier("story.import.cancel-pending")
                }
            }
            if let batch = model.routeBatch { RouteBatchEntry(model: batch) }
            if let failure = model.failure { StoryToolNote(text: failure) }
        }
    }
}
