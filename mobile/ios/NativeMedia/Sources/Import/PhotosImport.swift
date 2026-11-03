import CoreTransferable
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

private struct PickedMediaFile: Transferable {
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
    public let importer: MultipartImporter
    private var task: Task<Void, Never>?
    private var current: ImportRecord?
    private let journeyID: String
    let pointForBatch: () -> String?
    private let onImported: ([String]) async throws -> Void
    public init(importer: MultipartImporter, journeyID: String, routePointID: String?,
                currentPointID: (() -> String?)? = nil, onImported: @escaping ([String]) async throws -> Void) {
        self.importer = importer; self.journeyID = journeyID; self.onImported = onImported
        self.pointForBatch = currentPointID ?? { routePointID }
    }
    public func importItems(_ items: [PhotosPickerItem]) {
        guard !busy, !items.isEmpty else { return }
        let pointID = pointForBatch()
        busy = true; progress = 0; failure = nil
        task = Task {
            defer { busy = false; current = nil }
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
            defer { busy = false; current = nil }
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
        Task { do { try await cancelAndRefresh(record) } catch { failure = error.localizedDescription } }
    }
    public func cancelPending() {
        guard !busy else { return }; busy = true; failure = nil
        task = Task {
            defer { busy = false; current = nil }
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

public struct PhotosImportButton: View {
    @ObservedObject var model: PhotosImportModel
    @State private var selection: [PhotosPickerItem] = []
    public init(model: PhotosImportModel) { self.model = model }
    public var body: some View {
        VStack {
            if model.busy {
                ProgressView("正在读取或上传素材", value: model.progress)
                Button("取消导入") { model.cancel() }.frame(minHeight: 44)
            } else {
                PhotosPicker(selection: $selection, maxSelectionCount: 100, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current) {
                    Label("添加照片或视频", systemImage: "photo.on.rectangle.angled")
                }.frame(minHeight: 44).accessibilityIdentifier("story.import")
                Button("恢复上传") { model.recover() }.frame(minHeight: 44)
                Button("取消未完成导入") { model.cancelPending() }.frame(minHeight: 44)
            }
            if let failure = model.failure { Text(failure).font(.callout) }
        }.onChange(of: selection) { items in model.importItems(items); selection = [] }
    }
}
