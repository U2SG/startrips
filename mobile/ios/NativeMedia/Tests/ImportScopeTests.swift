import XCTest
@testable import StartripsMedia

@MainActor private final class RecordingUploader: PartUploading {
    var parts: [Data] = []
    var keys: [String] = []
    var cancelled: [String] = []
    var expireOnce = false
    func upload(_ signed: SignedUploadPart, file: URL, key: String) async throws -> String {
        if expireOnce { expireOnce = false; throw MediaFailure.http(403) }
        parts.append(try Data(contentsOf: file)); keys.append(key)
        return "\"etag-\(parts.count)\""
    }
    func cancel(prefix: String) async { cancelled.append(prefix) }
}

@MainActor private final class SuspendedUploader: PartUploading {
    let started: XCTestExpectation
    var continuation: CheckedContinuation<String, Error>?
    init(started: XCTestExpectation) { self.started = started }
    func upload(_ signed: SignedUploadPart, file: URL, key: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in self.continuation = continuation; started.fulfill() }
    }
    func cancel(prefix: String) async {
        continuation?.resume(throwing: CancellationError()); continuation = nil
    }
}

final class ImportScopeTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    func testStatusFixtureMatchesPrivateServerContract() throws {
        let status: UploadStatus = try MediaFixtures.decode("upload-status")
        XCTAssertEqual(status.uploadId, "c9a5cfb0-9bed-41d9-bdea-945283d63bb6")
        XCTAssertEqual(status.partSize, 8388608); XCTAssertEqual(status.partCount, 1); XCTAssertNil(status.assetId)
    }
    @MainActor func testGuestReadsThroughGuestClosureAndCannotWriteOrRecoverAsOwner() async throws {
        var reads: [String] = [], apiCalls = 0
        let session = ScopedMediaSession(scopeID: "guest-share-generation-2", access: .guest,
            read: { id in reads.append(id); return URL(string: "https://media.invalid/fixture")! },
            request: { _, _, _ in apiCalls += 1; return Data() }, revalidate: {})
        _ = try await session.mediaURL("photo-one")
        XCTAssertEqual(reads, ["photo-one"])
        do { _ = try await session.write("/api/uploads/u/status", method: "GET"); XCTFail("Guest entered owner API") }
        catch { XCTAssertEqual(error as? MediaFailure, .readOnly) }
        XCTAssertEqual(apiCalls, 0)
        let root = try directory(), source = root.appendingPathComponent("source")
        try Data([1]).write(to: source)
        let importer = try MultipartImporter(session: session, directory: root.appendingPathComponent("journal"), uploader: RecordingUploader())
        XCTAssertThrowsError(try importer.stage(file: source, fileName: "one.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil))
    }
    @MainActor func testImportUsesCommittedPointAndExportFollowsExternalJourneyRefresh() throws {
        var current = try MediaFixtures.journey()
        let intent = MediaFixtures.intent()
        let owner = ScopedMediaSession(scopeID: "owner", access: .owner,
            read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in throw MediaFailure.unavailable }, revalidate: {})
        let feature = try NativeMediaFeatureModel(journey: current, intent: intent, session: owner,
            directory: directory(), uploader: RecordingUploader(), currentIntent: { intent }, latestJourney: { current },
            readJourney: { current }, refresh: { _, _ in XCTFail("External refresh was echoed") }, onReturn: { _ in })
        defer { feature.invalidate() }
        let importer = try XCTUnwrap(feature.importer)
        let second = try XCTUnwrap(feature.story.cursor.entries.firstIndex { $0.routePointId == "point-two" })
        let proposal = feature.story.beginPaging(second)
        XCTAssertEqual(importer.pointForBatch(), "point-one")
        feature.story.finishPaging(proposal, completed: true)
        let batchPoint = importer.pointForBatch()
        XCTAssertEqual(batchPoint, "point-two")
        feature.story.select(0)
        XCTAssertNil(importer.pointForBatch())
        XCTAssertEqual(batchPoint, "point-two")

        let old = try XCTUnwrap(feature.exporter)
        XCTAssertFalse(old.includeNotes)
        let normal = try old.prepareForExport()
        XCTAssertEqual(normal.manifest.output.width, 1080)
        XCTAssertEqual(normal.manifest.output.height, 1920)
        XCTAssertEqual(normal.plan.actualDurationMs, 30000, accuracy: 10)
        for seconds in [15, 30, 60] {
            old.presetSeconds = seconds
            old.portrait = false
            let configured = try old.prepareForExport()
            XCTAssertEqual(configured.plan.actualDurationMs, Double(seconds * 1000), accuracy: 10)
            XCTAssertEqual(configured.manifest.output.width, 1920)
            XCTAssertEqual(configured.manifest.output.height, 1080)
        }
        old.includeNotes = true
        current.title = "旅程的新标题"; current.revision += 1
        try feature.updateJourney(current)
        let refreshed = try XCTUnwrap(feature.exporter)
        XCTAssertFalse(old === refreshed)
        XCTAssertTrue(refreshed.includeNotes)
        XCTAssertEqual(refreshed.presetSeconds, 60)
        XCTAssertFalse(refreshed.portrait)
        XCTAssertEqual(feature.mover?.source, current)
        XCTAssertEqual(try refreshed.prepareForExport().manifest.journeyRevision, current.revision)
        XCTAssertTrue(try refreshed.prepareForExport().manifest.narrativeSnapshot.matches(current))
    }

    @MainActor func testLongCaptionNeverBlocksOpeningStoryAndCanBeRemovedFromExport() throws {
        var journey = try MediaFixtures.journey()
        journey.routePoints[0].note = String(repeating: "🌍", count: 4001)
        let intent = MediaFixtures.intent()
        let owner = ScopedMediaSession(scopeID: "owner", access: .owner,
            read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in throw MediaFailure.unavailable }, revalidate: {})
        let feature = try NativeMediaFeatureModel(journey: journey, intent: intent, session: owner,
            directory: directory(), uploader: RecordingUploader(), currentIntent: { intent }, latestJourney: { journey },
            readJourney: { journey }, refresh: { _, _ in }, onReturn: { _ in })
        XCTAssertEqual(feature.story.cursor.current?.asset?.id, "photo-one")
        let exporter = try XCTUnwrap(feature.exporter)
        XCTAssertNoThrow(try exporter.prepareForExport())
        exporter.includeNotes = true
        XCTAssertThrowsError(try exporter.prepareForExport()) {
            XCTAssertTrue($0 is FilmPreparation.CaptionError)
        }
        exporter.includeNotes = false
        let film = try exporter.prepareForExport()
        XCTAssertTrue(film.captions.isEmpty)
        XCTAssertFalse(film.plan.scenes.isEmpty)
    }

    @MainActor func testGuestCanOpenStoryButCannotPrepareExportOrShareAnExistingArtifact() async throws {
        let journey = try MediaFixtures.journey(), intent = MediaFixtures.intent(), root = try directory()
        var calls = 0
        let guest = ScopedMediaSession(scopeID: "guest", access: .guest,
            read: { _ in calls += 1; throw MediaFailure.unavailable },
            request: { _, _, _ in calls += 1; throw MediaFailure.unavailable }, revalidate: { calls += 1 })
        let feature = try NativeMediaFeatureModel(journey: journey, intent: intent, session: guest,
            directory: root, uploader: RecordingUploader(), currentIntent: { intent }, latestJourney: { journey },
            readJourney: { calls += 1; return journey }, refresh: { _, _ in }, onReturn: { _ in })
        XCTAssertNil(feature.exporter)
        let film = try FilmPreparation.prepare(journey: journey)
        XCTAssertThrowsError(try feature.usePreparedFilm(film, derivativeRead: { _ in throw MediaFailure.unavailable })) {
            XCTAssertEqual($0 as? MediaFailure, .readOnly)
        }
        let direct = FilmExportModel(session: guest, directory: root, expectedJourney: journey,
            currentJourney: { calls += 1; return journey })
        direct.start()
        XCTAssertFalse(direct.busy); XCTAssertNotNil(direct.failure)
        do { _ = try await direct.authorizeShare(); XCTFail("Guest opened export") }
        catch { XCTAssertEqual(error as? MediaFailure, .readOnly) }
        XCTAssertEqual(calls, 0)
    }
    @MainActor func testRevokedScopeDoesNotCallSigner() async {
        var reads = 0
        let session = ScopedMediaSession(scopeID: "revoked", access: .guest,
            read: { _ in reads += 1; throw MediaFailure.unavailable }, request: { _, _, _ in Data() },
            revalidate: { throw MediaFailure.accessChanged })
        do { _ = try await session.mediaURL("a"); XCTFail("Revoked read succeeded") } catch { XCTAssertEqual(error as? MediaFailure, .accessChanged) }
        XCTAssertEqual(reads, 0)
    }
    @MainActor func testFilePartsUseServerSizeETagsAndExactCompletedAssetID() async throws {
        var requests: [String] = []
        var completeBody: Data?
        let session = ScopedMediaSession(scopeID: "owner-1", access: .owner, read: { _ in throw MediaFailure.unavailable }, request: { path, _, body in
            requests.append(path)
            if path == "/api/uploads/start" { return Data(#"{"uploadId":"upload-one","partSize":4,"partCount":2}"#.utf8) }
            if path.hasSuffix("/complete") { completeBody = body; return Data(#"{"asset":{"id":"server-deduplicated-asset"}}"#.utf8) }
            return Data(#"{"url":"https://storage.invalid/part","headers":{}}"#.utf8)
        }, revalidate: {})
        let root = try directory(), source = root.appendingPathComponent("original")
        try Data([0, 1, 2, 3, 4, 5, 6]).write(to: source)
        let sender = RecordingUploader(); sender.expireOnce = true
        let importer = try MultipartImporter(session: session, directory: root.appendingPathComponent("journal"), uploader: sender)
        let record = try importer.stage(file: source, fileName: "sample.jpg", mimeType: "image/jpeg", journeyId: "journey-one", routePointId: "point-one")
        let assetID = try await importer.resume(record)
        XCTAssertEqual(assetID, "server-deduplicated-asset")
        XCTAssertEqual(sender.parts, [Data([0, 1, 2, 3]), Data([4, 5, 6])])
        XCTAssertEqual(requests.filter { $0.hasSuffix("/parts/1") }.count, 2)
        struct Completion: Decodable { let parts: [UploadedPart] }
        let completion = try JSONDecoder().decode(Completion.self, from: XCTUnwrap(completeBody))
        XCTAssertEqual(completion.parts.map(\.etag), ["\"etag-1\"", "\"etag-2\""])
        XCTAssertEqual(completion.parts.map(\.partNumber), [1, 2])
        XCTAssertTrue(try importer.pending().isEmpty)
    }
    @MainActor func testAmbiguousCompletionRecoversByStatusWithoutReuploadOrNewStart() async throws {
        var starts = 0, completed = false, statusReads = 0
        let session = ScopedMediaSession(scopeID: "owner-1", access: .owner, read: { _ in throw MediaFailure.unavailable }, request: { path, _, _ in
            if path.hasSuffix("/start") { starts += 1; return Data(#"{"uploadId":"u","partSize":4,"partCount":1}"#.utf8) }
            if path.hasSuffix("/complete") { completed = true; throw URLError(.timedOut) }
            if path.hasSuffix("/status") {
                statusReads += 1
                return Data(#"{"uploadId":"u","status":"completed","partSize":4,"partCount":1,"assetId":"durable-id"}"#.utf8)
            }
            return Data(#"{"url":"https://storage.invalid/part","headers":{}}"#.utf8)
        }, revalidate: {})
        let root = try directory(), source = root.appendingPathComponent("original")
        try Data([1, 2, 3]).write(to: source)
        let sender = RecordingUploader(), journal = root.appendingPathComponent("journal")
        let importer = try MultipartImporter(session: session, directory: journal, uploader: sender)
        let record = try importer.stage(file: source, fileName: "sample.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil)
        do { _ = try await importer.resume(record); XCTFail("Timeout should remain recoverable") } catch {}
        XCTAssertTrue(completed)
        let restored = try MultipartImporter(session: session, directory: journal, uploader: sender)
        let recovered = try await restored.resume(record)
        XCTAssertEqual(recovered, "durable-id"); XCTAssertEqual(starts, 1); XCTAssertEqual(statusReads, 1); XCTAssertEqual(sender.parts.count, 1)
    }
    @MainActor func testPendingCancelDuringFinalizationCanStillReconcileWithoutResendingParts() async throws {
        var operations: [String] = [], uncertain = true
        let session = ScopedMediaSession(scopeID: "owner", access: .owner, read: { _ in throw MediaFailure.unavailable },
            request: { path, method, _ in
                operations.append("\(method) \(path)")
                if path.hasSuffix("/start") { return Data(#"{"uploadId":"u","partSize":4,"partCount":1}"#.utf8) }
                if path.hasSuffix("/complete") {
                    if uncertain { throw URLError(.timedOut) }
                    return Data(#"{"asset":{"id":"durable-id"}}"#.utf8)
                }
                if path.hasSuffix("/status") {
                    return Data(#"{"uploadId":"u","status":"completion_unknown","partSize":4,"partCount":1,"assetId":null}"#.utf8)
                }
                return Data(#"{"url":"https://storage.invalid/part","headers":{}}"#.utf8)
            }, revalidate: {})
        let root = try directory(), source = root.appendingPathComponent("original")
        try Data([1, 2]).write(to: source)
        let sender = RecordingUploader()
        let importer = try MultipartImporter(session: session, directory: root.appendingPathComponent("journal"), uploader: sender)
        let record = try importer.stage(file: source, fileName: "sample.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil)
        do { _ = try await importer.resume(record); XCTFail("Expected lost response") }
        catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        operations.removeAll()
        do { _ = try await importer.cancel(record); XCTFail("Server is resolving completion") }
        catch { XCTAssertEqual(error as? MediaFailure, .uploadPending) }
        uncertain = false
        let id = try await importer.resume(record)
        XCTAssertEqual(id, "durable-id")
        XCTAssertEqual(operations, ["GET /api/uploads/u/status", "GET /api/uploads/u/status", "POST /api/uploads/u/complete"])
        XCTAssertEqual(sender.parts.count, 1)
        XCTAssertTrue(try importer.pending().isEmpty)
    }

    @MainActor func testCompletedUploadWithDeletedAssetIsRetiredOnRecoveryOrPendingCancellation() async throws {
        for cancelInstead in [false, true] {
            var operations: [String] = []
            let session = ScopedMediaSession(scopeID: "owner", access: .owner, read: { _ in throw MediaFailure.unavailable },
                request: { path, method, _ in
                    operations.append("\(method) \(path)")
                    if path.hasSuffix("/start") { return Data(#"{"uploadId":"u","partSize":4,"partCount":1}"#.utf8) }
                    if path.hasSuffix("/complete") { throw URLError(.timedOut) }
                    if path.hasSuffix("/status") {
                        return Data(#"{"uploadId":"u","status":"completed","partSize":4,"partCount":1,"assetId":null}"#.utf8)
                    }
                    return Data(#"{"url":"https://storage.invalid/part","headers":{}}"#.utf8)
                }, revalidate: {})
            let root = try directory(), source = root.appendingPathComponent("original")
            try Data([1, 2, 3]).write(to: source)
            let sender = RecordingUploader(), journal = root.appendingPathComponent("journal")
            let first = try MultipartImporter(session: session, directory: journal, uploader: sender)
            let record = try first.stage(file: source, fileName: "sample.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil)
            do { _ = try await first.resume(record); XCTFail("Expected lost completion response") }
            catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
            let leftover = journal.appendingPathComponent(record.id.uuidString + "-1.part")
            try Data([1, 2, 3]).write(to: leftover)
            let restored = try MultipartImporter(session: session, directory: journal, uploader: sender)
            let other = try restored.stage(file: source, fileName: "other.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil)
            operations.removeAll()
            if cancelInstead {
                let outcome = try await restored.cancel(record)
                XCTAssertEqual(outcome, .alreadyCompleted(nil))
            } else {
                do { _ = try await restored.resume(record); XCTFail("Deleted asset should not be returned") }
                catch { XCTAssertEqual(error as? MediaFailure, .uploadedAssetRemoved) }
            }
            XCTAssertEqual(operations, ["GET /api/uploads/u/status"])
            XCTAssertEqual(sender.parts.count, 1)
            XCTAssertEqual(try restored.pending().map(\.id), [other.id])
            for url in [record.file, leftover, journal.appendingPathComponent(record.id.uuidString + ".json")] {
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            }
            XCTAssertTrue(FileManager.default.fileExists(atPath: other.file.path))
        }
    }

    @MainActor func testChangedAccountCannotResumePreviousJournal() async throws {
        let root = try directory(), source = root.appendingPathComponent("original")
        try Data([1]).write(to: source)
        func session(_ scope: String) -> ScopedMediaSession {
            ScopedMediaSession(scopeID: scope, access: .owner, read: { _ in throw MediaFailure.unavailable },
                               request: { _, _, _ in XCTFail("Foreign scope reached API"); return Data() }, revalidate: {})
        }
        let journal = root.appendingPathComponent("journal"), sender = RecordingUploader()
        let first = try MultipartImporter(session: session("owner-1"), directory: journal, uploader: sender)
        let record = try first.stage(file: source, fileName: "one.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil)
        let second = try MultipartImporter(session: session("owner-2"), directory: journal, uploader: sender)
        XCTAssertTrue(try second.pending().isEmpty)
        do { _ = try await second.resume(record); XCTFail("Foreign scope resumed") } catch { XCTAssertEqual(error as? MediaFailure, .accessChanged) }
    }
    @MainActor func testCancelAbortsExactUploadAndDoesNotCompleteOrAttachAsset() async throws {
        var requests: [(String, String)] = []
        let session = ScopedMediaSession(scopeID: "owner", access: .owner, read: { _ in throw MediaFailure.unavailable }, request: { path, method, _ in
            requests.append((path, method))
            if path.hasSuffix("/start") { return Data(#"{"uploadId":"owned-upload","partSize":4,"partCount":1}"#.utf8) }
            if method == "DELETE" { return Data() }
            return Data(#"{"url":"https://storage.invalid/part","headers":{}}"#.utf8)
        }, revalidate: {})
        let root = try directory(), source = root.appendingPathComponent("original")
        try Data([1, 2]).write(to: source)
        let started = expectation(description: "file part entered background transport")
        let sender = SuspendedUploader(started: started)
        let importer = try MultipartImporter(session: session, directory: root.appendingPathComponent("journal"), uploader: sender)
        let record = try importer.stage(file: source, fileName: "one.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil)
        let operation = Task { try await importer.resume(record) }
        await fulfillment(of: [started], timeout: 2)
        try await importer.cancel(record)
        do { _ = try await operation.value; XCTFail("Cancelled upload completed") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(requests.contains { $0.0.removingPercentEncoding == "/api/uploads/owned-upload" && $0.1 == "DELETE" })
        XCTAssertFalse(requests.contains { $0.0.hasSuffix("/complete") })
        XCTAssertTrue(try importer.pending().isEmpty)
    }
    @MainActor func testUnknownStartIsNotBlindlyReplayed() async throws {
        var starts = 0
        let session = ScopedMediaSession(scopeID: "owner", access: .owner, read: { _ in throw MediaFailure.unavailable }, request: { _, _, _ in
            starts += 1; throw URLError(.timedOut)
        }, revalidate: {})
        let root = try directory(), source = root.appendingPathComponent("original")
        try Data([1]).write(to: source)
        let importer = try MultipartImporter(session: session, directory: root.appendingPathComponent("journal"), uploader: RecordingUploader())
        let record = try importer.stage(file: source, fileName: "one.jpg", mimeType: "image/jpeg", journeyId: "j", routePointId: nil)
        do { _ = try await importer.resume(record); XCTFail("Expected timeout") } catch {}
        do { _ = try await importer.resume(record); XCTFail("Replayed ambiguous start") } catch { XCTAssertEqual(error as? MediaFailure, .uploadStartUnknown) }
        XCTAssertEqual(starts, 1)
    }
}
