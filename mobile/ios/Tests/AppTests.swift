import XCTest
import Testing
@testable import Startrips

@MainActor
final class AppTests: XCTestCase {
    func fixture() throws -> BridgeFixture {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        return try JSONDecoder().decode(BridgeFixture.self, from: Data(contentsOf: url))
    }

    func testSharedFixtureAndStaleBridgeMessages() throws {
        let fixture = try fixture()
        XCTAssertNoThrow(try validateSceneEvent(fixture.event, snapshot: fixture.snapshot))
        let event = fixture.event
        let stale = SceneEvent(version: 1, kind: .story, scopeId: event.scopeId, requestId: event.requestId,
                               revision: event.revision - 1, journeyId: event.journeyId)
        XCTAssertThrowsError(try validateSceneEvent(stale, snapshot: fixture.snapshot))
        let wrongPoint = SceneEvent(version: 1, kind: .story, scopeId: event.scopeId, requestId: event.requestId,
                                    revision: event.revision, journeyId: event.journeyId, routePointId: "other")
        XCTAssertThrowsError(try validateSceneEvent(wrongPoint, snapshot: fixture.snapshot))
        let wrongAsset = SceneEvent(version: 1, kind: .story, scopeId: event.scopeId, requestId: event.requestId,
                                    revision: event.revision, journeyId: event.journeyId, routePointId: "point-b", assetId: event.assetId)
        XCTAssertThrowsError(try validateSceneEvent(wrongAsset, snapshot: fixture.snapshot))
    }

    func testOwnerRestoreGuestIsolationInvalidationAndReturn() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let records = try fixture().snapshot.journeys
        let router = AppRouter(defaults: defaults)
        router.install(records, identity: "owner-a", access: .owner, earthExperience: "particle-only")
        let open = SceneEvent(version: 1, kind: .story, scopeId: router.scopeId, requestId: UUID().uuidString,
                              revision: router.revision, journeyId: "journey-fixture", routePointId: "point-a")
        router.receive(open)
        XCTAssertEqual(router.path.first?.routePointId, "point-a")
        router.receive(open) // Duplicate/late callback cannot push a second destination.
        XCTAssertEqual(router.path.count, 1)
        router.returnToAtlas()
        XCTAssertTrue(router.path.isEmpty)
        XCTAssertEqual(router.selection?.journeyId, "journey-fixture")
        let recreated = AppRouter(defaults: defaults)
        recreated.install(records, identity: "owner-a", access: .owner, earthExperience: "particle-only")
        XCTAssertEqual(recreated.selection?.routePointId, "point-a")
        recreated.sceneRestarted()
        XCTAssertEqual(recreated.snapshot.selection?.journeyId, "journey-fixture")
        recreated.install(records, identity: "guest-new", access: .guest, earthExperience: "default")
        XCTAssertNil(recreated.selection)
        recreated.receive(open) // A former owner message is not guest authority.
        XCTAssertTrue(recreated.path.isEmpty)
        recreated.install([], identity: "guest-new", access: .guest, earthExperience: "default")
        XCTAssertTrue(recreated.journeys.isEmpty)
    }

    func testLocalResourceAndHTTPSBoundaries() throws {
        XCTAssertEqual(BundledSceneServer.resourcePath("/assets/worker.js"), "assets/worker.js")
        for path in ["//other-host", "/../secret", "/%2e%2e/secret", "/a%5csecret"] {
            XCTAssertNil(BundledSceneServer.resourcePath(path))
        }
        XCTAssertNoThrow(try AtlasSession.validatedOrigin("https://atlas.example"))
        for origin in ["http://atlas.example", "https://user:password@atlas.example", "https://atlas.example/path", "https://atlas.example?token=secret"] {
            XCTAssertThrowsError(try AtlasSession.validatedOrigin(origin))
        }
    }
}

@Test func bridgeProjectionContainsNoCredentials() throws {
    let url = try #require(Bundle.main.url(forResource: "bridge", withExtension: "json"))
    let fixture = try JSONDecoder().decode(BridgeFixture.self, from: Data(contentsOf: url))
    let encoded = try JSONEncoder().encode(fixture.snapshot)
    let text = String(decoding: encoded, as: UTF8.self)
    for forbidden in ["cookie", "Authorization", "shareToken", "read-url", "createdByUserId"] {
        #expect(!text.contains(forbidden))
    }
}
