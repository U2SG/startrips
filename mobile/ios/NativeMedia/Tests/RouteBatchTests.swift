import CoreLocation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import StartripsMedia

/// `route-point-proposals.json` is shared with src/journey/mediaPlacementParity.test.ts.
private struct ParityFixture: Decodable {
    struct Case: Decodable {
        struct Input: Decodable { let id: String; let signal: PlacementSignal? }
        struct Expected: Decodable, Equatable {
            struct Existing: Decodable, Equatable { let routePointId: String; let files: [String]; let basis: PlacementBasis }
            struct Representative: Decodable, Equatable { let file: String; let latitude: Double; let longitude: Double }
            struct New: Decodable, Equatable { let files: [String]; let representative: Representative; let basis: PlacementBasis }
            struct Pending: Decodable, Equatable { let files: [String]; let basis: PlacementBasis }
            let matchExisting: [Existing]
            let suggestNew: [New]
            let pendingConfirmation: [Pending]
        }
        let name: String
        let journey: PlacementJourney
        let inputs: [Input]
        let expected: Expected
    }
    let algorithmVersion: String
    let cases: [Case]
}

@MainActor private final class FakeBackend: RouteBatchBackend {
    var current: MediaJourney
    var calls: [String] = []
    var applyError: Error?
    var undoError: Error?
    var readResult: Result<RouteBatchOperation, Error>
    var lostFiles: Set<String> = []
    var onStage: (() -> Void)?
    private var staged: [UUID: String] = [:]

    init(journey: MediaJourney, status: String = "applied") {
        current = journey
        readResult = .success(RouteBatchOperation(operationId: "", status: status,
                                                  undo: .init(eligible: true, expiresAt: nil, reason: nil)))
    }
    func journey() async throws -> MediaJourney { calls.append("journey"); return current }
    func stage(_ file: RouteBatchFile) throws -> UUID {
        onStage?()
        calls.append("stage:" + file.id)
        let id = UUID(); staged[id] = file.id; return id
    }
    func upload(_ record: UUID, progress: @escaping (Double) -> Void) async throws -> String? {
        let file = staged[record]!
        calls.append("upload:" + file)
        if lostFiles.contains(file) { return nil }
        let asset = "asset-" + file
        current.media.append(MediaAsset(id: asset, journeyId: current.id, routePointId: nil, fileName: file,
                                        mimeType: "image/jpeg", bytes: 1, sortOrder: current.media.count))
        return asset
    }
    func apply(_ body: Data, journeyID: String) async throws -> RouteBatchOperation {
        calls.append("apply")
        lastBody = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        if let applyError { throw applyError }
        let operationId = lastBody?["operationId"] as? String ?? ""
        return RouteBatchOperation(operationId: operationId, status: "applied", undo: .init(eligible: true, expiresAt: nil, reason: nil))
    }
    var lastBody: [String: Any]?
    func read(_ operationID: String, journeyID: String) async throws -> RouteBatchOperation {
        calls.append("read:" + operationID)
        var value = try readResult.get(); value.operationId = operationID
        return value
    }
    func undo(_ operationID: String, journeyID: String) async throws -> RouteBatchOperation {
        calls.append("undo:" + operationID)
        if let undoError { readResult = .success(RouteBatchOperation(operationId: operationID, status: "undone",
                                                                      undo: .init(eligible: false, expiresAt: nil, reason: "undone")))
            throw undoError }
        return RouteBatchOperation(operationId: operationID, status: "undone", undo: .init(eligible: false, expiresAt: nil, reason: "undone"))
    }
}

final class RouteBatchTests: XCTestCase {
    private func fixture() throws -> ParityFixture { try MediaFixtures.decode("route-point-proposals") }

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func mediaJourney(_ value: PlacementJourney) -> MediaJourney {
        MediaJourney(id: value.id, title: value.id, note: "", revision: value.revision, coverMediaAssetId: nil,
                     routePoints: value.routePoints.map {
                         MediaRoutePoint(id: $0.id, latitude: $0.latitude, longitude: $0.longitude, label: $0.id, isStop: true,
                                         note: nil, stayAnchorRoutePointId: nil, occurredAt: $0.occurredAt)
                     }, media: [], startedOn: value.startedOn, endedOn: value.endedOn)
    }

    // MARK: Planner parity

    func testPlannerMatchesTheSharedWebFixture() throws {
        let shared = try fixture()
        XCTAssertEqual(shared.algorithmVersion, PlacementPlanner.algorithmVersion)
        for value in shared.cases {
            let plan = try PlacementPlanner.plan(value.inputs.map { PlacementInput(id: $0.id, signal: $0.signal) },
                                                 journey: value.journey, batchId: "parity")
            typealias Expected = ParityFixture.Case.Expected
            let existing = plan.matchExisting.map { Expected.Existing(routePointId: $0.routePointId, files: $0.files, basis: $0.basis) }
            let candidates = plan.suggestNew.map { proposal -> Expected.New in
                Expected.New(files: proposal.files, representative: Expected.Representative(
                    file: proposal.representative, latitude: proposal.latitude, longitude: proposal.longitude), basis: proposal.basis)
            }
            let pending = plan.pendingConfirmation.map { Expected.Pending(files: $0.files, basis: $0.basis) }
            XCTAssertEqual(existing, value.expected.matchExisting, value.name)
            XCTAssertEqual(candidates, value.expected.suggestNew, value.name)
            XCTAssertEqual(pending, value.expected.pendingConfirmation, value.name)
            // Candidate identity comes from a stable file id, never a position.
            for candidate in plan.suggestNew { XCTAssertEqual(candidate.candidateId, "new:" + candidate.files[0]) }
        }
    }

    func testPlannerRejectsDuplicateIdentitiesAndUnboundedBatches() {
        let journey = PlacementJourney(id: "j", revision: 1, startedOn: nil, endedOn: nil, routePoints: [])
        XCTAssertThrowsError(try PlacementPlanner.plan([.init(id: "a", signal: nil), .init(id: "a", signal: nil)],
                                                       journey: journey, batchId: "b"))
        XCTAssertThrowsError(try PlacementPlanner.plan((0...PlacementPlanner.maxInputs).map { .init(id: "\($0)", signal: nil) },
                                                       journey: journey, batchId: "b"))
        XCTAssertThrowsError(try PlacementPlanner.plan([], journey: journey, batchId: ""))
    }

    // MARK: Reader

    func testReaderNormalizesOffsetLocalOnlyAndGpsTime() throws {
        let gps: [String: Any] = [
            kCGImagePropertyGPSLatitude as String: 35.0116, kCGImagePropertyGPSLatitudeRef as String: "N",
            kCGImagePropertyGPSLongitude as String: 135.7681, kCGImagePropertyGPSLongitudeRef as String: "E",
            kCGImagePropertyGPSHPositioningError as String: 7.5,
            kCGImagePropertyGPSDateStamp as String: "2026:05:01", kCGImagePropertyGPSTimeStamp as String: "03:04:05.25",
        ]
        let offset = try XCTUnwrap(PlacementSignalReader.signal(properties: [
            kCGImagePropertyGPSDictionary as String: gps,
            kCGImagePropertyExifDictionary as String: [kCGImagePropertyExifDateTimeOriginal as String: "2026:05:01 12:04:05",
                                                       kCGImagePropertyExifOffsetTimeOriginal as String: "+09:00"],
        ]))
        XCTAssertEqual(offset.latitude, 35.0116); XCTAssertEqual(offset.longitude, 135.7681); XCTAssertEqual(offset.accuracyMeters, 7.5)
        XCTAssertEqual(offset.capturedAt, "2026-05-01T12:04:05+09:00"); XCTAssertEqual(offset.offsetMinutes, 540)
        XCTAssertEqual(offset.captureTimeSource, "exif-original"); XCTAssertEqual(offset.timezoneState, "offset-known")

        let local = try XCTUnwrap(PlacementSignalReader.signal(properties: [
            kCGImagePropertyExifDictionary as String: [kCGImagePropertyExifDateTimeOriginal as String: "2026:05:01 12:04:05"],
        ]))
        XCTAssertNil(local.capturedAt); XCTAssertEqual(local.capturedLocal, "2026-05-01T12:04:05")
        XCTAssertEqual(local.timezoneState, "local-only"); XCTAssertNil(local.latitude)

        var southWest = gps
        southWest[kCGImagePropertyGPSLatitudeRef as String] = "S"; southWest[kCGImagePropertyGPSLongitudeRef as String] = "W"
        let utc = try XCTUnwrap(PlacementSignalReader.signal(properties: [kCGImagePropertyGPSDictionary as String: southWest]))
        XCTAssertEqual(utc.latitude, -35.0116); XCTAssertEqual(utc.longitude, -135.7681)
        XCTAssertEqual(utc.capturedAt, "2026-05-01T03:04:05.250Z"); XCTAssertEqual(utc.capturedLocal, "2026-05-01T03:04:05.250")
        XCTAssertEqual(utc.captureTimeSource, "gps"); XCTAssertEqual(utc.offsetMinutes, 0)

        var invalid = gps; invalid[kCGImagePropertyGPSLatitudeRef as String] = "X"; invalid[kCGImagePropertyGPSDateStamp as String] = nil
        XCTAssertNil(PlacementSignalReader.signal(properties: [kCGImagePropertyGPSDictionary as String: invalid]))
        XCTAssertNil(PlacementSignalReader.signal(properties: [kCGImagePropertyExifDictionary as String:
            [kCGImagePropertyExifDateTimeOriginal as String: "2026:02:30 12:00:00"]]))
    }

    func testReaderReadsJpegAndHeicFilesFromDisk() throws {
        let root = try directory()
        let metadata: [String: Any] = [
            kCGImagePropertyGPSDictionary as String: [
                kCGImagePropertyGPSLatitude as String: 22.5431, kCGImagePropertyGPSLatitudeRef as String: "N",
                kCGImagePropertyGPSLongitude as String: 114.0579, kCGImagePropertyGPSLongitudeRef as String: "E",
                kCGImagePropertyGPSHPositioningError as String: 12.0,
            ],
            kCGImagePropertyExifDictionary as String: [
                kCGImagePropertyExifDateTimeOriginal as String: "2026:09:30 12:34:56",
                kCGImagePropertyExifOffsetTimeOriginal as String: "+08:00",
            ],
        ]
        let context = try XCTUnwrap(CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        let supported = (CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? []
        for type in [UTType.jpeg, UTType.heic] where supported.contains(type.identifier) {
            let url = root.appendingPathComponent("photo").appendingPathExtension(type.preferredFilenameExtension ?? "img")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, metadata as CFDictionary)
            // A simulator may list HEIC without an encoder; JPEG must always round-trip.
            let written = CGImageDestinationFinalize(destination)
            if type == .jpeg { XCTAssertTrue(written) }
            guard written else { continue }
            let signal = try XCTUnwrap(PlacementSignalReader.signal(at: url), type.identifier)
            XCTAssertEqual(try XCTUnwrap(signal.latitude), 22.5431, accuracy: 1e-4)
            XCTAssertEqual(try XCTUnwrap(signal.longitude), 114.0579, accuracy: 1e-4)
            XCTAssertEqual(signal.capturedLocal, "2026-09-30T12:34:56", type.identifier)
            XCTAssertEqual(signal.spatialSource, "exif")
        }
        XCTAssertNil(PlacementSignalReader.signal(at: root.appendingPathComponent("missing.jpg")))
    }

    func testLibraryLocationOnlyFillsAMissingCoordinate() {
        let library = CLLocationFixture.location
        let merged = PlacementSignalReader.merging(nil, library: library)
        XCTAssertEqual(merged?.spatialSource, "imported"); XCTAssertEqual(merged?.accuracyMeters, 30)
        XCTAssertNil(merged?.capturedAt, "A library date has no place offset")
        let file = PlacementSignal(latitude: 1, longitude: 2, spatialSource: "exif", spatialGranularity: "coordinate")
        XCTAssertEqual(PlacementSignalReader.merging(file, library: library), file)
    }

    func testRecordedEvidenceMatchesTheUploadDocument() throws {
        let signal = PlacementSignal(latitude: 22.5, longitude: 114, capturedAt: "2026-09-30T12:34:56+08:00",
                                     capturedLocal: "2026-09-30T12:34:56", spatialSource: "exif", spatialGranularity: "coordinate",
                                     accuracyMeters: nil, captureTimeSource: "exif-original", timezoneState: "offset-known", offsetMinutes: 480)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(XCTUnwrap(RecordedEvidence(signal)))) as? [String: Any])
        let spatial = try XCTUnwrap(json["spatial"] as? [String: Any])
        XCTAssertEqual(spatial["granularity"] as? String, "coordinate")
        XCTAssertTrue(spatial["accuracyMeters"] is NSNull); XCTAssertTrue(spatial["label"] is NSNull)
        let time = try XCTUnwrap(json["captureTime"] as? [String: Any])
        XCTAssertEqual(time["timezone"] as? String, "offset-known"); XCTAssertEqual(time["offsetMinutes"] as? Int, 480)

        var local = signal; local.timezoneState = "local-only"; local.capturedAt = nil; local.offsetMinutes = nil
        XCTAssertEqual(RecordedEvidence(local)?.captureTime.timezone, "local-only")
        XCTAssertNil(RecordedEvidence(local)?.captureTime.instant)
        var unknown = signal; unknown.captureTimeSource = "unknown"
        XCTAssertEqual(RecordedEvidence(unknown)?.captureTime, .init(source: "unknown", timezone: "unknown", local: nil, instant: nil, offsetMinutes: nil))
        XCTAssertNil(RecordedEvidence(PlacementSignal(capturedLocal: "2026-09-30T12:34:56")), "No coordinate, no document")
    }

    // MARK: Draft

    private func makeDraft(case index: Int) throws -> (RouteBatchDraft, MediaJourney, ParityFixture.Case) {
        let value = try fixture().cases[index]
        let journey = mediaJourney(value.journey)
        let plan = try PlacementPlanner.plan(value.inputs.map { .init(id: $0.id, signal: $0.signal) },
                                             journey: value.journey, batchId: "route-batch:test")
        let signals = Dictionary(uniqueKeysWithValues: value.inputs.compactMap { input in input.signal.map { (input.id, $0) } })
        return (try RouteBatchDraft(plan: plan, journey: journey, signals: signals, files: value.inputs.map(\.id)), journey, value)
    }

    func testDraftKeepsEveryPhotoVisibleAndUncertaintyNeedsConfirmation() throws {
        var (draft, journey, value) = try makeDraft(case: 0)
        XCTAssertEqual(Set(draft.groups.flatMap(\.files)), Set(value.inputs.map(\.id)))
        let unplaced = draft.groups.filter { $0.destination == .unplaced }
        XCTAssertTrue(unplaced.contains { $0.files == ["photo-no-gps"] })
        XCTAssertTrue(unplaced.contains { $0.files == ["video-no-signal"] })
        XCTAssertTrue(unplaced.allSatisfy(\.needsConfirmation))
        let localOnly = try XCTUnwrap(draft.groups.first { $0.files == ["photo-local-only"] })
        XCTAssertNil(localOnly.occurredAt, "A wall clock without offset is never an instant")
        XCTAssertTrue(localOnly.needsConfirmation)
        let cluster = try XCTUnwrap(draft.groups.first { $0.id == "new:photo-a" })
        XCTAssertEqual(cluster.occurredAt, "2026-05-03T11:00:00+09:00"); XCTAssertFalse(cluster.needsConfirmation)
        draft = try draft.editing(.autoOrganize(true), journey: journey)
        XCTAssertFalse(draft.canAutoOrganize, "Unplaced or uncertain groups block automatic organizing")
        XCTAssertFalse(draft.shouldAutoSubmit(after: .autoOrganize(true)))
    }

    func testAutoOrganizeIsOptInForAFullyConfidentBatchOnly() throws {
        var (draft, journey, _) = try makeDraft(case: 1)
        draft = try draft.editing(.assign("unplaced:conflict-photo", routePointId: "point-nara"), journey: journey)
        draft = try draft.editing(.autoOrganize(true), journey: journey)
        XCTAssertFalse(draft.canAutoOrganize, "A manual decision is reviewed, never auto-submitted")
        var (clean, cleanJourney, _) = try makeDraft(case: 1)
        clean.groups.removeAll { $0.destination == .unplaced }
        clean.files.removeAll { $0 == "conflict-photo" }
        XCTAssertFalse(clean.canAutoOrganize, "Off until the owner turns it on")
        clean = try clean.editing(.autoOrganize(true), journey: cleanJourney)
        XCTAssertTrue(clean.shouldAutoSubmit(after: .autoOrganize(true)))
        XCTAssertFalse(clean.shouldAutoSubmit(after: .move("x", by: 1)))
        var stale = cleanJourney; stale.revision += 1
        XCTAssertThrowsError(try clean.editing(.autoOrganize(false), journey: stale))
    }

    func testSplitAndMergeNeverBorrowAnotherPhotosLocationOrTime() throws {
        let (draft, journey, _) = try makeDraft(case: 3)
        let split = try draft.editing(.split("new:walk-1", file: "walk-4"), journey: journey)
        let kept = try XCTUnwrap(split.groups.first { $0.id == "new:walk-1" })
        let alone = try XCTUnwrap(split.groups.first { $0.id == "manual:1" })
        for group in [kept, alone] {
            XCTAssertEqual(group.destination, .unplaced); XCTAssertNil(group.latitude); XCTAssertNil(group.occurredAt)
        }
        XCTAssertEqual(alone.files, ["walk-4"]); XCTAssertEqual(split.nextGroupNumber, 2)
        let merged = try draft.editing(.merge("new:walk-1", other: "new:walk-5"), journey: journey)
        let group = try XCTUnwrap(merged.groups.first { $0.id == "new:walk-1" })
        XCTAssertEqual(group.destination, .unplaced, "Different coordinates need a new decision")
        XCTAssertEqual(group.files, ["walk-1", "walk-2", "walk-3", "walk-4", "walk-5"])
        XCTAssertNil(group.occurredAt)
        let moved = try draft.editing(.move("new:walk-5", by: -1), journey: journey)
        XCTAssertEqual(moved.groups.map(\.id), ["new:walk-5", "new:walk-1", "new:next-morning"])
    }

    func testApplyBodyPlacesByAssetIdAndKeepsUnplacedAtJourneyLevel() throws {
        var (draft, journey, value) = try makeDraft(case: 0)
        draft = try draft.editing(.rename("new:photo-a", "Kamakura"), journey: journey)
        let assets = Dictionary(uniqueKeysWithValues: value.inputs.map { ($0.id, "asset-" + $0.id) })
        let body = try XCTUnwrap(draft.applyBody(assets: assets, operationId: draft.batchId))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["operationId"] as? String, "route-batch:test"); XCTAssertEqual(json["baseRevision"] as? Int, 4)
        let points = try XCTUnwrap(json["points"] as? [[String: Any]])
        XCTAssertEqual(points.map { $0["candidateId"] as? String }, ["new:photo-a", "new:photo-local-only"])
        XCTAssertEqual(points[0]["label"] as? String, "Kamakura"); XCTAssertEqual(points[0]["isStop"] as? Bool, true)
        let attachments = try XCTUnwrap(json["attachments"] as? [[String: Any]])
        XCTAssertEqual(Set(attachments.compactMap { $0["assetId"] as? String }),
                       ["asset-photo-a", "asset-photo-b", "asset-photo-local-only"])
        XCTAssertTrue(attachments.allSatisfy { ($0["candidateId"] == nil) != ($0["routePointId"] == nil) })

        var duplicate = assets; duplicate["photo-no-gps"] = "asset-photo-a"
        XCTAssertThrowsError(try draft.applyBody(assets: duplicate, operationId: draft.batchId)) {
            XCTAssertEqual($0 as? RouteBatchError, .conflictingDuplicate)
        }
        XCTAssertThrowsError(try draft.applyBody(assets: [:], operationId: draft.batchId))
        XCTAssertThrowsError(try draft.applyBody(assets: assets, operationId: "not valid/"))
        let journeyOnly = draft.groups.reduce(draft) { current, group in
            (try? current.editing(.assign(group.id, routePointId: nil), journey: journey)) ?? current
        }
        XCTAssertNil(try journeyOnly.applyBody(assets: assets, operationId: draft.batchId))
    }

    func testLostRepresentativeLeavesItsGroupUnplaced() throws {
        let (draft, _, _) = try makeDraft(case: 0)
        let reduced = draft.removingFiles(["photo-b"])
        let group = try XCTUnwrap(reduced.groups.first { $0.id == "new:photo-a" })
        XCTAssertEqual(group.files, ["photo-a"]); XCTAssertEqual(group.destination, .unplaced); XCTAssertNil(group.latitude)
        XCTAssertFalse(reduced.files.contains("photo-b")); XCTAssertNoThrow(try reduced.checkCoverage())
    }

    // MARK: Batch transaction

    @MainActor private func model(case index: Int, root: URL) async throws -> (RoutePointBatchModel, FakeBackend, RouteBatchJournalStore) {
        let value = try fixture().cases[index]
        let backend = FakeBackend(journey: mediaJourney(value.journey))
        let store = RouteBatchJournalStore(directory: root.appendingPathComponent("route-batches"))
        let model = RoutePointBatchModel(journeyID: value.journey.id, backend: backend, store: store) {}
        var picked: [RouteBatchFile] = []
        for input in value.inputs {
            let url = root.appendingPathComponent(input.id)
            try Data([1]).write(to: url)
            picked.append(RouteBatchFile(id: input.id, url: url, type: .jpeg, signal: input.signal))
        }
        await model.review(picked)
        XCTAssertEqual(model.stage, .review)
        return (model, backend, store)
    }

    @MainActor func testConfirmPersistsTheOperationBeforeUploadingAndAppliesOnce() async throws {
        let root = try directory()
        let (model, backend, store) = try await self.model(case: 1, root: root)
        let operationId = try XCTUnwrap(model.draft?.batchId)
        backend.onStage = { XCTAssertEqual((try? store.load("journey-kansai"))?.operationId, operationId) }
        await model.confirm()
        XCTAssertEqual(model.stage, .applied)
        XCTAssertEqual(backend.calls.filter { $0 == "apply" }.count, 1)
        XCTAssertEqual(backend.lastBody?["operationId"] as? String, operationId)
        XCTAssertEqual(try store.load("journey-kansai")?.phase, .applied)
        XCTAssertEqual(model.files.count, 0, "Staged copies are removed")
    }

    @MainActor func testLostApplyResponseReadsTheSameOperationInsteadOfResending() async throws {
        let root = try directory()
        let (model, backend, store) = try await self.model(case: 1, root: root)
        backend.applyError = URLError(.networkConnectionLost)
        await model.confirm()
        let operationId = try XCTUnwrap(model.draft?.batchId)
        XCTAssertEqual(backend.calls.filter { $0 == "apply" }.count, 1)
        XCTAssertEqual(backend.calls.last, "read:" + operationId)
        XCTAssertEqual(model.stage, .applied)

        backend.readResult = .failure(URLError(.notConnectedToInternet))
        var journal = try XCTUnwrap(store.load("journey-kansai")); journal.phase = .applying
        try store.save(journal)
        let relaunched = RoutePointBatchModel(journeyID: "journey-kansai", backend: backend, store: store) {}
        relaunched.restore()
        try await waitUntil { if case .unknown = relaunched.stage { return true }; return false }
        XCTAssertEqual(backend.calls.filter { $0 == "apply" }.count, 1, "A lost response is never a replay permit")
        XCTAssertNotNil(try store.load("journey-kansai"), "The unknown batch stays recorded")
    }

    @MainActor func testRejectedApplyReleasesTheBatchWithPhotosKept() async throws {
        let root = try directory()
        let (model, backend, store) = try await self.model(case: 1, root: root)
        backend.applyError = MediaFailure.http(409)
        backend.readResult = .failure(MediaFailure.http(404))
        await model.confirm()
        guard case .done = model.stage else { return XCTFail("\(model.stage)") }
        XCTAssertNil(try store.load("journey-kansai"))
        XCTAssertEqual(backend.current.media.count, 3)
    }

    @MainActor func testUploadLossAndRouteChangeNeverPlaceByGuess() async throws {
        let root = try directory()
        let (model, backend, _) = try await self.model(case: 3, root: root)
        backend.lostFiles = ["walk-3"] // the cluster's representative
        await model.confirm()
        let attachments = try XCTUnwrap(backend.lastBody?["attachments"] as? [[String: Any]])
        XCTAssertFalse(attachments.contains { ($0["assetId"] as? String) == "asset-walk-1" })
        XCTAssertTrue(attachments.contains { ($0["assetId"] as? String) == "asset-walk-5" })

        let (changed, changedBackend, changedStore) = try await self.model(case: 1, root: try directory())
        changedBackend.current.revision += 1
        await changed.confirm()
        guard case .done = changed.stage else { return XCTFail("\(changed.stage)") }
        XCTAssertFalse(changedBackend.calls.contains("apply"))
        XCTAssertNil(try changedStore.load("journey-kansai"))
    }

    @MainActor func testUndoReadsTheReceiptFirstAndNeverSendsASecondUndo() async throws {
        let root = try directory()
        let (model, backend, store) = try await self.model(case: 1, root: root)
        await model.confirm()
        let operationId = try XCTUnwrap(model.operation?.operationId)
        backend.calls.removeAll()
        backend.undoError = URLError(.timedOut)
        await model.undo()
        XCTAssertEqual(backend.calls, ["read:" + operationId, "undo:" + operationId, "read:" + operationId])
        guard case .done = model.stage else { return XCTFail("\(model.stage)") }
        XCTAssertNil(try store.load("journey-kansai"))
    }

    @MainActor func testIneligibleUndoIsNotSent() async throws {
        let root = try directory()
        let (model, backend, _) = try await self.model(case: 1, root: root)
        await model.confirm()
        backend.readResult = .success(RouteBatchOperation(operationId: "", status: "applied",
                                                          undo: .init(eligible: false, expiresAt: nil, reason: "expired")))
        await model.undo()
        XCTAssertFalse(backend.calls.contains { $0.hasPrefix("undo:") })
        XCTAssertEqual(model.stage, .applied)
    }

    @MainActor private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(condition())
    }
}

private enum CLLocationFixture {
    static let location = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 35, longitude: 135), altitude: 0,
                                     horizontalAccuracy: 30, verticalAccuracy: -1, timestamp: Date())
}
