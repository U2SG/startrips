import CoreGraphics
import Foundation

/// 旅程之流 playback as one continuous downward flow: each beat maps to a row on
/// the thread, and the reading point travels from this beat's row toward the
/// next beat's row over the beat's duration. Pure, so the motion is tested.
enum StreamFlow {
    /// Where on screen the current row sits while it is being read.
    static let readingLine: CGFloat = 0.3
    /// A seek (next/previous, tempo jump) glides instead of jumping.
    static let seekSeconds: Double = 0.6

    /// The stream row (index into the stream's entries) a beat belongs to;
    /// nil means the top of the stream (intro and prelude beats).
    static func row(for beat: PlaybackBeat, in entries: [StoryEntry]) -> Int? {
        if let asset = beat.asset, let index = entries.firstIndex(where: { $0.asset?.id == asset.id }) { return index }
        if let point = beat.routePointId,
           let index = entries.firstIndex(where: { $0.routePointId == point || $0.chapterRoutePointId == point }) {
            return index
        }
        switch beat.kind {
        case .outro, .homeEpilogue: return entries.isEmpty ? nil : entries.count - 1
        default: return nil
        }
    }

    /// The next beat that lands on a different row, so the flow heads somewhere.
    static func nextRow(after index: Int, beats: [PlaybackBeat], entries: [StoryEntry]) -> Int?? {
        guard beats.indices.contains(index) else { return nil }
        let current = row(for: beats[index], in: entries)
        for beat in beats.dropFirst(index + 1) {
            let candidate = row(for: beat, in: entries)
            if candidate != current { return .some(candidate) }
        }
        return nil
    }

    static func ease(_ t: Double) -> Double {
        let x = min(1, max(0, t))
        return x * x * (3 - 2 * x)
    }

    /// Content y the reading point is at: eased from `from` to `to` across the beat.
    static func reading(from: CGFloat, to: CGFloat?, fraction: Double) -> CGFloat {
        guard let to else { return from }
        return from + (to - from) * CGFloat(ease(fraction))
    }

    /// Scroll offset that puts `reading` on the reading line, clamped to the content.
    static func offset(reading: CGFloat, viewport: CGFloat, content: CGFloat) -> CGFloat {
        let maxOffset = max(0, content - viewport)
        return min(maxOffset, max(0, reading - viewport * readingLine))
    }

    /// After a seek, glide from where the stream was to the new target.
    static func glide(from start: CGFloat, to target: CGFloat, elapsed: Double, reduceMotion: Bool) -> CGFloat {
        guard !reduceMotion else { return target }
        return start + (target - start) * CGFloat(ease(elapsed / seekSeconds))
    }

    /// Pictures to prefetch and pre-decode ahead of the reading point (current row first).
    static func lookahead(from row: Int?, entries: [StoryEntry], count: Int = 8) -> [MediaAsset] {
        let start = max(0, row ?? 0)
        guard start < entries.count else { return [] }
        return entries[start...].compactMap(\.asset).filter { !$0.isVideo && $0.isVisual }.prefix(count).map { $0 }
    }

    /// Clock samples arrive every ~50ms; between them the reading point is extrapolated
    /// per display frame, but never more than `maxLead` ahead, so a clock that waits
    /// for a picture (mediaReady) holds the flow instead of running past it.
    static let maxLeadMS: Double = 120
    static func elapsed(sampled: Double, sinceSampleMS: Double, duration: Double, paused: Bool) -> Double {
        guard !paused else { return sampled }
        return min(max(duration, sampled), sampled + min(max(0, sinceSampleMS), maxLeadMS))
    }
}
