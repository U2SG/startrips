import SwiftUI

/// The native subset of the web `MediaPresentationStyle`, in the web order and
/// with the web labels. `book-3d` reuses the web renderer later and is not listed.
public enum StoryPresentationStyle: String, CaseIterable, Identifiable, Sendable {
    case classic, noteOverlay = "note-overlay", book, stream
    /// Remembered per device; the raw values match the web style ids.
    public static let defaultsKey = "startrips.story.presentationStyle"
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .classic: return "默认"
        case .noteOverlay: return "图上感想"
        case .book: return "旅程之书"
        case .stream: return "旅程之流"
        }
    }
    public var symbol: String {
        switch self {
        case .classic: return "rectangle.on.rectangle"
        case .noteOverlay: return "text.below.photo"
        case .book: return "book"
        case .stream: return "text.justify.left"
        }
    }
    /// Unknown stored values (including the web-only `book-3d`) open the default Story.
    public init(stored: String) { self = StoryPresentationStyle(rawValue: stored) ?? .classic }
}

/// Mirrors the app's Night Flight tokens (Sources/Design/NightFlight.swift);
/// this package cannot import the app target, so the values are repeated here.
enum StoryTheme {
    static let background = Color(red: 7 / 255, green: 9 / 255, blue: 15 / 255)
    static let surface = Color(red: 18 / 255, green: 21 / 255, blue: 30 / 255)
    static let ink = Color(red: 242 / 255, green: 244 / 255, blue: 248 / 255)
    static let muted = Color(red: 169 / 255, green: 176 / 255, blue: 191 / 255)
    /// The single warm accent: selection and the current position only.
    static let accent = Color(red: 232 / 255, green: 182 / 255, blue: 92 / 255)
    static let line = Color.white.opacity(0.08)
    // Journey Book tokens (src/styles/journey-book.css).
    static let paper = Color(red: 247 / 255, green: 246 / 255, blue: 240 / 255)
    static let paperInk = Color(red: 41 / 255, green: 44 / 255, blue: 38 / 255)
    static let night = Color(red: 11 / 255, green: 18 / 255, blue: 34 / 255)
    static let gold = Color(red: 217 / 255, green: 185 / 255, blue: 122 / 255)
    static let coverInk = Color(red: 236 / 255, green: 230 / 255, blue: 214 / 255)
    static func serif(_ style: Font.TextStyle) -> Font { .system(style, design: .serif) }
}

/// Port of `src/journey/journeyBookPages.ts` (#393): the Journey read as a book.
public enum StoryBookPage: Equatable, Identifiable, Sendable {
    case cover(MediaAsset?)
    case media(MediaAsset, routePoint: MediaRoutePoint?, note: String?)
    case note(routePoint: MediaRoutePoint?, note: String)
    case blank, end
    public var id: String {
        switch self {
        case .cover: return "cover"
        case .media(let asset, _, _): return "media:\(asset.id)"
        case .note(let point, _): return "note:\(point?.id ?? "journey")"
        case .blank: return "blank"
        case .end: return "end"
        }
    }
    public var routePointID: String? {
        switch self {
        case .media(_, let point, _), .note(let point, _): return point?.id
        default: return nil
        }
    }
    public var asset: MediaAsset? {
        switch self {
        case .cover(let asset): return asset
        case .media(let asset, _, _): return asset
        default: return nil
        }
    }
}

extension MediaJourney {
    /// Same limit as the web: compared in UTF-16 units, as JS `String.length` is.
    static let bookOverlayNoteLimit = 90

    public func bookPages() -> [StoryBookPage] {
        func trimmed(_ value: String?) -> String? {
            let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return text.isEmpty ? nil : text
        }
        func ownerPages(_ assets: [MediaAsset], _ point: MediaRoutePoint?, _ note: String?) -> [StoryBookPage] {
            let notePage = note.map { assets.isEmpty || $0.utf16.count > Self.bookOverlayNoteLimit || assets[0].isVideo } ?? false
            var pages: [StoryBookPage] = []
            if notePage, let note { pages.append(.note(routePoint: point, note: note)) }
            for (index, asset) in assets.enumerated() {
                pages.append(.media(asset, routePoint: point, note: !notePage && index == 0 ? note : nil))
            }
            return pages
        }
        let cover = media.first { $0.id == coverMediaAssetId && $0.isVisual }
            ?? media.filter(\.isVisual).sorted { $0.sortOrder < $1.sortOrder }.first
        var pages: [StoryBookPage] = [.cover(cover)]
        if let journeyNote = trimmed(note) { pages.append(.note(routePoint: nil, note: journeyNote)) }
        pages += ownerPages(ownedMedia(nil), nil, nil)
        for point in routePoints { pages += ownerPages(ownedMedia(point.id), point, trimmed(point.note)) }
        if pages.count % 2 == 0 { pages.append(.blank) }
        pages.append(.end)
        return pages
    }
}

/// Port of `journeyBookStartPage`: an asset wins over its point; unknown opens at the cover.
public func storyBookStartPage(_ pages: [StoryBookPage], assetID: String?, routePointID: String?) -> Int {
    if let assetID, let index = pages.firstIndex(where: { if case .media(let asset, _, _) = $0 { return asset.id == assetID }; return false }) {
        return index
    }
    if let routePointID, let index = pages.firstIndex(where: { $0.routePointID == routePointID }) { return index }
    return 0
}

/// Read-only projection of the owner's 每日手记 (`GET /api/journeys/:id/journal`).
public struct StoryJournalChapter: Decodable, Equatable, Identifiable, Sendable {
    public struct Event: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
        public let text: String
        public let status: String
        public let localTime: String?
        public let routePointId: String?
        public let mediaIds: [String]
    }
    public let id: String
    public let date: String
    public let title: String
    public let events: [Event]
    struct Envelope: Decodable {
        struct Journal: Decodable { let chapters: [StoryJournalChapter] }
        let journal: Journal
    }
}
