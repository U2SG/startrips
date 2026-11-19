import XCTest
import StartripsMedia
@testable import Startrips

/// A synthetic first-party server for Journey writes: records every request and
/// answers each path with a scripted status and body. No network.
private final class JourneyServer: URLProtocol {
    struct Recorded { let method: String; let path: String; let query: String?; let headers: [String: String]; let body: Data? }
    static let lock = NSLock()
    nonisolated(unsafe) static var recorded: [Recorded] = []
    nonisolated(unsafe) static var replies: [String: (Int, String)] = [:]

    static func reset() { lock.lock(); recorded = []; replies = [:]; lock.unlock() }
    static func reply(_ method: String, _ path: String, _ status: Int, _ body: String) {
        lock.lock(); replies[method + " " + path] = (status, body); lock.unlock()
    }
    static func writes() -> [Recorded] {
        lock.lock(); defer { lock.unlock() }
        return recorded.filter { !$0.path.hasPrefix("/api/auth/") }
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "atlas.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            var data = Data()
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            body = data
        }
        let method = request.httpMethod ?? "GET"
        Self.lock.lock()
        Self.recorded.append(Recorded(method: method, path: url.path, query: url.query,
                                      headers: request.allHTTPHeaderFields ?? [:], body: body))
        var reply = Self.replies[method + " " + url.path] ?? (200, "{}")
        Self.lock.unlock()
        if url.path == "/api/auth/get-session" {
            reply = (200, #"{"user":{"id":"user-1"},"session":{"activeOrganizationId":"org-1"}}"#)
        }
        let response = HTTPURLResponse(url: url, statusCode: reply.0, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class JourneyComposerTests: XCTestCase {
    let origin = URL(string: "https://atlas.example")!

    override func setUp() async throws { JourneyServer.reset(); AtlasSession.testProtocolClasses = [JourneyServer.self] }
    override func tearDown() async throws { AtlasSession.testProtocolClasses = []; JourneyServer.reset() }

    private func fixtureJourney() throws -> AtlasJourney {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json"))
        return try JSONDecoder().decode(BridgeFixture.self, from: Data(contentsOf: url)).snapshot.journeys[0]
    }

    private func json(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func signedIn() async throws -> AtlasSession {
        let session = AtlasSession()
        try session.configureTestOrigin(origin)
        try session.configureOwner()
        session.loginPresented = true
        let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "__Secure-startrips.session_token=tok.sig; Path=/; HttpOnly; Secure; Max-Age=600"], for: origin)[0]
        let published = await session.publishGoogleSession(cookie, at: origin, generation: session.generation, pending: { true })
        XCTAssertTrue(published)
        session.loginPresented = false
        let fixture = try Data(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json")))
        try session.installFixture(fixture, scope: "\(session.origin!.absoluteString)|user-1|org-1")
        return session
    }

    private func cleanUp(_ session: AtlasSession) async {
        let store = session.cookieStore.httpCookieStore
        for cookie in await store.allCookies() { await store.deleteCookie(cookie) }
    }

    private func journeyResponse(title: String, revision: Int) -> String {
        ##"{"journey":{"id":"journey-new","title":"\##(title)","startedOn":"2025-03-01","endedOn":null,"note":"","lightColor":"#f4ce73","lightEffect":null,"routeSegments":null,"revision":\##(revision),"routePoints":[{"id":"9b2f6d0e-4c1a-4e7b-9a55-0d8c2f1e3a77","latitude":35.0116,"longitude":135.7681,"label":"京都","isStop":true,"occurredAt":null}],"media":[]}}"##
    }

    // MARK: Request building

    func testNewJourneyBodyHasNoRevisionOrPointIdsAndExplicitNulls() throws {
        var draft = JourneyDraft(startedOn: "2025-03-01")
        draft.title = "  京都之行 "
        draft.points = [RouteDraftPoint(latitude: 35.0116, longitude: 135.7681, label: " 京都 ", isStop: true)]
        XCTAssertEqual(draft.validationErrors, [])
        let body = try json(draft.requestBody())
        XCTAssertNil(body["revision"], "a new Journey cannot carry a revision")
        XCTAssertEqual(body["title"] as? String, "京都之行")
        XCTAssertEqual(body["startedOn"] as? String, "2025-03-01")
        XCTAssertTrue(body["endedOn"] is NSNull)
        XCTAssertTrue(body["lightEffect"] is NSNull)
        XCTAssertEqual(body["lightColor"] as? String, "#f4ce73")
        let points = try XCTUnwrap(body["routePoints"] as? [[String: Any]])
        XCTAssertEqual(points.count, 1)
        XCTAssertNil(points[0]["id"])
        XCTAssertEqual(points[0]["label"] as? String, "京都")
        XCTAssertEqual(points[0]["isStop"] as? Bool, true)
        // The server reads a missing occurredAt as invalid; null means undated.
        XCTAssertTrue(points[0]["occurredAt"] is NSNull)
    }

    func testEditBodyEchoesRevisionIdsTimesAndLeavesPointExtrasToTheServer() throws {
        let journey = try fixtureJourney()
        var draft = JourneyDraft(journey)
        draft.points[0].occurredAt = "2025-01-01T08:00:00.000Z"
        draft.title = "海岸旅程（改）"
        let body = try json(draft.requestBody())
        XCTAssertEqual(body["revision"] as? Int, journey.revision)
        XCTAssertEqual(body["lightColor"] as? String, journey.lightColor)
        let points = try XCTUnwrap(body["routePoints"] as? [[String: Any]])
        XCTAssertEqual(points.map { $0["id"] as? String }, ["point-a", "point-b"])
        XCTAssertEqual(points[0]["occurredAt"] as? String, "2025-01-01T08:00:00.000Z")
        // Omitted, so the PATCH keeps the stored note/role/stay ownership.
        for key in ["note", "regionContext", "placeRole", "overviewVisibility", "stayAnchorRoutePointId"] {
            XCTAssertNil(points[1][key], key)
        }
    }

    func testValidationFollowsTheWebComposer() {
        var draft = JourneyDraft(startedOn: "2025-03-02")
        XCTAssertEqual(draft.validationErrors, ["旅程标题不能为空且不能超过 80 个字符", "路线必须包含 1 到 64 个点"])
        draft.title = String(repeating: "长", count: 81)
        draft.endedOn = "2025-03-01"
        draft.points = [RouteDraftPoint(latitude: 1, longitude: 2, label: " ", isStop: true)]
        XCTAssertEqual(draft.validationErrors, ["旅程标题不能为空且不能超过 80 个字符", "结束日期不能早于开始日期", "停靠点 1 需要地点标签"])
        draft.title = "海岸"
        draft.endedOn = "2025-02-30"
        draft.points = [
            RouteDraftPoint(latitude: 1, longitude: 2, label: "甲", isStop: false, occurredAt: "2025-03-02T10:00:00Z"),
            RouteDraftPoint(latitude: 1, longitude: 2, label: "乙", isStop: false, occurredAt: "2025-03-02T09:00:00.000Z"),
        ]
        XCTAssertEqual(draft.validationErrors, ["结束日期无效", "路线点时间必须按旅程顺序递增"])
        draft.endedOn = nil
        draft.points.reverse()
        XCTAssertEqual(draft.validationErrors, [])
        draft.points = Array(repeating: RouteDraftPoint(latitude: 1, longitude: 2, label: "", isStop: false), count: 65)
        XCTAssertEqual(draft.validationErrors, ["路线必须包含 1 到 64 个点"])
    }

    func testMergeKeepsTheMembersEditsOnTopOfTheNewerJourney() throws {
        let base = JourneyDraft(try fixtureJourney())
        var mine = base
        mine.title = "我的标题"
        mine.points.append(RouteDraftPoint(latitude: 2, longitude: 3, label: "新点", isStop: true))
        var theirs = base
        theirs.revision = (base.revision ?? 0) + 1
        theirs.note = "别处写的故事"
        theirs.points.removeLast()

        let merged = JourneyDraft.merge(base: base, mine: mine, theirs: theirs)
        XCTAssertEqual(merged.revision, theirs.revision, "the next save targets the newer revision")
        XCTAssertEqual(merged.title, "我的标题")
        XCTAssertEqual(merged.note, "别处写的故事")
        // Both changed the route: the newer route wins and the new point is kept.
        XCTAssertEqual(merged.points.map(\.label), ["起点", "新点"])

        var renamed = base
        renamed.revision = theirs.revision
        renamed.title = "别处的标题"
        let routeOnly = JourneyDraft.merge(base: base, mine: mine, theirs: renamed)
        XCTAssertEqual(routeOnly.title, "我的标题")
        XCTAssertEqual(routeOnly.points, mine.points, "an untouched server route takes the member's route")
        XCTAssertEqual(JourneyDraft.merge(base: base, mine: base, theirs: renamed), renamed)
    }

    func testMergeAboveTheRouteLimitKeepsEveryPointAndBlocksSave() {
        var base = JourneyDraft(startedOn: "2025-03-01")
        base.title = "长路线"
        base.revision = 5
        base.points = (0..<63).map {
            RouteDraftPoint(persistedId: "00000000-0000-4000-8000-\(String(format: "%012d", $0))",
                            latitude: 1, longitude: Double($0), label: "点\($0)", isStop: false)
        }
        var theirs = base
        theirs.revision = 6
        theirs.points.append(RouteDraftPoint(persistedId: "00000000-0000-4000-8000-999999999999",
                                             latitude: 2, longitude: 2, label: "别处新增", isStop: true))
        var mine = base
        mine.points.append(RouteDraftPoint(latitude: 3, longitude: 3, label: "我的新增", isStop: true))

        let merged = JourneyDraft.merge(base: base, mine: mine, theirs: theirs)
        XCTAssertEqual(merged.points.count, 65, "the owner's added point is never dropped")
        XCTAssertEqual(merged.points.suffix(2).map(\.label), ["别处新增", "我的新增"])
        // Save refuses with the route limit until the owner removes a point.
        XCTAssertEqual(merged.validationErrors, ["路线必须包含 1 到 64 个点"])
        var trimmed = merged
        trimmed.points.remove(at: 0)
        XCTAssertEqual(trimmed.validationErrors, [])
    }

    func testSearchPathEncodesTheQueryAndFocus() {
        XCTAssertEqual(LiveJourneyStore.searchPath("京都 C++", near: (35.5, 135.25)),
                       "/api/locations/search?q=%E4%BA%AC%E9%83%BD%20C%2B%2B&lat=35.5&lon=135.25")
        XCTAssertEqual(LiveJourneyStore.journeyPath("a/b", "/restore"), "/api/journeys/a%2Fb/restore")
    }

    // MARK: Live owner API against a synthetic server

    func testCreatePostsTheDraftWithTheFirstPartyOrigin() async throws {
        let session = try await signedIn()
        JourneyServer.reply("POST", "/api/journeys", 201, journeyResponse(title: "京都之行", revision: 1))
        var draft = JourneyDraft(startedOn: "2025-03-01")
        draft.title = "京都之行"
        draft.points = [RouteDraftPoint(latitude: 35.0116, longitude: 135.7681, label: "京都", isStop: true)]
        let created = try await LiveJourneyStore(session: session).create(draft)
        XCTAssertEqual(created.title, "京都之行")
        XCTAssertEqual(created.routePoints.count, 1)
        let request = try XCTUnwrap(JourneyServer.writes().last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/journeys")
        XCTAssertEqual(request.headers["Origin"], "https://atlas.example")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(try json(XCTUnwrap(request.body))["title"] as? String, "京都之行")
        await cleanUp(session)
    }

    func testStaleEditIsAConflictNeverAnOverwrite() async throws {
        let session = try await signedIn()
        let journey = try fixtureJourney()
        JourneyServer.reply("PATCH", "/api/journeys/journey-fixture", 409,
                            #"{"error":"JOURNEY_ROUTE_CHANGED","message":"Journey route changed; reopen it before saving"}"#)
        var draft = JourneyDraft(journey)
        draft.title = "改名"
        do {
            _ = try await LiveJourneyStore(session: session).update(journey.id, draft)
            XCTFail("a 409 must surface as a conflict")
        } catch {
            XCTAssertEqual(error as? JourneyWriteFailure, .routeChanged)
        }
        let writes = JourneyServer.writes()
        XCTAssertEqual(writes.map(\.method), ["PATCH"], "no retry and no second write")
        XCTAssertEqual(try json(XCTUnwrap(writes[0].body))["revision"] as? Int, journey.revision)
        await cleanUp(session)
    }

    func testDeleteAndRestoreUseTheJourneyEndpoints() async throws {
        let session = try await signedIn()
        JourneyServer.reply("DELETE", "/api/journeys/journey-new", 204, "")
        JourneyServer.reply("POST", "/api/journeys/journey-new/restore", 200, journeyResponse(title: "京都之行", revision: 2))
        let store = LiveJourneyStore(session: session)
        try await store.delete("journey-new")
        let restored = try await store.restore("journey-new")
        XCTAssertEqual(restored.revision, 2)
        XCTAssertEqual(JourneyServer.writes().map { $0.method + " " + $0.path },
                       ["DELETE /api/journeys/journey-new", "POST /api/journeys/journey-new/restore"])
        JourneyServer.reply("GET", "/api/journeys/gone", 404, #"{"error":"JOURNEY_NOT_FOUND"}"#)
        do { _ = try await store.load("gone"); XCTFail("missing") }
        catch { XCTAssertEqual(error as? JourneyWriteFailure, .missing) }
        await cleanUp(session)
    }

    func testGuestCannotWrite() async throws {
        let session = AtlasSession()
        try session.configureGuest("https://atlas.example/share#" + String(repeating: "a", count: 43))
        var draft = JourneyDraft(startedOn: "2025-03-01")
        draft.title = "x"
        draft.points = [RouteDraftPoint(latitude: 1, longitude: 2, label: "a", isStop: true)]
        do { _ = try await LiveJourneyStore(session: session).create(draft); XCTFail("guest write") } catch {}
        XCTAssertTrue(JourneyServer.writes().isEmpty)
    }

    // MARK: Scene refresh

    func testSavedAndDeletedJourneysReachTheSceneAtOnce() throws {
        let journey = try fixtureJourney()
        let router = AppRouter(defaults: UserDefaults(suiteName: "app.startrips.composer." + UUID().uuidString)!)
        router.install([journey], identity: "composer-owner", access: .owner, earthExperience: "default")
        let before = router.revision
        let created = AtlasJourney(id: "journey-new", title: "京都之行", startedOn: "2024-12-01", endedOn: nil, note: "",
                                   lightColor: "#f4ce73", lightEffect: nil, routeSegments: nil, revision: 1,
                                   routePoints: [AtlasRoutePoint(id: "p", latitude: 35, longitude: 135, label: "京都",
                                                                 isStop: true, occurredAt: nil)], media: [])
        router.apply(saved: created)
        XCTAssertGreaterThan(router.revision, before, "a new scene revision redraws the globe")
        XCTAssertEqual(router.journeys.map(\.id), ["journey-new", "journey-fixture"], "server order by start date")
        XCTAssertEqual(router.selection?.journeyId, "journey-new")
        XCTAssertEqual(router.snapshot.journeys.count, 2)

        let afterSave = router.revision
        router.remove(journeyId: "journey-new")
        XCTAssertGreaterThan(router.revision, afterSave)
        XCTAssertEqual(router.journeys.map(\.id), ["journey-fixture"])
        XCTAssertNil(router.selection)

        let guest = AppRouter(defaults: UserDefaults(suiteName: "app.startrips.composer." + UUID().uuidString)!)
        guest.install([journey], identity: "guest", access: .guest, earthExperience: "default")
        guest.apply(saved: created)
        XCTAssertEqual(guest.journeys.map(\.id), ["journey-fixture"], "a shared Atlas is never written locally")
    }
}
