import XCTest
import WebKit
import StartripsMedia
@testable import Startrips

/// Counts requests per path and answers like the first-party server, without any network.
private final class CountingServer: URLProtocol {
    static let lock = NSLock()
    nonisolated(unsafe) static var counts: [String: Int] = [:]
    nonisolated(unsafe) static var limitedOnce: Set<String> = []

    static func reset() { lock.lock(); counts = [:]; limitedOnce = []; lock.unlock() }
    static func count(_ suffix: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts.filter { $0.key.hasSuffix(suffix) }.values.reduce(0, +)
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "atlas.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        let path = url.path
        Self.lock.lock()
        Self.counts[path, default: 0] += 1
        let limit = Self.limitedOnce.remove(path) != nil
        Self.lock.unlock()
        var status = 200
        var headers = ["Content-Type": "application/json"]
        var body = Data("{}".utf8)
        if limit {
            status = 429; headers["Retry-After"] = "0"
        } else if path.hasSuffix("/api/auth/get-session") {
            body = Data(#"{"user":{"id":"user-1"},"session":{"activeOrganizationId":"org-1"}}"#.utf8)
        } else if path.hasSuffix("/read-url") {
            let id = url.deletingLastPathComponent().lastPathComponent
            body = Data(#"{"url":"https://atlas.example/blob/\#(id)","preview":{"url":"https://atlas.example/preview/\#(id)","width":1600,"height":1200}}"#.utf8)
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class RequestDisciplineTests: XCTestCase {
    let origin = URL(string: "https://atlas.example")!

    override func setUp() async throws { CountingServer.reset(); AtlasSession.testProtocolClasses = [CountingServer.self] }
    override func tearDown() async throws { AtlasSession.testProtocolClasses = [] }

    private func signedIn() async throws -> (AtlasSession, String) {
        let session = AtlasSession()
        try session.configureTestOrigin(origin)
        try session.configureOwner()
        session.loginPresented = true
        let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "__Secure-startrips.session_token=tok.sig; Path=/; HttpOnly; Secure; Max-Age=600"], for: origin)[0]
        let published = await session.publishGoogleSession(cookie, at: origin, generation: session.generation, pending: { true })
        XCTAssertTrue(published)
        session.loginPresented = false
        let scope = "\(session.origin!.absoluteString)|user-1|org-1"
        let fixture = try Data(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "bridge", withExtension: "json")))
        try session.installFixture(fixture, scope: scope)
        return (session, scope)
    }

    private func cleanUp(_ session: AtlasSession) async {
        let store = session.cookieStore.httpCookieStore
        for cookie in await store.allCookies() { await store.deleteCookie(cookie) }
    }

    /// Stream playback reads ~30 pictures a minute. Before: each display read cost three
    /// get-session calls (revalidate, the scoped request, revalidate) plus one more after
    /// the download: 4 x 30 = 120 a minute, over the 100/min auth limit. Now: one.
    func testThirtyPictureReadsCostOneSessionCheck() async throws {
        let (session, scope) = try await signedIn()
        let media = session.mediaScope(scope: scope, access: .owner)
        for index in 0..<30 {
            let read = try await media.mediaDisplay("asset-\(index)")
            XCTAssertEqual(read.width, 1600)
            try await media.revalidate()   // StoryModel re-checks after each download
        }
        XCTAssertEqual(CountingServer.count("/read-url"), 30)
        XCTAssertEqual(CountingServer.count("/api/auth/get-session"), 1)
        await cleanUp(session)
    }

    func testRateLimitedReadsBackOffAndRetryInsteadOfFailing() async throws {
        let (session, scope) = try await signedIn()
        CountingServer.lock.lock(); CountingServer.limitedOnce = ["/api/uploads/assets/asset-1/read-url", "/api/auth/get-session"]
        CountingServer.lock.unlock()
        let read = try await session.mediaScope(scope: scope, access: .owner).mediaDisplay("asset-1")
        XCTAssertEqual(read.url.lastPathComponent, "asset-1")
        XCTAssertEqual(CountingServer.count("/read-url"), 2, "one 429, one retry")
        XCTAssertEqual(CountingServer.count("/api/auth/get-session"), 2, "one 429, one retry")
        await cleanUp(session)
    }

    func testSignOutAndNewGenerationsAreNeverServedACachedIdentity() async throws {
        let (session, scope) = try await signedIn()
        try await session.revalidate(scope)
        try await session.revalidate(scope)
        XCTAssertEqual(CountingServer.count("/api/auth/get-session"), 1)
        session.disconnect()
        do { try await session.revalidate(scope); XCTFail("a signed-out session cannot revalidate") }
        catch { XCTAssertEqual(error as? MediaFailure, .accessChanged) }
        XCTAssertEqual(CountingServer.count("/api/auth/get-session"), 1)
        await cleanUp(session)
    }

    // MARK: pure logic

    func testConcurrentVerificationsShareOneRequestAndExpire() async throws {
        var clock = Date(timeIntervalSince1970: 0)
        let cache = VerificationCache(ttl: 20) { clock }
        let key = VerificationCache.Key(generation: UUID(), credential: "token")
        var fetches = 0
        let fetch: @MainActor () async throws -> String = {
            fetches += 1
            try await Task.sleep(for: .milliseconds(20))
            return "owner"
        }
        async let a = cache.identity(for: key, fetch: fetch)
        async let b = cache.identity(for: key, fetch: fetch)
        async let c = cache.identity(for: key, fetch: fetch)
        let results = try await [a, b, c]
        XCTAssertEqual(results, ["owner", "owner", "owner"])
        XCTAssertEqual(fetches, 1, "concurrent callers share one get-session")
        clock = clock.addingTimeInterval(19)
        _ = try await cache.identity(for: key, fetch: fetch)
        XCTAssertEqual(fetches, 1, "within the window")
        clock = clock.addingTimeInterval(2)
        _ = try await cache.identity(for: key, fetch: fetch)
        XCTAssertEqual(fetches, 2, "expired")
        _ = try await cache.identity(for: .init(generation: UUID(), credential: "token"), fetch: fetch)
        XCTAssertEqual(fetches, 3, "a new generation is a new key")
        _ = try await cache.identity(for: .init(generation: key.generation, credential: "rotated"), fetch: fetch)
        XCTAssertEqual(fetches, 4, "a new session cookie is a new key")
        cache.invalidate()
        _ = try await cache.identity(for: key, fetch: fetch)
        XCTAssertEqual(fetches, 5, "invalidated")
    }

    func testErrorsAreNeverCached() async {
        let cache = VerificationCache()
        let key = VerificationCache.Key(generation: UUID(), credential: "token")
        var fetches = 0
        for _ in 0..<2 {
            do {
                _ = try await cache.identity(for: key) { fetches += 1; throw SessionFailure.unavailable(401) }
                XCTFail("must throw")
            } catch {}
        }
        XCTAssertEqual(fetches, 2)
    }

    func testCredentialNamesTheSessionNotTheMinuteCache() {
        let a = VerificationCache.credential(["Cookie": "__Secure-startrips.session_token=t1; __Secure-startrips.session_data=c1"])
        let b = VerificationCache.credential(["Cookie": "__Secure-startrips.session_data=c2; __Secure-startrips.session_token=t1"])
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, VerificationCache.credential(["Cookie": "__Secure-startrips.session_token=t2"]))
        XCTAssertEqual(VerificationCache.credential(["Authorization": "Bearer x"]), "Bearer x")
    }

    func testBackOffHonoursTheServerAndIsBounded() async throws {
        let response = HTTPURLResponse(url: origin, statusCode: 429, httpVersion: nil, headerFields: ["X-Retry-After": "3"])
        XCTAssertEqual(RateLimited.retryAfter(response), 3)
        XCTAssertEqual(RateLimited.delay(attempt: 0, retryAfter: nil), 1)
        XCTAssertEqual(RateLimited.delay(attempt: 2, retryAfter: nil), 4)
        XCTAssertEqual(RateLimited.delay(attempt: 0, retryAfter: 60), 8, "capped")
        var waits: [TimeInterval] = []
        var calls = 0
        let value = try await retryOnRateLimit(sleep: { waits.append($0) }) {
            calls += 1
            if calls < 3 { throw RateLimited(retryAfter: nil) }
            return "ok"
        }
        XCTAssertEqual(value, "ok"); XCTAssertEqual(waits, [1, 2])
        calls = 0
        do {
            _ = try await retryOnRateLimit(attempts: 1, sleep: { _ in }) { () -> String in calls += 1; throw RateLimited(retryAfter: nil) }
            XCTFail("gives up")
        } catch { XCTAssertTrue(error is RateLimited); XCTAssertEqual(calls, 2) }
        do {
            _ = try await retryOnRateLimit(sleep: { _ in }) { () -> String in throw MediaFailure.unavailable }
            XCTFail("other errors pass through")
        } catch { XCTAssertEqual(error as? MediaFailure, .unavailable) }
    }
}
