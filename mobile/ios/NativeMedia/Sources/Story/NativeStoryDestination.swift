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
    @Environment(\.scenePhase) private var scenePhase
    public init(model: StoryModel, importer: PhotosImportModel? = nil, exporter: FilmExportModel? = nil, moveModel: MediaMoveModel? = nil) {
        self.model = model; self.importer = importer; self.exporter = exporter; self.moveModel = moveModel
    }
    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.leave() } label: { Image(systemName: "chevron.down").frame(width: 44, height: 44) }.accessibilityLabel("返回").accessibilityIdentifier("story.close")
                Spacer()
                Text(model.journey.title).font(.headline).lineLimit(1)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("story.title")
                Spacer()
                Button { if model.expanded { model.collapse() } else { model.expanded = true } } label: {
                    Image(systemName: model.expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44)
                }.accessibilityLabel(model.expanded ? "收起" : "全屏").accessibilityIdentifier("story.expand")
            }.frame(minHeight: 44).padding(.horizontal, 16)
            if model.playback != nil {
                StoryPage(model: model, entry: nil).id(model.playback?.current?.id)
            } else if model.cursor.entries.isEmpty {
                ScrollView { Text(model.journey.note).font(.title3).padding(24) }
            } else {
                StoryPager(model: model)
                    .accessibilityIdentifier("story.pager")
            }
            if !model.expanded {
                ScrollView { Text(model.activeText).frame(maxWidth: .infinity, alignment: .leading).padding(24) }
                    .frame(maxHeight: 220)
            }
            HStack {
                Button("上一项") { model.skip(-1) }.accessibilityIdentifier("story.previous")
                Spacer()
                if model.playback == nil {
                    Button { model.playJourney() } label: { Image(systemName: "play.fill").frame(width: 44, height: 44) }.accessibilityLabel("播放旅程").accessibilityIdentifier("story.play")
                } else {
                    Button(model.paused ? "继续" : "暂停") { model.setPaused(!model.paused) }.accessibilityIdentifier("story.pause")
                    Menu("节奏") {
                        ForEach(NarrativeTempo.allCases, id: \.self) { tempo in
                            Button(tempo == .fast ? "轻快" : tempo == .standard ? "标准" : "沉浸") { model.changeTempo(tempo) }
                        }
                    }
                }
                Spacer()
                Button("下一项") { model.skip(1) }.accessibilityIdentifier("story.next")
            }.frame(minHeight: 44).padding(16)
            if model.session.access == .owner && (importer != nil || exporter != nil || moveModel != nil) {
                Button("素材与影片") { model.setPaused(true); toolsPresented = true }.frame(minHeight: 44)
            }
        }
        .foregroundStyle(Color(white: 0.98)).background(Color(white: 0.04))
        .onAppear { model.appear() }
        .onDisappear { model.disappear() }
        .onChange(of: scenePhase) { phase in if phase != .active { model.setPaused(true) } }
        .sheet(isPresented: $toolsPresented) {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 24) {
                        if model.session.access == .owner, let importer { PhotosImportButton(model: importer) }
                        if model.session.access == .owner, let moveModel { MediaMoveView(model: moveModel) }
                        if model.session.access == .owner, let exporter { FilmExportButton(model: exporter) }
                    }.padding(24)
                }.navigationTitle("素材与影片")
                    .toolbar { Button("完成") { toolsPresented = false } }
            }
        }
    }
}

private struct StoryPage: View {
    @ObservedObject var model: StoryModel
    let entry: StoryEntry?
    @State private var noteExpanded = false
    var asset: MediaAsset? { if let entry { return entry.asset }; return model.activeAsset }
    var text: String { entry?.note ?? model.activeText }
    var current: Bool { entry == nil || entry?.id == model.cursor.current?.id }
    var body: some View {
        VStack(spacing: 8) {
            if let asset {
                if asset.isVideo {
                    if current {
                        ForegroundVideo(playback: model.foreground)
                        if model.foreground.failure != nil { Button("重试视频") { model.retry() }.frame(minHeight: 44) }
                    }
                    else { Image(systemName: "play.rectangle").font(.largeTitle).frame(maxWidth: .infinity, maxHeight: .infinity) }
                } else if let image = model.images[asset.id] {
                    ZoomPhoto(image: image, onPullDown: { model.leave() })
                        .accessibilityIdentifier("story.photo.\(asset.id)")
                } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
                if !text.isEmpty {
                    if noteExpanded {
                        ScrollView { Text(text).font(.body).frame(maxWidth: .infinity, alignment: .leading).padding(16) }
                            .frame(maxHeight: 240)
                    } else { Text(text).font(.body).lineLimit(3).padding(.horizontal, 16) }
                    Button(noteExpanded ? "收起感想" : "阅读感想") { noteExpanded.toggle() }.frame(minHeight: 44)
                }
            } else {
                ScrollView { Text(text).font(.title2).lineSpacing(8).frame(maxWidth: .infinity, alignment: .leading).padding(24) }
            }
            if current, let failure = model.failure {
                Text(failure).font(.callout)
                Button("重试") { model.retry() }.frame(minHeight: 44)
            }
        }.background(Color(white: 0.04))
    }
}

private struct ForegroundVideo: View {
    @ObservedObject var playback: ForegroundPlayback
    var body: some View {
        ZStack {
            PlayerSurface(player: playback.player)
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
    func makeUIView(context: Context) -> PlayerUIView { PlayerUIView() }
    func updateUIView(_ view: PlayerUIView, context: Context) {
        let layer = view.layer as! AVPlayerLayer
        layer.videoGravity = .resizeAspect; layer.player = player
    }
    static func dismantleUIView(_ view: PlayerUIView, coordinator: ()) { (view.layer as! AVPlayerLayer).player = nil }
}

private struct StoryPager: UIViewControllerRepresentable {
    @ObservedObject var model: StoryModel
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIViewController(context: Context) -> UIPageViewController {
        let controller = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
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
        init(model: StoryModel) { self.model = model }
        func page(_ index: Int) -> IndexedPage? {
            guard model.cursor.entries.indices.contains(index) else { return nil }
            return IndexedPage(index: index, rootView: AnyView(StoryPage(model: model, entry: model.cursor.entries[index])))
        }
        func pageViewController(_ controller: UIPageViewController, viewControllerBefore viewController: UIViewController) -> UIViewController? {
            page((viewController as! IndexedPage).index - 1)
        }
        func pageViewController(_ controller: UIPageViewController, viewControllerAfter viewController: UIViewController) -> UIViewController? {
            page((viewController as! IndexedPage).index + 1)
        }
        func pageViewController(_ controller: UIPageViewController, willTransitionTo pendingViewControllers: [UIViewController]) {
            if let next = pendingViewControllers.first as? IndexedPage { pending = model.beginPaging(next.index) }
        }
        func pageViewController(_ controller: UIPageViewController, didFinishAnimating finished: Bool,
                                previousViewControllers: [UIViewController], transitionCompleted completed: Bool) {
            if let pending { model.finishPaging(pending, completed: completed) }
            pending = nil
        }
    }
}

private struct ZoomPhoto: UIViewRepresentable {
    let image: UIImage
    let onPullDown: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onPullDown: onPullDown) }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 5
        scroll.delegate = context.coordinator; scroll.alwaysBounceVertical = true
        scroll.addSubview(context.coordinator.imageView)
        context.coordinator.imageView.contentMode = .scaleAspectFit
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2; scroll.addGestureRecognizer(doubleTap)
        return scroll
    }
    func updateUIView(_ view: UIScrollView, context: Context) {
        context.coordinator.imageView.image = image
        if view.zoomScale == 1 {
            context.coordinator.imageView.frame = view.bounds
            context.coordinator.imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.contentSize = view.bounds.size
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
