import Foundation

/// The owner's first Atlas, created natively with the web gate's exact calls
/// (`AuthGateway.createOrganization` / `bootstrapAtlas`): organization/create →
/// organization/set-active → atlases/bootstrap. Bootstrap is idempotent on the
/// server, and a retried create re-lists first, so a lost response or a relaunch
/// never creates a second Organization.
@MainActor
struct AtlasSetup {
    /// What the name step does when submitted.
    enum Step: Equatable {
        case createOrganization
        case bootstrap
    }

    /// Where sign-in goes once an owner session exists.
    enum Next: Equatable {
        case ready
        case choose([OwnerSignIn.Organization])
        case name(Step, prefill: String)
    }

    enum Failure: Error, Equatable {
        case create, activate, bootstrap, rateLimited, unavailable

        var message: String {
            switch self {
            case .create: return "无法创建私人图谱"
            case .activate: return "无法切换私人图谱"
            case .bootstrap: return "无法完成图谱初始化"
            case .rateLimited: return OwnerSignIn.Failure.rateLimited.message
            case .unavailable: return OwnerSignIn.Failure.unavailable.message
            }
        }
    }

    static let titleLimit = 80

    let session: AtlasSession
    var suffix: () -> String = { String(UUID().uuidString.lowercased().prefix(8)) }

    /// The web slug: lowercase ASCII words joined by "-", or "atlas", plus 8 hex characters.
    static func slug(_ name: String, suffix: String) -> String {
        let words = name.lowercased().split(whereSeparator: { !($0.isASCII && ($0.isLetter || $0.isNumber)) })
        let base = words.joined(separator: "-")
        return (base.isEmpty ? "atlas" : base) + "-" + suffix
    }

    /// The server's Atlas title rule: trimmed, 1...80 characters.
    static func title(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.count > titleLimit ? nil : trimmed
    }

    /// Mirrors `gateFromOrganizationList` + `gateFromCurrentAtlas`.
    func next() async throws -> Next {
        let active = try await session.activeOrganization()
        let listed = try await organizations()
        switch OwnerSignIn.organizationStep(listed, active: active) {
        case .ready: return try await atlas(in: listed.first { $0.id == active })
        case .activate(let id): return try await activate(id, in: listed)
        case .choose(let all): return .choose(all)
        case .none: return .name(.createOrganization, prefill: "")
        }
    }

    func choose(_ organization: OwnerSignIn.Organization) async throws -> Next {
        try await activate(organization.id, in: [organization])
    }

    /// The name step's create path. `resuming` re-lists first: an earlier attempt
    /// may have created the Organization even though its response was lost.
    func create(name: String, resuming: Bool) async throws -> Next {
        guard let title = Self.title(name) else { throw Failure.create }
        var id: String?
        if resuming {
            let listed = try await organizations()
            switch OwnerSignIn.organizationStep(listed, active: nil) {
            case .activate(let existing): id = existing
            case .choose(let all): return .choose(all)
            case .ready, .none: break
            }
        }
        if id == nil {
            struct Created: Decodable { let id: String }
            let body = try JSONSerialization.data(withJSONObject: ["name": title, "slug": Self.slug(title, suffix: suffix())],
                                                  options: [.sortedKeys])
            let data = try await call("/api/auth/organization/create", body: body, failure: .create)
            guard let created = try? JSONDecoder().decode(Created.self, from: data) else { throw Failure.create }
            id = created.id
        }
        try await setActive(id ?? "")
        return try await bootstrap(name: title)
    }

    /// The name step's bootstrap path for an active Organization without an Atlas.
    func bootstrap(name: String) async throws -> Next {
        guard let title = Self.title(name) else { throw Failure.bootstrap }
        let body = try JSONSerialization.data(withJSONObject: ["title": title, "dedication": ""], options: [.sortedKeys])
        _ = try await call("/api/atlases/bootstrap", body: body, failure: .bootstrap)
        return .ready
    }

    private func activate(_ id: String, in listed: [OwnerSignIn.Organization]) async throws -> Next {
        try await setActive(id)
        return try await atlas(in: listed.first { $0.id == id })
    }

    private func setActive(_ id: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["organizationId": id])
        _ = try await call("/api/auth/organization/set-active", body: body, failure: .activate)
    }

    /// `/api/atlases/current`: present → ready; 404 ATLAS_NOT_FOUND → bootstrap step.
    private func atlas(in organization: OwnerSignIn.Organization?) async throws -> Next {
        let (data, status) = try await session.ownerResponse("/api/atlases/current")
        if (200..<300).contains(status) { return .ready }
        struct Refusal: Decodable { let error: String? }
        if status == 404, (try? JSONDecoder().decode(Refusal.self, from: data))?.error == "ATLAS_NOT_FOUND" {
            return .name(.bootstrap, prefill: String((organization?.name ?? "").prefix(Self.titleLimit)))
        }
        throw status == 429 ? Failure.rateLimited : Failure.unavailable
    }

    private func organizations() async throws -> [OwnerSignIn.Organization] {
        let data = try await call("/api/auth/organization/list", method: "GET", body: nil, failure: .unavailable)
        guard let listed = try? JSONDecoder().decode([OwnerSignIn.Organization].self, from: data) else { throw Failure.unavailable }
        return listed
    }

    /// One owner call; a transport error (a possibly lost response) is the step's failure.
    private func call(_ path: String, method: String = "POST", body: Data?, failure: Failure) async throws -> Data {
        let data: Data, status: Int
        do { (data, status) = try await session.ownerResponse(path, method: method, body: body) }
        catch is URLError { throw failure }
        if status == 429 { throw Failure.rateLimited }
        guard (200..<300).contains(status) else { throw failure }
        return data
    }
}
