import AVFoundation
import SwiftUI
import UIKit

/// Mounted by FeatureDestinations.story; it owns media presentation, never navigation.
public struct NativeStoryDestination: View {
    @ObservedObject private var model: StoryModel
    private let importer: PhotosImportModel?
    private let exporter: FilmExportModel?
    private let moveModel: MediaMoveModel?
    @State private var toolsPresented = false
    @StateObject private var book = StoryBookState()
    @AppStorage(StoryPresentationStyle.defaultsKey) private var storedStyle = StoryPresentationStyle.classic.rawValue
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(model: StoryModel, importer: PhotosImportModel? = nil, exporter: FilmExportModel? = nil, moveModel: MediaMoveModel? = nil) {
        self.model = model; self.importer = importer; self.exporter = exporter; self.moveModel = moveModel
    }
    private var style: StoryPresentationStyle { StoryPresentationStyle(stored: storedStyle) }
    private var pagesBook: Bool { model.playback == nil && style == .book }
    public var body: some View {
        VStack(spacing: 0) {
            header
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            // Each StoryPage already owns its caption/notes. A second,
            // collapsed-mode text panel repeats the same reflection.
            controls
        }
        .foregroundStyle(StoryTheme.ink).tint(StoryTheme.ink)
        .background(StoryTheme.background.ignoresSafeArea())
        .onAppear {
            model.appear()
            #if DEBUG
            // Screenshot probe only: start playback without a tap.
            let arguments = ProcessInfo.processInfo.arguments
            if let flag = arguments.firstIndex(of: "-story-tempo"), arguments.indices.contains(flag + 1),
               let tempo = NarrativeTempo(rawValue: arguments[flag + 1]) { model.changeTempo(tempo) }
            if arguments.contains("-story-autoplay") { model.playJourney() }
            // "15:fast,30:immersive": the tempo menu's own action at those seconds.
            if let flag = arguments.firstIndex(of: "-story-tempo-at"), arguments.indices.contains(flag + 1) {
                for step in arguments[flag + 1].split(separator: ",") {
                    let parts = step.split(separator: ":")
                    guard parts.count == 2, let seconds = Double(parts[0]), let tempo = NarrativeTempo(rawValue: String(parts[1])) else { continue }
                    Task { @MainActor [model] in
                        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                        model.changeTempo(tempo)
                    }
                }
            }
            #endif
        }
        .onDisappear { model.disappear() }
        .onChange(of: scenePhase) { phase in if phase != .active { model.setPaused(true) } }
        .onChange(of: storedStyle) { _ in model.cancelPaging() }
        .sheet(isPresented: $toolsPresented) {
            NavigationStack {
                ScrollView {
                    VStack(spacing: StoryTheme.grid(6)) {
                        if model.session.access == .owner, let importer { PhotosImportButton(model: importer) }
                        if model.session.access == .owner, let moveModel { MediaMoveView(model: moveModel) }
                        if model.session.access == .owner, let exporter { FilmExportButton(model: exporter) }
                    }.padding(StoryTheme.grid(6))
                }.navigationTitle("整理与导出")
                    .toolbar { Button("完成") { toolsPresented = false } }
            }
        }
    }

    /// Equal leading and trailing slots (two 44pt icons each) keep the title on the screen axis.
    private var header: some View {
        HStack(spacing: 0) {
            HStack(spacing: 0) {
                StoryIconButton(symbol: "chevron.down", label: "返回", id: "story.close") { model.leave() }
                Spacer(minLength: 0)
            }.frame(width: StoryTheme.hitTarget * 2)
            Text(model.journey.title).font(StoryTheme.serif(.headline)).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("story.title")
            HStack(spacing: 0) {
                Menu {
                Picker(selection: $storedStyle) {
                    ForEach(StoryPresentationStyle.allCases) { option in
                        Label(option.label, systemImage: option.symbol).tag(option.rawValue)
                    }
                } label: { EmptyView() }.pickerStyle(.inline).labelsHidden()
            } label: {
                Image(systemName: style.symbol).font(.body.weight(.medium))
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .frame(width: StoryTheme.hitTarget, height: StoryTheme.hitTarget).contentShape(Rectangle())
            }
            .accessibilityLabel("展示方式").accessibilityValue(style.label).accessibilityIdentifier("story.style")
            StoryIconButton(symbol: model.expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                            label: model.expanded ? "收起" : "全屏", id: "story.expand") {
                if model.expanded { model.collapse() } else { model.expanded = true }
            }
            }.frame(width: StoryTheme.hitTarget * 2)
        }.frame(minHeight: StoryTheme.hitTarget).padding(.horizontal, StoryTheme.slotInset)
    }

    @ViewBuilder private var content: some View {
        // 旅程之流 plays as one continuous flow inside the stream itself, never page by page.
        if model.playback != nil && style != .stream {
            StoryPage(model: model, entry: nil, overlay: style == .noteOverlay).id(model.playback?.current?.id)
        } else {
            switch style {
            case .book:
                StoryBook(model: model, state: book, reduceMotion: reduceMotion).id(model.pageGeneration)
            case .stream:
                StoryStream(model: model)
            case .classic, .noteOverlay:
                if model.cursor.entries.isEmpty {
                    ScrollView {
                        Text(model.journey.note).font(StoryTheme.serif(.title3)).lineSpacing(6)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(StoryTheme.pageInset)
                    }
                } else {
                    StoryPager(model: model, overlay: style == .noteOverlay)
                        .id("\(model.pageGeneration):\(style.rawValue)")
                }
            }
        }
    }

    /// Five equal slots: previous, an auxiliary, play, an auxiliary, next. Empty
    /// slots keep their width, so play always sits on the screen axis.
    private var controls: some View {
        let pages = style != .stream || model.playback != nil
        let tools = model.session.access == .owner && (importer != nil || exporter != nil || moveModel != nil)
        return HStack(spacing: 0) {
            slot {
                if pages { StoryIconButton(symbol: "chevron.left", label: "上一页", id: "story.previous", acting: { turn(-1) }) }
            }
            slot {
                // Tempo can be chosen before playback too; a checkmarked single choice, slow to fast.
                Menu {
                    Picker(selection: Binding(get: { model.tempo }, set: { model.changeTempo($0) })) {
                        ForEach(NarrativeTempo.slowToFast, id: \.self) { tempo in
                            Label(tempo.label, systemImage: tempo.symbol).tag(tempo)
                        }
                    } label: { EmptyView() }.pickerStyle(.inline).labelsHidden()
                } label: {
                    Label("节奏", systemImage: "metronome").labelStyle(.iconOnly)
                        .font(.body.weight(.medium)).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                        .frame(width: StoryTheme.hitTarget, height: StoryTheme.hitTarget)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(StoryTheme.ink.opacity(0.86))
                .accessibilityLabel("节奏").accessibilityValue(model.tempo.label).accessibilityIdentifier("story.tempo")
            }
            slot {
                // One view for play and pause, so the tap haptic survives the swap from play to pause.
                let idle = model.playback == nil
                StoryIconButton(symbol: idle || model.paused ? "play.fill" : "pause.fill",
                                label: idle ? "播放旅程" : model.paused ? "继续" : "暂停",
                                id: idle ? "story.play" : "story.pause") {
                    if idle { model.playJourney() } else { model.setPaused(!model.paused) }
                }
            }
            slot {
                if tools {
                    StoryIconButton(symbol: "slider.horizontal.3", label: "整理与导出", id: "story.tools") {
                        model.setPaused(true); toolsPresented = true
                    }
                }
            }
            slot {
                if pages { StoryIconButton(symbol: "chevron.right", label: "下一页", id: "story.next", acting: { turn(1) }) }
            }
        }
        .frame(minHeight: StoryTheme.hitTarget)
        .padding(.horizontal, StoryTheme.slotInset).padding(.vertical, StoryTheme.grid(1))
    }

    private func slot<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        // A clear base keeps an empty slot's width; `EmptyView` alone would collapse.
        Color.clear.frame(maxWidth: .infinity, minHeight: StoryTheme.hitTarget, maxHeight: StoryTheme.hitTarget)
            .overlay { content() }
    }

    /// Turns one page; false when there is nowhere to go, so the tap stays silent.
    private func turn(_ direction: Int) -> Bool {
        guard pagesBook else {
            let before = (model.cursor.index, model.playback?.index)
            model.skip(direction)
            return before != (model.cursor.index, model.playback?.index)
        }
        let before = book.index
        withAnimation(reduceMotion ? .easeInOut(duration: 0.25) : nil) { book.turn(direction, animated: !reduceMotion) }
        return book.index != before
    }
}

/// A quiet icon control; the label is for VoiceOver and UI tests, never drawn.
struct StoryIconButton: View {
    let symbol: String
    let label: String
    let id: String
    /// Runs the tap; returns whether anything happened (a no-op gets no haptic).
    let acting: () -> Bool
    @State private var taps = 0
    @_disfavoredOverload init(symbol: String, label: String, id: String, acting: @escaping () -> Bool) {
        self.symbol = symbol; self.label = label; self.id = id; self.acting = acting
    }
    init(symbol: String, label: String, id: String, action: @escaping () -> Void) {
        self.init(symbol: symbol, label: label, id: id, acting: { action(); return true })
    }
    var body: some View {
        Button {
            if acting() { taps += 1 }
        } label: {
            // An icon-only Label: VoiceOver and Dynamic Type treat it like a system control.
            Label(label, systemImage: symbol).labelStyle(.iconOnly).font(.body.weight(.medium))
                // Glyphs stop growing at the largest standard size so they stay inside their slot.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .frame(width: StoryTheme.hitTarget, height: StoryTheme.hitTarget)
                .contentShape(Rectangle())
        }
        .foregroundStyle(StoryTheme.ink.opacity(0.86))
        .accessibilityLabel(label).accessibilityIdentifier(id)
        .tapHaptic(taps)
    }
}

private extension View {
    /// A light system haptic for a user tap only (never for auto-advance or per frame).
    @ViewBuilder func tapHaptic(_ trigger: Int) -> some View {
        if #available(iOS 17.0, *) { sensoryFeedback(.impact(weight: .light), trigger: trigger) } else { self }
    }
}

private struct StoryPage: View {
    @ObservedObject var model: StoryModel
    let entry: StoryEntry?
    var overlay = false
    @State private var noteExpanded = false
    var asset: MediaAsset? { if let entry { return entry.asset }; return model.activeAsset }
    var text: String { entry?.note ?? model.activeText }
    var current: Bool { entry == nil || entry?.id == model.cursor.current?.id }
    var body: some View {
        VStack(spacing: 0) {
            if let asset {
                if overlay {
                    ZStack(alignment: .bottom) {
                        media(asset).frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                        if !text.isEmpty { overlayNote }
                    }
                } else {
                    media(asset)
                    if !text.isEmpty { note.padding(.vertical, StoryTheme.grid(3)) }
                }
            } else {
                ScrollView {
                    Text(text).font(StoryTheme.serif(.title2)).lineSpacing(8)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(StoryTheme.pageInset)
                }
            }
            if current, let failure = model.failure {
                VStack(spacing: 4) {
                    Text(failure).font(.callout).foregroundStyle(StoryTheme.muted)
                    Button("重试") { model.retry() }.frame(minHeight: StoryTheme.hitTarget)
                }.padding(.horizontal, StoryTheme.edge)
            }
        }.background(StoryTheme.background)
    }

    @ViewBuilder private func media(_ asset: MediaAsset) -> some View {
        if asset.isVideo {
            if current {
                ForegroundVideo(playback: model.foreground, fill: overlay)
                if model.foreground.failure != nil { Button("重试视频") { model.retry() }.frame(minHeight: StoryTheme.hitTarget) }
            } else {
                Image(systemName: "play.rectangle").font(.largeTitle).foregroundStyle(StoryTheme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else if let image = model.image(for: asset.id) {
            ZoomPhoto(image: image, entryID: entry?.id ?? "media:\(asset.id)",
                      label: asset.fileName, current: current, onPullDown: { model.leave() }, fill: overlay)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var expandToggle: some View {
        StoryIconButton(symbol: noteExpanded ? "chevron.down" : "chevron.up",
                        label: noteExpanded ? "收起感想" : "阅读感想", id: "story.note.toggle") {
            withAnimation(.easeInOut(duration: 0.2)) { noteExpanded.toggle() }
        }
    }

    /// Text starts at `edge`; the chevron's 44pt slot ends at `slotInset`, so its
    /// glyph lines up with the header and control icons, centred on the caption.
    @ViewBuilder private var note: some View {
        HStack(alignment: .center, spacing: 0) {
            Group {
                if noteExpanded {
                    ScrollView {
                        Text(text).font(StoryTheme.serif(.body)).lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: StoryTheme.grid(60))
                } else {
                    Text(text).font(StoryTheme.serif(.body)).lineSpacing(5).lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.leading, StoryTheme.edge - StoryTheme.slotInset)
            expandToggle
        }
        .padding(.horizontal, StoryTheme.slotInset)
    }

    /// 图上感想: the route point note is laid over the picture, like web note-overlay.
    private var overlayNote: some View {
        HStack(alignment: .center, spacing: 0) {
            Group {
                if noteExpanded {
                    ScrollView {
                        Text(text).font(StoryTheme.serif(.title3)).lineSpacing(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: StoryTheme.grid(65))
                } else {
                    Text(text).font(StoryTheme.serif(.title3)).lineSpacing(6).lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }.shadow(color: .black.opacity(0.6), radius: 6, y: 1)
            .padding(.leading, StoryTheme.edge - StoryTheme.slotInset)
            expandToggle
        }
        .foregroundStyle(StoryTheme.ink)
        .padding(.horizontal, StoryTheme.slotInset).padding(.top, StoryTheme.grid(12)).padding(.bottom, StoryTheme.edge)
        .background(LinearGradient(colors: [.clear, StoryTheme.background.opacity(0.88)], startPoint: .top, endPoint: .bottom)
            .allowsHitTesting(false))
        .accessibilityElement(children: .contain).accessibilityIdentifier("story.overlay")
    }
}

struct ForegroundVideo: View {
    @ObservedObject var playback: ForegroundPlayback
    var fill = false
    var body: some View {
        ZStack {
            PlayerSurface(player: playback.player, fill: fill)
            if !playback.ready && playback.failure == nil { ProgressView() }
            if let failure = playback.failure { Text(failure).padding(StoryTheme.grid(6)) }
        }
    }
}

private final class PlayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
}
private struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer?
    var fill = false
    func makeUIView(context: Context) -> PlayerUIView { PlayerUIView() }
    func updateUIView(_ view: PlayerUIView, context: Context) {
        let layer = view.layer as! AVPlayerLayer
        layer.videoGravity = fill ? .resizeAspectFill : .resizeAspect; layer.player = player
    }
    static func dismantleUIView(_ view: PlayerUIView, coordinator: ()) { (view.layer as! AVPlayerLayer).player = nil }
}

struct StoryPager: UIViewControllerRepresentable {
    @ObservedObject var model: StoryModel
    var overlay = false
    func makeCoordinator() -> Coordinator { Coordinator(model: model, overlay: overlay) }
    func makeUIViewController(context: Context) -> UIPageViewController {
        let controller = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
        controller.view.backgroundColor = .clear
        controller.dataSource = context.coordinator; controller.delegate = context.coordinator
        if let page = context.coordinator.page(model.cursor.index) { controller.setViewControllers([page], direction: .forward, animated: false) }
        return controller
    }
    func updateUIViewController(_ controller: UIPageViewController, context: Context) {
        guard context.coordinator.pending == nil,
              (controller.viewControllers?.first as? IndexedPage)?.index != model.cursor.index,
              let page = context.coordinator.page(model.cursor.index) else { return }
        controller.setViewControllers([page], direction: .forward, animated: false)
    }
    final class IndexedPage: UIHostingController<AnyView> {
        let index: Int
        init(index: Int, rootView: AnyView) { self.index = index; super.init(rootView: rootView) }
        @MainActor required dynamic init?(coder aDecoder: NSCoder) { fatalError("Use init(index:rootView:)") }
    }
    @MainActor final class Coordinator: NSObject, UIPageViewControllerDataSource, UIPageViewControllerDelegate {
        let model: StoryModel
        var pending: Int?
        private let generation: Int
        private let overlay: Bool
        init(model: StoryModel, overlay: Bool = false) { self.model = model; self.overlay = overlay; generation = model.pageGeneration }
        func page(_ index: Int) -> IndexedPage? {
            guard generation == model.pageGeneration, model.cursor.entries.indices.contains(index) else { return nil }
            return IndexedPage(index: index, rootView: AnyView(StoryPage(model: model, entry: model.cursor.entries[index], overlay: overlay)))
        }
        func pageViewController(_ controller: UIPageViewController, viewControllerBefore viewController: UIViewController) -> UIViewController? {
            page((viewController as! IndexedPage).index - 1)
        }
        func pageViewController(_ controller: UIPageViewController, viewControllerAfter viewController: UIViewController) -> UIViewController? {
            page((viewController as! IndexedPage).index + 1)
        }
        func pageViewController(_ controller: UIPageViewController, willTransitionTo pendingViewControllers: [UIViewController]) {
            guard generation == model.pageGeneration, let next = pendingViewControllers.first as? IndexedPage else { return }
            pending = model.beginPaging(next.index)
        }
        func pageViewController(_ controller: UIPageViewController, didFinishAnimating finished: Bool,
                                previousViewControllers: [UIViewController], transitionCompleted completed: Bool) {
            defer { pending = nil }
            guard generation == model.pageGeneration, let pending else { return }
            model.finishPaging(pending, completed: completed)
        }
    }
}

private struct ZoomPhoto: UIViewRepresentable {
    let image: UIImage
    let entryID: String
    let label: String
    let current: Bool
    let onPullDown: () -> Void
    /// 图上感想 fills the page so the note lies on the picture, not on letterboxing.
    var fill = false
    func makeCoordinator() -> Coordinator { Coordinator(onPullDown: onPullDown) }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = PhotoScrollView()
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 5
        scroll.delegate = context.coordinator; scroll.alwaysBounceVertical = true
        scroll.addSubview(context.coordinator.imageView)
        context.coordinator.imageView.contentMode = fill ? .scaleAspectFill : .scaleAspectFit
        context.coordinator.imageView.clipsToBounds = true; scroll.clipsToBounds = true
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2; scroll.addGestureRecognizer(doubleTap)
        return scroll
    }
    func updateUIView(_ view: UIScrollView, context: Context) {
        view.isAccessibilityElement = current
        view.accessibilityElementsHidden = !current
        view.accessibilityIdentifier = current ? "story.photo.\(entryID)" : nil
        view.accessibilityLabel = label
        view.accessibilityTraits = .image
        context.coordinator.imageView.image = image
        if view.zoomScale == 1 {
            context.coordinator.imageView.frame = view.bounds
            context.coordinator.imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.contentSize = view.bounds.size
        }
    }
    private final class PhotoScrollView: UIScrollView {
        override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            if gestureRecognizer === panGestureRecognizer && zoomScale <= minimumZoomScale + 0.01 {
                let velocity = panGestureRecognizer.velocity(in: self)
                if abs(velocity.x) > abs(velocity.y) { return false }
            }
            return super.gestureRecognizerShouldBegin(gestureRecognizer)
        }
    }
    @MainActor final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()
        let onPullDown: () -> Void
        init(onPullDown: @escaping () -> Void) { self.onPullDown = onPullDown }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if scrollView.zoomScale <= 1.01 && scrollView.contentOffset.y < -80 { onPullDown() }
        }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            scroll.setZoomScale(scroll.zoomScale > 1 ? 1 : 2.5, animated: true)
        }
    }
}

extension NarrativeTempo {
    /// Menu order, slowest first.
    static let slowToFast: [NarrativeTempo] = [.immersive, .standard, .fast]
    var label: String {
        switch self {
        case .immersive: return "沉浸"
        case .standard: return "标准"
        case .fast: return "轻快"
        }
    }
    var symbol: String {
        switch self {
        case .immersive: return "tortoise"
        case .standard: return "figure.walk"
        case .fast: return "hare"
        }
    }
}
