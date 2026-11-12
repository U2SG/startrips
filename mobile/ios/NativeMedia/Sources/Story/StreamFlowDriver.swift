import QuartzCore
import SwiftUI
import UIKit

/// Moves the stream's `UIScrollView` once per display frame while 旅程之流 plays.
/// SwiftUI only hands it a clock sample per playback tick; no SwiftUI state,
/// `scrollTo` or animation is involved in the per-frame motion.
@MainActor
final class StreamFlowDriver: NSObject, ObservableObject {
    struct Sample: Equatable {
        let beat: Int
        /// Position on the playback timeline (ms) when sampled.
        let scheduleMS: Double
        let paused: Bool
        /// Where the reading point must be, and when (see `StreamFlow.knots`).
        let knots: [StreamFlow.Knot]
        /// The row the first knot belongs to: if its y moves while it stays the anchor, the
        /// content above it was re-laid out.
        var anchor: String? = nil
        /// A video beat: the flow glides once to show this row, then holds while the clip plays.
        var videoRow: ClosedRange<CGFloat>? = nil
        static func == (lhs: Sample, rhs: Sample) -> Bool {
            lhs.beat == rhs.beat && lhs.scheduleMS == rhs.scheduleMS && lhs.paused == rhs.paused
                && lhs.knots == rhs.knots && lhs.anchor == rhs.anchor
        }
    }


    weak var scrollView: UIScrollView?
    var onTakeover: (() -> Void)?
    var reduceMotion = false
    private var link: CADisplayLink?
    private var sample: Sample?
    private var sampledAt: CFTimeInterval = 0
    private var follower: StreamFollower?
    private var lastFrame: CFTimeInterval?
    /// Only an explicit seek (previous/next) may move the stream back up the thread.
    private var seeking = false
    private var lastOffset: CGFloat?
    #if DEBUG
    private var frameCount = 0
    #endif

    var attached: Bool { scrollView != nil }

    func update(_ next: Sample) {
        if let previous = sample {
            if previous.paused, !next.paused { follower = nil }   // resume from where the reader is
            if next.beat != previous.beat && next.beat != previous.beat + 1 { seeking = true; log("SEEK beat=\(previous.beat)->\(next.beat)") }
            // Same anchor row, new y: rows above it changed height. Move with the content.
            if let anchor = next.anchor, anchor == previous.anchor, let old = previous.knots.first?.y,
               let new = next.knots.first?.y, abs(new - old) > 0.5, let scrollView {
                let delta = new - old
                follower?.shift(by: delta)
                lastOffset = lastOffset.map { $0 + delta }
                scrollView.contentOffset.y += delta
                log(String(format: "RELAYOUT anchor=%@ delta=%.1f", anchor, delta))
            }
        }
        sample = next; sampledAt = CACurrentMediaTime()
        start()
    }

    func stop() {
        link?.invalidate(); link = nil
        sample = nil; follower = nil; lastFrame = nil; seeking = false; lastOffset = nil
    }

    private func start() {
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func log(_ line: String) {
        #if DEBUG
        StreamTimingLog.write(String(format: "%@ t=%.3f", line, CACurrentMediaTime()))
        #endif
    }

    private func currentReading() -> CGFloat? {
        guard let scrollView else { return nil }
        return scrollView.contentOffset.y + scrollView.adjustedContentInset.top
            + scrollView.bounds.height * StreamFlow.readingLine
    }

    @objc private func frame(_ link: CADisplayLink) {
        let now = link.targetTimestamp
        defer { lastFrame = now }
        guard let scrollView, let sample else { return }
        // The reader's finger always wins: playback pauses, play resumes the flow.
        // Only a real finger counts. `isDecelerating`/`isDragging` can be left set by UIKit's own
        // content-size adjustments (no touch at all), which used to pause playback by itself.
        let pan = scrollView.panGestureRecognizer.state
        if scrollView.isTracking || pan == .began || pan == .changed {
            if !sample.paused {
                log(String(format: "USER offset=%.1f tracking=%d dragging=%d decelerating=%d pan=%d", scrollView.contentOffset.y,
                           scrollView.isTracking ? 1 : 0, scrollView.isDragging ? 1 : 0, scrollView.isDecelerating ? 1 : 0, pan.rawValue))
                onTakeover?()
            }
            follower = nil; lastOffset = nil
            return
        }
        guard !sample.paused, let first = sample.knots.first else { follower?.velocity = 0; return }
        let start = currentReading() ?? first.y
        let viewport = scrollView.bounds.height
        let reading: CGFloat
        if reduceMotion {
            // Step to the row being read, no motion in between.
            reading = first.y
        } else {
            // Between 50ms clock samples the timeline advances with the display, never more
            // than maxLead ahead of a clock that is waiting for a picture.
            let time = sample.scheduleMS + min(max(0, (now - sampledAt) * 1000), StreamFlow.maxLeadMS)
            var follower = self.follower ?? StreamFollower(position: start)
            let ahead: CGFloat
            if let row = sample.videoRow {
                ahead = StreamFlow.videoHold(row: row, viewport: viewport, current: seeking ? -.infinity : follower.position)
            } else {
                guard let scheduled = StreamFlow.scheduled(sample.knots, at: time + StreamFollower.lead * 1000) else { return }
                ahead = scheduled
            }
            let dt = min(0.05, max(0, now - (lastFrame ?? now)))
            follower.step(ahead: ahead, dt: dt, catchUp: seeking)
            if sample.videoRow != nil { follower.settle(at: ahead) }
            if seeking && abs(ahead - follower.position) < 4 { seeking = false }
            self.follower = follower
            reading = follower.position
        }
        let inset = scrollView.adjustedContentInset
        let offset = StreamFlow.offset(reading: reading, viewport: viewport,
                                       content: scrollView.contentSize.height + inset.top + inset.bottom)
        var y = (offset - inset.top).rounded(toPixelsOf: scrollView)
        // Invariant: while playing, the stream only moves down; a lower offset is only for a seek.
        if !seeking, !reduceMotion, let lastOffset, y < lastOffset {
            log(String(format: "CLAMP wanted=%.1f kept=%.1f", y, lastOffset))   // DEBUG invariant: never back while playing
            y = lastOffset
        }
        lastOffset = y
        if abs(scrollView.contentOffset.y - y) > 0.01 { scrollView.contentOffset.y = y }
        #if DEBUG
        frameCount += 1
        if StreamTimingLog.enabled, frameCount % 6 == 0 {
            let knots = sample.knots.map { String(format: "%.0f@%.0f", $0.y, $0.time) }.joined(separator: ",")
            StreamTimingLog.write(String(format: "FRAME t=%.3f beat=%d schedule=%.0f reading=%.1f offset=%.1f content=%.0f seek=%d video=%d knots=%@",
                                         now, sample.beat, sample.scheduleMS, reading, y, scrollView.contentSize.height,
                                         seeking ? 1 : 0, sample.videoRow == nil ? 0 : 1, knots))
        }
        #endif
    }
}

#if DEBUG
/// One shared `-stream-timing` log (one handle, always appended), so model and driver events
/// interleave instead of overwriting each other. Every line carries the same media-time clock.
@MainActor
enum StreamTimingLog {
    static let enabled = ProcessInfo.processInfo.arguments.contains("-stream-timing")
    private static let handle: FileHandle? = {
        guard enabled else { return nil }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("stream-timing.log")
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        return try? FileHandle(forWritingTo: file)
    }()
    static func write(_ line: String) {
        guard let handle else { return }
        handle.seekToEndOfFile()
        handle.write(Data((line + "\n").utf8))
    }
}
#endif

private extension CGFloat {
    func rounded(toPixelsOf view: UIView) -> CGFloat {
        let scale = view.window?.screen.scale ?? 3
        return (self * scale).rounded() / scale
    }
}

/// Hands the enclosing `UIScrollView` of a SwiftUI `ScrollView` to the driver.
struct StreamScrollViewFinder: UIViewRepresentable {
    let found: (UIScrollView) -> Void
    func makeUIView(context: Context) -> FinderView { FinderView(found: found) }
    func updateUIView(_ view: FinderView, context: Context) {}
    final class FinderView: UIView {
        let found: (UIScrollView) -> Void
        init(found: @escaping (UIScrollView) -> Void) { self.found = found; super.init(frame: .zero); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            var view = superview
            while let current = view {
                if let scroll = current as? UIScrollView { found(scroll); return }
                view = current.superview
            }
        }
    }
}
