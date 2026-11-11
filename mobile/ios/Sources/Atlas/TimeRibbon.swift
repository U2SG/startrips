import SwiftUI

/// Month buckets from the earliest Journey start to the latest Journey end.
/// Pure and deterministic so the ribbon's date math is unit-tested.
struct TimeRibbonModel: Equatable {
    struct Month: Hashable {
        let year: Int
        let month: Int
        var id: String { String(format: "%04d-%02d", year, month) }
        var firstDay: String { id + "-01" }
        var lastDay: String {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
            let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
            return id + String(format: "-%02d", days)
        }
        var ordinal: Int { year * 12 + month - 1 }
        init(year: Int, month: Int) { self.year = year; self.month = month }
        init(ordinal: Int) { self.init(year: ordinal / 12, month: ordinal % 12 + 1) }
        /// Reads the `YYYY-MM` prefix of an ISO date or timestamp.
        init?(iso: String?) {
            guard let iso, iso.count >= 7 else { return nil }
            let parts = iso.prefix(7).split(separator: "-")
            guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]),
                  (1...12).contains(month), year > 0 else { return nil }
            self.init(year: year, month: month)
        }
    }

    struct Span: Equatable {
        let journeyId: String
        let start: Int
        let end: Int
    }

    let months: [Month]
    /// Dated Journeys in server order, as month index ranges into `months`.
    let spans: [Span]

    init(journeys: [AtlasJourney]) {
        let dated = journeys.compactMap { journey -> (String, Int, Int)? in
            guard let start = Month(iso: journey.startedOn) else { return nil }
            let end = Month(iso: journey.endedOn) ?? start
            return (journey.id, start.ordinal, max(start.ordinal, end.ordinal))
        }
        guard let first = dated.map(\.1).min(), let last = dated.map(\.2).max() else {
            months = []; spans = []; return
        }
        months = (first...last).map(Month.init(ordinal:))
        spans = dated.map { Span(journeyId: $0.0, start: $0.1 - first, end: $0.2 - first) }
    }

    var isEmpty: Bool { months.isEmpty }
    var lastIndex: Int { max(0, months.count - 1) }

    func index(at fraction: Double) -> Int {
        guard !months.isEmpty else { return 0 }
        let clamped = min(1, max(0, fraction.isFinite ? fraction : 1))
        return Int((clamped * Double(lastIndex)).rounded())
    }

    func fraction(of index: Int) -> Double {
        lastIndex == 0 ? 1 : Double(min(max(0, index), lastIndex)) / Double(lastIndex)
    }

    /// The Journey under the cursor: one that spans the month, else the closest
    /// start. Ties keep the latest started one, like the web scrubber reaching it.
    func journey(at index: Int) -> String? {
        if let covering = spans.last(where: { $0.start <= index && index <= $0.end }) { return covering.journeyId }
        return spans.min(by: { abs($0.start - index) < abs($1.start - index) })?.journeyId
    }

    func index(of journeyId: String?) -> Int? {
        spans.first(where: { $0.journeyId == journeyId })?.end
    }

    /// Everything up to the end of the cursor's month; the final month clears it.
    func window(through index: Int) -> SceneTimeWindow? {
        guard let first = months.first, months.indices.contains(index), index < lastIndex else { return nil }
        return SceneTimeWindow(start: first.firstDay, end: months[index].lastDay)
    }
}

/// Draggable year/month ribbon. Dragging flies the camera across Journeys by
/// date (preview only); releasing commits the Journey under the cursor.
struct TimeRibbon: View {
    @ObservedObject var router: AppRouter
    let model: TimeRibbonModel
    @State private var dragIndex: Int?
    /// Where the cursor was released; kept until another surface changes the Journey.
    @State private var restingIndex: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var selectedIndex: Int {
        dragIndex ?? restingIndex ?? model.index(of: router.focusedJourneyId) ?? model.lastIndex
    }

    var body: some View {
        GeometryReader { proxy in
            let width = max(1, proxy.size.width - NightFlight.grid(8))
            ZStack(alignment: .leading) {
                track(width: width)
                cursor
                    .offset(x: NightFlight.grid(4) + width * model.fraction(of: selectedIndex) - 1)
                    .animation(dragIndex == nil ? NightFlight.motion(NightFlight.snappy, reduceMotion: reduceMotion) : nil,
                               value: selectedIndex)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                scrub(to: model.index(at: (value.location.x - NightFlight.grid(4)) / width))
            }.onEnded { _ in commit() })
        }
        .frame(height: NightFlight.hitTarget + NightFlight.grid(3))
        .accessibilityElement()
        .accessibilityLabel("时间轴")
        .accessibilityValue(label(for: selectedIndex))
        .accessibilityAdjustableAction { direction in
            let step = direction == .increment ? 1 : -1
            scrub(to: min(model.lastIndex, max(0, selectedIndex + step)))
            commit()
        }
        .accessibilityIdentifier("atlas.ribbon")
        .onChange(of: router.selection?.journeyId) { _, journey in
            guard dragIndex == nil, let resting = restingIndex, model.journey(at: resting) != journey else { return }
            restingIndex = nil
            router.presentation.window = nil
        }
    }

    private func track(width: CGFloat) -> some View {
        Canvas { context, size in
            let mid = size.height / 2
            let step = width / CGFloat(max(1, model.lastIndex))
            for (index, month) in model.months.enumerated() {
                let x = NightFlight.grid(4) + CGFloat(index) * step
                let tall = month.month == 1 || index == 0
                var tick = Path()
                tick.move(to: CGPoint(x: x, y: mid - (tall ? 7 : 3)))
                tick.addLine(to: CGPoint(x: x, y: mid + (tall ? 7 : 3)))
                context.stroke(tick, with: .color(NightFlight.muted.opacity(contrast == .increased ? 0.9 : 0.45)),
                               lineWidth: tall ? 1.5 : 1)
            }
            for span in model.spans {
                var bar = Path()
                let start = NightFlight.grid(4) + CGFloat(span.start) * step
                let end = NightFlight.grid(4) + CGFloat(span.end) * step
                bar.move(to: CGPoint(x: start, y: mid)); bar.addLine(to: CGPoint(x: max(start + 2, end), y: mid))
                let current = span.journeyId == router.focusedJourneyId
                context.stroke(bar, with: .color(current ? NightFlight.accent : NightFlight.ink.opacity(0.6)),
                               style: StrokeStyle(lineWidth: 3, lineCap: .round))
            }
        }
        .overlay(alignment: .bottomLeading) { yearLabels(width: width) }
        .accessibilityHidden(true)
    }

    private func yearLabels(width: CGFloat) -> some View {
        let step = width / CGFloat(max(1, model.lastIndex))
        let years = model.months.enumerated().filter { $0.offset == 0 || $0.element.month == 1 }
        // Thin labels so neighbouring years never collide.
        let stride = max(1, Int((44 / max(step * 12, 1)).rounded(.up)))
        return ZStack(alignment: .leading) {
            ForEach(Array(years.enumerated()).filter { $0.offset % stride == 0 }.map(\.element), id: \.offset) { item in
                Text(String(item.element.year))
                    .font(.caption2.monospacedDigit())
                    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                    .nightFlightMuted()
                    .fixedSize()
                    .offset(x: NightFlight.grid(4) + CGFloat(item.offset) * step)
            }
        }
    }

    private var cursor: some View {
        Capsule().fill(NightFlight.accent).frame(width: 2, height: NightFlight.grid(7))
            .shadow(color: NightFlight.accent.opacity(0.6), radius: 4)
    }

    private func label(for index: Int) -> String {
        guard model.months.indices.contains(index) else { return "" }
        let month = model.months[index]
        return "\(month.year)年\(month.month)月"
    }

    private func scrub(to index: Int) {
        guard index != dragIndex else { return }
        dragIndex = index
        router.presentation.window = model.window(through: index)
        router.previewFocus(journeyId: model.journey(at: index))
    }

    private func commit() {
        guard let index = dragIndex else { return }
        dragIndex = nil
        restingIndex = index == model.lastIndex ? nil : index
        if let journey = model.journey(at: index) { router.select(journeyId: journey) }
        router.previewFocus(journeyId: nil)
    }
}
