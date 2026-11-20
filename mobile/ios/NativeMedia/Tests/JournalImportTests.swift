import XCTest
@testable import StartripsMedia

private let journeyID = "11111111-1111-4111-8111-111111111111"
private let digest = String(repeating: "a", count: 64)

/// Synthetic owner server: each `METHOD path` answers from a queue (the last
/// answer repeats), and every request is recorded. No network.
@MainActor private final class FakeServer: JournalImportBackend {
    struct Call { let method: String; let path: String; let body: Data? }
    var calls: [Call] = []
    var replies: [String: [Result<String, Error>]] = [:]
    var onCall: ((Call) -> Void)?

    func reply(_ method: String, _ path: String, _ answers: Result<String, Error>...) { replies[method + " " + path] = answers }
    func send(_ path: String, method: String, body: Data?) async throws -> Data {
        let call = Call(method: method, path: path, body: body)
        calls.append(call); onCall?(call)
        let key = method + " " + path
        guard var queue = replies[key], let next = queue.first else { throw MediaFailure.http(500) }
        if queue.count > 1 { queue.removeFirst(); replies[key] = queue }
        return Data(try next.get().utf8)
    }
    func count(_ method: String, _ path: String) -> Int { calls.filter { $0.method == method && $0.path == path }.count }
    func json(_ method: String, _ path: String) -> [String: Any]? {
        guard let body = calls.last(where: { $0.method == method && $0.path == path })?.body else { return nil }
        return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }
}

private func event(_ id: String, _ text: String, status: String = "actual", time: String? = nil) -> String {
    #"{"id":"\#(id)","source":"\#(text)","text":"\#(text)","status":"\#(status)","localDate":null,"localTime":\#(time.map { "\"\($0)\"" } ?? "null"),"timeContext":"当地时间","routePointId":null,"mediaIds":[],"edited":false}"#
}

private func chapter(_ id: String, _ date: String, events: [String], questions: [String: [String]] = [:], batch: String? = nil) -> String {
    let suggestions = questions.map { #"{"eventId":"\#($0.key)","text":"","questions":[\#($0.value.map { "\"\($0)\"" }.joined(separator: ","))],"background":""}"# }
    let importBatch = batch.map { #","importBatch":{"id":"\#($0)","at":"2026-11-19T10:00:00.000Z","digest":"\#(digest)","pointIds":[]}"# } ?? ""
    return #"{"id":"\#(id)","date":"\#(date)","title":"","source":"\#(id) source","events":[\#(events.joined(separator: ","))],"suggestions":[\#(suggestions.joined(separator: ","))]\#(importBatch)}"#
}

private func journal(_ revision: Int, _ chapters: [String]) -> String {
    #"{"journal":{"revision":\#(revision),"chapters":[\#(chapters.joined(separator: ","))]}}"#
}

private let existing = chapter("old", "2026-05-01", events: [event("old-1", "旧的一天")])
private let dayOne = chapter("new-1", "2026-05-02", events: [event("e1", "早上到京都", time: "08:30"), event("e2", "也许去了奈良", status: "uncertain")],
                             questions: ["e2": ["是否实际去了奈良？"]])
private let dayTwo = chapter("new-2", "2026-05-03", events: [event("e3", "回程")])

private func progress(_ id: String, phase: String = "receiving", segments: Int? = 4, done: Int? = 1) -> String {
    let extra = segments.map { #","segments":\#($0),"segmentsDone":\#(done ?? 0)"# } ?? ""
    return #"{"jobId":"\#(id)","status":"running","phase":"\#(phase)","characters":120,"chunks":3\#(extra)}"#
}

private func completed(_ id: String, before: Int = 3, expires: Double = 4_102_444_800_000, journey: String = journeyID) -> String {
    #"{"jobId":"\#(id)","status":"completed","phase":"validating","characters":10,"chunks":1,"segments":2,"segmentsDone":2,"degradedLines":1,"degradations":[],"planDigest":"\#(digest)","envelope":{"signature":"\#(digest)","plan":{"version":2,"target":{"atlasId":"atlas","journeyId":"\#(journey)"},"before":{"revision":\#(before),"chapters":[\#(existing)]},"after":{"revision":\#(before + 1),"chapters":[\#(existing),\#(dayOne),\#(dayTwo)]},"expires":\#(expires),"importedChapterIds":["new-1","new-2"]}}}"#
}

private let root = "/api/intents/journal-import"
private let journalPath = "/api/journeys/\(journeyID)/journal"
private let provider = #"{"available":true,"baseUrl":"https://model.example","model":"journal-model"}"#

final class JournalImportTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("journal-import-\(UUID().uuidString)")
    }
    override func tearDown() { try? FileManager.default.removeItem(at: directory) }

    @MainActor private func model(_ server: FakeServer, journalChanged: @escaping @MainActor () -> Void = {},
                                  journeyChanged: @escaping @MainActor () async throws -> Void = {}) -> JournalImportModel {
        JournalImportModel(journeyID: journeyID, fallbackDate: "2026-05-01", backend: server,
                           store: JournalImportRecordStore(directory: directory), pollInterval: 1_000_000,
                           journalChanged: journalChanged, journeyChanged: journeyChanged)
    }

    @MainActor private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<400 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("condition not reached", file: file, line: line)
    }

    // MARK: Snapshot parsing

    func testProgressCarriesSegmentCountsAndRejectsImpossibleOnes() throws {
        let id = "job-1"
        XCTAssertEqual(try JournalImportSnapshot.read(Data(progress(id).utf8), jobID: id, journeyID: journeyID),
                       .progress(JournalImportProgress(phase: "receiving", characters: 120, chunks: 3, segments: 4, segmentsDone: 1)))
        XCTAssertEqual(try JournalImportSnapshot.read(Data(progress(id, phase: "queued", segments: nil).utf8), jobID: id, journeyID: journeyID),
                       .progress(JournalImportProgress(phase: "queued", characters: 120, chunks: 3)))
        XCTAssertThrowsError(try JournalImportSnapshot.read(Data(progress(id, segments: 2, done: 3).utf8), jobID: id, journeyID: journeyID))
        XCTAssertThrowsError(try JournalImportSnapshot.read(Data(progress(id, phase: "thinking").utf8), jobID: id, journeyID: journeyID))
        XCTAssertThrowsError(try JournalImportSnapshot.read(Data(progress("other").utf8), jobID: id, journeyID: journeyID))
    }

    func testCompletedPlanBecomesAPreviewOnItsBeforeRevisionOnly() throws {
        let id = "job-2"
        guard case .completed(let draft) = try JournalImportSnapshot.read(Data(completed(id).utf8), jobID: id, journeyID: journeyID) else {
            return XCTFail("expected a preview")
        }
        XCTAssertEqual(draft.revision, 3)
        XCTAssertEqual(draft.chapters.map(\.id), ["old", "new-1", "new-2"])
        // The model's status and its 待确认 question are kept as delivered.
        XCTAssertEqual(draft.chapters[1].events[1].status, .uncertain)
        XCTAssertEqual(draft.chapters[1].questions, ["是否实际去了奈良？"])
        XCTAssertThrowsError(try JournalImportSnapshot.read(Data(completed(id, journey: "another").utf8), jobID: id, journeyID: journeyID)) {
            XCTAssertEqual($0 as? JournalImportFailure, .invalidResult)
        }
        XCTAssertThrowsError(try JournalImportSnapshot.read(Data(completed(id, expires: 1).utf8), jobID: id, journeyID: journeyID)) {
            XCTAssertEqual($0 as? JournalImportFailure, .expired)
        }
    }

    func testTerminalErrorCodesKeepTheWebWording() throws {
        func failed(_ status: String, _ code: String) throws -> JournalImportSnapshot {
            try JournalImportSnapshot.read(Data(#"{"jobId":"j","status":"\#(status)","phase":"receiving","characters":0,"chunks":0,"error":"\#(code)","kind":"operation"}"#.utf8),
                                           jobID: "j", journeyID: journeyID)
        }
        XCTAssertEqual(try failed("failed", "JOURNAL_CHANGED"), .failed("手记已更新，请保留原文，重新打开后导入。"))
        XCTAssertEqual(try failed("interrupted", "JOURNAL_JOB_INTERRUPTED"), .failed("导入已中断；原文已保留，可重新生成。"))
        XCTAssertEqual(try failed("failed", "INTENT_TIMEOUT"), .failed("模型长时间没有返回有效内容；原文已保留，可重试。"))
        XCTAssertEqual(try failed("failed", "LLM_INVALID_OUTPUT"), .failed("未能完成导入；原文已保留，可重试。"))
        XCTAssertEqual(try failed("cancelled", ""), .cancelled)
        XCTAssertEqual(JournalImportModel.rejected(409), "已有导入任务或手记已更新，请先完成当前任务。")
        XCTAssertEqual(JournalImportModel.rejected(403), "当前账户不能导入，请重新登录后重试。")
    }

    func testChaptersRoundTripWithExplicitNullsAndWithoutInventedKeys() throws {
        let data = Data(journal(3, [existing, chapter("b", "2026-05-02", events: [event("x", "y")], batch: "batch-1")]).utf8)
        let decoded = try JSONDecoder().decode(DailyJournal.Envelope.self, from: data).journal
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as! [String: Any]
        let chapters = encoded["chapters"] as! [[String: Any]]
        let firstEvent = (chapters[0]["events"] as! [[String: Any]])[0]
        XCTAssertTrue(firstEvent["localDate"] is NSNull)
        XCTAssertTrue(firstEvent["routePointId"] is NSNull)
        XCTAssertNil(chapters[0]["importDate"])
        XCTAssertNil(chapters[0]["importBatch"])
        XCTAssertEqual((chapters[1]["importBatch"] as? [String: Any])?["id"] as? String, "batch-1")
        XCTAssertEqual(decoded.latestImport?.id, "batch-1")
        XCTAssertEqual(decoded.latestImport?.chapters, 1)
    }

    // MARK: Job lifecycle

    @MainActor func testImportPersistsTheJobBeforeSubmittingAndSavesOnlyAcceptedChapters() async throws {
        let server = FakeServer()
        var reloaded = 0
        let model = model(server, journalChanged: { reloaded += 1 })
        let store = JournalImportRecordStore(directory: directory)
        server.reply("GET", journalPath, .success(journal(3, [existing])))
        server.reply("GET", root + "/provider", .success(provider))
        var jobID = ""
        server.onCall = { call in
            guard call.method == "POST", call.path == root + "/jobs",
                  let body = try? JSONSerialization.jsonObject(with: call.body ?? Data()) as? [String: Any],
                  let requestID = body["requestId"] as? String else { return }
            // The record exists before the submission leaves the device.
            XCTAssertEqual(store.load(journeyID)?.requestId, requestID)
            XCTAssertEqual(store.load(journeyID)?.submitted, false)
            jobID = requestID
            server.reply("POST", root + "/jobs", .success(#"{"jobId":"\#(requestID)"}"#))
            server.reply("GET", root + "/jobs/\(requestID)", .success(progress(requestID)), .success(progress(requestID, done: 3)),
                         .success(completed(requestID)))
        }
        model.source = "5月2日 早上到京都"
        model.start()
        try await waitUntil { model.stage == .review }
        XCTAssertEqual(server.count("POST", root + "/jobs"), 1)
        let body = server.json("POST", root + "/jobs")
        XCTAssertEqual(body?["fallbackDate"] as? String, "2026-05-01")
        XCTAssertEqual(body?["sentence"] as? String, JournalImportModel.sentence)
        XCTAssertEqual((body?["provider"] as? [String: String])?["model"], "journal-model")
        XCTAssertEqual(model.newChapters.map(\.id), ["new-1", "new-2"])

        model.setStatus("new-1", "e2", .actual)
        model.editText("new-1", "e1", "早上抵达京都")
        model.setIncluded("new-2", false)
        server.reply("PUT", journalPath, .success(journal(4, [existing, dayOne])))
        model.apply()
        try await waitUntil { model.stage == .saved }
        let saved = try XCTUnwrap(server.json("PUT", journalPath))
        XCTAssertEqual(saved["baseRevision"] as? Int, 3)
        XCTAssertEqual(saved["importedChapterIds"] as? [String], ["new-1"])
        let chapters = try XCTUnwrap(saved["chapters"] as? [[String: Any]])
        XCTAssertEqual(chapters.map { $0["id"] as? String }, ["old", "new-1"])
        let events = try XCTUnwrap(chapters[1]["events"] as? [[String: Any]])
        XCTAssertEqual(events[0]["text"] as? String, "早上抵达京都")
        XCTAssertEqual(events[0]["edited"] as? Bool, true)
        XCTAssertEqual(events[1]["status"] as? String, "actual")
        XCTAssertNil(store.load(journeyID))
        XCTAssertEqual(model.source, "")
        XCTAssertEqual(reloaded, 1)
        XCTAssertFalse(jobID.isEmpty)
    }

    @MainActor func testStaleSaveReloadsTheJournalAndNeverOverwrites() async throws {
        let server = FakeServer()
        let model = model(server)
        let id = "22222222-2222-4222-8222-222222222222"
        try JournalImportRecordStore(directory: directory).save(JournalImportRecord(
            journeyId: journeyID, requestId: id, source: "原文", fallbackDate: "2026-05-01",
            provider: .init(baseUrl: "https://model.example", model: "journal-model"), submitted: true))
        server.reply("GET", journalPath, .success(journal(3, [existing])), .success(journal(5, [existing, dayTwo])))
        server.reply("GET", root + "/jobs/\(id)", .success(completed(id)))
        server.reply("PUT", journalPath, .failure(MediaFailure.http(409)))
        model.restore()
        try await waitUntil { model.stage == .review }
        model.apply()
        try await waitUntil { model.stage == .compose }
        XCTAssertEqual(server.count("PUT", journalPath), 1)
        XCTAssertEqual(model.saved?.revision, 5)
        XCTAssertNil(model.draft)
        XCTAssertEqual(model.source, "原文")
        XCTAssertEqual(model.message, "手记已在别处更新，已重新读取；原文已保留，可重新导入。")
    }

    @MainActor func testRelaunchObservesTheSameJobWithoutSubmittingAgain() async throws {
        let server = FakeServer()
        let model = model(server)
        let id = "33333333-3333-4333-8333-333333333333"
        try JournalImportRecordStore(directory: directory).save(JournalImportRecord(
            journeyId: journeyID, requestId: id, source: "原文", fallbackDate: "2026-05-01",
            provider: .init(baseUrl: "https://model.example", model: "journal-model"), submitted: true))
        server.reply("GET", root + "/jobs/\(id)", .success(progress(id, done: 2)), .failure(URLError(.notConnectedToInternet)),
                     .success(progress(id, done: 3)))
        model.restore()
        try await waitUntil { if case .running(let value) = model.stage { return value?.segmentsDone == 3 }; return false }
        XCTAssertEqual(server.count("POST", root + "/jobs"), 0)
        XCTAssertEqual(model.source, "原文")
        model.detach()
    }

    @MainActor func testLostSubmissionResumesWithTheSameRequestID() async throws {
        let server = FakeServer()
        let model = model(server)
        server.reply("GET", journalPath, .success(journal(3, [existing])))
        server.reply("GET", root + "/provider", .success(provider))
        server.reply("POST", root + "/jobs", .failure(MediaFailure.http(502)))
        model.source = "原文"
        model.start()
        try await waitUntil { model.stage == .interrupted(stopping: false) }
        let first = try XCTUnwrap(server.json("POST", root + "/jobs")?["requestId"] as? String)
        server.reply("POST", root + "/jobs", .success(#"{"jobId":"\#(first)"}"#))
        server.reply("GET", root + "/jobs/\(first)", .success(#"{"jobId":"\#(first)","status":"failed","phase":"receiving","characters":0,"chunks":0,"error":"INTENT_TIMEOUT"}"#))
        model.resume()
        try await waitUntil { model.stage == .compose }
        XCTAssertEqual(server.calls.filter { $0.path == root + "/jobs" }.compactMap {
            ($0.body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["requestId"] as? String
        }, [first, first])
        XCTAssertEqual(model.message, "模型长时间没有返回有效内容；原文已保留，可重试。")
        XCTAssertNil(JournalImportRecordStore(directory: directory).load(journeyID))
    }

    @MainActor func testRejectedSubmissionKeepsTheSourceAndForgetsTheJob() async throws {
        let server = FakeServer()
        let model = model(server)
        server.reply("GET", journalPath, .success(journal(3, [])))
        server.reply("GET", root + "/provider", .success(provider))
        server.reply("POST", root + "/jobs", .failure(MediaFailure.http(409)))
        model.source = "原文"
        model.start()
        try await waitUntil { model.stage == .compose && model.message != nil }
        XCTAssertEqual(model.message, "已有导入任务或手记已更新，请先完成当前任务。")
        XCTAssertEqual(model.source, "原文")
        XCTAssertNil(JournalImportRecordStore(directory: directory).load(journeyID))
    }

    @MainActor func testUnavailableProviderNeverSubmits() async throws {
        let server = FakeServer()
        let model = model(server)
        server.reply("GET", journalPath, .success(journal(3, [])))
        server.reply("GET", root + "/provider", .success(#"{"available":false}"#))
        model.source = "原文"
        model.start()
        try await waitUntil { model.message != nil }
        XCTAssertEqual(model.message, "AI 导入暂不可用；原文已保留，请稍后重试。")
        XCTAssertEqual(server.count("POST", root + "/jobs"), 0)
    }

    @MainActor func testStopCancelsTheRunningJobAndKeepsTheSource() async throws {
        let server = FakeServer()
        let model = model(server)
        let id = "44444444-4444-4444-8444-444444444444"
        try JournalImportRecordStore(directory: directory).save(JournalImportRecord(
            journeyId: journeyID, requestId: id, source: "原文", fallbackDate: "2026-05-01",
            provider: .init(baseUrl: "https://model.example", model: "journal-model"), submitted: true))
        server.reply("GET", root + "/jobs/\(id)", .success(progress(id)))
        server.reply("POST", root + "/jobs/\(id)/cancel", .failure(MediaFailure.http(503)),
                     .success(#"{"jobId":"\#(id)","status":"cancelled","phase":"receiving","characters":0,"chunks":0}"#))
        model.restore()
        try await waitUntil { if case .running(.some) = model.stage { return true }; return false }
        model.stop()
        try await waitUntil { model.stage == .interrupted(stopping: true) }
        XCTAssertEqual(model.message, "未能确认停止，请重试停止。")
        model.resume()
        try await waitUntil { model.stage == .compose }
        XCTAssertEqual(server.count("POST", root + "/jobs/\(id)/cancel"), 2)
        XCTAssertEqual(model.source, "原文")
        XCTAssertNil(JournalImportRecordStore(directory: directory).load(journeyID))
    }

    @MainActor func testVanishedJobEndsObservation() async throws {
        let server = FakeServer()
        let model = model(server)
        let id = "55555555-5555-4555-8555-555555555555"
        try JournalImportRecordStore(directory: directory).save(JournalImportRecord(
            journeyId: journeyID, requestId: id, source: "原文", fallbackDate: "2026-05-01",
            provider: .init(baseUrl: "https://model.example", model: "journal-model"), submitted: true))
        server.reply("GET", root + "/jobs/\(id)", .failure(MediaFailure.http(404)))
        model.restore()
        try await waitUntil { model.stage == .compose && model.message != nil }
        XCTAssertEqual(server.count("GET", root + "/jobs/\(id)"), 1)
        XCTAssertNil(JournalImportRecordStore(directory: directory).load(journeyID))
    }

    // MARK: Undo

    @MainActor func testUndoConfirmsEditedChaptersOnlyWhenTheRevisionIsUnchanged() async throws {
        let server = FakeServer()
        var journeyReads = 0
        let model = model(server, journeyChanged: { journeyReads += 1 })
        let imported = chapter("new-1", "2026-05-02", events: [event("e1", "到京都")], batch: "batch-1")
        let undo = journalPath + "/imports/batch-1/undo"
        server.reply("GET", journalPath, .success(journal(4, [existing, imported])))
        await model.reload()
        XCTAssertTrue(model.canUndo)
        model.requestUndo()
        XCTAssertEqual(model.undoConfirmation, .chapters(1))
        server.reply("POST", undo, .failure(MediaFailure.http(409)), .success(journal(5, [existing])))
        model.confirmUndo()
        try await waitUntil { model.undoConfirmation == .edited }
        XCTAssertEqual(server.json("POST", undo)?["confirmEdited"] as? Bool, false)
        model.confirmUndo()
        try await waitUntil { model.saved?.revision == 5 && !model.busy }
        XCTAssertEqual(server.json("POST", undo)?["confirmEdited"] as? Bool, true)
        XCTAssertEqual(server.json("POST", undo)?["baseRevision"] as? Int, 4)
        XCTAssertEqual(model.message, "已撤销这次导入。")
        XCTAssertFalse(model.canUndo)
        XCTAssertEqual(journeyReads, 1)
    }

    @MainActor func testUndoAfterAnotherSaveReloadsInsteadOfConfirming() async throws {
        let server = FakeServer()
        let model = model(server)
        let imported = chapter("new-1", "2026-05-02", events: [event("e1", "到京都")], batch: "batch-1")
        let undo = journalPath + "/imports/batch-1/undo"
        server.reply("GET", journalPath, .success(journal(4, [existing, imported])), .success(journal(6, [existing, imported])))
        await model.reload()
        model.requestUndo()
        server.reply("POST", undo, .failure(MediaFailure.http(409)))
        model.confirmUndo()
        try await waitUntil { model.saved?.revision == 6 && !model.busy }
        XCTAssertNil(model.undoConfirmation)
        XCTAssertEqual(server.count("POST", undo), 1)
        XCTAssertEqual(model.message, "手记已在别处更新，已重新读取。")
    }
}
