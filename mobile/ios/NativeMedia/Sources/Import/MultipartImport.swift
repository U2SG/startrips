import Foundation

public struct UploadStatus: Codable, Equatable, Sendable {
    public let uploadId: String
    public let status: String
    public let partSize: Int
    public let partCount: Int
    public let assetId: String?
}
public struct UploadedPart: Codable, Equatable, Sendable {
    public let partNumber: Int
    public let etag: String
}
public struct SignedUploadPart: Decodable, Sendable {
    public let url: URL
    public let headers: [String: String]
}
public struct ImportRecord: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let scopeID: String
    public let journeyId: String
    public let routePointId: String?
    public let fileName: String
    public let mimeType: String
    public let bytes: Int64
    public let file: URL
    public var uploadId: String?
    public var startAttempted = false
    public var partSize: Int = 0
    public var partCount: Int = 0
    public var parts: [UploadedPart] = []
    public var assetId: String?
    public var cancelled = false
    public var aborted = false
}

@MainActor public protocol PartUploading: AnyObject {
    func upload(_ signed: SignedUploadPart, file: URL, key: String) async throws -> String
    func cancel(prefix: String) async
}

public enum ImportCancellation: Equatable { case cancelled, alreadyCompleted(String?) }

/// Journal contains stable IDs and ETags only; never cookies, Bearers or signed URLs.
@MainActor public final class MultipartImporter {
    private let session: ScopedMediaSession
    private let directory: URL
    private let uploader: PartUploading
    private var active = Set<UUID>()
    private var cancelled = Set<UUID>()
    public init(session: ScopedMediaSession, directory: URL, uploader: PartUploading) throws {
        self.session = session; self.directory = directory; self.uploader = uploader
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var destination = directory; try destination.setResourceValues(values)
    }
    public func stage(file: URL, fileName: String, mimeType: String, journeyId: String, routePointId: String?) throws -> ImportRecord {
        guard session.access == .owner else { throw MediaFailure.readOnly }
        let id = UUID(), target = directory.appendingPathComponent(UUID().uuidString + ".source")
        try FileManager.default.copyItem(at: file, to: target)
        let bytes = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard bytes > 0 else { try? FileManager.default.removeItem(at: target); throw MediaFailure.invalidUpload }
        let record = ImportRecord(id: id, scopeID: session.scopeID, journeyId: journeyId, routePointId: routePointId,
                                  fileName: fileName, mimeType: mimeType, bytes: bytes, file: target)
        try save(record)
        return record
    }
    public func pending() throws -> [ImportRecord] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map { try JSONDecoder().decode(ImportRecord.self, from: Data(contentsOf: $0)) }
            .filter { $0.scopeID == session.scopeID && $0.assetId == nil && !$0.aborted }
    }
    public func resume(_ input: ImportRecord, progress: (Double) -> Void = { _ in }) async throws -> String {
        guard session.access == .owner, input.scopeID == session.scopeID else { throw MediaFailure.accessChanged }
        guard !active.contains(input.id) else { throw MediaFailure.uploadPending }
        active.insert(input.id)
        defer {
            active.remove(input.id)
            if let final = try? read(input.id), final.aborted { try? cleanup(final) }
        }
        var record = try read(input.id)
        guard record.scopeID == session.scopeID else { throw MediaFailure.accessChanged }
        guard !record.aborted else { throw MediaFailure.uploadAborted }
        try await session.revalidate(); try Task.checkCancellation()
        if let assetId = record.assetId { return assetId }
        if let uploadID = record.uploadId {
            let status = try await readStatus(of: record, uploadID: uploadID)
            try Task.checkCancellation()
            switch status.status {
            case "completed":
                guard let assetID = try finishCompleted(record, assetID: status.assetId) else {
                    throw MediaFailure.uploadedAssetRemoved
                }
                return assetID
            case "initiated": break
            case "finalizing", "completion_unknown":
                // The server's idempotent complete endpoint owns lease/reconciliation.
                // Reuse the exact saved ETags; never sign parts or create a new upload.
                guard record.partCount > 0,
                      Set(record.parts.map(\.partNumber)) == Set(1...record.partCount),
                      record.parts.count == record.partCount else { throw MediaFailure.uploadPending }
                return try await complete(record, uploadID: uploadID)
            case "aborted", "failed": record.aborted = true; try save(record); throw MediaFailure.uploadAborted
            default: throw MediaFailure.uploadPending // another reconciler owns the server lease
            }
            if record.cancelled || cancelled.contains(record.id) {
                _ = try await session.write("/api/uploads/\(component(uploadID))", method: "DELETE")
                record.aborted = true; try save(record); throw MediaFailure.uploadAborted
            }
        } else {
            try check(record)
            guard !record.startAttempted else { throw MediaFailure.uploadStartUnknown }
            record.startAttempted = true; try save(record)
            struct Started: Decodable { let uploadId: String; let partSize: Int; let partCount: Int }
            let body = try JSONSerialization.data(withJSONObject: [
                "journeyId": record.journeyId, "routePointId": record.routePointId as Any? ?? NSNull(),
                "fileName": record.fileName, "mimeType": record.mimeType, "bytes": record.bytes
            ])
            let result = try JSONDecoder().decode(Started.self, from: await session.write("/api/uploads/start", body: body))
            record.uploadId = result.uploadId; record.partSize = result.partSize; record.partCount = result.partCount
            // Persist the remote identity even if cancellation arrived during start.
            record.cancelled = cancelled.contains(record.id)
            try save(record)
            if record.cancelled {
                _ = try await session.write("/api/uploads/\(component(result.uploadId))", method: "DELETE")
                record.aborted = true; try save(record)
                throw CancellationError()
            }
        }
        guard record.partSize > 0, record.partSize <= 64 * 1024 * 1024, record.partCount > 0,
              Int64(record.partCount) == (record.bytes + Int64(record.partSize) - 1) / Int64(record.partSize),
              let uploadID = record.uploadId else { throw MediaFailure.invalidUpload }
        let handle = try FileHandle(forReadingFrom: record.file)
        defer { try? handle.close() }
        for number in 1...record.partCount {
            try check(record)
            if record.parts.contains(where: { $0.partNumber == number }) { continue }
            let offset = Int64(number - 1) * Int64(record.partSize)
            let length = Int(min(Int64(record.partSize), record.bytes - offset))
            try handle.seek(toOffset: UInt64(offset))
            guard let chunk = try handle.read(upToCount: length), chunk.count == length else { throw MediaFailure.invalidUpload }
            let file = directory.appendingPathComponent("\(record.id.uuidString)-\(number).part")
            if !FileManager.default.fileExists(atPath: file.path) { try chunk.write(to: file, options: .atomic) }
            let key = "\(record.id.uuidString)-\(number)"
            var etag: String?
            // Only expired storage signatures are retried; remote API writes aren't blindly replayed.
            for attempt in 0..<2 {
                let signed = try JSONDecoder().decode(SignedUploadPart.self, from: await session.write("/api/uploads/\(component(uploadID))/parts/\(number)"))
                try check(record)
                do { etag = try await uploader.upload(signed, file: file, key: key); break }
                catch MediaFailure.http(let code) where (code == 401 || code == 403) && attempt == 0 { continue }
            }
            try check(record)
            guard let etag, !etag.isEmpty else { throw MediaFailure.missingETag }
            record.parts.append(UploadedPart(partNumber: number, etag: etag)); try save(record)
            try? FileManager.default.removeItem(at: file)
            progress(Double(record.parts.count) / Double(record.partCount))
        }
        try check(record)
        return try await complete(record, uploadID: uploadID)
    }
    private func complete(_ saved: ImportRecord, uploadID: String) async throws -> String {
        var record = saved
        struct Completion: Decodable { struct Asset: Decodable { let id: String }; let asset: Asset }
        struct Body: Encodable { let parts: [UploadedPart] }
        let body = try JSONEncoder().encode(Body(parts: record.parts.sorted { $0.partNumber < $1.partNumber }))
        let response = try await session.write("/api/uploads/\(component(uploadID))/complete", body: body)
        let completed = try JSONDecoder().decode(Completion.self, from: response)
        guard !completed.asset.id.isEmpty else { throw MediaFailure.invalidUpload }
        // A completed asset is durable even if the user cancelled while complete was in flight.
        record.assetId = completed.asset.id; try save(record); try cleanup(record)
        return completed.asset.id
    }
    @discardableResult public func cancel(_ record: ImportRecord) async throws -> ImportCancellation {
        guard record.scopeID == session.scopeID else { throw MediaFailure.accessChanged }
        var current = try read(record.id)
        guard session.access == .owner, current.scopeID == session.scopeID else { throw MediaFailure.accessChanged }
        let wasActive = active.contains(record.id)
        cancelled.insert(record.id)
        current.cancelled = true; try save(current)
        await uploader.cancel(prefix: record.id.uuidString + "-")
        if let uploadID = current.uploadId {
            if !wasActive {
                let status = try await readStatus(of: current, uploadID: uploadID)
                switch status.status {
                case "completed": return .alreadyCompleted(try finishCompleted(current, assetID: status.assetId))
                case "aborted", "failed": break
                case "initiated": _ = try await session.write("/api/uploads/\(component(uploadID))", method: "DELETE")
                default: throw MediaFailure.uploadPending
                }
            } else {
                _ = try await session.write("/api/uploads/\(component(uploadID))", method: "DELETE")
            }
        }
        // An in-flight start must record its eventual uploadId before aborting it.
        if current.uploadId != nil || !active.contains(record.id) {
            current.aborted = true; try save(current)
        }
        // Retain the source/journal until the abort is acknowledged; an ambiguous completion
        // is reconciled by status, never reported as a deleted durable asset.
        if !active.contains(record.id) { try cleanup(current) }
        return .cancelled
    }
    private func readStatus(of record: ImportRecord, uploadID: String) async throws -> UploadStatus {
        let data = try await session.write("/api/uploads/\(component(uploadID))/status", method: "GET")
        let status = try JSONDecoder().decode(UploadStatus.self, from: data)
        guard status.uploadId == uploadID, status.partSize == record.partSize, status.partCount == record.partCount else { throw MediaFailure.invalidUpload }
        return status
    }
    private func finishCompleted(_ record: ImportRecord, assetID: String?) throws -> String? {
        guard let assetID else {
            // ON DELETE SET NULL: the remote upload completed, but its asset was subsequently removed.
            // Remove the journal last so an interrupted local cleanup is safe to retry.
            try cleanup(record)
            try FileManager.default.removeItem(at: directory.appendingPathComponent(record.id.uuidString + ".json"))
            return nil
        }
        guard !assetID.isEmpty else { throw MediaFailure.invalidUpload }
        var finished = record
        finished.assetId = assetID; try save(finished); try cleanup(finished)
        return assetID
    }
    private func check(_ record: ImportRecord) throws {
        try Task.checkCancellation()
        if cancelled.contains(record.id) || record.cancelled { throw CancellationError() }
    }
    private func read(_ id: UUID) throws -> ImportRecord {
        try JSONDecoder().decode(ImportRecord.self, from: Data(contentsOf: directory.appendingPathComponent(id.uuidString + ".json")))
    }
    private func save(_ record: ImportRecord) throws {
        try JSONEncoder().encode(record).write(to: directory.appendingPathComponent(record.id.uuidString + ".json"), options: .atomic)
    }
    private func cleanup(_ record: ImportRecord) throws {
        // Only this operation's files, never an account-wide directory.
        if FileManager.default.fileExists(atPath: record.file.path) { try FileManager.default.removeItem(at: record.file) }
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where url.lastPathComponent.hasPrefix(record.id.uuidString + "-") && url.pathExtension == "part" {
            try FileManager.default.removeItem(at: url)
        }
    }
}

func component(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
}
