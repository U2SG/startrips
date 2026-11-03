import Foundation

/// The web export pins these metadata fields, never a signed capability.
struct OwnerFilmCover: Decodable, Equatable {
    let id: String
    let journeyId: String
    let sourceMediaAssetId: String
    let sourceContentHash: String
    let generationKind: String?
    let generationVersion: Int?
    let presetId: String
    let mimeType: String
    let width: Int
    let height: Int

    private struct Payload: Decodable {
        struct Display: Decodable { let url: String; let expiresAt: String }
        let derivative: OwnerFilmCover?
        let display: Display?
    }

    private var recipeID: String? {
        guard generationVersion == 1, mimeType == "image/jpeg", width > 0, height > 0, !id.isEmpty else { return nil }
        // These are the shipped creativeCoverRecipes.json v1 definitions and the
        // reveal preset names accepted by planCoverRevealOpening.
        switch generationKind {
        case "ink-wash-poster":
            guard ["reveal-flow-ink-wash-v1", "ink-bloom", "guided-ribbon", "brush-sweep", "fiber-soak", "mist-veil"].contains(presetId) else { return nil }
            return "ink-wash-memory"
        case "poetic-line-memory" where presetId == "brush-sweep": return "poetic-line-memory"
        case "paper-collage-memory" where presetId == "guided-ribbon": return "paper-collage-memory"
        default: return nil
        }
    }

    var filmCover: FilmCover? {
        recipeID.map { FilmCover(derivativeId: id, sourceMediaAssetId: sourceMediaAssetId, recipeId: $0, recipeVersion: 1) }
    }

    @MainActor private static func fetch(_ journeyID: String, session: ScopedMediaSession) async throws -> Payload {
        guard session.access == .owner else { throw MediaFailure.readOnly }
        let data = try await session.write("/api/cover-reveal/journeys/\(component(journeyID))", method: "GET")
        try await session.revalidate()
        return try JSONDecoder().decode(Payload.self, from: data)
    }

    @MainActor static func resolve(journey: MediaJourney, session: ScopedMediaSession) async throws -> OwnerFilmCover? {
        guard session.access == .owner else { throw MediaFailure.readOnly }
        let source = journey.media.first { $0.id == journey.coverMediaAssetId && $0.isVisual }
            ?? journey.media.first(where: \.isVisual)
        guard let source, source.journeyId == journey.id, source.mimeType.hasPrefix("image/"),
              source.contentHashVerified == true, let hash = source.contentHash, !hash.isEmpty else { return nil }
        let result = try await fetch(journey.id, session: session)
        guard let pin = result.derivative, pin.journeyId == journey.id,
              pin.sourceMediaAssetId == source.id, pin.sourceContentHash == hash,
              pin.recipeID != nil, let display = result.display,
              let url = URL(string: display.url), url.scheme?.lowercased() == "https", url.host != nil else { return nil }
        return pin
    }

    @MainActor func verify(in session: ScopedMediaSession) async throws {
        let result = try await Self.fetch(journeyId, session: session)
        guard result.derivative == self, result.display != nil else { throw MediaFailure.staleIntent }
    }

    @MainActor func renewedURL(in session: ScopedMediaSession, now: Date = Date()) async throws -> URL {
        let result = try await Self.fetch(journeyId, session: session)
        guard result.derivative == self else { throw MediaFailure.staleIntent }
        guard let display = result.display, let url = URL(string: display.url),
              url.scheme?.lowercased() == "https", url.host != nil else { throw MediaFailure.unavailable }
        let time = ISO8601DateFormatter()
        time.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expires = time.date(from: display.expiresAt) ?? ISO8601DateFormatter().date(from: display.expiresAt)
        guard let expires, expires > now else { throw MediaFailure.unavailable }
        return url
    }
}
