import CryptoKit
import Foundation

/// The owner's 每日手记 as `GET/PUT /api/journeys/:id/journal` carries it
/// (`src/journey/dailyJournal.ts`). Every field round-trips unchanged, so a
/// save never drops what the server or the web editor wrote.
public struct JournalEvent: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, CaseIterable, Sendable {
        case actual, planned, cancelled, uncertain
        public var label: String {
            switch self {
            case .actual: return "实际"
            case .planned: return "计划"
            case .cancelled: return "取消"
            case .uncertain: return "待确认"
            }
        }
        /// The statuses a line can be changed to, in display order.
        public var alternatives: [Status] { Self.allCases.filter { $0 != self } }
    }
    public var id: String
    public var source: String
    public var text: String
    public var status: Status
    public var localDate: String?
    public var localTime: String?
    public var timeContext: String
    public var routePointId: String?
    public var mediaIds: [String]
    public var edited: Bool

    private enum CodingKeys: String, CodingKey {
        case id, source, text, status, localDate, localTime, timeContext, routePointId, mediaIds, edited
    }

    /// The server requires these three keys to be present, as `null` when empty.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(source, forKey: .source)
        try container.encode(text, forKey: .text)
        try container.encode(status, forKey: .status)
        try container.encode(localDate, forKey: .localDate)
        try container.encode(localTime, forKey: .localTime)
        try container.encode(timeContext, forKey: .timeContext)
        try container.encode(routePointId, forKey: .routePointId)
        try container.encode(mediaIds, forKey: .mediaIds)
        try container.encode(edited, forKey: .edited)
    }
}

public struct JournalSuggestion: Codable, Equatable, Sendable {
    public var eventId: String
    public var text: String
    public var questions: [String]
    public var background: String
}

/// Server-owned record of the saved AI import that added a chapter.
public struct JournalImportBatch: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var digest: String
    public var pointIds: [String]
}

public struct JournalChapter: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var date: String
    /// Optional keys are omitted, never sent as `null`.
    public var importDate: String?
    public var importBatch: JournalImportBatch?
    public var title: String
    public var source: String
    public var events: [JournalEvent]
    public var suggestions: [JournalSuggestion]

    /// Questions the model left for the owner, once each, in event order
    /// (`journalChapterQuestions`).
    public var questions: [String] {
        var seen = Set<String>()
        return events.flatMap { event in
            (suggestions.first { $0.eventId == event.id }?.questions ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && seen.insert($0).inserted }
        }
    }

    public func questions(for eventID: String) -> [String] {
        (suggestions.first { $0.eventId == eventID }?.questions ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}

public struct DailyJournal: Codable, Equatable, Sendable {
    public var revision: Int
    public var chapters: [JournalChapter]

    /// The most recently saved AI import that still has chapters (`latestJournalImport`).
    public var latestImport: (id: String, chapters: Int)? {
        var latest: JournalImportBatch?
        for batch in chapters.compactMap(\.importBatch) where latest == nil || batch.at > latest!.at { latest = batch }
        guard let latest else { return nil }
        return (latest.id, chapters.filter { $0.importBatch?.id == latest.id }.count)
    }

    struct Envelope: Codable { let journal: DailyJournal }
}

/// `GET /api/intents/journal-import/jobs/:jobId` progress (`JournalImportProgress`).
public struct JournalImportProgress: Equatable, Sendable {
    public var phase: String
    public var characters: Int
    public var chunks: Int
    /// Completed source segments, the only determinate measure (#783/#807).
    public var segments: Int?
    public var segmentsDone: Int?

    public var label: String {
        switch phase {
        case "connecting": return "正在连接模型…"
        case "receiving": return "正在接收识别结果…"
        case "validating": return "正在核对完整记录…"
        default: return "正在等待处理…"
        }
    }
}

public enum JournalImportSnapshot: Equatable, Sendable {
    case progress(JournalImportProgress)
    /// The unsaved preview; `revision` is the journal revision it was planned on.
    case completed(DailyJournal)
    case cancelled
    case failed(String)
}

public enum JournalImportFailure: LocalizedError, Equatable {
    case invalidResult, expired

    public var errorDescription: String? {
        switch self {
        case .invalidResult: return "未收到完整有效的导入结果；原文已保留。"
        case .expired: return "导入结果已过期；原文已保留，可重新导入。"
        }
    }
}

extension JournalImportSnapshot {
    private struct Wire: Decodable {
        struct Envelope: Decodable { let signature: String; let plan: Plan }
        struct Plan: Decodable {
            struct Target: Decodable { let journeyId: String }
            struct Side: Decodable { let revision: Int; let chapters: [JournalChapter] }
            let version: Int
            let target: Target
            let before: Side
            let after: Side
            let expires: Double
            let importedChapterIds: [String]
        }
        let jobId: String
        let status: String
        let phase: String?
        let characters: Int?
        let chunks: Int?
        let segments: Int?
        let segmentsDone: Int?
        let error: String?
        let envelope: Envelope?
        let planDigest: String?
    }

    /// Port of `readJournalImportSnapshot`: only a complete, bounded plan for
    /// this Journey becomes a preview.
    public static func read(_ data: Data, jobID: String, journeyID: String, now: Date = Date()) throws -> JournalImportSnapshot {
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data), wire.jobId == jobID else {
            throw JournalImportFailure.invalidResult
        }
        let digest = #"^[a-f0-9]{64}$"#
        switch wire.status {
        case "completed":
            guard let envelope = wire.envelope, envelope.signature.range(of: digest, options: .regularExpression) != nil,
                  wire.planDigest?.range(of: digest, options: .regularExpression) != nil else { throw JournalImportFailure.invalidResult }
            let plan = envelope.plan
            let ids = Set(plan.after.chapters.map(\.id))
            guard plan.version == 2, plan.target.journeyId == journeyID, plan.before.revision >= 0,
                  plan.after.revision == plan.before.revision || plan.after.revision == plan.before.revision + 1,
                  ids.count == plan.after.chapters.count,
                  plan.importedChapterIds.allSatisfy(ids.contains) else { throw JournalImportFailure.invalidResult }
            guard plan.expires > now.timeIntervalSince1970 * 1000 else { throw JournalImportFailure.expired }
            return .completed(DailyJournal(revision: plan.before.revision, chapters: plan.after.chapters))
        case "cancelled":
            return .cancelled
        case "failed", "interrupted":
            return .failed(failedMessage(wire.error))
        case "queued", "running":
            guard let phase = wire.phase, ["queued", "connecting", "receiving", "validating"].contains(phase),
                  let characters = wire.characters, characters >= 0, let chunks = wire.chunks, chunks >= 0 else {
                throw JournalImportFailure.invalidResult
            }
            var progress = JournalImportProgress(phase: phase, characters: characters, chunks: chunks)
            if let total = wire.segments, let done = wire.segmentsDone {
                guard total >= 0, done >= 0, done <= total else { throw JournalImportFailure.invalidResult }
                progress.segments = total; progress.segmentsDone = done
            } else if wire.segments != nil || wire.segmentsDone != nil {
                throw JournalImportFailure.invalidResult
            }
            return .progress(progress)
        default:
            throw JournalImportFailure.invalidResult
        }
    }

    static func failedMessage(_ code: String?) -> String {
        switch code {
        case "JOURNAL_CHANGED": return "手记已更新，请保留原文，重新打开后导入。"
        case "JOURNAL_JOB_INTERRUPTED": return "导入已中断；原文已保留，可重新生成。"
        case "INTENT_TIMEOUT": return "模型长时间没有返回有效内容；原文已保留，可重试。"
        default: return "未能完成导入；原文已保留，可重试。"
        }
    }
}

/// The one import a Journey may have in flight. Written before `POST /jobs`, so a
/// relaunch observes the same job (the request id is the job id) and a lost
/// response is retried with the same id, which the server treats as the same job.
public struct JournalImportRecord: Codable, Equatable, Sendable {
    public struct Provider: Codable, Equatable, Sendable { public var baseUrl: String; public var model: String }
    public var version = 1
    public var journeyId: String
    public var requestId: String
    public var source: String
    public var fallbackDate: String
    public var provider: Provider
    /// True once the server answered the submission.
    public var submitted: Bool
}

public struct JournalImportRecordStore {
    let directory: URL
    public init(directory: URL) { self.directory = directory }
    private func url(_ journeyID: String) -> URL {
        let name = SHA256.hash(data: Data(journeyID.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name + ".json")
    }
    public func load(_ journeyID: String) -> JournalImportRecord? {
        guard let data = try? Data(contentsOf: url(journeyID)),
              let record = try? JSONDecoder().decode(JournalImportRecord.self, from: data) else { return nil }
        return record.journeyId == journeyID ? record : nil
    }
    public func save(_ record: JournalImportRecord) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try JSONEncoder().encode(record).write(to: url(record.journeyId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    public func remove(_ journeyID: String) {
        try? FileManager.default.removeItem(at: url(journeyID))
    }
}

/// One owner request to the journal endpoints. HTTP errors arrive as `MediaFailure.http`.
@MainActor public protocol JournalImportBackend: AnyObject {
    func send(_ path: String, method: String, body: Data?) async throws -> Data
}

/// The production backend: the revalidated owner media session, which adds the
/// first-party Origin to every write.
@MainActor final class LiveJournalImportBackend: JournalImportBackend {
    private let session: ScopedMediaSession
    init(session: ScopedMediaSession) { self.session = session }
    func send(_ path: String, method: String, body: Data?) async throws -> Data {
        try await session.write(path, method: method, body: body)
    }
}
