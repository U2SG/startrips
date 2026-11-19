import XCTest
import StartripsMedia
@testable import Startrips

/// A synthetic first-party server for share links: records every request and
/// answers each path with a scripted status and body. No network.
private final class ShareServer: URLProtocol {
    struct Recorded { let method: String; let path: String; let headers: [String: String]; let body: Data? }
    static let lock = NSLock()
    nonisolated(unsafe) static var recorded: [Recorded] = []
    nonisolated(unsafe) static var replies: [String: (Int, String)] = [:]

    static func reset() { lock.lock(); recorded = []; replies = [:]; lock.unlock() }
    static func reply(_ method: String, _ path: String, _ status: Int, _ body: String) {
        lock.lock(); replies[method + " " + path] = (status, body); lock.unlock()
    }
    static func calls() -> [Recorded] {
        lock.lock(); defer { lock.unlock() }
        return recorded.filter { !$0.path.hasPrefix("/api/auth/") }
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "shares.example" }
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
        Self.recorded.append(Recorded(method: method, path: url.path, headers: request.allHTTPHeaderFields ?? [:], body: body))
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
final class JourneyShareTests: XCTestCase {
    let origin = URL(string: "https://shares.example")!
    let now = Date(timeIntervalSince1970: 1_800_000_000) // 2027-01-15T08:00:00.000Z
    let token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"

    override func setUp() async throws { ShareServer.reset(); AtlasSession.testProtocolClasses = [ShareServer.self] }
    override func tearDown() async throws { AtlasSession.testProtocolClasses = []; ShareServer.reset() }

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

    // MARK: Request building

    func testPresetBodySharesEveryMediaUntilAScopeIsChosen() throws {
        var request = ShareRequest(journeyId: "journey-1", customExpiry: now)
        XCTAssertEqual(request.expiry, .week, "the web dialog's default")
        var body = try json(request.body(now: now))
        XCTAssertEqual(body["journeyIds"] as? [String], ["journey-1"])
        XCTAssertEqual(body["expiresAt"] as? String, "2027-01-22T08:00:00.000Z")
        XCTAssertNil(body["mediaAssetIds"], "absent means every media of the Journey")

        request.expiry = .day
        request.mediaAssetIds = []
        body = try json(request.body(now: now))
        XCTAssertEqual(body["expiresAt"] as? String, "2027-01-16T08:00:00.000Z")
        XCTAssertEqual(body["mediaAssetIds"] as? [String], [], "an empty scope shares no media, not all of it")

        request.expiry = .month
        request.mediaAssetIds = ["asset-b", "asset-a"]
        body = try json(request.body(now: now))
        XCTAssertEqual(body["expiresAt"] as? String, "2027-02-14T08:00:00.000Z")
        XCTAssertEqual(body["mediaAssetIds"] as? [String], ["asset-b", "asset-a"])
    }

    func testCustomExpiryKeepsTheServerBounds() throws {
        var request = ShareRequest(journeyId: "journey-1", customExpiry: now.addingTimeInterval(30))
        request.expiry = .custom
        XCTAssertThrowsError(try request.body(now: now)) { XCTAssertEqual($0 as? ShareFailure, .tooSoon) }
        request.customExpiry = now.addingTimeInterval(ShareRequest.maximumLifetime + 1)
        XCTAssertThrowsError(try request.body(now: now)) { XCTAssertEqual($0 as? ShareFailure, .tooFar) }
        request.customExpiry = now.addingTimeInterval(ShareRequest.maximumLifetime)
        XCTAssertEqual(try request.expiresAt(now: now), now.addingTimeInterval(ShareRequest.maximumLifetime))
    }

    func testLinkPutsTheTokenInTheFragmentAndOpensAsAGuestShare() throws {
        let link = try CreatedShare.link(origin: origin, token: token)
        XCTAssertEqual(link.absoluteString, "https://shares.example/share#" + token)
        // The link the owner sends is exactly what the guest entry accepts.
        let guest = AtlasSession()
        try guest.configureGuest(link.absoluteString)
        XCTAssertEqual(guest.guestToken, token)
        XCTAssertThrowsError(try CreatedShare.link(origin: origin, token: "short"))
        XCTAssertThrowsError(try CreatedShare.link(origin: origin, token: token + "/x"))
    }

    // MARK: Response handling

    func testActiveLinksAreThisJourneysUnexpiredUnrevokedNewestFirst() throws {
        let payload = #"""
        {"shares":[
          {"id":"old","createdAt":"2027-01-10T08:00:00.000Z","expiresAt":"2027-01-20T08:00:00.000Z","revokedAt":null,"lastAccessedAt":null,"status":"active","journeyCount":2,"journeys":[{"id":"journey-2","title":"B"},{"id":"journey-1","title":"A"}]},
          {"id":"new","createdAt":"2027-01-14T08:00:00.000Z","expiresAt":"2027-01-21T08:00:00Z","revokedAt":null,"lastAccessedAt":null,"status":"active","journeyCount":1,"journeys":[{"id":"journey-1","title":"A"}]},
          {"id":"revoked","createdAt":"2027-01-14T09:00:00.000Z","expiresAt":"2027-01-21T08:00:00.000Z","revokedAt":"2027-01-14T10:00:00.000Z","lastAccessedAt":null,"status":"revoked","journeyCount":1,"journeys":[{"id":"journey-1","title":"A"}]},
          {"id":"lapsed","createdAt":"2027-01-01T08:00:00.000Z","expiresAt":"2027-01-15T07:59:00.000Z","revokedAt":null,"lastAccessedAt":null,"status":"active","journeyCount":1,"journeys":[{"id":"journey-1","title":"A"}]},
          {"id":"other","createdAt":"2027-01-14T08:00:00.000Z","expiresAt":"2027-01-21T08:00:00.000Z","revokedAt":null,"lastAccessedAt":null,"status":"active","journeyCount":1,"journeys":[{"id":"journey-2","title":"B"}]}
        ]}
        """#
        struct Payload: Decodable { let shares: [ShareGrant] }
        let grants = try JSONDecoder().decode(Payload.self, from: Data(payload.utf8)).shares
        XCTAssertEqual(ShareGrant.active(grants, journeyId: "journey-1", now: now).map(\.id), ["new", "old"])
    }

    // MARK: Live owner API against a synthetic server

    func testCreateListAndRevokeGoThroughTheOwnerSession() async throws {
        let session = try await signedIn()
        ShareServer.reply("POST", "/api/shares", 201,
                          #"{"share":{"id":"7c1e2d3f-0000-4000-8000-000000000001","expiresAt":"2027-01-22T08:00:00.000Z","journeyCount":1,"createdAt":"2027-01-15T08:00:00.000Z"},"token":"\#(token)"}"#)
        ShareServer.reply("GET", "/api/shares", 200,
                          #"{"shares":[{"id":"7c1e2d3f-0000-4000-8000-000000000001","createdAt":"2027-01-15T08:00:00.000Z","expiresAt":"2999-01-22T08:00:00.000Z","revokedAt":null,"lastAccessedAt":null,"status":"active","journeyCount":1,"journeys":[{"id":"journey-fixture","title":"海岸旅程"}]}]}"#)
        ShareServer.reply("POST", "/api/shares/7c1e2d3f-0000-4000-8000-000000000001/revoke", 200, #"{"share":{"status":"revoked"}}"#)
        let store = LiveShareStore(session: session, now: { self.now })
        var request = ShareRequest(journeyId: "journey-fixture", customExpiry: now)
        request.mediaAssetIds = ["asset-fixture"]

        let created = try await store.create(request)
        XCTAssertEqual(created.link.absoluteString, "https://shares.example/share#" + token)
        let grants = try await store.list()
        XCTAssertEqual(ShareGrant.active(grants, journeyId: "journey-fixture", now: Date()).map(\.id), [created.id])
        try await store.revoke(created.id)

        let calls = ShareServer.calls()
        XCTAssertEqual(calls.map { $0.method + " " + $0.path },
                       ["POST /api/shares", "GET /api/shares", "POST /api/shares/\(created.id)/revoke"])
        XCTAssertEqual(calls[0].headers["Origin"], "https://shares.example")
        XCTAssertEqual(calls[2].headers["Origin"], "https://shares.example")
        let body = try json(XCTUnwrap(calls[0].body))
        XCTAssertEqual(body["journeyIds"] as? [String], ["journey-fixture"])
        XCTAssertEqual(body["expiresAt"] as? String, "2027-01-22T08:00:00.000Z")
        XCTAssertEqual(body["mediaAssetIds"] as? [String], ["asset-fixture"])
        await cleanUp(session)
    }

    func testRefusalsMapToShareFailuresWithoutARetry() async throws {
        let session = try await signedIn()
        ShareServer.reply("POST", "/api/shares", 400, #"{"error":"INVALID_SHARE","message":"Invalid share selection or expiry"}"#)
        ShareServer.reply("POST", "/api/shares/gone/revoke", 404, #"{"error":"SHARE_NOT_FOUND"}"#)
        let store = LiveShareStore(session: session, now: { self.now })
        do { _ = try await store.create(ShareRequest(journeyId: "journey-fixture", customExpiry: now)); XCTFail("400") }
        catch { XCTAssertEqual(error as? ShareFailure, .invalid) }
        do { try await store.revoke("gone"); XCTFail("404") }
        catch { XCTAssertEqual(error as? ShareFailure, .missing) }
        XCTAssertEqual(ShareServer.calls().map(\.method), ["POST", "POST"], "a create is never retried")
        // A malformed token in a 201 never becomes a link.
        ShareServer.reply("POST", "/api/shares", 201, #"{"share":{"id":"x"},"token":"not-a-token"}"#)
        do { _ = try await store.create(ShareRequest(journeyId: "journey-fixture", customExpiry: now)); XCTFail("token") }
        catch { XCTAssertEqual(error as? ShareFailure, .invalidLink) }
        XCTAssertEqual(LiveShareStore.revokePath("a/b"), "/api/shares/a%2Fb/revoke")
        await cleanUp(session)
    }

    func testGuestCannotCreateOrRevoke() async throws {
        let session = AtlasSession()
        try session.configureGuest("https://shares.example/share#" + token)
        let store = LiveShareStore(session: session)
        do { _ = try await store.create(ShareRequest(journeyId: "journey-1", customExpiry: now)); XCTFail("guest create") } catch {}
        do { try await store.revoke("x"); XCTFail("guest revoke") } catch {}
        XCTAssertTrue(ShareServer.calls().isEmpty)
    }
}
