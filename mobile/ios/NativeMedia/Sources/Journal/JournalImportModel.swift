import Foundation

/// Owner-only native 自动导入 (#775): paste or pick a travel log, let the server
/// job turn it into dated chapters, review them chapter by chapter, save with
/// the journal revision the plan was made on, and undo the saved import.
/// Semantics follow `journalImportApi.ts`, `journalImportSession.ts` and
/// `DailyJournalPanel.tsx`; progress is read by polling the durable job.
@MainActor public final class JournalImportModel: ObservableObject {
    public enum Stage: Equatable {
        case compose, starting, running(JournalImportProgress?), stopping
        /// Observation or stop could not be confirmed; the job keeps its id.
        case interrupted(stopping: Bool)
        case review, saving, saved
    }
    public enum UndoConfirmation: Equatable {
        case chapters(Int)
        /// Some imported chapters were edited after the import.
        case edited
    }

    static let maxSource = 100_000
    static let sentence = "按日期整理这份流水账，保留原文和事件顺序，不新增地图点。"

    @Published public private(set) var stage: Stage = .compose
    @Published public var source = ""
    @Published public private(set) var saved: DailyJournal?
    @Published public private(set) var draft: DailyJournal?
    @Published public private(set) var skipped: Set<String> = []
    @Published public private(set) var message: String?
    @Published public private(set) var busy = false
    @Published public var undoConfirmation: UndoConfirmation?
    @Published public var presented = false

    public let journeyID: String
    private let fallbackDate: String
    private let backend: JournalImportBackend
    private let store: JournalImportRecordStore
    private let pollInterval: UInt64
    private let journalChanged: @MainActor () -> Void
    private let journeyChanged: @MainActor () async throws -> Void
    private var task: Task<Void, Never>?
    private var generation = 0
    private var stopRequested = false

    public init(journeyID: String, fallbackDate: String, backend: JournalImportBackend, store: JournalImportRecordStore,
                pollInterval: UInt64 = 1_000_000_000,
                journalChanged: @escaping @MainActor () -> Void = {}, journeyChanged: @escaping @MainActor () async throws -> Void = {}) {
        self.journeyID = journeyID; self.fallbackDate = fallbackDate; self.backend = backend; self.store = store
        self.pollInterval = pollInterval; self.journalChanged = journalChanged; self.journeyChanged = journeyChanged
    }

    private var journalPath: String { "/api/journeys/\(component(journeyID))/journal" }
    private static let root = "/api/intents/journal-import"
    private static func jobPath(_ id: String, _ suffix: String = "") -> String { "\(root)/jobs/\(component(id))\(suffix)" }

    public var newChapters: [JournalChapter] {
        guard let draft else { return [] }
        let known = Set(saved?.chapters.map(\.id) ?? [])
        return draft.chapters.enumerated().filter { !known.contains($0.element.id) }
            .sorted { $0.element.date == $1.element.date ? $0.offset < $1.offset : $0.element.date < $1.element.date }
            .map(\.element)
    }
    public var canStart: Bool {
        stage == .compose && !busy && !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    public var canApply: Bool { stage == .review && newChapters.contains { !skipped.contains($0.id) } }
    public var canUndo: Bool { (stage == .compose || stage == .saved) && saved?.latestImport != nil && !busy }

    // MARK: Opening and relaunch

    public func open() {
        presented = true
        if saved == nil && stage == .compose { Task { await reload() } }
    }

    /// An import left by an earlier launch resumes observing the same job.
    public func restore() {
        guard stage == .compose, task == nil, let record = store.load(journeyID) else { return }
        source = record.source
        run { model, version in await model.submitAndObserve(record, version: version) }
    }

    /// The Story closed or the account changed: stop observing, never send a cancel.
    /// The record stays, so `restore()` picks the same job up again. A save in
    /// flight is left to finish.
    public func detach() {
        guard stage != .saving else { return }
        generation += 1; task?.cancel(); task = nil
        switch stage {
        case .starting, .running, .stopping, .interrupted: stage = .compose; stopRequested = false
        default: break
        }
    }

    // MARK: Starting and observing

    public func start() {
        guard canStart else { return }
        guard source.utf16.count <= Self.maxSource else { message = "原文不能超过 10 万字。"; return }
        message = nil; stopRequested = false
        let text = source
        stage = .starting
        run { model, version in
            do {
                if model.saved == nil { try await model.load() }
                struct Provider: Decodable { let available: Bool; let baseUrl: String?; let model: String? }
                let provider = try JSONDecoder().decode(Provider.self, from: await model.backend.send(Self.root + "/provider", method: "GET", body: nil))
                guard model.current(version) else { return }
                guard provider.available, let baseUrl = provider.baseUrl, let name = provider.model else {
                    model.back("AI 导入暂不可用；原文已保留，请稍后重试。"); return
                }
                if model.stopRequested { model.back(nil); return }
                let record = JournalImportRecord(journeyId: model.journeyID, requestId: UUID().uuidString.lowercased(), source: text,
                                                 fallbackDate: model.fallbackDate, provider: .init(baseUrl: baseUrl, model: name), submitted: false)
                try model.store.save(record)
                await model.submitAndObserve(record, version: version)
            } catch {
                guard model.current(version) else { return }
                model.back(Self.status(error).map(Self.rejected) ?? Self.describe(error))
            }
        }
    }

    /// Continue receiving after an interruption, or retry an unconfirmed stop.
    public func resume() {
        guard case .interrupted(let stopping) = stage, let record = store.load(journeyID) else { return }
        message = nil
        if stopping { stop(); return }
        stage = .running(nil)
        run { model, version in await model.submitAndObserve(record, version: version) }
    }

    private func submitAndObserve(_ initial: JournalImportRecord, version: Int) async {
        var record = initial
        if !record.submitted {
            do {
                struct Body: Encodable {
                    let journeyId, requestId, sentence, source, fallbackDate: String
                    let provider: JournalImportRecord.Provider
                }
                let body = try JSONEncoder().encode(Body(journeyId: record.journeyId, requestId: record.requestId, sentence: Self.sentence,
                                                         source: record.source, fallbackDate: record.fallbackDate, provider: record.provider))
                struct Accepted: Decodable { let jobId: String }
                let accepted = try JSONDecoder().decode(Accepted.self, from: await backend.send(Self.root + "/jobs", method: "POST", body: body))
                guard current(version) else { return }
                guard accepted.jobId == record.requestId else { throw JournalImportFailure.invalidResult }
                record.submitted = true
                try? store.save(record)
            } catch {
                guard current(version) else { return }
                // A 4xx answer means no job exists for this id; anything else may have created it.
                if let status = Self.status(error), (400..<500).contains(status) {
                    store.remove(journeyID); back(Self.rejected(status))
                } else {
                    interrupt(error)
                }
                return
            }
            if stopRequested { await cancel(record.requestId, version: version); return }
        }
        stage = .running(nil)
        await observe(record.requestId, version: version)
    }

    private func observe(_ jobID: String, version: Int) async {
        var failures = 0
        while current(version) {
            do {
                let data = try await backend.send(Self.jobPath(jobID), method: "GET", body: nil)
                guard current(version) else { return }
                failures = 0
                switch try JournalImportSnapshot.read(data, jobID: jobID, journeyID: journeyID) {
                case .progress(let progress):
                    if stage != .running(progress) { stage = .running(progress) }
                case .completed(let preview):
                    await review(preview, version: version); return
                case .cancelled:
                    store.remove(journeyID); back("已停止，原文已保留。"); return
                case .failed(let text):
                    store.remove(journeyID); back(text); return
                }
            } catch {
                guard current(version) else { return }
                if error as? JournalImportFailure == .expired || Self.status(error) == 404 {
                    store.remove(journeyID)
                    back(Self.status(error) == 404 ? "导入任务已不可用，请重新导入。" : Self.describe(error)); return
                }
                // Transient reads retry the same job; three in a row pause for the owner.
                let transient = Self.status(error).map { $0 >= 500 || $0 == 429 } ?? !(error is JournalImportFailure || error is MediaFailure)
                failures += 1
                if !transient || failures >= 3 { interrupt(error); return }
            }
            try? await Task.sleep(nanoseconds: pollInterval)
        }
    }

    private func review(_ preview: DailyJournal, version: Int) async {
        do {
            try await load()
            guard current(version) else { return }
            // The plan was made on one journal revision; a newer journal is never overwritten.
            guard saved?.revision == preview.revision else {
                store.remove(journeyID); back("手记已更新，请保留原文，重新打开后导入。"); return
            }
            draft = preview; skipped = []; message = nil
            stage = .review
        } catch {
            guard current(version) else { return }
            interrupt(error)
        }
    }

    // MARK: Stopping

    public func stop() {
        switch stage {
        case .starting:
            stopRequested = true
            // Before the submission there is no job; afterwards the POST answer is cancelled at once.
            if store.load(journeyID) == nil { generation += 1; task?.cancel(); task = nil; back("已停止，原文已保留。") }
            else { stage = .stopping }
        case .running, .interrupted:
            guard let record = store.load(journeyID) else { back(nil); return }
            stopRequested = true
            stage = .stopping
            run { model, version in
                if record.submitted { await model.cancel(record.requestId, version: version) }
                else {
                    // An unanswered submission may still have created the job.
                    await model.submitAndObserve(record, version: version)
                }
            }
        default:
            break
        }
    }

    private func cancel(_ jobID: String, version: Int) async {
        stage = .stopping
        do {
            let data = try await backend.send(Self.jobPath(jobID, "/cancel"), method: "POST", body: nil)
            guard current(version) else { return }
            if case .progress = try JournalImportSnapshot.read(data, jobID: jobID, journeyID: journeyID) {
                throw JournalImportFailure.invalidResult
            }
            store.remove(journeyID); back("已停止，原文已保留。")
        } catch {
            guard current(version) else { return }
            if Self.status(error) == 404 { store.remove(journeyID); back("已停止，原文已保留。"); return }
            message = "未能确认停止，请重试停止。"
            stage = .interrupted(stopping: true)
        }
    }

    // MARK: Review

    public func setIncluded(_ chapterID: String, _ included: Bool) {
        if included { skipped.remove(chapterID) } else { skipped.insert(chapterID) }
    }

    public func editText(_ chapterID: String, _ eventID: String, _ text: String) {
        updateEvent(chapterID, eventID) { if $0.text != text { $0.text = text; $0.edited = true } }
    }

    /// Answers a 待确认 line. A place link only belongs to an actual visit, as on the web.
    public func setStatus(_ chapterID: String, _ eventID: String, _ status: JournalEvent.Status) {
        updateEvent(chapterID, eventID) { if $0.status != status { $0.status = status; $0.routePointId = nil } }
    }

    private func updateEvent(_ chapterID: String, _ eventID: String, _ change: (inout JournalEvent) -> Void) {
        guard stage == .review, var value = draft, let c = value.chapters.firstIndex(where: { $0.id == chapterID }),
              let e = value.chapters[c].events.firstIndex(where: { $0.id == eventID }) else { return }
        change(&value.chapters[c].events[e])
        draft = value
    }

    public func discard() {
        guard stage == .review else { return }
        store.remove(journeyID)
        draft = nil; skipped = []
        stage = .compose; message = nil
    }

    /// Saves the reviewed chapters on the revision the plan was made on.
    public func apply() {
        guard canApply, let draft else { return }
        let known = Set(saved?.chapters.map(\.id) ?? [])
        let chapters = draft.chapters.filter { known.contains($0.id) || !skipped.contains($0.id) }
        let imported = chapters.map(\.id).filter { !known.contains($0) }
        stage = .saving; message = nil
        run { model, version in
            do {
                struct Body: Encodable { let baseRevision: Int; let chapters: [JournalChapter]; let importedChapterIds: [String] }
                let body = try JSONEncoder().encode(Body(baseRevision: draft.revision, chapters: chapters, importedChapterIds: imported))
                let journal = try JSONDecoder().decode(DailyJournal.Envelope.self,
                                                       from: await model.backend.send(model.journalPath, method: "PUT", body: body)).journal
                guard model.current(version) else { return }
                model.store.remove(model.journeyID)
                model.saved = journal; model.draft = nil; model.skipped = []; model.source = ""
                model.stage = .saved
                model.journalChanged()
            } catch {
                guard model.current(version) else { return }
                if Self.status(error) == 409 {
                    // Someone else saved meanwhile: show their journal, keep the source, never overwrite.
                    model.store.remove(model.journeyID)
                    model.draft = nil; model.skipped = []
                    try? await model.load()
                    guard model.current(version) else { return }
                    model.back("手记已在别处更新，已重新读取；原文已保留，可重新导入。")
                } else {
                    model.message = Self.describe(error)
                    model.stage = .review
                }
            }
        }
    }

    public func finish() {
        guard stage == .saved else { return }
        stage = .compose; message = nil; presented = false
    }

    // MARK: Undo

    public func requestUndo() {
        guard canUndo, let latest = saved?.latestImport else { return }
        undoConfirmation = .chapters(latest.chapters)
    }

    public func confirmUndo() {
        guard let confirmation = undoConfirmation, let saved, let latest = saved.latestImport, !busy else { return }
        let confirmEdited = confirmation == .edited
        undoConfirmation = nil
        busy = true; message = nil
        Task { [weak self] in
            guard let self else { return }
            defer { self.busy = false }
            do {
                let body = try JSONSerialization.data(withJSONObject: ["baseRevision": saved.revision, "confirmEdited": confirmEdited])
                let path = self.journalPath + "/imports/\(component(latest.id))/undo"
                let journal = try JSONDecoder().decode(DailyJournal.Envelope.self, from: await self.backend.send(path, method: "POST", body: body)).journal
                self.saved = journal
                if self.stage == .saved { self.stage = .compose }
                self.message = "已撤销这次导入。"
                self.journalChanged()
                // Hotel points the import added go with it.
                try? await self.journeyChanged()
            } catch let error where Self.status(error) == 409 {
                // Either imported chapters were edited since (same revision), or the journal moved on.
                do {
                    try await self.load()
                    if !confirmEdited && self.saved?.revision == saved.revision { self.undoConfirmation = .edited }
                    else { self.message = "手记已在别处更新，已重新读取。" }
                } catch { self.message = Self.describe(error) }
            } catch {
                self.message = Self.describe(error)
            }
        }
    }

    // MARK: Helpers

    public func reload() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await load() } catch { message = Self.describe(error) }
    }

    private func load() async throws {
        let data = try await backend.send(journalPath, method: "GET", body: nil)
        saved = try JSONDecoder().decode(DailyJournal.Envelope.self, from: data).journal
    }

    private func run(_ work: @escaping @MainActor (JournalImportModel, Int) async -> Void) {
        generation += 1; task?.cancel()
        let version = generation
        task = Task { [weak self] in
            guard let self else { return }
            await work(self, version)
            if self.generation == version { self.task = nil }
        }
    }

    private func current(_ version: Int) -> Bool { version == generation && !Task.isCancelled }

    private func back(_ text: String?) {
        stage = .compose; message = text; stopRequested = false
    }

    private func interrupt(_ error: Error) {
        message = (error as? JournalImportFailure)?.errorDescription
            ?? Self.status(error).flatMap { (400..<500).contains($0) && $0 != 429 ? Self.rejected($0) : nil }
            ?? (error as? MediaFailure).flatMap { $0 == .accessChanged ? $0.errorDescription : nil }
            ?? "连接中断；可继续接收当前导入。"
        if stopRequested { message = "未能确认停止，请重试停止。" }
        stage = .interrupted(stopping: stopRequested)
    }

    nonisolated static func status(_ error: Error) -> Int? {
        if case .http(let status)? = error as? MediaFailure { return status }
        return nil
    }

    /// Same wording as `statusError` in `journalImportApi.ts`.
    nonisolated static func rejected(_ status: Int) -> String {
        switch status {
        case 401, 403: return "当前账户不能导入，请重新登录后重试。"
        case 404: return "导入任务已不可用，请重新打开手记。"
        case 409: return "已有导入任务或手记已更新，请先完成当前任务。"
        default: return "无法开始导入；原文已保留，请稍后重试。"
        }
    }

    nonisolated static func describe(_ error: Error) -> String {
        if let failure = error as? JournalImportFailure { return failure.errorDescription ?? "" }
        if let status = status(error) {
            return status == 409 ? "手记已在别处更新，请重新打开。" : "手记操作失败（\(status)）；原文仍保留。"
        }
        if let failure = error as? MediaFailure { return failure.errorDescription ?? "操作失败；原文仍保留。" }
        return "连接中断；原文仍保留，请重试。"
    }
}
