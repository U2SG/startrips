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
        let elapsedMS: Double
        let durationMS: Double
        let paused: Bool
        /// Content y of this beat's row, and of the next beat that lands elsewhere.
        let from: CGFloat
        let to: CGFloat?
    }

    weak var scrollView: UIScrollView?
    var onTakeover: (() -> Void)?
    var reduceMotion = false
    private var link: CADisplayLink?
    private var sample: Sample?
    private var sampledAt: CFTimeInterval = 0
    private var reading: CGFloat?
    private var glide: (from: CGFloat, start: CFTimeInterval)?

    var attached: Bool { scrollView != nil }

    func update(_ next: Sample) {
        let now = CACurrentMediaTime()
        if let previous = sample {
            let resumed = previous.paused && !next.paused
            // Natural advances are continuous already; seeks and resumes glide.
            if resumed || (previous.beat != next.beat && next.beat != previous.beat + 1) {
                glide = (currentReading() ?? reading ?? next.from, now)
                reading = nil
            } else if previous.beat != next.beat {
                reading = nil
            }
        }
        sample = next; sampledAt = now
        start()
    }

    func stop() {
        link?.invalidate(); link = nil
        sample = nil; reading = nil; glide = nil
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
        guard let scrollView, let sample else { return }
        // The reader's finger always wins: playback pauses, play resumes the flow.
        if scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating {
            if !sample.paused { onTakeover?() }
            return
        }
        guard !sample.paused else { return }
        let now = link.targetTimestamp
        let elapsed = StreamFlow.elapsed(sampled: sample.elapsedMS, sinceSampleMS: (now - sampledAt) * 1000,
                                         duration: sample.durationMS, paused: sample.paused)
        let fraction = sample.durationMS > 0 ? elapsed / sample.durationMS : 0
        var target = reduceMotion ? sample.from : StreamFlow.reading(from: sample.from, to: sample.to, fraction: fraction)
        if let reading, target < reading, glide == nil { target = reading }   // never runs backwards within a beat
        if let glide {
            let t = now - glide.start
            target = StreamFlow.glide(from: glide.from, to: target, elapsed: t, reduceMotion: reduceMotion)
            if t >= StreamFlow.seekSeconds || reduceMotion { self.glide = nil }
        }
        reading = target
        let inset = scrollView.adjustedContentInset
        let viewport = scrollView.bounds.height
        let offset = StreamFlow.offset(reading: target, viewport: viewport,
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
