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
        .foregroundStyle(StoryTheme.ink).tint(StoryTheme.accent)
        .background(StoryTheme.background.ignoresSafeArea())
        .onAppear { model.appear() }
        .onDisappear { model.disappear() }
        .onChange(of: scenePhase) { phase in if phase != .active { model.setPaused(true) } }
        .onChange(of: storedStyle) { _ in model.cancelPaging() }
        .sheet(isPresented: $toolsPresented) {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 24) {
                        if model.session.access == .owner, let importer { PhotosImportButton(model: importer) }
                        if model.session.access == .owner, let moveModel { MediaMoveView(model: moveModel) }
                        if model.session.access == .owner, let exporter { FilmExportButton(model: exporter) }
                    }.padding(24)
                }.navigationTitle("整理与导出")
                    .toolbar { Button("完成") { toolsPresented = false } }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            StoryIconButton(symbol: "chevron.down", label: "返回", id: "story.close") { model.leave() }
            Spacer(minLength: 8)
            Text(model.journey.title).font(StoryTheme.serif(.headline)).lineLimit(1)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("story.title")
            Spacer(minLength: 8)
            Menu {
                Picker(selection: $storedStyle) {
                    ForEach(StoryPresentationStyle.allCases) { option in
                        Label(option.label, systemImage: option.symbol).tag(option.rawValue)
                    }
                } label: { EmptyView() }.pickerStyle(.inline).labelsHidden()
            } label: {
                Image(systemName: style.symbol).font(.body.weight(.medium)).frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("展示方式").accessibilityValue(style.label).accessibilityIdentifier("story.style")
            StoryIconButton(symbol: model.expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                            label: model.expanded ? "收起" : "全屏", id: "story.expand") {
                if model.expanded { model.collapse() } else { model.expanded = true }
            }
        }.frame(minHeight: 44).padding(.horizontal, 8)
    }

    @ViewBuilder private var content: some View {
        if model.playback != nil {
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
                            .frame(maxWidth: .infinity, alignment: .leading).padding(24)
                    }
                } else {
                    StoryPager(model: model, overlay: style == .noteOverlay)
                        .id("\(model.pageGeneration):\(style.rawValue)")
                }
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 4) {
            if style != .stream || model.playback != nil {
                StoryIconButton(symbol: "chevron.left", label: "上一页", id: "story.previous") { turn(-1) }
            }
            Spacer(minLength: 8)
            if model.playback == nil {
                StoryIconButton(symbol: "play.fill", label: "播放旅程", id: "story.play") { model.playJourney() }
            } else {
                StoryIconButton(symbol: model.paused ? "play.fill" : "pause.fill", label: model.paused ? "继续" : "暂停",
                                id: "story.pause") { model.setPaused(!model.paused) }
                Menu {
                    ForEach(NarrativeTempo.allCases, id: \.self) { tempo in
                        Button(tempo == .fast ? "轻快" : tempo == .standard ? "标准" : "沉浸") { model.changeTempo(tempo) }
                    }
                } label: { Image(systemName: "metronome").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel("节奏").accessibilityIdentifier("story.tempo")
            }
            if model.session.access == .owner && (importer != nil || exporter != nil || moveModel != nil) {
                StoryIconButton(symbol: "slider.horizontal.3", label: "整理与导出", id: "story.tools") {
                    model.setPaused(true); toolsPresented = true
                }
            }
            Spacer(minLength: 8)
            if style != .stream || model.playback != nil {
                StoryIconButton(symbol: "chevron.right", label: "下一页", id: "story.next") { turn(1) }
            }
        }.frame(minHeight: 44).padding(.horizontal, 8).padding(.vertical, 6)
    }

    private func turn(_ direction: Int) {
        guard pagesBook else { model.skip(direction); return }
        withAnimation(reduceMotion ? .easeInOut(duration: 0.25) : nil) { book.turn(direction, animated: !reduceMotion) }
    }
}

/// A quiet icon control; the label is for VoiceOver and UI tests, never drawn.
struct StoryIconButton: View {
    let symbol: String
    let label: String
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.body.weight(.medium)).frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .foregroundStyle(StoryTheme.ink.opacity(0.86))
        .accessibilityLabel(label).accessibilityIdentifier(id)
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
                    if !text.isEmpty { note.padding(.horizontal, 20).padding(.vertical, 12) }
                }
            } else {
                ScrollView {
                    Text(text).font(StoryTheme.serif(.title2)).lineSpacing(8)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(28)
                }
            }
            if current, let failure = model.failure {
                VStack(spacing: 4) {
                    Text(failure).font(.callout).foregroundStyle(StoryTheme.muted)
                    Button("重试") { model.retry() }.frame(minHeight: 44)
                }.padding(.horizontal, 20)
            }
        }.background(StoryTheme.background)
    }

    @ViewBuilder private func media(_ asset: MediaAsset) -> some View {
        if asset.isVideo {
            if current {
                ForegroundVideo(playback: model.foreground, fill: overlay)
                if model.foreground.failure != nil { Button("重试视频") { model.retry() }.frame(minHeight: 44) }
            } else {
                Image(systemName: "play.rectangle").font(.largeTitle).foregroundStyle(StoryTheme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else if let image = model.images[asset.id] {
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

    @ViewBuilder private var note: some View {
        HStack(alignment: .top, spacing: 8) {
            if noteExpanded {
                ScrollView {
                    Text(text).font(StoryTheme.serif(.body)).lineSpacing(5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 240)
            } else {
                Text(text).font(StoryTheme.serif(.body)).lineSpacing(5).lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            expandToggle
        }
    }

    /// 图上感想: the route point note is laid over the picture, like web note-overlay.
    private var overlayNote: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Group {
                if noteExpanded {
                    ScrollView {
                        Text(text).font(StoryTheme.serif(.title3)).lineSpacing(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 260)
                } else {
                    Text(text).font(StoryTheme.serif(.title3)).lineSpacing(6).lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }.shadow(color: .black.opacity(0.6), radius: 6, y: 1)
            expandToggle
        }
        .foregroundStyle(StoryTheme.ink)
        .padding(.horizontal, 20).padding(.top, 48).padding(.bottom, 16)
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
            if let failure = playback.failure { Text(failure).padding(24) }
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
