import CryptoKit
import XCTest
import WebKit
@testable import Startrips

final class GoogleLoginTests: XCTestCase {
    let origin = URL(string: "https://atlas.example:8443")!
    let code = String(repeating: "a", count: 43)

    func testOriginBoundStartAndPKCEExchange() throws {
        let flow = try GoogleLoginAttempt(origin: origin)
        let signIn = try flow.start("sign-in")
        let signUp = try flow.start("sign-up")
        XCTAssertEqual(signIn.url?.absoluteString, "https://atlas.example:8443/api/native-auth/start")
        XCTAssertEqual(signIn.httpMethod, "POST")
        XCTAssertEqual(signIn.value(forHTTPHeaderField: "Origin"), origin.absoluteString)
        XCTAssertNil(signIn.value(forHTTPHeaderField: "Cookie"))
        let body = try fields(signIn)
        XCTAssertEqual(body["state"], flow.state)
        XCTAssertEqual(body["intent"], "sign-in")
        XCTAssertEqual(try fields(signUp)["intent"], "sign-up")
        let expected = Data(SHA256.hash(data: Data(flow.verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(body["codeChallenge"], expected)
        XCTAssertEqual(body.count, 3)
        XCTAssertNotEqual(flow.state, flow.verifier)
        XCTAssertNotEqual(try GoogleLoginAttempt(origin: origin).state, flow.state)
        let authorized = origin.appendingPathComponent("api/native-auth/authorize").absoluteString + "?request=opaque"
        XCTAssertEqual(try flow.authorize(JSONEncoder().encode(["authorizeUrl": authorized])).absoluteString, authorized)
        let request = try flow.exchange(url("startrips://auth?code=\(code)&state=\(flow.state)"))
        XCTAssertEqual(request.url?.absoluteString, "https://atlas.example:8443/api/native-auth/exchange")
        XCTAssertEqual(try fields(request), ["code": code, "state": flow.state, "codeVerifier": flow.verifier])
        XCTAssertFalse(try XCTUnwrap(request.url).absoluteString.contains(flow.verifier))
    }

    func testCancellationAndForgedCallbacksNeverProduceAnExchange() throws {
        let flow = try GoogleLoginAttempt(origin: origin)
        let old = try GoogleLoginAttempt(origin: origin)
        XCTAssertThrowsError(try flow.exchange(url("startrips://auth?error=access_denied&state=\(flow.state)"))) {
            XCTAssertEqual($0 as? GoogleLoginError, .cancelled)
        }
        let query = "?code=\(code)&state=\(flow.state)"
        for raw in ["startrips://other\(query)", "startrips://auth:80\(query)", "startrips://user@auth\(query)",
                    "startrips://auth/redirect\(query)", "startrips://auth\(query)#fragment", "https://auth\(query)",
                    "startrips://auth\(query)&state=\(flow.state)", "startrips://auth?code=short&state=\(flow.state)",
                    "startrips://auth?code=\(code)&state=\(old.state)"] {
            XCTAssertThrowsError(try flow.exchange(url(raw)))
        }
        for raw in ["https://atlas.example.evil:8443", "https://atlas.example", "https://user@atlas.example:8443",
                    "http://atlas.example:8443"] {
            let authorize = raw + "/api/native-auth/authorize?request=opaque"
            XCTAssertThrowsError(try flow.authorize(JSONEncoder().encode(["authorizeUrl": authorize])))
        }
        XCTAssertThrowsError(try flow.start("bind"))
    }

    func testOnlyExpectedHostOnlySecureSessionCookieCanBeInstalled() throws {
        let flow = try GoogleLoginAttempt(origin: origin)
        let exchange = origin.appendingPathComponent("api/native-auth/exchange")
        let header = "__Secure-startrips.session_token=synthetic-fixture; Path=/; Secure; HttpOnly; SameSite=Lax"
        func response(_ header: String, url: URL? = nil, status: Int = 204) -> HTTPURLResponse {
            HTTPURLResponse(url: url ?? exchange, statusCode: status, httpVersion: "HTTP/1.1",
                            headerFields: ["Set-Cookie": header])!
        }
        XCTAssertEqual(try flow.sessionCookie(response(header)).domain, "atlas.example")
        let bare = header.replacingOccurrences(of: "__Secure-startrips.session_token", with: "startrips.session_token")
        XCTAssertEqual(try flow.sessionCookie(response(bare)).name, "startrips.session_token")
        XCTAssertThrowsError(try flow.sessionCookie(response(bare.replacingOccurrences(of: "; Secure", with: ""))))
        XCTAssertThrowsError(try flow.sessionCookie(response(header + "; Domain=atlas.example")))
        XCTAssertThrowsError(try flow.sessionCookie(response(header.replacingOccurrences(of: "; Secure", with: ""))))
        XCTAssertThrowsError(try flow.sessionCookie(response(header.replacingOccurrences(of: "; HttpOnly", with: ""))))
        XCTAssertThrowsError(try flow.sessionCookie(response(header.replacingOccurrences(of: "session_token", with: "other"))))
        XCTAssertThrowsError(try flow.sessionCookie(response(header, url: url("https://atlas.example:8444/api/native-auth/exchange"))))
        XCTAssertThrowsError(try flow.sessionCookie(response(header, status: 303)))
    }

    @MainActor
    func testOwnerStoresIsolateEvenTwoPortsOnOneHost() {
        let bare = url("https://atlas.example")
        XCTAssertEqual(AtlasSession.ownerStoreID(bare), AtlasSession.ownerStoreID(url("https://ATLAS.example:443/")))
        XCTAssertNotEqual(AtlasSession.ownerStoreID(bare), AtlasSession.ownerStoreID(origin))
        XCTAssertNotEqual(AtlasSession.ownerStoreID(bare), AtlasSession.ownerStoreID(url("https://other.example")))
    }

    @MainActor
    func testDismissedOrReplacedOwnerLoginCannotInstallALateCallback() throws {
        let defaults = UserDefaults.standard
        let original = defaults.object(forKey: "atlas.origin")
        defer { defaults.set(original, forKey: "atlas.origin") }
        let session = AtlasSession()
        try session.configureTestOrigin(origin)
        try session.configureOwner()
        let captured = session.generation
        session.loginPresented = true
        XCTAssertTrue(session.isOwnerLoginCurrent(captured, at: origin))
        session.loginPresented = false
        XCTAssertFalse(session.isOwnerLoginCurrent(captured, at: origin))
        session.loginPresented = true
        session.disconnect()
        XCTAssertFalse(session.isOwnerLoginCurrent(captured, at: origin))
        try session.configureGuest("https://atlas.example:8443/share#" + String(repeating: "a", count: 43))
        XCTAssertFalse(session.isOwnerLoginCurrent(captured, at: origin))
        try session.configureOwner()
        XCTAssertFalse(session.isOwnerLoginCurrent(captured, at: origin))
    }

    @MainActor
    func testDelayedCookieWriteCanBeCancelledThenRetriedWithoutTouchingTheActiveStore() async throws {
        let testOrigin = url("https://\(UUID().uuidString.lowercased()).example")
        let defaults = UserDefaults.standard
        let oldOrigin = defaults.object(forKey: "atlas.origin")
        let key = "atlas.stores." + AtlasSession.ownerStoreID(testOrigin).uuidString
        defer { defaults.set(oldOrigin, forKey: "atlas.origin"); defaults.removeObject(forKey: key) }
        let session = AtlasSession()
        try session.configureTestOrigin(testOrigin)
        try session.configureOwner()
        session.loginPresented = true
        let originalStore = session.cookieStore
        let originalID = try XCTUnwrap(originalStore.identifier)
        func cookie(_ name: String) throws -> HTTPCookie {
            let headers = ["Set-Cookie": "\(name)=fixture; Path=/; Secure; HttpOnly"]
            return try XCTUnwrap(HTTPCookie.cookies(withResponseHeaderFields: headers, for: testOrigin).first)
        }
        let before = try cookie("__Secure-startrips.session_token")
        let after = try cookie("startrips.session_token")
        await originalStore.httpCookieStore.setCookie(before)
        await originalStore.httpCookieStore.setCookie(try cookie("__Secure-startrips.session_data"))
        let generation = session.generation
        var pending = true
        let cancelled = await session.publishGoogleSession(after, at: testOrigin, generation: generation, pending: { pending }) {
            value, candidate in
            XCTAssertNotEqual(candidate.identifier, originalID)
            await candidate.httpCookieStore.setCookie(value)
            XCTAssertEqual(session.cookieStore.identifier, originalID)
            pending = false // cancellation during WebKit's asynchronous write
        }
        XCTAssertFalse(cancelled)
        let untouched = await session.cookieStore.httpCookieStore.allCookies()
        XCTAssertEqual(Set(untouched.map(\.name)), ["__Secure-startrips.session_token", "__Secure-startrips.session_data"])
        pending = true
        let switched = await session.publishGoogleSession(after, at: testOrigin, generation: generation, pending: { pending }) {
            value, candidate in
            await candidate.httpCookieStore.setCookie(value)
            session.disconnect()
            try? session.configureOwner()
        }
        XCTAssertFalse(switched)
        XCTAssertEqual(session.cookieStore.identifier, originalID)
        let completed = await session.publishGoogleSession(after, at: testOrigin, generation: session.generation, pending: { true })
        XCTAssertTrue(completed)
        let newID = try XCTUnwrap(session.cookieStore.identifier)
        XCTAssertNotEqual(newID, originalID)
        let committed = await session.cookieStore.httpCookieStore.allCookies()
        XCTAssertEqual(committed.map(\.name), ["startrips.session_token"])
        try session.configureOwner()
        XCTAssertEqual(session.cookieStore.identifier, newID)
        session.disconnect()
        try? await WKWebsiteDataStore.remove(forIdentifier: newID)
        try? await WKWebsiteDataStore.remove(forIdentifier: originalID)
    }

    private func fields(_ request: URLRequest) throws -> [String: String] {
        try JSONDecoder().decode([String: String].self, from: XCTUnwrap(request.httpBody))
    }

    private func url(_ text: String) -> URL { URL(string: text)! }
}
