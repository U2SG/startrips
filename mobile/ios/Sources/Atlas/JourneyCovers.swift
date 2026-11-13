import ImageIO
import SwiftUI
import StartripsMedia

/// Journey covers for the native card, loaded through the same scoped,
/// revalidated read path native Story uses. Signed URLs stay in this process:
/// they are never encoded into the scene snapshot or a scene command.
@MainActor
final class JourneyCoverStore: ObservableObject {
    @Published private(set) var images: [String: UIImage] = [:]
    private var scope: String?
    private var media: ScopedMediaSession?
    private var tasks: [String: Task<Void, Never>] = [:]
    private var failed = Set<String>()

    /// The cover asset: the Journey's chosen cover, else its first picture.
    static func coverAsset(_ journey: MediaJourney) -> MediaAsset? {
        let pictures = journey.media.filter { $0.mimeType.hasPrefix("image/") }
        return pictures.first(where: { $0.id == journey.coverMediaAssetId }) ?? pictures.first
    }

    func image(for journeyId: String) -> UIImage? { images[journeyId] }

    /// Loads on demand only (selected Journey, visible list rows); each scope has its own cache.
    func load(_ journeyId: String, session: AtlasSession, access: AtlasAccess) {
        guard let identity = session.activeIdentity else { reset(); return }
        if identity != scope { reset(); scope = identity }
        guard images[journeyId] == nil, tasks[journeyId] == nil, !failed.contains(journeyId),
              let journey = session.mediaJourneys[journeyId], let asset = Self.coverAsset(journey) else { return }
        let scoped = media ?? session.mediaScope(scope: identity, access: access == .guest ? .guest : .owner)
        media = scoped
        tasks[journeyId] = Task { [weak self] in
            defer { if self?.scope == identity { self?.tasks[journeyId] = nil } }
            do {
                let image = try await Self.read(asset, from: scoped)
                guard let self, self.scope == identity, session.activeIdentity == identity else { return }
                self.images[journeyId] = image
            } catch is CancellationError {
            } catch {
                guard let self, self.scope == identity else { return }
                self.failed.insert(journeyId)
            }
        }
    }

    /// Sign-out, share switch and expiry drop every cover and in-flight read.
    func reset() {
        tasks.values.forEach { $0.cancel() }
        tasks = [:]; images = [:]; failed = []; scope = nil; media = nil
    }

    private static func read(_ asset: MediaAsset, from session: ScopedMediaSession) async throws -> UIImage {
        let url = try await session.mediaURL(asset.id)
        let (file, response) = try await session.imageTransport.download(from: url)
        defer { try? FileManager.default.removeItem(at: file) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw MediaFailure.unavailable }
        try Task.checkCancellation()
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1200
              ] as CFDictionary) else { throw MediaFailure.unavailable }
        return UIImage(cgImage: image)
    }
}

/// A cover or, without one, a quiet field in the Journey's light colour.
struct JourneyCoverView: View {
    let image: UIImage?
    let lightColor: String
    var body: some View {
        ZStack {
            Rectangle().fill(LinearGradient(colors: [Color(cssHex: lightColor).opacity(0.35), NightFlight.background],
                                            startPoint: .top, endPoint: .bottom))
            if let image {
                // Fill without growing the frame: an unclipped fill image overflows its row for
                // hit testing and accessibility, covering the buttons below the cover.
                Image(uiImage: image).resizable().scaledToFill()
                    .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                    .clipped()
                    .transition(.opacity)
            } else {
                Image(systemName: "photo").font(.title2).foregroundStyle(NightFlight.muted.opacity(0.6))
            }
        }
        .clipped()
        .accessibilityHidden(true)
    }
}

extension Color {
    /// `#rrggbb` Journey light colours; anything else falls back to ink.
    init(cssHex: String) {
        let text = cssHex.hasPrefix("#") ? String(cssHex.dropFirst()) : cssHex
        guard text.count == 6, let value = UInt32(text, radix: 16) else { self = NightFlight.ink; return }
        self.init(hex: value)
    }
}
