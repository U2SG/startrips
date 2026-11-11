import SwiftUI

/// Native chrome over the globe-only scene: wordmark and account at the top,
/// the time ribbon and the Journey card at the bottom. It reports the points
/// it covers so the scene keeps the globe clear of the card.
struct AtlasChrome: View {
    @ObservedObject var router: AppRouter
    @ObservedObject var session: AtlasSession
    @ObservedObject var covers: JourneyCoverStore
    let storyNamespace: Namespace.ID
    let onAccount: () -> Void
    @State private var detent: CardDetent = .peek
    @State private var dragOffset: CGFloat = 0
    @State private var peekHeight: CGFloat = 96
    @State private var topBarHeight: CGFloat = NightFlight.hitTarget
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    private var journey: AtlasJourney? {
        router.journeys.first(where: { $0.id == router.focusedJourneyId })
    }
    private var ribbon: TimeRibbonModel { TimeRibbonModel(journeys: router.journeys) }
    @State private var ribbonHeight: CGFloat = NightFlight.hitTarget + NightFlight.grid(3)

    var body: some View {
        GeometryReader { proxy in
            let safe = proxy.safeAreaInsets
            let layout = Layout(screen: proxy.size.height + safe.top + safe.bottom, safeTop: safe.top,
                                safeBottom: safe.bottom, topBar: topBarHeight, peek: peekHeight)
            ZStack(alignment: .top) {
                topBar
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { topBarHeight = $0 }
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    if let journey {
                        JourneyCard(router: router, session: session, covers: covers, journey: journey,
                                    detent: $detent, dragOffset: $dragOffset,
                                    height: layout.cardHeight(detent, drag: dragOffset),
                                    mediumScrolls: layout.medium >= layout.large || typeSize.isAccessibilitySize,
                                    storyNamespace: storyNamespace, onPeekHeight: { peekHeight = $0 })
                            .padding(.horizontal, NightFlight.grid(2))
                        if detent == .peek && !ribbon.isEmpty {
                            TimeRibbon(router: router, model: ribbon)
                                .frame(maxWidth: 560)
                                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { ribbonHeight = $0 }
                                .transition(.opacity)
                        }
                    } else {
                        empty.frame(maxHeight: .infinity)
                    }
                }
            }
            .onAppear { report(layout) }
            .onChange(of: layout) { _, value in report(value) }
            .onChange(of: detent) { _, _ in report(layout) }
            .onChange(of: ribbonHeight) { _, _ in report(layout) }
            .onChange(of: router.journeys.isEmpty) { _, _ in report(layout) }
        }
        .onChange(of: router.scopeId) { _, _ in detent = .peek }
        #if DEBUG
        .task {
            // Screenshot probe only: open the card at a detent without a gesture.
            let arguments = ProcessInfo.processInfo.arguments
            if let flag = arguments.firstIndex(of: "-atlas-card-detent"), arguments.indices.contains(flag + 1) {
                detent = ["medium": .medium, "large": .large][arguments[flag + 1]] ?? .peek
            }
        }
        #endif
    }

    /// Detent heights are measured, so Dynamic Type and landscape keep working.
    struct Layout: Equatable {
        let screen: CGFloat, safeTop: CGFloat, safeBottom: CGFloat, topBar: CGFloat, peek: CGFloat
        var large: CGFloat { max(peek, screen - safeTop - topBar - NightFlight.grid(2) - safeBottom) }
        var medium: CGFloat { min(large, max(peek + 340, screen * 0.5)) }
        func cardHeight(_ detent: CardDetent, drag: CGFloat) -> CGFloat {
            let base: CGFloat = detent == .peek ? peek : detent == .medium ? medium : large
            return min(large, max(peek, base + drag))
        }
    }

    /// Insets are sent only when the layout settles, never per drag frame.
    private func report(_ layout: Layout) {
        // At peek the globe stays full-bleed behind the wordmark. Once the card
        // rises, the focused point must not land under the top bar either.
        let top: CGFloat = detent >= .medium ? layout.safeTop + layout.topBar : 0
        var bottom: CGFloat = 0
        if journey != nil {
            bottom = layout.safeBottom + layout.cardHeight(detent, drag: 0) + (detent == .peek && !ribbon.isEmpty ? ribbonHeight : 0)
        }
        // Keep at least a strip of globe for the large detent.
        bottom = min(bottom, max(0, layout.screen - layout.safeTop - layout.topBar - 120))
        let insets = SceneInsets(top: Double(top.rounded()), bottom: Double(bottom.rounded()))
        if router.presentation.insets != insets { router.presentation.insets = insets }
    }

    private var topBar: some View {
        HStack {
            Text("startrips")
                .font(NightFlight.serif(.title2))
                .foregroundStyle(NightFlight.ink)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("atlas.wordmark")
            Spacer()
            Button(action: onAccount) {
                Image(systemName: router.access == .guest ? "person.2" : "person.crop.circle")
                    .font(.body.weight(.medium))
                    .foregroundStyle(NightFlight.ink)
                    .frame(width: NightFlight.hitTarget, height: NightFlight.hitTarget)
                    .nightFlightSurface(Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("设置")
            .accessibilityIdentifier("atlas.account")
        }
        .padding(.horizontal, NightFlight.grid(4))
        .padding(.vertical, NightFlight.grid(1))
        .background(alignment: .top) {
            LinearGradient(colors: [NightFlight.background.opacity(0.75), .clear], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        }
    }

    private var empty: some View {
        Text("图谱里还没有旅程")
            .font(NightFlight.serif(.title2))
            .foregroundStyle(NightFlight.ink)
            .multilineTextAlignment(.center)
            .padding(.horizontal, NightFlight.grid(6))
            .accessibilityIdentifier("atlas.empty")
    }
}

extension View {
    /// Story zooms out of the Journey cover (iOS 18+); iOS 17 keeps the push.
    @ViewBuilder
    func storyZoomTransition(id: String, in namespace: Namespace.ID) -> some View {
        if #available(iOS 18.0, *) { navigationTransition(.zoom(sourceID: id, in: namespace)) } else { self }
    }

    /// The Journey cover is the source of the zoom into Story (iOS 18+).
    @ViewBuilder
    func storyTransitionSource(id: String, in namespace: Namespace.ID) -> some View {
        if #available(iOS 18.0, *) { matchedTransitionSource(id: id, in: namespace) } else { self }
    }
}
