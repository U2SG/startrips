import XCTest
@testable import Startrips

final class MediaProjectionTests: XCTestCase {
    @MainActor func testSharePayloadDerivesOnlyParentAndOrder() throws {
        let json = """
        {"journeys":[{"id":"j","title":"行程","note":"","revision":4,"coverMediaAssetId":"b",
        "routePoints":[{"id":"p","latitude":1,"longitude":2,"label":"岸","isStop":true,"note":"停靠感想"}],
        "media":[{"id":"b","routePointId":"p","mimeType":"image/png","bytes":123,"fileName":"b.png"},
                 {"id":"a","routePointId":"p","mimeType":"image/png","bytes":45,"fileName":"a.png"}]}]}
        """
        let data = Data(json.utf8)
        let result = try XCTUnwrap(AtlasSession.mediaProjection(data, guest: true)["j"])
        XCTAssertEqual(result.media.map(\.journeyId), ["j", "j"])
        XCTAssertEqual(result.media.map(\.sortOrder), [0, 1])
        XCTAssertEqual(result.media.map(\.id), ["b", "a"])
        XCTAssertEqual(result.coverMediaAssetId, "b")
        XCTAssertEqual(result.routePoints.first?.note, "停靠感想")
        XCTAssertThrowsError(try AtlasSession.mediaProjection(data, guest: false))
    }
}
