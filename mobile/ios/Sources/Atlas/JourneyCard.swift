import SwiftUI

/// Three detents. Peek: title, dates, route stats. Medium: real cover and
/// route points. Large: the full Journey and every Journey in the Atlas.
enum CardDetent: Int, Comparable, CaseIterable {
    case peek, medium, large
    static func < (lhs: CardDetent, rhs: CardDetent) -> Bool { lhs.rawValue < rhs.rawValue }

    /// Same distances as the web Journey sheet (`mobileSheetDetents`).
    static let expandDistance: CGFloat = 48
    static let collapseDistance: CGFloat = 64
    /// Same horizontal-swipe rule as the web Journey chip (`journeySwipeDirection`).
    static let swipeDistance: CGFloat = 42

    /// A vertical drag of `dy` points (positive = down) moves one detent at most.
    func resolve(dy: CGFloat) -> CardDetent {
        if dy <= -Self.expandDistance { return CardDetent(rawValue: rawValue + 1) ?? self }
        if dy > Self.collapseDistance { return CardDetent(rawValue: rawValue - 1) ?? self }
        return self
    }

    /// -1 previous Journey, 1 next Journey, 0 not a horizontal swipe.
    static func swipeStep(dx: CGFloat, dy: CGFloat) -> Int {
        guard abs(dx) >= swipeDistance, abs(dx) >= abs(dy) * 1.25 else { return 0 }
        return dx < 0 ? 1 : -1
    }

    /// Next Journey index without wrapping at either end.
    static func step(_ index: Int, total: Int, by step: Int) -> Int {
        guard index >= 0, total > 1, step != 0 else { return index }
        return min(total - 1, max(0, index + step))
    }

    var accessibilityValue: String {
        switch self {
        case .peek: return "预览"
        case .medium: return "半屏"
        case .large: return "全屏"
        }
    }
}

struct JourneyCard: View {
    @ObservedObject var router: AppRouter
    @ObservedObject var session: AtlasSession
    @ObservedObject var covers: JourneyCoverStore
    let journey: AtlasJourney
    @Binding var detent: CardDetent
    /// Live height while a vertical drag is in progress.
    @Binding var dragOffset: CGFloat
    let height: CGFloat
    /// Landscape (medium == large) and accessibility sizes let medium scroll.
    let mediumScrolls: Bool
    let storyNamespace: Namespace.ID
    let onPeekHeight: (CGFloat) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    private var index: Int { router.journeys.firstIndex(where: { $0.id == journey.id }) ?? 0 }
    private var pointId: String? {
        router.selection?.journeyId == journey.id ? router.selection?.routePointId : nil
    }
    private var scrolls: Bool { detent == .large || (detent == .medium && mediumScrolls) }
    private var point: AtlasRoutePoint? { journey.routePoints.first(where: { $0.id == pointId }) }

    var body: some View {
        VStack(spacing: 0) {
            header
            // Peek shows only the header; details exist from the first upward drag.
            if detent != .peek || dragOffset > 0 {
                ScrollView {
                    details.padding(.bottom, NightFlight.grid(6))
                }
                .scrollDisabled(!scrolls)
                .scrollIndicators(.hidden)
                .gesture(drag, including: scrolls ? .subviews : .all)
            }
        }
        .frame(height: height, alignment: .top)
        .frame(maxWidth: 560)
        .clipShape(RoundedRectangle(cornerRadius: NightFlight.radiusLarge, style: .continuous))
        .nightFlightSurface(radius: NightFlight.radiusLarge)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("atlas.card")
        .onChange(of: detent) { _, value in
            if value >= .medium { covers.load(journey.id, session: session, access: router.access) }
        }
        .onChange(of: journey.id) { _, id in
            if detent >= .medium { covers.load(id, session: session, access: router.access) }
        }
        .onAppear { if detent >= .medium { covers.load(journey.id, session: session, access: router.access) } }
        // A moved or re-chosen cover picture loads its own cover; the old one is never shown.
        .onChange(of: JourneyCoverStore.key(session.mediaJourneys[journey.id])) { _, _ in
            if detent >= .medium { covers.load(journey.id, session: session, access: router.access) }
        }
    }

    // MARK: Peek

    private var header: some View {
        VStack(spacing: 0) {
            grabber
            HStack(alignment: .center, spacing: NightFlight.grid(3)) {
                Capsule().fill(Color(cssHex: journey.lightColor)).frame(width: NightFlight.grid(1)).padding(.vertical, NightFlight.grid(0.5))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: NightFlight.grid(1)) {
                    // Accessibility sizes break between the two dates, never inside one.
                    ViewThatFits(in: .horizontal) {
                        Text(dateRange)
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(dates, id: \.self) { Text($0).fixedSize() }
                        }
                    }
                    .font(.footnote.monospacedDigit()).nightFlightMuted()
                    Text(journey.title).font(NightFlight.serif(.title3).weight(.semibold))
                        .foregroundStyle(NightFlight.ink).lineLimit(2)
                        .accessibilityIdentifier("atlas.card.title")
                    stats
                }
                Spacer(minLength: NightFlight.grid(2))
                if router.journeys.count > 1 && !typeSize.isAccessibilitySize {
                    Text("\(index + 1)/\(router.journeys.count)").font(.footnote.monospacedDigit()).nightFlightMuted()
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, NightFlight.cardPadding)
            .padding(.bottom, NightFlight.grid(4))
            .frame(minHeight: NightFlight.hitTarget)
            .contentShape(Rectangle())
            .onTapGesture { if detent == .peek { move(to: .medium) } }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("旅程：" + journey.title)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("atlas.card.peek")
            .accessibilityAction { if detent == .peek { move(to: .medium) } }
            .accessibilityAction(named: "下一段旅程") { switchJourney(by: 1) }
            .accessibilityAction(named: "上一段旅程") { switchJourney(by: -1) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onPeekHeight($0) }
        .gesture(drag)
    }

    private var grabber: some View {
        Button { move(to: detent == .large ? .medium : CardDetent(rawValue: detent.rawValue + 1) ?? .large) } label: {
            Capsule().fill(NightFlight.muted.opacity(0.5)).frame(width: 36, height: 5)
                .frame(maxWidth: .infinity, minHeight: NightFlight.grid(6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(detent == .large ? "收起旅程详情" : "展开旅程详情")
        .accessibilityValue(detent.accessibilityValue)
        .accessibilityIdentifier("atlas.card.grabber")
    }

    private var stats: some View {
        // One row when it fits; accessibility sizes stack the counts instead of truncating.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: NightFlight.grid(3)) { statItems }
            VStack(alignment: .leading, spacing: NightFlight.grid(1)) { statItems }
        }
        .labelStyle(StatLabelStyle())
        .font(.footnote.monospacedDigit())
        .nightFlightMuted()
    }

    @ViewBuilder private var statItems: some View {
        let stops = journey.routePoints.filter(\.isStop).count
        Label("\(journey.routePoints.count)", systemImage: "mappin.and.ellipse").fixedSize()
            .accessibilityLabel("\(journey.routePoints.count) 个路线点")
        Label("\(journey.media.count)", systemImage: "photo.on.rectangle").fixedSize()
            .accessibilityLabel("\(journey.media.count) 个媒体")
        if stops > 0 {
            Label("\(stops)", systemImage: "flag").fixedSize().accessibilityLabel("\(stops) 个停靠")
        }
    }

    // MARK: Medium and large

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: NightFlight.grid(4)) {
            cover
            if !journey.routePoints.isEmpty { routePoints }
            Button { openStory() } label: {
                HStack {
                    Text("打开故事")
                    Spacer()
                    Image(systemName: "arrow.right")
                }
            }
            .buttonStyle(NightFlightPillButtonStyle())
            .accessibilityLabel(point.map { "打开故事：" + $0.label } ?? "打开故事")
            .accessibilityIdentifier("atlas.card.story")
            if detent == .large {
                if !journey.note.isEmpty {
                    Text(journey.note).font(NightFlight.serif(.body)).lineSpacing(5)
                        .foregroundStyle(NightFlight.ink)
                        .accessibilityIdentifier("atlas.card.note")
                }
                JourneyList(router: router, session: session, covers: covers) { move(to: .peek) }
            }
        }
        .padding(.horizontal, NightFlight.cardPadding)
    }

    private var cover: some View {
        Button { openStory() } label: {
            JourneyCoverView(image: covers.image(for: JourneyCoverStore.key(session.mediaJourneys[journey.id])), lightColor: journey.lightColor)
                .frame(maxWidth: .infinity)
                .frame(height: detent == .large ? 220 : 168)
                .clipShape(RoundedRectangle(cornerRadius: NightFlight.radiusSmall, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: NightFlight.radiusSmall, style: .continuous))
                .storyTransitionSource(id: journey.id, in: storyNamespace)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("封面：" + journey.title)
        .accessibilityIdentifier("atlas.card.cover")
    }

    private var routePoints: some View {
        ScrollView(.horizontal) {
            HStack(spacing: NightFlight.grid(2)) {
                ForEach(journey.routePoints) { routePoint in
                    let selected = routePoint.id == pointId
                    Button {
                        router.select(journeyId: journey.id, routePointId: routePoint.id)
                        move(to: .peek)
                    } label: {
                        Label(routePoint.label.isEmpty ? "路线点" : routePoint.label,
                              systemImage: routePoint.isStop ? "mappin" : "point.topleft.down.to.point.bottomright.curvepath")
                            .font(.subheadline)
                            .padding(.horizontal, NightFlight.grid(4))
                            .frame(minHeight: NightFlight.hitTarget)
                            .foregroundStyle(selected ? NightFlight.accent : NightFlight.ink)
                            .overlay(Capsule().strokeBorder(selected ? NightFlight.accent : NightFlight.stroke.opacity(2.5),
                                                            lineWidth: selected ? 1.5 : 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(routePoint.label.isEmpty ? "路线点" : routePoint.label)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("atlas.card.point." + routePoint.id)
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Gestures and actions

    private var drag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                let dx = value.translation.width, dy = value.translation.height
                guard abs(dy) > abs(dx) else { return }
                dragOffset = -dy
            }
            .onEnded { value in
                let dx = value.translation.width, dy = value.translation.height
                withAnimation(NightFlight.motion(NightFlight.snappy, reduceMotion: reduceMotion)) { dragOffset = 0 }
                if detent == .peek, case let step = CardDetent.swipeStep(dx: dx, dy: dy), step != 0 {
                    switchJourney(by: step); return
                }
                guard abs(dy) > abs(dx) else { return }
                move(to: detent.resolve(dy: dy))
            }
    }

    private func move(to next: CardDetent) {
        guard next != detent else { return }
        withAnimation(NightFlight.motion(NightFlight.snappy, reduceMotion: reduceMotion)) { detent = next }
    }

    private func switchJourney(by step: Int) {
        let next = CardDetent.step(index, total: router.journeys.count, by: step)
        guard next != index, router.journeys.indices.contains(next) else { return }
        router.select(journeyId: router.journeys[next].id)
    }

    private func openStory() {
        router.openStory(journeyId: journey.id, routePointId: pointId)
    }

    private var dates: [String] { [journey.startedOn, journey.endedOn].compactMap { $0 }.filter { !$0.isEmpty } }
    private var dateRange: String { dates.joined(separator: " — ") }
}

/// Every Journey, current one marked in gold. Covers load as rows appear.
struct JourneyList: View {
    @ObservedObject var router: AppRouter
    @ObservedObject var session: AtlasSession
    @ObservedObject var covers: JourneyCoverStore
    let onSelect: () -> Void

    var body: some View {
        // Lazy: covers are read only for rows that actually scroll into view.
        LazyVStack(alignment: .leading, spacing: NightFlight.grid(2)) {
            Text("全部旅程").font(.headline).foregroundStyle(NightFlight.ink)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, NightFlight.grid(2))
            ForEach(router.journeys) { journey in
                let current = journey.id == router.focusedJourneyId
                Button {
                    router.select(journeyId: journey.id)
                    onSelect()
                } label: {
                    HStack(spacing: NightFlight.grid(3)) {
                        JourneyCoverView(image: covers.image(for: JourneyCoverStore.key(session.mediaJourneys[journey.id])), lightColor: journey.lightColor)
                            .frame(width: NightFlight.grid(14), height: NightFlight.grid(14))
                            .clipShape(RoundedRectangle(cornerRadius: NightFlight.radiusSmall, style: .continuous))
                        VStack(alignment: .leading, spacing: NightFlight.grid(0.5)) {
                            Text(journey.title).font(.body.weight(.semibold))
                                .foregroundStyle(current ? NightFlight.accent : NightFlight.ink)
                            Text([journey.startedOn, journey.endedOn].compactMap { $0 }.joined(separator: " — "))
                                .font(.footnote.monospacedDigit()).nightFlightMuted()
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(NightFlight.grid(2))
                    .frame(minHeight: NightFlight.hitTarget)
                    .overlay(RoundedRectangle(cornerRadius: NightFlight.radiusSmall, style: .continuous)
                        .strokeBorder(current ? NightFlight.accent.opacity(0.7) : Color.clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("切换到旅程：" + journey.title)
                .accessibilityAddTraits(current ? .isSelected : [])
                .accessibilityIdentifier("atlas.journeys." + journey.id)
                .onAppear { covers.load(journey.id, session: session, access: router.access) }
                .onChange(of: JourneyCoverStore.key(session.mediaJourneys[journey.id])) { _, _ in
                    covers.load(journey.id, session: session, access: router.access)
                }
            }
        }
    }
}

private struct StatLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: NightFlight.grid(1)) { configuration.icon; configuration.title }
    }
}
