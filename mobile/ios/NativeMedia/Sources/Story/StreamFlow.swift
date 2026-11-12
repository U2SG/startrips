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

    /// Pictures to have decoded before the reading point gets there, nearest first: every
    /// picture whose beat starts within `horizonMS` of now, at least `minimum`, at most `maximum`.
    static func lookahead(beats: [PlaybackBeat], index: Int, elapsedMS: Double, horizonMS: Double = 20_000,
                          minimum: Int = 3, maximum: Int = 10) -> [MediaAsset] {
        guard beats.indices.contains(index) else { return [] }
        let starts = beatStarts(beats)
        let now = starts[index] + elapsedMS
        var seen = Set<String>()
        var result: [MediaAsset] = []
        for position in index..<beats.count {
            guard let asset = beats[position].asset, !asset.isVideo, asset.isVisual, seen.insert(asset.id).inserted else { continue }
            if starts[position] - now > horizonMS && result.count >= minimum { break }
            result.append(asset)
            if result.count >= maximum { break }
        }
        return result
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

    // MARK: Even flow (owner feedback: lurch-stop-lurch)

    /// A point the reading position must pass: the start of a run of beats on one row.
    struct Knot: Equatable { let time: Double; let y: CGFloat }

    /// Start time (ms) of every beat on the playback timeline.
    static func beatStarts(_ beats: [PlaybackBeat]) -> [Double] {
        var total = 0.0
        return beats.map { beat in defer { total += max(0, beat.durationMS) }; return total }
    }

    /// Knots from the run containing `index` onward: consecutive beats on one row form one run,
    /// so a row shared by several beats is crossed slowly across all of them (no hard stop),
    /// and the position reaches each new row exactly when its first beat starts.
    static func knots(index: Int, beats: [PlaybackBeat], entries: [StoryEntry], count: Int = 4,
                      y: (Int?) -> CGFloat?) -> [Knot] {
        guard beats.indices.contains(index) else { return [] }
        let starts = beatStarts(beats)
        let rows = beats.map { row(for: $0, in: entries) }
        var first = index
        while first > 0 && rows[first - 1] == rows[index] { first -= 1 }
        var knots: [Knot] = []
        var cursor = first
        while cursor < beats.count && knots.count < count {
            guard let position = y(rows[cursor]) else { break }
            knots.append(Knot(time: starts[cursor], y: position))
            let row = rows[cursor]
            while cursor < beats.count && rows[cursor] == row { cursor += 1 }
        }
        return knots
    }

    /// The current run's row and the next run's row, positioned only from fresh frames:
    /// a laid-out row's own frame, the row right after a laid-out row (its maxY + spacing),
    /// or, further down, the last laid-out row's end plus the average laid-out pitch. A row
    /// above everything laid out yields no knot (the follower holds; it never chases back).
    static func nearKnots(index: Int, beats: [PlaybackBeat], entries: [StoryEntry],
                          frames: [ClosedRange<CGFloat>?], spacing: CGFloat) -> [Knot] {
        func y(_ row: Int?) -> CGFloat? {
            guard let row else { return 0 }
            guard entries.indices.contains(row) else { return nil }
            if let frame = frames[row] { return frame.lowerBound }
            let laid = frames.indices.filter { frames[$0] != nil }
            guard let before = laid.last(where: { $0 < row }), let end = frames[before]?.upperBound else { return nil }
            let heights = laid.compactMap { frames[$0].map { $0.upperBound - $0.lowerBound } }
            let pitch = heights.isEmpty ? 0 : heights.reduce(0, +) / CGFloat(heights.count) + spacing
            return end + spacing + pitch * CGFloat(row - before - 1)
        }
        return knots(index: index, beats: beats, entries: entries, count: 2, y: y)
    }

    /// The scheduled reading position: piecewise linear between knots, holding at the ends.
    static func scheduled(_ knots: [Knot], at time: Double) -> CGFloat? {
        guard let first = knots.first else { return nil }
        if time <= first.time { return first.y }
        for (a, b) in zip(knots, knots.dropFirst()) where time < b.time {
            let span = max(1, b.time - a.time)
            return a.y + (b.y - a.y) * CGFloat((time - a.time) / span)
        }
        return knots.last?.y
    }
}

/// Follows the scheduled position with bounded acceleration and speed, chasing a point a
/// little ahead in time so speed changes are spread out instead of stepping at every knot.
struct StreamFollower: Equatable {
    static let lead: Double = 0.6
    static let maxAcceleration: CGFloat = 500   // pt/s²
    static let maxSpeed: CGFloat = 1200         // pt/s

    var position: CGFloat
    var velocity: CGFloat = 0

    /// `ahead` is the scheduled position `lead` seconds from now. `catchUp` (a seek or a
    /// resume far from the schedule) allows a quicker, still continuous, glide.
    mutating func step(ahead: CGFloat, dt: Double, catchUp: Bool = false) {
        guard dt > 0 else { return }
        var desired = (ahead - position) / CGFloat(Self.lead)
        if !catchUp { desired = max(0, desired) }   // playing never runs back up the thread
        let speed = catchUp ? Self.maxSpeed * 3 : Self.maxSpeed
        desired = min(speed, max(-speed, desired))
        let limit = (catchUp ? Self.maxAcceleration * 6 : Self.maxAcceleration) * CGFloat(dt)
        velocity += min(limit, max(-limit, desired - velocity))
        position += velocity * CGFloat(dt)
    }
}
