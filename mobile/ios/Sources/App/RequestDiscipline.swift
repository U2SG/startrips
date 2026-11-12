import Foundation

/// The server's auth rate limit (Better Auth: 100 requests a minute per client) is shared
/// by every scoped media read. These helpers keep the app far below it: one verified
/// identity per short window, and 429 as a pause rather than an Atlas failure.

/// HTTP 429 from the first-party server, with the server's requested wait when given.
struct RateLimited: LocalizedError, Equatable {
    let retryAfter: TimeInterval?
    var errorDescription: String? { SessionFailure.unavailable(429).errorDescription }

    /// `Retry-After` (seconds) or Better Auth's `X-Retry-After`.
    static func retryAfter(_ response: HTTPURLResponse?) -> TimeInterval? {
        for name in ["Retry-After", "X-Retry-After"] {
            if let text = response?.value(forHTTPHeaderField: name), let seconds = TimeInterval(text.trimmingCharacters(in: .whitespaces)),
               seconds.isFinite, seconds >= 0 { return seconds }
        }
        return nil
    }

    /// Wait before retry `attempt` (0-based): the server's value, else 1s, 2s, 4s; never above `cap`.
    static func delay(attempt: Int, retryAfter: TimeInterval?, cap: TimeInterval = 8) -> TimeInterval {
        min(cap, retryAfter ?? pow(2, Double(attempt)))
    }
}

/// Retries an idempotent read on 429 with back-off; any other error is returned at once.
@MainActor
func retryOnRateLimit<T>(attempts: Int = 3, sleep: (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
                         _ operation: () async throws -> T) async throws -> T {
    var attempt = 0
    while true {
        do { return try await operation() }
        catch let limited as RateLimited {
            guard attempt < attempts else { throw limited }
            try await sleep(RateLimited.delay(attempt: attempt, retryAfter: limited.retryAfter))
            attempt += 1
        }
    }
}

/// One verified identity per (generation, session credential) for `ttl` seconds, and one
/// shared in-flight verification for concurrent callers. Errors are never cached, so a
/// 401 or a changed account is seen by the next call; a new generation (sign-in, share
/// switch, sign-out) or a new session cookie is a different key.
@MainActor
final class VerificationCache {
    struct Key: Hashable {
        let generation: UUID
        let credential: String
    }

    let ttl: TimeInterval
    private let now: () -> Date
    private var cached: (key: Key, identity: String, at: Date)?
    private var inflight: (key: Key, id: UUID, task: Task<String, Error>)?

    init(ttl: TimeInterval = 20, now: @escaping () -> Date = Date.init) { self.ttl = ttl; self.now = now }

    func identity(for key: Key, fetch: @escaping @MainActor () async throws -> String) async throws -> String {
        if let cached, cached.key == key, now().timeIntervalSince(cached.at) < ttl { return cached.identity }
        if let inflight, inflight.key == key { return try await inflight.task.value }
        let id = UUID()
        let task = Task { @MainActor in try await fetch() }
        inflight = (key, id, task)
        defer { if inflight?.id == id { inflight = nil } }
        do {
            let identity = try await task.value
            if inflight?.id == id { cached = (key, identity, now()) }
            return identity
        } catch {
            if cached?.key == key { cached = nil }
            throw error
        }
    }

    func invalidate() { cached = nil; inflight = nil }

    /// The part of the request credential that names the session: the session token
    /// (not the minute-long cache cookie), or the guest bearer.
    static func credential(_ headers: [String: String]) -> String {
        if let bearer = headers["Authorization"] { return bearer }
        let cookie = headers["Cookie"] ?? ""
        let token = cookie.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.hasPrefix("__Secure-startrips.session_token=") || $0.hasPrefix("startrips.session_token=") }
        return token ?? cookie
    }
}
