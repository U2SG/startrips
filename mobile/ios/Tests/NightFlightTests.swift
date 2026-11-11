import XCTest
import StartripsMedia
@testable import Startrips

@MainActor
final class NightFlightTests: XCTestCase {
    private func journey(_ id: String, _ start: String, _ end: String?) -> AtlasJourney {
        AtlasJourney(id: id, title: id, startedOn: start, endedOn: end, note: "", lightColor: "#d6b58c",
                     lightEffect: nil, routeSegments: nil, revision: 1,
                     routePoints: [AtlasRoutePoint(id: id + "-p", latitude: 0, longitude: 0, label: id,
                                                   isStop: true, occurredAt: nil)], media: [])
    }

    func testRibbonBucketsMonthsAndPicksTheJourneyUnderTheCursor() {
        let model = TimeRibbonModel(journeys: [
            journey("coast", "2024-11-03", "2025-01-02"),
            journey("valley", "2025-03-01", nil),
            journey("undated", "", nil),
        ])
        XCTAssertEqual(model.months.map(\.id), ["2024-11", "2024-12", "2025-01", "2025-02", "2025-03"])
        XCTAssertEqual(model.spans, [.init(journeyId: "coast", start: 0, end: 2), .init(journeyId: "valley", start: 4, end: 4)])
        XCTAssertEqual(model.journey(at: 1), "coast")
        XCTAssertEqual(model.journey(at: 3), "coast", "a gap month keeps the latest Journey the window still shows")
        let later = TimeRibbonModel(journeys: [journey("late", "2025-06-01", nil), journey("early", "2025-03-01", nil)])
        XCTAssertEqual(later.journey(at: 0), "early")
        XCTAssertEqual(later.journey(at: 2), "early")
        XCTAssertEqual(model.index(of: "coast"), 2)
        XCTAssertEqual(model.index(at: 0), 0)
        XCTAssertEqual(model.index(at: 1), 4)
        XCTAssertEqual(model.index(at: .nan), 4)
        XCTAssertEqual(model.window(through: 1), SceneTimeWindow(start: "2024-11-01", end: "2024-12-31"))
        XCTAssertNil(model.window(through: 4), "the final month shows everything")
        XCTAssertEqual(TimeRibbonModel.Month(year: 2024, month: 2).lastDay, "2024-02-29")
        XCTAssertEqual(TimeRibbonModel.Month(year: 2100, month: 2).lastDay, "2100-02-28")
        XCTAssertTrue(TimeRibbonModel(journeys: [journey("undated", "", nil)]).isEmpty)
    }

    func testRibbonWindowsAreValidSceneCommands() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        let fixture = try JSONDecoder().decode(BridgeFixture.self, from: Data(contentsOf: url))
        let router = AppRouter(defaults: UserDefaults(suiteName: "ribbon." + UUID().uuidString)!)
        router.install(fixture.snapshot.journeys + [journey("valley", "2025-03-01", nil)], identity: "ribbon",
                       access: .owner, earthExperience: "default")
        let model = TimeRibbonModel(journeys: router.journeys)
        for index in model.months.indices {
            let command = router.command(.timeWindow, window: model.window(through: index))
            XCTAssertNoThrow(try validateSceneCommand(command, snapshot: router.snapshot))
        }
    }

    func testCardDetentsStepOnceAndSwipesNeverWrap() {
        XCTAssertEqual(CardDetent.peek.resolve(dy: -48), .medium)
        XCTAssertEqual(CardDetent.medium.resolve(dy: -200), .large, "one step per drag")
        XCTAssertEqual(CardDetent.large.resolve(dy: -200), .large)
        XCTAssertEqual(CardDetent.large.resolve(dy: 65), .medium)
        XCTAssertEqual(CardDetent.medium.resolve(dy: 65), .peek)
        XCTAssertEqual(CardDetent.peek.resolve(dy: 300), .peek, "peek never closes")
        XCTAssertEqual(CardDetent.medium.resolve(dy: 40), .medium)
        XCTAssertEqual(CardDetent.swipeStep(dx: -60, dy: 5), 1)
        XCTAssertEqual(CardDetent.swipeStep(dx: 65, dy: 2), -1)
        XCTAssertEqual(CardDetent.swipeStep(dx: -39, dy: 0), 0)
        XCTAssertEqual(CardDetent.swipeStep(dx: -60, dy: 85), 0)
        XCTAssertEqual(CardDetent.step(2, total: 3, by: 1), 2)
        XCTAssertEqual(CardDetent.step(0, total: 3, by: -1), 0)
        XCTAssertEqual(CardDetent.step(1, total: 3, by: 1), 2)
    }

    func testCardLayoutKeepsPeekVisibleAndLargeBelowTheTopBar() {
        let layout = AtlasChrome.Layout(screen: 874, safeTop: 62, safeBottom: 34, topBar: 52, peek: 110)
        XCTAssertEqual(layout.cardHeight(.peek, drag: -50), 110)
        XCTAssertEqual(layout.large, 874 - 62 - 52 - 8 - 34)
        XCTAssertLessThanOrEqual(layout.medium, layout.large)
        XCTAssertEqual(layout.cardHeight(.large, drag: 400), layout.large)
        let landscape = AtlasChrome.Layout(screen: 402, safeTop: 0, safeBottom: 21, topBar: 52, peek: 110)
        XCTAssertEqual(landscape.medium, landscape.large)
    }

    func testCoverIsTheChosenPictureElseTheFirstPicture() throws {
        func cover(_ chosen: String?) throws -> String? {
            let json = """
            {"id":"j","title":"j","note":"","revision":1,"coverMediaAssetId":\(chosen.map { "\"\($0)\"" } ?? "null"),
             "routePoints":[],"media":[
              {"id":"v","journeyId":"j","routePointId":null,"fileName":"v","mimeType":"video/mp4","bytes":1,"sortOrder":0},
              {"id":"a","journeyId":"j","routePointId":null,"fileName":"a","mimeType":"image/jpeg","bytes":1,"sortOrder":1},
              {"id":"b","journeyId":"j","routePointId":null,"fileName":"b","mimeType":"image/png","bytes":1,"sortOrder":2}]}
            """
            return JourneyCoverStore.coverAsset(try JSONDecoder().decode(MediaJourney.self, from: Data(json.utf8)))?.id
        }
        XCTAssertEqual(try cover(nil), "a")
        XCTAssertEqual(try cover("b"), "b")
        XCTAssertEqual(try cover("v"), "a", "a video is never a still cover")
    }

    func testSystemPopLeavesStoryThroughItsOwnExit() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        let fixture = try JSONDecoder().decode(BridgeFixture.self, from: Data(contentsOf: url))
        let router = AppRouter(defaults: UserDefaults(suiteName: "pop." + UUID().uuidString)!)
        router.install(fixture.snapshot.journeys, identity: "pop", access: .owner, earthExperience: "default")
        var invalidations = 0
        router.onInvalidation = { invalidations += 1 }
        XCTAssertTrue(router.openStory(journeyId: "journey-fixture", routePointId: "point-a"))
        let revision = router.revision
        var exits = 0
        // The live Story commits its position and returns, as story.finish() does.
        router.onStoryPop = {
            exits += 1
            router.commitStoryPosition(StoryHandoff(journeyId: "journey-fixture", routePointId: "point-b", assetId: nil,
                                                    revision: router.path.last!.revision, requestId: router.path.last!.requestId))
            router.returnToAtlas()
        }
        router.navigate([])
        XCTAssertEqual(exits, 1)
        XCTAssertTrue(router.path.isEmpty)
        XCTAssertEqual(router.selection?.routePointId, "point-b", "the zoom dismiss keeps Story's last position")
        XCTAssertEqual(router.revision, revision + 1)
        XCTAssertEqual(invalidations, 1)

        // A Story that has not loaded (or refuses a stale exit) still returns once.
        router.onStoryPop = { exits += 1 }
        XCTAssertTrue(router.openStory(journeyId: "journey-fixture"))
        router.navigate([])
        XCTAssertTrue(router.path.isEmpty)
        XCTAssertEqual(invalidations, 2)
        // Pushes are not pops.
        let handoff = try XCTUnwrap(router.selection)
        router.navigate([handoff])
        XCTAssertEqual(router.path, [handoff])
        XCTAssertEqual(exits, 2)
    }
}
