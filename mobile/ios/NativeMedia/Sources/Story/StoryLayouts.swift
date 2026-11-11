import SwiftUI
import UIKit

// MARK: - 旅程之书

/// The open page of the native Journey Book; the header/footer controls turn it too.
@MainActor final class StoryBookState: ObservableObject {
    @Published private(set) var index = 0
    @Published private(set) var animated = false
    private(set) var count = 0
    func reset(_ index: Int, count: Int) { self.count = count; animated = false; self.index = max(0, min(index, count - 1)) }
    func turn(_ delta: Int, animated: Bool) {
        let next = index + delta
        guard next >= 0, next < count else { return }
        self.animated = animated; index = next
    }
    func settle(_ index: Int) { animated = false; if self.index != index { self.index = index } }
}

struct StoryBook: View {
    @ObservedObject var model: StoryModel
    @ObservedObject var state: StoryBookState
    let reduceMotion: Bool
    @State private var pages: [StoryBookPage] = []

    var body: some View {
        GeometryReader { proxy in
            let size = Self.pageSize(in: proxy.size)
            ZStack {
                if pages.indices.contains(state.index) {
                    if reduceMotion {
                        // Reduced Motion: no curl, the page crossfades in place.
                        StoryBookPageView(model: model, page: pages[state.index], number: state.index, count: pages.count)
                            .id(pages[state.index].id)
                            .transition(.opacity)
                            .gesture(DragGesture(minimumDistance: 24).onEnded { value in
                                let delta = value.translation.width < -40 ? 1 : value.translation.width > 40 ? -1 : 0
                                guard delta != 0 else { return }
                                withAnimation(.easeInOut(duration: 0.25)) { state.turn(delta, animated: false) }
                            })
                    } else {
                        StoryBookCurl(model: model, state: state, pages: pages)
                    }
                }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .shadow(color: .black.opacity(0.5), radius: 18, y: 8)
            .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .accessibilityElement(children: .contain).accessibilityIdentifier("story.book")
        .onAppear(perform: open)
        .onChange(of: state.index) { index in follow(index) }
    }

    /// Single pages at the reference 512 × 640 ratio (`BOOK_PAGE_RATIO`), fitted to the space.
    static func pageSize(in space: CGSize) -> CGSize {
        let ratio: CGFloat = 0.8
        let height = min(space.height, space.width / ratio)
        return CGSize(width: max(0, floor(height * ratio)), height: max(0, floor(height)))
    }

    private func open() {
        pages = model.journey.bookPages()
        let current = model.cursor.current
        let asset = current?.role == .journeyCover ? nil : current?.asset?.id
        state.reset(storyBookStartPage(pages, assetID: asset, routePointID: current?.routePointId), count: pages.count)
    }

    /// The open page is the Story position, so closing the book returns to it on the globe.
    private func follow(_ index: Int) {
        guard pages.indices.contains(index) else { return }
        let entries = model.cursor.entries
        let target: Int?
        switch pages[index] {
        case .cover: target = entries.first?.role == .journeyCover ? 0 : nil
        case .media(let asset, _, _): target = entries.firstIndex { $0.role != .journeyCover && $0.asset?.id == asset.id }
        case .note(let point, _): target = point.flatMap { point in entries.firstIndex { $0.routePointId == point.id } }
        case .blank, .end: target = nil
        }
        if let target, target != model.cursor.index { model.select(target) }
    }
}

private struct StoryBookCurl: UIViewControllerRepresentable {
    @ObservedObject var model: StoryModel
    @ObservedObject var state: StoryBookState
    let pages: [StoryBookPage]
    func makeCoordinator() -> Coordinator { Coordinator(model: model, state: state, pages: pages) }
    func makeUIViewController(context: Context) -> UIPageViewController {
        // One page with the spine on the left: a two-page spread needs double-sided
        // view controller pairs, which the native book does not use.
        let controller = UIPageViewController(transitionStyle: .pageCurl, navigationOrientation: .horizontal,
            options: [.spineLocation: NSNumber(value: UIPageViewController.SpineLocation.min.rawValue)])
        controller.isDoubleSided = false
        controller.dataSource = context.coordinator; controller.delegate = context.coordinator
        if let page = context.coordinator.page(state.index) { controller.setViewControllers([page], direction: .forward, animated: false) }
        return controller
    }
    func updateUIViewController(_ controller: UIPageViewController, context: Context) {
        let coordinator = context.coordinator
        coordinator.pages = pages
        guard !coordinator.transitioning,
              let shown = (controller.viewControllers?.first as? StoryPager.IndexedPage)?.index, shown != state.index,
              let page = coordinator.page(state.index) else { return }
        coordinator.transitioning = state.animated
        controller.setViewControllers([page], direction: state.index > shown ? .forward : .reverse, animated: state.animated) { _ in
            coordinator.transitioning = false
        }
    }
    @MainActor final class Coordinator: NSObject, UIPageViewControllerDataSource, UIPageViewControllerDelegate {
        let model: StoryModel
        let state: StoryBookState
        var pages: [StoryBookPage]
        var transitioning = false
        init(model: StoryModel, state: StoryBookState, pages: [StoryBookPage]) { self.model = model; self.state = state; self.pages = pages }
        func page(_ index: Int) -> StoryPager.IndexedPage? {
            guard pages.indices.contains(index) else { return nil }
            let page = StoryPager.IndexedPage(index: index, rootView: AnyView(
                StoryBookPageView(model: model, page: pages[index], number: index, count: pages.count)))
            page.view.backgroundColor = UIColor(StoryTheme.paper)
            return page
        }
        func pageViewController(_ controller: UIPageViewController, viewControllerBefore viewController: UIViewController) -> UIViewController? {
            page((viewController as! StoryPager.IndexedPage).index - 1)
        }
        func pageViewController(_ controller: UIPageViewController, viewControllerAfter viewController: UIViewController) -> UIViewController? {
            page((viewController as! StoryPager.IndexedPage).index + 1)
        }
        func pageViewController(_ controller: UIPageViewController, willTransitionTo pendingViewControllers: [UIViewController]) {
            transitioning = true; model.foreground.setPaused(true)
        }
        func pageViewController(_ controller: UIPageViewController, didFinishAnimating finished: Bool,
                                previousViewControllers: [UIViewController], transitionCompleted completed: Bool) {
            transitioning = false
            guard let shown = (controller.viewControllers?.first as? StoryPager.IndexedPage)?.index else { return }
            if completed { state.settle(shown) } else { model.foreground.setPaused(model.paused) }
        }
    }
}

private struct StoryBookPageView: View {
    @ObservedObject var model: StoryModel
    let page: StoryBookPage
    let number: Int
    let count: Int

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("story.book.\(page.id)")
            .accessibilityLabel("第 \(number + 1) 页，共 \(count) 页")
    }

    @ViewBuilder private var content: some View {
        switch page {
        case .cover(let asset):
            ZStack(alignment: .bottomLeading) {
                if let asset, !asset.isVideo { picture(asset, fill: true) }
                else { starry }
                LinearGradient(colors: [.clear, StoryTheme.night.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                Text(model.journey.title).font(StoryTheme.serif(.largeTitle)).foregroundStyle(StoryTheme.coverInk)
                    .padding(28).accessibilityAddTraits(.isHeader)
            }.background(StoryTheme.night)
        case .media(let asset, _, let note):
            VStack(spacing: 0) {
                if asset.isVideo { video(asset) } else { picture(asset, fill: false) }
                if let note {
                    Text(note).font(StoryTheme.serif(.body)).lineSpacing(5).foregroundStyle(StoryTheme.paperInk)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).padding(.vertical, 18)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.padding(.top, 18).background(StoryTheme.paper)
        case .note(_, let note):
            ScrollView {
                Text(note).font(StoryTheme.serif(.title3)).lineSpacing(8).foregroundStyle(StoryTheme.paperInk)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(32)
            }.background(StoryTheme.paper)
        case .blank:
            StoryTheme.paper
        case .end:
            starry.overlay(Image(systemName: "sparkles").font(.title).foregroundStyle(StoryTheme.gold))
        }
    }

    private var starry: some View {
        RadialGradient(colors: [Color(red: 143 / 255, green: 211 / 255, blue: 232 / 255).opacity(0.12), StoryTheme.night],
                       center: .center, startRadius: 0, endRadius: 360)
    }

    @ViewBuilder private func picture(_ asset: MediaAsset, fill: Bool) -> some View {
        Group {
            if let image = model.image(for: asset.id) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: fill ? .fill : .fit)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                    .accessibilityLabel(asset.fileName).accessibilityAddTraits(.isImage)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, fill ? 0 : 18)
        .onAppear { model.requestLibraryImage(asset) }
        .onDisappear { model.cancelLibraryImage(asset.id) }
    }

    @ViewBuilder private func video(_ asset: MediaAsset) -> some View {
        if model.cursor.current?.role != .journeyCover && model.cursor.current?.asset?.id == asset.id {
            ForegroundVideo(playback: model.foreground).padding(.horizontal, 18)
        } else {
            Image(systemName: "play.rectangle").font(.largeTitle).foregroundStyle(StoryTheme.paperInk.opacity(0.5))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(asset.fileName)
        }
    }
}

// MARK: - 旅程之流

struct StoryStream: View {
    @ObservedObject var model: StoryModel

    var body: some View {
        let entries = Array(model.cursor.entries.enumerated()).filter { $0.element.role != .journeyCover }
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    Text(model.journey.title).font(StoryTheme.serif(.largeTitle)).accessibilityAddTraits(.isHeader)
                    let journeyNote = model.journey.note.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !journeyNote.isEmpty {
                        Text(journeyNote).font(StoryTheme.serif(.body)).lineSpacing(6).foregroundStyle(StoryTheme.muted)
                    }
                    ForEach(entries, id: \.element.id) { index, entry in
                        row(index, entry, previous: index > 0 ? model.cursor.entries[index - 1] : nil).id(entry.id)
                    }
                    if !model.journal.isEmpty { journal }
                }
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: 680).frame(maxWidth: .infinity)
            }
            .accessibilityElement(children: .contain).accessibilityIdentifier("story.stream")
            .onAppear {
                model.loadJournal()
                if let current = model.cursor.current, current.role != .journeyCover { proxy.scrollTo(current.id, anchor: .top) }
            }
        }
    }

    private func point(_ id: String?) -> MediaRoutePoint? { id.flatMap { id in model.journey.routePoints.first { $0.id == id } } }

    /// A route point's place and note are said once, at its first row.
    @ViewBuilder private func row(_ index: Int, _ entry: StoryEntry, previous: StoryEntry?) -> some View {
        let opensPoint = entry.routePointId != nil && entry.routePointId != previous?.routePointId
        VStack(alignment: .leading, spacing: 10) {
            if opensPoint, let point = point(entry.routePointId) {
                Text(point.label).font(StoryTheme.serif(.title3)).foregroundStyle(StoryTheme.accent)
                    .accessibilityAddTraits(.isHeader).padding(.top, 12)
            }
            if let asset = entry.asset { StoryStreamMedia(model: model, asset: asset, index: index, entryID: entry.id) }
            if opensPoint, let note = point(entry.routePointId)?.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
                Text(note).font(StoryTheme.serif(.body)).lineSpacing(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var journal: some View {
        VStack(alignment: .leading, spacing: 16) {
            Divider().overlay(StoryTheme.line).padding(.vertical, 12)
            Text("每日手记").font(StoryTheme.serif(.title2)).accessibilityAddTraits(.isHeader)
            ForEach(model.journal) { chapter in
                VStack(alignment: .leading, spacing: 10) {
                    Text([chapter.date, chapter.title].filter { !$0.isEmpty }.joined(separator: "  "))
                        .font(StoryTheme.serif(.headline)).foregroundStyle(StoryTheme.accent).accessibilityAddTraits(.isHeader)
                    ForEach(chapter.events) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            if let time = event.localTime, !time.isEmpty {
                                Text(time).font(.footnote.monospacedDigit()).foregroundStyle(StoryTheme.muted)
                            }
                            Text(event.text).font(StoryTheme.serif(.body)).lineSpacing(5)
                                .strikethrough(event.status == "cancelled")
                                .opacity(event.status == "actual" || event.status == "uncertain" ? 1 : 0.6)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("story.journal")
    }
}

private struct StoryStreamMedia: View {
    @ObservedObject var model: StoryModel
    let asset: MediaAsset
    let index: Int
    let entryID: String

    var body: some View {
        Group {
            if asset.isVideo {
                if model.cursor.index == index {
                    ForegroundVideo(playback: model.foreground).aspectRatio(16 / 9, contentMode: .fit)
                } else {
                    Button { model.select(index) } label: {
                        ZStack {
                            StoryTheme.surface
                            Image(systemName: "play.circle").font(.largeTitle).foregroundStyle(StoryTheme.ink.opacity(0.8))
                        }.aspectRatio(16 / 9, contentMode: .fit)
                    }.accessibilityLabel("播放视频：\(asset.fileName)")
                }
            } else if let image = model.image(for: asset.id) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                    .accessibilityLabel(asset.fileName).accessibilityAddTraits(.isImage)
            } else {
                ZStack { StoryTheme.surface; ProgressView() }.aspectRatio(4 / 3, contentMode: .fit)
            }
        }
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityIdentifier("story.stream.\(entryID)")
        .onAppear { if !asset.isVideo { model.requestLibraryImage(asset) } }
        .onDisappear { model.cancelLibraryImage(asset.id) }
    }
}
