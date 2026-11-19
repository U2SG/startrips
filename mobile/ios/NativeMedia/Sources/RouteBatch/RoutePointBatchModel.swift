import CryptoKit
import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The receipt of `/api/journeys/:id/route-point-batches[/:operationId]`.
public struct RouteBatchOperation: Codable, Equatable, Sendable {
    public struct Undo: Codable, Equatable, Sendable {
        public var eligible: Bool
        public var expiresAt: String?
        public var reason: String?
    }
    public var operationId: String
    public var status: String
    public var undo: Undo
}

/// One picked file waiting for review: a private temporary copy plus its signal.
public struct RouteBatchFile: Equatable, Sendable {
    public var id: String
    public var url: URL
    public var type: UTType
    public var signal: PlacementSignal?
}

/// The durable record of one confirmed batch. Written before the first upload
/// and before the apply POST, so a lost response is reconciled by reading the
/// same operation, never by sending it again.
public struct RouteBatchJournal: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Sendable { case uploading, applying, applied }
    public struct Entry: Codable, Equatable, Sendable {
        public var file: String
        public var record: UUID?
        public var assetId: String?
        public var lost = false
    }
    public var version = 1
    public var operationId: String
    public var draft: RouteBatchDraft
    public var entries: [Entry]
    public var phase: Phase
}

public struct RouteBatchJournalStore {
    let directory: URL
    public init(directory: URL) { self.directory = directory }
    private func url(_ journeyID: String) -> URL {
        let name = SHA256.hash(data: Data(journeyID.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name + ".json")
    }
    public func load(_ journeyID: String) throws -> RouteBatchJournal? {
        let file = url(journeyID)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let journal = try JSONDecoder().decode(RouteBatchJournal.self, from: Data(contentsOf: file))
        return journal.draft.journeyId == journeyID ? journal : nil
    }
    public func save(_ journal: RouteBatchJournal) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try JSONEncoder().encode(journal).write(to: url(journal.draft.journeyId), options: .atomic)
    }
    public func remove(_ journeyID: String) throws {
        let file = url(journeyID)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}

@MainActor public protocol RouteBatchBackend: AnyObject {
    func journey() async throws -> MediaJourney
    /// Copies the file into the resumable import journal at Journey level.
    func stage(_ file: RouteBatchFile) throws -> UUID
    /// The confirmed asset id, or nil when the upload was aborted or its asset removed.
    func upload(_ record: UUID, progress: @escaping (Double) -> Void) async throws -> String?
    func apply(_ body: Data, journeyID: String) async throws -> RouteBatchOperation
    func read(_ operationID: String, journeyID: String) async throws -> RouteBatchOperation
    func undo(_ operationID: String, journeyID: String) async throws -> RouteBatchOperation
}

/// Owner-only native flow of #337: pick several photos, review Route Point
/// drafts from their GPS and capture time, apply them as one batch, undo it.
@MainActor public final class RoutePointBatchModel: ObservableObject {
    public enum Stage: Equatable {
        case idle, reading, review, uploading(Double), interrupted(String), applying, applied, unknown(String), done(String)
    }
    @Published public private(set) var stage: Stage = .idle
    @Published public private(set) var draft: RouteBatchDraft?
    @Published public private(set) var journey: MediaJourney?
    @Published public private(set) var operation: RouteBatchOperation?
    @Published public private(set) var message: String?
    @Published public private(set) var busy = false
    @Published public var presented = false
    public private(set) var files: [String: RouteBatchFile] = [:]
    private let journeyID: String
    private let backend: RouteBatchBackend
    private let store: RouteBatchJournalStore
    private let onChanged: () async throws -> Void

    public init(journeyID: String, backend: RouteBatchBackend, store: RouteBatchJournalStore,
                onChanged: @escaping () async throws -> Void) {
        self.journeyID = journeyID; self.backend = backend; self.store = store; self.onChanged = onChanged
    }

    /// A batch left by an earlier session resumes from what the server says.
    public func restore() {
        guard stage == .idle, let journal = try? store.load(journeyID) else { return }
        draft = journal.draft
        switch journal.phase {
        case .uploading: stage = .interrupted("照片上传未完成。")
        case .applying, .applied: Task { await reconcile(rejected: false) }
        }
    }

    // MARK: Review

    /// False when a batch is already open; the caller imports the items plainly.
    @discardableResult public func pick(_ items: [PhotosPickerItem]) -> Bool {
        guard !busy, stage == .idle || isFinished, items.count > 1 else { return false }
        discardFiles(); draft = nil; journey = nil; operation = nil
        stage = .reading; presented = true; message = nil
        Task {
            var picked: [RouteBatchFile] = []
            do {
                for item in items {
                    guard let file = try await item.loadTransferable(type: PickedMediaFile.self) else { throw MediaFailure.unavailable }
                    let url = file.url, identifier = item.itemIdentifier
                    let signal = await Task.detached(priority: .userInitiated) {
                        PlacementSignalReader.signal(at: url, libraryIdentifier: identifier)
                    }.value
                    picked.append(RouteBatchFile(id: UUID().uuidString.lowercased(), url: file.url, type: file.type, signal: signal))
                }
                await review(picked)
            } catch {
                picked.forEach { try? FileManager.default.removeItem(at: $0.url) }
                stage = .done(error.localizedDescription)
            }
        }
        return true
    }

    /// Plans against a fresh Journey read; nothing is uploaded or saved yet.
    public func review(_ picked: [RouteBatchFile]) async {
        do {
            let fresh = try await backend.journey()
            let ids = picked.map(\.id)
            let plan = try PlacementPlanner.plan(picked.map { PlacementInput(id: $0.id, signal: $0.signal) },
                                                 journey: PlacementJourney(fresh),
                                                 batchId: "route-batch:" + UUID().uuidString.lowercased())
            let signals = Dictionary(uniqueKeysWithValues: picked.compactMap { file in file.signal.map { (file.id, $0) } })
            draft = try RouteBatchDraft(plan: plan, journey: fresh, signals: signals, files: ids)
            files = Dictionary(uniqueKeysWithValues: picked.map { ($0.id, $0) })
            journey = fresh
            stage = .review
        } catch {
            picked.forEach { try? FileManager.default.removeItem(at: $0.url) }
            stage = .done(error.localizedDescription)
        }
    }

    public func edit(_ action: RouteBatchAction) {
        guard stage == .review, !busy, let draft, let journey else { return }
        do {
            let next = try draft.editing(action, journey: journey)
            self.draft = next; message = nil
            if next.shouldAutoSubmit(after: action) { Task { await confirm() } }
        } catch {
            message = error.localizedDescription
        }
    }

    /// The photo's own coordinate, offered so a pending group can be confirmed as a new point.
    public func photoCoordinate(_ group: RouteBatchGroup) -> (latitude: Double, longitude: Double)? {
        let candidates = group.representative.map { [$0] } ?? (group.files.count == 1 ? group.files : [])
        guard let file = candidates.first, let signal = files[file]?.signal, signal.hasCoordinateEvidence else { return nil }
        return (signal.latitude!, signal.longitude!)
    }

    public func cancelReview() {
        guard stage == .review || isFinished, !busy else { return }
        discardFiles(); draft = nil; journey = nil; message = nil
        stage = .idle; presented = false
    }

    // MARK: Apply

    public func confirm() async {
        guard stage == .review, !busy, let draft, draft.isComplete else { return }
        busy = true
        defer { busy = false }
        do {
            guard try store.load(journeyID) == nil else { message = "上一批照片还在整理中。"; return }
            // Identity first: the operation id exists on disk before any upload starts.
            let journal = RouteBatchJournal(operationId: draft.batchId, draft: draft,
                                            entries: draft.files.map { RouteBatchJournal.Entry(file: $0) }, phase: .uploading)
            try store.save(journal)
            try await upload(journal)
        } catch {
            stage = .interrupted(error.localizedDescription)
        }
    }

    public func resume() async {
        guard !busy, case .interrupted = stage, let journal = try? store.load(journeyID), journal.phase == .uploading else { return }
        busy = true
        defer { busy = false }
        do { try await upload(journal) } catch { stage = .interrupted(error.localizedDescription) }
    }

    private func upload(_ saved: RouteBatchJournal) async throws {
        var journal = saved
        let total = Double(max(journal.entries.count, 1))
        stage = .uploading(0)
        // Stage every file into the resumable import journal before the first upload.
        for index in journal.entries.indices where journal.entries[index].record == nil && !journal.entries[index].lost {
            guard let file = files[journal.entries[index].file] else { journal.entries[index].lost = true; try store.save(journal); continue }
            journal.entries[index].record = try backend.stage(file)
            try store.save(journal)
            try? FileManager.default.removeItem(at: file.url)
            files[file.id] = nil
        }
        for index in journal.entries.indices where journal.entries[index].assetId == nil && !journal.entries[index].lost {
            stage = .uploading(Double(index) / total)
            guard let record = journal.entries[index].record else { journal.entries[index].lost = true; try store.save(journal); continue }
            let asset = try await backend.upload(record) { [weak self] fraction in
                self?.stage = .uploading((Double(index) + fraction) / total)
            }
            if let asset { journal.entries[index].assetId = asset } else { journal.entries[index].lost = true }
            try store.save(journal)
        }
        try await apply(journal)
    }

    private func apply(_ saved: RouteBatchJournal) async throws {
        var journal = saved
        journal.draft = journal.draft.removingFiles(Set(journal.entries.filter(\.lost).map(\.file)))
        draft = journal.draft
        let assets = Dictionary(journal.entries.compactMap { entry in entry.assetId.map { (entry.file, $0) } },
                                uniquingKeysWith: { first, _ in first })
        stage = .applying
        let fresh = try await backend.journey()
        // A fresh read right before apply: the route and the uploaded assets must be exactly as reviewed.
        let unplacedAssets = Set(fresh.media.filter { $0.routePointId == nil }.map(\.id))
        guard fresh.revision == journal.draft.routeRevision, assets.values.allSatisfy(unplacedAssets.contains),
              let body = try journal.draft.applyBody(assets: assets, operationId: journal.operationId) else {
            try store.remove(journeyID)
            stage = .done(fresh.revision == journal.draft.routeRevision ? "照片已保留在整段旅程。" : RouteBatchError.stale.localizedDescription)
            try? await onChanged()
            return
        }
        journal.phase = .applying
        try store.save(journal)
        do {
            operation = try await backend.apply(body, journeyID: journeyID)
            journal.phase = .applied
            try store.save(journal)
            stage = .applied
            try? await onChanged()
        } catch {
            await reconcile(rejected: Self.isRejection(error))
        }
    }

    /// Reads the saved operation. A 404 after a definite rejection releases the
    /// batch; any other uncertainty keeps the journal so nothing is resent.
    public func reconcile(rejected: Bool = false) async {
        guard let journal = try? store.load(journeyID), journal.phase != .uploading else { return }
        draft = journal.draft
        stage = .applying
        do {
            let current = try await backend.read(journal.operationId, journeyID: journeyID)
            operation = current
            if current.status == "undone" || current.status == "partially-undone" {
                try? store.remove(journeyID); stage = .done("已撤销。")
            } else {
                var applied = journal; applied.phase = .applied
                try? store.save(applied)
                stage = .applied
            }
            try? await onChanged()
        } catch MediaFailure.http(404) where rejected {
            try? store.remove(journeyID)
            stage = .done(RouteBatchError.stale.localizedDescription)
            try? await onChanged()
        } catch {
            stage = .unknown("整理结果暂时无法确认。")
        }
    }

    private static func isRejection(_ error: Error) -> Bool {
        if case MediaFailure.http(let status) = error { return (400..<500).contains(status) && status != 408 && status != 429 }
        return false
    }

    public func undo() async {
        guard stage == .applied, !busy, let operation else { return }
        busy = true
        defer { busy = false }
        do {
            let current = try await backend.read(operation.operationId, journeyID: journeyID)
            self.operation = current
            guard current.undo.eligible else { message = "这一批已无法撤销。"; return }
            let outcome: RouteBatchOperation
            do { outcome = try await backend.undo(current.operationId, journeyID: journeyID) }
            catch {
                // Check the same operation; never send a second undo blindly.
                outcome = try await backend.read(current.operationId, journeyID: journeyID)
            }
            self.operation = outcome
            if outcome.status == "undone" || outcome.status == "partially-undone" {
                try? store.remove(journeyID)
                stage = .done("已撤销。")
            } else {
                message = "撤销结果暂时无法确认。"
            }
            try? await onChanged()
        } catch {
            message = "撤销结果暂时无法确认。"
        }
    }

    /// Closes a settled batch. Uploaded photos always stay in the Journey.
    public func finish() {
        guard !busy else { return }
        switch stage {
        case .applied, .unknown, .interrupted, .done: try? store.remove(journeyID)
        default: break
        }
        discardFiles(); draft = nil; journey = nil; operation = nil; message = nil
        stage = .idle; presented = false
    }

    private var isFinished: Bool { if case .done = stage { return true }; return false }

    private func discardFiles() {
        files.values.forEach { try? FileManager.default.removeItem(at: $0.url) }
        files = [:]
    }
}

/// The production backend: the resumable importer and the owner media session.
@MainActor final class LiveRouteBatchBackend: RouteBatchBackend {
    private let session: ScopedMediaSession
    private let importer: MultipartImporter
    private let journeyID: String
    private let readJourney: () async throws -> MediaJourney
    private struct Envelope: Decodable { let operation: RouteBatchOperation }

    init(session: ScopedMediaSession, importer: MultipartImporter, journeyID: String,
         readJourney: @escaping () async throws -> MediaJourney) {
        self.session = session; self.importer = importer; self.journeyID = journeyID; self.readJourney = readJourney
    }

    func journey() async throws -> MediaJourney { try await readJourney() }

    func stage(_ file: RouteBatchFile) throws -> UUID {
        let prepared = try PhotosImportModel.prepare(file.url, type: file.type)
        defer { if prepared.url != file.url { try? FileManager.default.removeItem(at: prepared.url) } }
        return try importer.stage(file: prepared.url, fileName: prepared.url.lastPathComponent, mimeType: prepared.mime,
                                  journeyId: journeyID, routePointId: nil,
                                  recordedEvidence: RecordedEvidence(file.signal)).id
    }

    func upload(_ record: UUID, progress: @escaping (Double) -> Void) async throws -> String? {
        guard let saved = try importer.record(record) else { return nil }
        guard !saved.aborted else { return nil }
        do { return try await importer.resume(saved, progress: progress) }
        catch MediaFailure.uploadAborted { return nil }
        catch MediaFailure.uploadedAssetRemoved { return nil }
    }

    private func path(_ journeyID: String, _ suffix: String = "") -> String {
        "/api/journeys/\(component(journeyID))/route-point-batches" + suffix
    }

    func apply(_ body: Data, journeyID: String) async throws -> RouteBatchOperation {
        try JSONDecoder().decode(Envelope.self, from: await session.write(path(journeyID), body: body)).operation
    }

    func read(_ operationID: String, journeyID: String) async throws -> RouteBatchOperation {
        try JSONDecoder().decode(Envelope.self, from: await session.write(path(journeyID, "/" + component(operationID)), method: "GET")).operation
    }

    func undo(_ operationID: String, journeyID: String) async throws -> RouteBatchOperation {
        try JSONDecoder().decode(Envelope.self, from: await session.write(path(journeyID, "/" + component(operationID) + "/undo"))).operation
    }
}
