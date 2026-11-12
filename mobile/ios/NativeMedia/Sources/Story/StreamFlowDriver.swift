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
    }

    weak var scrollView: UIScrollView?
    var onTakeover: (() -> Void)?
    var reduceMotion = false
    private var link: CADisplayLink?
    private var sample: Sample?
    private var sampledAt: CFTimeInterval = 0
    private var follower: StreamFollower?
    private var lastFrame: CFTimeInterval?

    var attached: Bool { scrollView != nil }

    func update(_ next: Sample) {
        if let previous = sample, previous.paused, !next.paused { follower = nil }   // resume from where the reader is
        sample = next; sampledAt = CACurrentMediaTime()
        start()
    }

    func stop() {
        link?.invalidate(); link = nil
        sample = nil; follower = nil; lastFrame = nil
    }

    private func start() {
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
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
        if scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating {
            if !sample.paused { onTakeover?() }
            follower = nil
            return
        }
        guard !sample.paused, let first = sample.knots.first else { follower?.velocity = 0; return }
        let viewport = scrollView.bounds.height
        let reading: CGFloat
        if reduceMotion {
            // Step to the row being read, no motion in between.
            reading = first.y
        } else {
            // Between 50ms clock samples the timeline advances with the display, never more
            // than maxLead ahead of a clock that is waiting for a picture.
            let time = sample.scheduleMS + min(max(0, (now - sampledAt) * 1000), StreamFlow.maxLeadMS)
            guard let ahead = StreamFlow.scheduled(sample.knots, at: time + StreamFollower.lead * 1000) else { return }
            var follower = self.follower ?? StreamFollower(position: currentReading() ?? first.y)
            let dt = min(0.05, max(0, now - (lastFrame ?? now)))
            follower.step(ahead: ahead, dt: dt, catchUp: abs(ahead - follower.position) > viewport)
            self.follower = follower
            reading = follower.position
        }
        let inset = scrollView.adjustedContentInset
        let offset = StreamFlow.offset(reading: reading, viewport: viewport,
                                       content: scrollView.contentSize.height + inset.top + inset.bottom)
        let y = (offset - inset.top).rounded(toPixelsOf: scrollView)
        if abs(scrollView.contentOffset.y - y) > 0.01 { scrollView.contentOffset.y = y }
    }
}

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
