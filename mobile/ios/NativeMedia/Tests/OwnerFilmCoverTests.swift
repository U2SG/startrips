import Foundation
import XCTest
@testable import StartripsMedia

final class OwnerFilmCoverTests: XCTestCase {
    private final class Server {
        var derivative: [String: Any]?
        var display: [String: Any]?
        var reads = 0
        init(_ journey: MediaJourney) {
            derivative = [
                "id": "derived", "journeyId": journey.id, "sourceMediaAssetId": "photo-one",
                "sourceContentHash": String(repeating: "a", count: 64), "generationKind": "poetic-line-memory",
                "generationVersion": 1, "presetId": "brush-sweep", "mimeType": "image/jpeg", "width": 96, "height": 64
            ]
            display = ["url": "https://cover.invalid/auth-1", "expiresAt": "2099-10-31T12:00:00.000Z"]
        }
        @MainActor func session(_ access: ScopedMediaSession.Access, journey: MediaJourney) -> ScopedMediaSession {
            ScopedMediaSession(scopeID: "fixture", access: access, read: { _ in throw MediaFailure.unavailable },
                request: { path, method, body in
                    XCTAssertEqual(path, "/api/cover-reveal/journeys/\(component(journey.id))")
                    XCTAssertEqual(method, "GET"); XCTAssertNil(body); self.reads += 1
                    return try JSONSerialization.data(withJSONObject: [
                        "derivative": self.derivative as Any? ?? NSNull(), "display": self.display as Any? ?? NSNull()
                    ])
                }, revalidate: {})
        }
    }
    private func makeJourney() throws -> MediaJourney {
        var value = try MediaFixtures.journey()
        let index = try XCTUnwrap(value.media.firstIndex { $0.id == "photo-one" })
        value.media[index].contentHash = String(repeating: "a", count: 64)
        value.media[index].contentHashVerified = true
        return value
    }

    func testFilmRejectsReplacedBytesEvenWhenTheFileSizeIsUnchanged() async throws {
        var asset = try XCTUnwrap(makeJourney().media.first { $0.id == "photo-one" })
        asset.bytes = 3
        asset.contentHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("abc".utf8).write(to: file)
        try await FilmExportModel.verifyAssetFile(file, expected: asset)
        try Data("abd".utf8).write(to: file)
        do { try await FilmExportModel.verifyAssetFile(file, expected: asset); XCTFail("Replaced bytes accepted") }
        catch { XCTAssertEqual(error as? MediaFailure, .staleIntent) }
        asset.contentHashVerified = false
        try await FilmExportModel.verifyAssetFile(file, expected: asset)
        asset.bytes = 4
        do { try await FilmExportModel.verifyAssetFile(file, expected: asset); XCTFail("Truncated file accepted") }
        catch { XCTAssertEqual(error as? MediaFailure, .staleIntent) }
    }

    @MainActor func testNormalExportPinsReadyCoverAndRenewsCapabilityBeforeReading() async throws {
        let journey = try makeJourney(), server = Server(journey)
        let session = server.session(.owner, journey: journey)
        let exporter = FilmExportModel(session: session, directory: FileManager.default.temporaryDirectory,
            expectedJourney: journey, currentJourney: { journey })
        let (film, opening) = try await exporter.prepareForRendering(reducedMotion: false)
        let pin = try XCTUnwrap(opening)
        XCTAssertEqual(film.manifest.privacy.mediaResolution, "authorized-owner-fetch")
        XCTAssertEqual(film.manifest.cover?.recipeId, "poetic-line-memory")
        XCTAssertEqual(film.manifest.shots.compactMap(\.openingDerivativeId), ["derived"])
        server.display?["url"] = "https://cover.invalid/auth-2"
        let url = try await pin.renewedURL(in: session)
        XCTAssertEqual(url.absoluteString, "https://cover.invalid/auth-2")
        server.display?["expiresAt"] = "2000-01-01T00:00:00Z"
        do { _ = try await pin.renewedURL(in: session); XCTFail("Expired display URL accepted") }
        catch { XCTAssertEqual(error as? MediaFailure, .unavailable) }
        server.derivative?["width"] = 100
        do { try await pin.verify(in: session); XCTFail("Replaced derivative accepted") }
        catch { XCTAssertEqual(error as? MediaFailure, .staleIntent) }
        server.derivative = nil; server.display = nil
        do { try await pin.verify(in: session); XCTFail("Revoked derivative accepted") }
        catch { XCTAssertEqual(error as? MediaFailure, .staleIntent) }
    }

    @MainActor func testRawFallbacksDoNotInventACoverOrRequestOwnerMetadataAsGuest() async throws {
        let journey = try makeJourney(), server = Server(journey)
        let exporter = FilmExportModel(session: server.session(.owner, journey: journey),
            directory: FileManager.default.temporaryDirectory, expectedJourney: journey, currentJourney: { journey })
        let reduced = try await exporter.prepareForRendering(reducedMotion: true)
        XCTAssertNil(reduced.film.manifest.cover)
        exporter.includeCover = false
        let disabled = try await exporter.prepareForRendering(reducedMotion: false)
        XCTAssertNil(disabled.film.manifest.cover); XCTAssertEqual(server.reads, 0)
        exporter.includeCover = true
        server.derivative?["sourceContentHash"] = "old-hash"
        let stale = try await exporter.prepareForRendering(reducedMotion: false)
        XCTAssertNil(stale.film.manifest.cover)
        server.derivative?["sourceContentHash"] = String(repeating: "a", count: 64)
        server.derivative?["generationVersion"] = 9
        let unknown = try await exporter.prepareForRendering(reducedMotion: false)
        XCTAssertNil(unknown.film.manifest.cover)
        server.derivative = nil; server.display = nil
        let absent = try await exporter.prepareForRendering(reducedMotion: false)
        XCTAssertNil(absent.film.manifest.cover)
        let count = server.reads
        let guest = FilmExportModel(session: server.session(.guest, journey: journey),
            directory: FileManager.default.temporaryDirectory, expectedJourney: journey, currentJourney: { journey })
        do { _ = try await guest.prepareForRendering(reducedMotion: false); XCTFail("Guest queried art") }
        catch { XCTAssertEqual(error as? MediaFailure, .readOnly) }
        XCTAssertEqual(server.reads, count)
    }
}
