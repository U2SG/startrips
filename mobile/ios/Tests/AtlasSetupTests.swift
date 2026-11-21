import XCTest
@testable import Startrips

/// A synthetic first-party server with the real Organization and Atlas rules
/// (one Organization per account, idempotent bootstrap, 404 ATLAS_NOT_FOUND).
/// A `.lost` fault applies the write and then drops the response. No network.
private final class AtlasServer: URLProtocol {
    enum Fault { case status(Int), lost }
    struct Recorded { let method: String; let path: String; let origin: String?; let body: [String: Any] }
    static let lock = NSLock()
    nonisolated(unsafe) static var organizations: [(id: String, name: String)] = []
    nonisolated(unsafe) static var active: String?
    nonisolated(unsafe) static var atlases: Set<String> = []
    nonisolated(unsafe) static var faults: [String: Fault] = [:]
    nonisolated(unsafe) static var recorded: [Recorded] = []

    static func reset() {
        lock.lock(); organizations = []; active = nil; atlases = []; faults = [:]; recorded = []; lock.unlock()
    }
    static func fault(_ key: String, _ fault: Fault?) { lock.lock(); faults[key] = fault; lock.unlock() }
    static func calls(_ key: String) -> [Recorded] {
        lock.lock(); defer { lock.unlock() }
        return recorded.filter { $0.method + " " + $0.path == key }
    }
    static func writes() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return recorded.filter { $0.method == "POST" }.map(\.path)
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "setup.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private static func json(_ value: Any) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
    }

    /// Applies one request to the server state; the caller holds the lock.
    private static func answer(_ key: String, _ body: [String: Any]) -> (Int, String) {
        switch key {
        case "GET /api/auth/get-session":
            return (200, json(["user": ["id": "user-1"], "session": ["activeOrganizationId": active.map { $0 as Any } ?? NSNull()]]))
        case "GET /api/auth/organization/list":
            return (200, json(organizations.map { ["id": $0.id, "name": $0.name] }))
        case "POST /api/auth/organization/create":
            guard organizations.isEmpty else { return (403, #"{"code":"YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS"}"#) }
            let id = "org-\(organizations.count + 1)", name = body["name"] as? String ?? ""
            organizations.append((id, name)); active = id
            return (200, json(["id": id, "name": name, "slug": body["slug"] ?? ""]))
        case "POST /api/auth/organization/set-active":
            guard let id = body["organizationId"] as? String, organizations.contains(where: { $0.id == id }) else { return (400, "{}") }
            active = id
            return (200, json(["id": id]))
        case "GET /api/atlases/current", "GET /api/journeys":
            guard let active else { return (409, #"{"error":"ACTIVE_ORGANIZATION_REQUIRED"}"#) }
            guard atlases.contains(active) else { return (404, #"{"error":"ATLAS_NOT_FOUND"}"#) }
            return key.hasSuffix("current") ? (200, #"{"atlas":{},"role":"owner"}"#) : (200, #"{"journeys":[]}"#)
        case "POST /api/atlases/bootstrap":
            guard let active else { return (409, #"{"error":"ACTIVE_ORGANIZATION_REQUIRED"}"#) }
            if atlases.contains(active) { return (200, #"{"atlas":{},"created":false}"#) }
            guard let title = body["title"] as? String, !title.isEmpty else { return (400, #"{"error":"INVALID_ATLAS"}"#) }
            atlases.insert(active)
            return (201, #"{"atlas":{},"created":true}"#)
        default:
            return (200, #"{"earthExperience":"default"}"#)
        }
    }

    override func startLoading() {
        guard let url = request.url else { return }
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
        }
        let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let method = request.httpMethod ?? "GET"
        let key = method + " " + url.path
        Self.lock.lock()
        Self.recorded.append(Recorded(method: method, path: url.path, origin: request.value(forHTTPHeaderField: "Origin"), body: body))
        let fault = Self.faults[key]
        let reply: (Int, String)
        if case .status(let status) = fault { reply = (status, "{}") } else { reply = Self.answer(key, body) }
        Self.lock.unlock()
        if case .lost = fault {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
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
final class AtlasSetupTests: XCTestCase {
    let origin = URL(string: "https://setup.example")!
    private let create = "POST /api/auth/organization/create"
    private let bootstrap = "POST /api/atlases/bootstrap"

    override func setUp() async throws { AtlasServer.reset(); AtlasSession.testProtocolClasses = [AtlasServer.self] }
    override func tearDown() async throws { AtlasSession.testProtocolClasses = []; AtlasServer.reset() }

    private func signedIn() async throws -> AtlasSession {
        let session = AtlasSession()
        try session.configureTestOrigin(origin)
        try session.configureOwner()
        session.loginPresented = true
        let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "__Secure-startrips.session_token=tok.sig; Path=/; HttpOnly; Secure; Max-Age=600"], for: origin)[0]
        let published = await session.publishGoogleSession(cookie, at: origin, generation: session.generation, pending: { true })
        XCTAssertTrue(published)
        return session
    }

    private func cleanUp(_ session: AtlasSession) async {
        let store = session.cookieStore.httpCookieStore
        for cookie in await store.allCookies() { await store.deleteCookie(cookie) }
    }

    func testSlugAndTitleFollowTheWebGate() {
        XCTAssertEqual(AtlasSetup.slug("  Our Trip: 2026! ", suffix: "1a2b3c4d"), "our-trip-2026-1a2b3c4d")
        XCTAssertEqual(AtlasSetup.slug("我们的图谱", suffix: "1a2b3c4d"), "atlas-1a2b3c4d")
        XCTAssertEqual(AtlasSetup.slug("海边 Café 7", suffix: "00ff00ff"), "caf-7-00ff00ff")
        XCTAssertEqual(AtlasSetup.title("  我们的图谱 \n"), "我们的图谱")
        XCTAssertNil(AtlasSetup.title(" "))
        XCTAssertNil(AtlasSetup.title(String(repeating: "图", count: 81)))
        XCTAssertEqual(AtlasSetup.title(String(repeating: "图", count: 80))?.count, 80)
    }

    func testAnEmptyAccountCreatesActivatesAndBootstrapsInOrder() async throws {
        let session = try await signedIn()
        let setup = AtlasSetup(session: session, suffix: { "1a2b3c4d" })
        let first = try await setup.next()
        XCTAssertEqual(first, .name(.createOrganization, prefill: ""))
        let done = try await setup.create(name: " Our Trip ", resuming: false)
        XCTAssertEqual(done, .ready)
        XCTAssertEqual(AtlasServer.writes(), ["/api/auth/organization/create", "/api/auth/organization/set-active", "/api/atlases/bootstrap"])
        XCTAssertEqual(AtlasServer.calls(create).first?.body["name"] as? String, "Our Trip")
        XCTAssertEqual(AtlasServer.calls(create).first?.body["slug"] as? String, "our-trip-1a2b3c4d")
        XCTAssertEqual(AtlasServer.calls("POST /api/auth/organization/set-active").first?.body["organizationId"] as? String, "org-1")
        XCTAssertEqual(AtlasServer.calls(bootstrap).first?.body["title"] as? String, "Our Trip")
        XCTAssertEqual(AtlasServer.calls(bootstrap).first?.body["dedication"] as? String, "")
        for path in ["/api/auth/organization/create", "/api/auth/organization/set-active", "/api/atlases/bootstrap"] {
            XCTAssertEqual(AtlasServer.calls("POST " + path).first?.origin, "https://setup.example", "first-party write")
        }
        let ready = try await setup.next()
        XCTAssertEqual(ready, .ready, "the active Organization now has its Atlas")
        await cleanUp(session)
    }

    func testALostCreateResponseResumesTheSameOrganization() async throws {
        let session = try await signedIn()
        let setup = AtlasSetup(session: session)
        AtlasServer.fault(create, .lost)
        do { _ = try await setup.create(name: "Our Trip", resuming: false); XCTFail("lost response") }
        catch { XCTAssertEqual(error as? AtlasSetup.Failure, .create) }
        XCTAssertEqual(AtlasServer.organizations.count, 1, "the server created it anyway")
        AtlasServer.fault(create, nil)
        let done = try await setup.create(name: "Our Trip", resuming: true)
        XCTAssertEqual(done, .ready)
        XCTAssertEqual(AtlasServer.calls(create).count, 1, "the retry re-listed instead of creating again")
        XCTAssertEqual(AtlasServer.organizations.count, 1)
        XCTAssertEqual(AtlasServer.atlases, ["org-1"])
        await cleanUp(session)
    }

    func testAFailedBootstrapResumesAfterRelaunchWithTheOrganizationName() async throws {
        let session = try await signedIn()
        AtlasServer.fault(bootstrap, .status(500))
        do { _ = try await AtlasSetup(session: session).create(name: "Our Trip", resuming: false); XCTFail("bootstrap failed") }
        catch { XCTAssertEqual(error as? AtlasSetup.Failure, .bootstrap) }
        AtlasServer.fault(bootstrap, nil)

        // A relaunch reads the Atlas through /api/journeys and lands on the step, not an error.
        let router = AppRouter(defaults: UserDefaults(suiteName: "setup." + UUID().uuidString)!)
        session.loginPresented = false
        await session.refresh(router)
        XCTAssertTrue(session.atlasSetupRequired)
        XCTAssertNil(router.error)
        XCTAssertFalse(session.signInRequired)

        session.loginPresented = true
        let setup = AtlasSetup(session: session)
        let step = try await setup.next()
        XCTAssertEqual(step, .name(.bootstrap, prefill: "Our Trip"))
        let done = try await setup.bootstrap(name: "Our Trip")
        XCTAssertEqual(done, .ready)
        XCTAssertEqual(AtlasServer.calls(create).count, 1, "no second Organization")
        XCTAssertEqual(AtlasServer.atlases, ["org-1"])
        await cleanUp(session)
    }

    func testRefusalsMapToShortStatusText() async throws {
        let session = try await signedIn()
        let setup = AtlasSetup(session: session)
        AtlasServer.fault(create, .status(429))
        do { _ = try await setup.create(name: "Trip", resuming: false); XCTFail() }
        catch { XCTAssertEqual(error as? AtlasSetup.Failure, .rateLimited) }
        AtlasServer.fault(create, nil)
        AtlasServer.fault("POST /api/auth/organization/set-active", .status(500))
        do { _ = try await setup.create(name: "Trip", resuming: false); XCTFail() }
        catch { XCTAssertEqual(error as? AtlasSetup.Failure, .activate) }
        AtlasServer.fault("POST /api/auth/organization/set-active", nil)
        AtlasServer.fault("GET /api/atlases/current", .status(500))
        do { _ = try await setup.next(); XCTFail() }
        catch { XCTAssertEqual(error as? AtlasSetup.Failure, .unavailable) }
        do { _ = try await setup.bootstrap(name: "  "); XCTFail() }
        catch { XCTAssertEqual(error as? AtlasSetup.Failure, .bootstrap) }
        XCTAssertEqual(AtlasSetup.Failure.create.message, "无法创建私人图谱")
        XCTAssertEqual(AtlasSetup.Failure.activate.message, "无法切换私人图谱")
        XCTAssertEqual(AtlasSetup.Failure.bootstrap.message, "无法完成图谱初始化")
        XCTAssertEqual(AtlasSetup.Failure.rateLimited.message, "尝试次数过多，请稍后再试")
        await cleanUp(session)
    }

    func testTheSignInSheetRetriesALostCreateWithoutASecondOrganization() async throws {
        let session = try await signedIn()
        let model = NativeSignInModel(session: session, origin: origin)
        model.sessionInstalled()
        await model.settle()
        XCTAssertEqual(model.stage, .name(.createOrganization))
        XCTAssertTrue(model.inSetup)
        model.atlasName = "Our Trip"
        AtlasServer.fault(create, .lost)
        model.createAtlas()
        await model.settle()
        XCTAssertEqual(model.message, "无法创建私人图谱")
        XCTAssertTrue(session.loginPresented)
        AtlasServer.fault(create, nil)
        model.createAtlas()
        await model.settle()
        XCTAssertNil(model.message)
        XCTAssertFalse(session.loginPresented, "the sheet closes into the normal connectOwner() path")
        XCTAssertEqual(AtlasServer.calls(create).count, 1)
        XCTAssertEqual(AtlasServer.atlases, ["org-1"])
        await cleanUp(session)
    }
}
