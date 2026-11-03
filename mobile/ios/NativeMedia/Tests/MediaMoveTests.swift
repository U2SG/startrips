import XCTest
@testable import StartripsMedia

final class MediaMoveTests: XCTestCase {
    @MainActor func testCrossJourneyMoveAndUndoRefreshBothListsAndPreserveNullTokenFields() async throws {
        let original = try MediaFixtures.journey()
        var source = original, destination = original
        destination.id = "journey-two"; destination.media = []
        let moved = source.media.remove(at: 1)
        var rebound = moved; rebound.journeyId = destination.id; rebound.routePointId = nil
        destination.media = [rebound]
        let encoder = JSONEncoder()
        let sourceJSON = try JSONSerialization.jsonObject(with: encoder.encode(source))
        let destinationJSON = try JSONSerialization.jsonObject(with: encoder.encode(destination))
        let originalJSON = try JSONSerialization.jsonObject(with: encoder.encode(original))
        var refreshed: [(MediaJourney, MediaJourney)] = [], bodies: [[String: Any]] = []
        let session = ScopedMediaSession(scopeID: "owner", access: .owner, read: { _ in throw MediaFailure.unavailable }, request: { path, _, body in
            bodies.append(try JSONSerialization.jsonObject(with: XCTUnwrap(body)) as! [String: Any])
            if path.hasSuffix("/undo") {
                return try JSONSerialization.data(withJSONObject: ["sourceJourney": originalJSON, "destinationJourney": destinationJSON])
            }
            return try JSONSerialization.data(withJSONObject: [
                "sourceJourney": sourceJSON, "destinationJourney": destinationJSON,
                "undo": ["sourceJourneyId": original.id, "targetJourneyId": destination.id,
                         "assetIds": [moved.id], "targetRoutePointId": NSNull(),
                         "sourceOrder": original.media.map(\.id), "targetOrder": [moved.id],
                         "sourceCoverMediaAssetId": NSNull(),
                         "placements": [["assetId": moved.id, "routePointId": NSNull()]]]
            ])
        }, revalidate: {})
        let controller = MediaMoveController(session: session) { refreshed.append(($0, $1)) }
        try await controller.move(source: original, targetJourneyID: destination.id, routePointID: nil, assetIDs: [moved.id])
        XCTAssertEqual(refreshed.count, 1)
        XCTAssertFalse(refreshed[0].0.media.contains { $0.id == moved.id })
        XCTAssertEqual(refreshed[0].1.media.first?.id, moved.id)
        try await controller.undo()
        XCTAssertEqual(refreshed.count, 2)
        XCTAssertTrue(refreshed[1].0.media.contains { $0.id == moved.id })
        XCTAssertTrue(bodies[1]["targetRoutePointId"] is NSNull)
        XCTAssertTrue(bodies[1]["sourceCoverMediaAssetId"] is NSNull)
        let placements = try XCTUnwrap(bodies[1]["placements"] as? [[String: Any]])
        XCTAssertTrue(placements[0]["routePointId"] is NSNull)
    }
    @MainActor func testSameJourneyMoveUndoCarriesOriginalPlacementsAndOrder() async throws {
        let original = try MediaFixtures.journey()
        var moved = original; moved.media[1].routePointId = "point-two"
        var bodies: [[String: Any]] = [], refreshCount = 0
        let session = ScopedMediaSession(scopeID: "owner", access: .owner, read: { _ in throw MediaFailure.unavailable }, request: { path, _, body in
            bodies.append(try JSONSerialization.jsonObject(with: XCTUnwrap(body)) as! [String: Any])
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(path.hasSuffix("/undo") ? original : moved))
            return try JSONSerialization.data(withJSONObject: ["journey": object])
        }, revalidate: {})
        let controller = MediaMoveController(session: session) { a, b in XCTAssertEqual(a.id, b.id); refreshCount += 1 }
        try await controller.move(source: original, targetJourneyID: original.id, routePointID: "point-two", assetIDs: ["photo-one"])
        try await controller.undo()
        XCTAssertEqual(refreshCount, 2)
        XCTAssertEqual(bodies[1]["expectedRoutePointId"] as? String, "point-two")
        let assignments = try XCTUnwrap(bodies[1]["assignments"] as? [[String: Any]])
        XCTAssertEqual(assignments[0]["routePointId"] as? String, "point-one")
        XCTAssertEqual(bodies[1]["assetOrder"] as? [String], ["intro-photo", "video-two", "photo-one"])
    }
}
