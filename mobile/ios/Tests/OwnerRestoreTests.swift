import XCTest
import WebKit
@testable import Startrips

/// A later launch reopens the Atlas while the persistent owner profile holds a session.
@MainActor
final class OwnerRestoreTests: XCTestCase {
    let origin = URL(string: "https://atlas.example:8443")!

    private func session(_ attributes: String) -> HTTPCookie {
        HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "__Secure-startrips.session_token=tok.sig; " + attributes],
                           for: origin)[0]
    }

    func testABareOriginMatchesAPathRootSession() {
        let cookie = session("Path=/; HttpOnly; Secure; Max-Age=604800")
        XCTAssertNotNil(cookie.expiresDate, "Better Auth's Max-Age keeps the session persistent")
        XCTAssertFalse(cookie.isSessionOnly)
        let now = Date()
        // The restore check asks with the bare origin, whose URL path is empty.
        XCTAssertEqual(origin.path, "")
        XCTAssertTrue(AtlasSession.cookie(cookie, matches: origin, at: now))
        XCTAssertTrue(AtlasSession.cookie(cookie, matches: origin.appendingPathComponent("api/journeys"), at: now))
        XCTAssertFalse(AtlasSession.cookie(cookie, matches: URL(string: "https://other.example:8443")!, at: now))
        XCTAssertFalse(AtlasSession.cookie(cookie, matches: origin, at: now.addingTimeInterval(700_000)), "expired")
        let scoped = session("Path=/api; HttpOnly; Secure; Max-Age=60")
        XCTAssertFalse(AtlasSession.cookie(scoped, matches: origin, at: now))
        XCTAssertTrue(AtlasSession.cookie(scoped, matches: origin.appendingPathComponent("api/auth/get-session"), at: now))
    }

    func testAPublishedOwnerSessionIsFoundByTheLaunchRestoreCheck() async throws {
        let session = AtlasSession()
        try session.configureTestOrigin(origin)
        try session.configureOwner()
        session.loginPresented = true
        let published = await session.publishGoogleSession(
            self.session("Path=/; HttpOnly; Secure; Max-Age=604800"), at: origin,
            generation: session.generation, pending: { true })
        XCTAssertTrue(published)
        // A new launch re-reads the persisted active profile for this site.
        let relaunched = AtlasSession()
        try relaunched.configureTestOrigin(origin)
        try relaunched.configureOwner()
        let restored = await relaunched.hasOwnerCredentials()
        XCTAssertTrue(restored)
        // Clean up without any network call.
        let store = relaunched.cookieStore.httpCookieStore
        for cookie in await store.allCookies() { await store.deleteCookie(cookie) }
    }
}
