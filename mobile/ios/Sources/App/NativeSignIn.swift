import Foundation

/// Native owner sign-in against the existing Better Auth endpoints. Pure parts
/// (request, cookie capture, error mapping, Organization choice) are unit tested.
enum OwnerSignIn {
    enum Failure: Error, Equatable {
        case invalidCredentials, emailNotVerified, rateLimited, unavailable

        /// Short native messages; the web maps the same codes (`authServiceErrorEvent`).
        var message: String {
            switch self {
            case .invalidCredentials: return "认证信息未通过，请检查后重试。"
            case .emailNotVerified: return "邮箱尚未验证"
            case .rateLimited: return "尝试次数过多，请稍后再试"
            case .unavailable: return "暂时无法登录，请重试"
            }
        }
    }

    struct Organization: Decodable, Equatable, Identifiable {
        let id: String
        let name: String
    }

    /// What happens after a session exists (mirrors `gateFromOrganizationList`).
    enum OrganizationStep: Equatable {
        case ready
        case activate(String)
        case choose([Organization])
        case none
    }

    static let sessionCookieNames: Set<String> = [
        "__Secure-startrips.session_token", "startrips.session_token",
        "__Secure-startrips.session_data", "startrips.session_data",
    ]

    /// The first-party Origin header: scheme and host, no default port.
    static func originHeader(_ origin: URL) -> String? {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        components?.path = ""; components?.query = nil; components?.fragment = nil
        components?.host = origin.host?.lowercased()
        if components?.port == 443 { components?.port = nil }
        return components?.string
    }

    /// `POST /api/auth/sign-in/email`. No cookie is attached: this is a new session.
    static func emailRequest(origin: URL, email: String, password: String) throws -> URLRequest {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !password.isEmpty else { throw Failure.invalidCredentials }
        var request = URLRequest(url: origin.appendingPathComponent("api/auth/sign-in/email"),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(originHeader(origin), forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": trimmed, "password": password,
                                                                       "rememberMe": true], options: [.sortedKeys])
        return request
    }

    /// Maps a refused sign-in to a native message; same precedence as the web.
    static func failure(status: Int, body: Data) -> Failure {
        struct Refusal: Decodable { let code: String?; let message: String? }
        let refusal = try? JSONDecoder().decode(Refusal.self, from: body)
        let text = [refusal?.code, refusal?.message].compactMap { $0 }.joined(separator: " ").uppercased()
        if status == 429 || text.range(of: "RATE.?LIMIT|TOO_MANY_REQUESTS", options: .regularExpression) != nil { return .rateLimited }
        if text.contains("EMAIL_NOT_VERIFIED") || text.contains("EMAIL_UNVERIFIED") { return .emailNotVerified }
        if (400..<500).contains(status) { return .invalidCredentials }
        return .unavailable
    }

    /// Host-only, Secure, HttpOnly first-party session cookies from a same-origin response.
    /// `URLSession` folds repeated Set-Cookie headers into one field; `HTTPCookie` splits them.
    static func sessionCookies(_ response: HTTPURLResponse, origin: URL, requireToken: Bool = true) throws -> [HTTPCookie] {
        guard GoogleLoginAttempt.sameOrigin(response.url, as: origin) else { throw Failure.unavailable }
        let header = response.value(forHTTPHeaderField: "Set-Cookie") ?? ""
        guard !header.contains("\n"), !header.contains("\r"),
              header.range(of: #"(?:^|;)\s*domain\s*="#, options: [.regularExpression, .caseInsensitive]) == nil
        else { throw Failure.unavailable }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: origin).filter { cookie in
            sessionCookieNames.contains(cookie.name) && cookie.domain.lowercased() == origin.host?.lowercased()
                && cookie.path == "/" && cookie.isSecure && cookie.isHTTPOnly && !cookie.value.isEmpty
                && (cookie.expiresDate.map { $0 > Date() } ?? true)
        }
        if requireToken && !cookies.contains(where: { $0.name.hasSuffix("startrips.session_token") }) {
            throw Failure.unavailable
        }
        return cookies
    }

    static func organizationStep(_ organizations: [Organization], active: String?) -> OrganizationStep {
        if let active, organizations.contains(where: { $0.id == active }) { return .ready }
        switch organizations.count {
        case 0: return .none
        case 1: return .activate(organizations[0].id)
        default: return .choose(organizations)
        }
    }
}

/// Drives the native sign-in sheet. Every step re-checks that this sheet is
/// still the current owner login for the pinned origin and generation.
@MainActor
final class NativeSignInModel: ObservableObject {
    /// What the sheet shows: credentials, the Atlas chooser, or the Atlas name step.
    enum Stage: Equatable {
        case credentials
        /// A restored session is being checked before the name step.
        case resuming
        case choose([OwnerSignIn.Organization])
        case name(AtlasSetup.Step)
    }

    @Published var email = ""
    @Published var password = ""
    @Published var atlasName = ""
    @Published private(set) var busy = false
    @Published var message: String?
    @Published private(set) var stage: Stage = .credentials

    private let session: AtlasSession
    private let origin: URL
    private var generation: UUID
    private var task: Task<Void, Never>?
    /// A create attempt failed after it may have reached the server.
    private var createAttempted = false

    init(session: AtlasSession, origin: URL, resuming: Bool = false) {
        self.session = session
        self.origin = origin
        self.generation = session.generation
        if resuming { stage = .resuming }
    }

    /// Whether leaving the sheet now abandons Atlas setup for an existing session.
    var inSetup: Bool {
        switch stage {
        case .resuming, .name: return true
        case .credentials, .choose: return false
        }
    }

    private var current: Bool { session.isOwnerLoginCurrent(generation, at: origin) }
    private var setup: AtlasSetup { AtlasSetup(session: session) }

    func submit() {
        guard !busy else { return }
        let request: URLRequest
        do { request = try OwnerSignIn.emailRequest(origin: origin, email: email, password: password) }
        catch { message = OwnerSignIn.Failure.invalidCredentials.message; return }
        run {
            let (data, response) = try await self.session.performResponse(
                try requireURL(request.url), method: "POST", body: request.httpBody,
                headers: request.allHTTPHeaderFields ?? [:])
            guard self.current else { return }
            guard (200..<300).contains(response.statusCode) else {
                throw OwnerSignIn.failure(status: response.statusCode, body: data)
            }
            let cookies = try OwnerSignIn.sessionCookies(response, origin: self.origin)
            guard await self.session.publishOwnerSession(cookies, at: self.origin, generation: self.generation,
                                                         pending: { [weak self] in self?.current == true }) else { return }
            self.generation = self.session.generation
            self.password = ""
            try await self.advance { try await $0.next() }
        }
    }

    /// Called after any owner session exists (email, Google, or a restored profile
    /// whose Atlas was never bootstrapped).
    func sessionInstalled() {
        generation = session.generation
        run { try await self.advance { try await $0.next() } }
    }

    func choose(_ organization: OwnerSignIn.Organization) {
        run { try await self.advance { try await $0.choose(organization) } }
    }

    /// The name step: create the Organization and its Atlas, or bootstrap the missing Atlas.
    func createAtlas() {
        guard !busy, case .name(let step) = stage, AtlasSetup.title(atlasName) != nil else { return }
        let name = atlasName
        run {
            switch step {
            case .createOrganization:
                let resuming = self.createAttempted
                self.createAttempted = true
                try await self.advance { try await $0.create(name: name, resuming: resuming) }
            case .bootstrap:
                try await self.advance { try await $0.bootstrap(name: name) }
            }
        }
    }

    private func advance(_ work: (AtlasSetup) async throws -> AtlasSetup.Next) async throws {
        let next = try await work(setup)
        guard current else { return }
        switch next {
        case .ready: finish()
        case .choose(let all): stage = .choose(all)
        case .name(let step, let prefill):
            if stage != .name(step) { atlasName = prefill }
            stage = .name(step)
        }
    }

    private func finish() {
        stage = .credentials
        // Closing the sheet runs the normal connectOwner() path.
        session.loginPresented = false
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true; message = nil
        task = Task {
            defer { busy = false }
            do { try await work() }
            catch let failure as OwnerSignIn.Failure { if current { message = failure.message } }
            catch let failure as AtlasSetup.Failure { if current { message = failure.message } }
            catch { if current { message = OwnerSignIn.Failure.unavailable.message } }
        }
    }

    /// Lets unit tests await the running step; the view never needs it.
    func settle() async { await task?.value }

    func cancel() { task?.cancel(); task = nil }
}

private func requireURL(_ url: URL?) throws -> URL {
    guard let url else { throw OwnerSignIn.Failure.unavailable }
    return url
}
