import XCTest
@testable import Startrips

final class NativeSignInTests: XCTestCase {
    let origin = URL(string: "https://atlas.example:8443")!

    func testEmailSignInRequestIsFirstPartyAndCookieless() throws {
        let request = try OwnerSignIn.emailRequest(origin: origin, email: "  owner@example.com\n", password: "correct horse")
        XCTAssertEqual(request.url?.absoluteString, "https://atlas.example:8443/api/auth/sign-in/email")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://atlas.example:8443")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["email"] as? String, "owner@example.com")
        XCTAssertEqual(body["password"] as? String, "correct horse")
        XCTAssertEqual(body["rememberMe"] as? Bool, true)
        XCTAssertThrowsError(try OwnerSignIn.emailRequest(origin: origin, email: " ", password: "x"))
        XCTAssertThrowsError(try OwnerSignIn.emailRequest(origin: origin, email: "a@b.c", password: ""))
        XCTAssertEqual(OwnerSignIn.originHeader(URL(string: "https://Atlas.Example:443/")!), "https://atlas.example")
    }

    private func response(_ setCookie: String?, url: String = "https://atlas.example:8443/api/auth/sign-in/email") -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: url)!, statusCode: 200, httpVersion: "HTTP/1.1",
                        headerFields: setCookie.map { ["Set-Cookie": $0] } ?? [:])!
    }

    func testOnlyHostOnlySecureSessionCookiesAreCaptured() throws {
        // URLSession folds repeated Set-Cookie headers into one comma-joined field.
        let header = "__Secure-startrips.session_token=tok.sig; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800, "
            + "__Secure-startrips.session_data=cache; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60, "
            + "tracking=1; Path=/; Secure"
        let cookies = try OwnerSignIn.sessionCookies(response(header), origin: origin)
        XCTAssertEqual(Set(cookies.map(\.name)), ["__Secure-startrips.session_token", "__Secure-startrips.session_data"])
        XCTAssertTrue(cookies.allSatisfy { $0.isSecure && $0.isHTTPOnly && $0.domain == "atlas.example" && $0.path == "/" })

        for refused in [
            "__Secure-startrips.session_token=tok; Path=/; HttpOnly; Secure; Domain=atlas.example",
            "__Secure-startrips.session_token=tok; Path=/; HttpOnly",
            "__Secure-startrips.session_token=tok; Path=/; Secure",
            "__Secure-startrips.session_token=tok; Path=/api; HttpOnly; Secure",
            "__Secure-startrips.session_data=cache; Path=/; HttpOnly; Secure",
            "__Secure-startrips.session_token=tok; Path=/; HttpOnly; Secure; Max-Age=0",
        ] {
            XCTAssertThrowsError(try OwnerSignIn.sessionCookies(response(refused), origin: origin), refused)
        }
        XCTAssertThrowsError(try OwnerSignIn.sessionCookies(response(header, url: "https://evil.example:8443/api/auth/sign-in/email"), origin: origin))
        XCTAssertThrowsError(try OwnerSignIn.sessionCookies(response(nil), origin: origin))
        // set-active may refresh only the cache cookie.
        let refreshed = try OwnerSignIn.sessionCookies(
            response("__Secure-startrips.session_data=new; Path=/; HttpOnly; Secure"), origin: origin, requireToken: false)
        XCTAssertEqual(refreshed.map(\.value), ["new"])
    }

    func testRefusalsMapToShortNativeMessages() {
        func body(_ code: String) -> Data { Data(#"{"code":"\#(code)","message":"x"}"#.utf8) }
        XCTAssertEqual(OwnerSignIn.failure(status: 403, body: body("EMAIL_NOT_VERIFIED")), .emailNotVerified)
        XCTAssertEqual(OwnerSignIn.failure(status: 401, body: body("INVALID_EMAIL_OR_PASSWORD")), .invalidCredentials)
        XCTAssertEqual(OwnerSignIn.failure(status: 429, body: Data()), .rateLimited)
        XCTAssertEqual(OwnerSignIn.failure(status: 400, body: body("TOO_MANY_REQUESTS")), .rateLimited)
        XCTAssertEqual(OwnerSignIn.failure(status: 500, body: Data("oops".utf8)), .unavailable)
        XCTAssertEqual(OwnerSignIn.Failure.emailNotVerified.message, "邮箱尚未验证")
        XCTAssertEqual(OwnerSignIn.Failure.invalidCredentials.message, "认证信息未通过，请检查后重试。")
    }

    func testOrganizationStepMirrorsTheWebGate() {
        let a = OwnerSignIn.Organization(id: "a", name: "甲")
        let b = OwnerSignIn.Organization(id: "b", name: "乙")
        XCTAssertEqual(OwnerSignIn.organizationStep([a, b], active: "b"), .ready)
        XCTAssertEqual(OwnerSignIn.organizationStep([a], active: nil), .activate("a"))
        XCTAssertEqual(OwnerSignIn.organizationStep([a], active: "gone"), .activate("a"))
        XCTAssertEqual(OwnerSignIn.organizationStep([a, b], active: nil), .choose([a, b]))
        XCTAssertEqual(OwnerSignIn.organizationStep([], active: nil), .none)
        XCTAssertEqual(OwnerSignIn.Failure.noOrganization.message, "这个账户还没有图谱")
    }

    @MainActor
    func testEmailSessionIsPublishedThroughTheSameProfileSwap() async throws {
        let session = AtlasSession()
        try session.configureTestOrigin(origin)
        try session.configureOwner()
        session.loginPresented = true
        let generation = session.generation
        let cookies = try OwnerSignIn.sessionCookies(response(
            "__Secure-startrips.session_token=tok; Path=/; HttpOnly; Secure, __Secure-startrips.session_data=c; Path=/; HttpOnly; Secure"),
            origin: origin)
        var written: [String] = []
        let published = await session.publishOwnerSession(cookies, at: origin, generation: generation, pending: { true }) { cookie, _ in
            written.append(cookie.name)
        }
        XCTAssertTrue(published)
        XCTAssertEqual(Set(written), ["__Secure-startrips.session_token", "__Secure-startrips.session_data"])
        XCTAssertNotEqual(session.generation, generation, "publication starts a new generation")
        let stale = await session.publishOwnerSession(cookies, at: origin, generation: generation, pending: { true }) { _, _ in }
        XCTAssertFalse(stale, "a superseded sheet cannot publish")
        let none = await session.publishOwnerSession([], at: origin, generation: session.generation, pending: { true }) { _, _ in }
        XCTAssertFalse(none)
    }
}
