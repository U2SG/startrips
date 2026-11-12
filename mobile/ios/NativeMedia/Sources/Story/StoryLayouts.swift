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
        .padding(.horizontal, StoryTheme.edge).padding(.vertical, StoryTheme.grid(2))
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
                    .padding(StoryTheme.pageInset).accessibilityAddTraits(.isHeader)
            }.background(StoryTheme.night)
        case .media(let asset, _, let note):
            VStack(spacing: 0) {
                if asset.isVideo { video(asset) } else { picture(asset, fill: false) }
                if let note {
                    Text(note).font(StoryTheme.serif(.body)).lineSpacing(5).foregroundStyle(StoryTheme.paperInk)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, StoryTheme.pageInset).padding(.vertical, StoryTheme.grid(4))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.padding(.top, StoryTheme.grid(4)).background(StoryTheme.paper)
        case .note(_, let note):
            ScrollView {
                Text(note).font(StoryTheme.serif(.title3)).lineSpacing(8).foregroundStyle(StoryTheme.paperInk)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(StoryTheme.grid(8))
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
        .padding(.horizontal, fill ? 0 : StoryTheme.edge)
        // Re-request when the Story pager prunes its own copy of this picture.
        .task(id: model.image(for: asset.id) == nil) { if model.image(for: asset.id) == nil { model.requestLibraryImage(asset) } }
        .onDisappear { model.cancelLibraryImage(asset.id) }
    }

    @ViewBuilder private func video(_ asset: MediaAsset) -> some View {
        if model.cursor.current?.role != .journeyCover && model.cursor.current?.asset?.id == asset.id {
            ForegroundVideo(playback: model.foreground).padding(.horizontal, StoryTheme.edge)
        } else {
            Image(systemName: "play.rectangle").font(.largeTitle).foregroundStyle(StoryTheme.paperInk.opacity(0.5))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(asset.fileName)
        }
    }
}

// MARK: - 旅程之流

/// Port of the web stream (`journey-stream.css`): one gold thread down the
/// centre is the spine every picture hangs on. Pictures cover it, so it shows
/// as connectors in the gaps; headings and notes sit on a small break in it.
/// The thread fills downward as the reader scrolls; Reduce Motion shows it whole.
struct StoryStream: View {
    @ObservedObject var model: StoryModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var viewport: CGFloat = 0
    @State private var scrolled: CGFloat = 0
    @State private var poured = false
    /// Content y of each rendered row, for the playback flow.
    @State private var rowY: [String: CGFloat] = [:]
    /// Where the reading point is during playback (content y).
    @State private var reading: CGFloat = 0
    @State private var glide: (from: CGFloat, start: Date)?

    private var playing: Bool { model.playback != nil }
    private var streamEntries: [StoryEntry] { model.cursor.entries.filter { $0.role != .journeyCover } }
    private var currentRow: Int? { model.playback?.current.flatMap { StreamFlow.row(for: $0, in: streamEntries) } }

    var body: some View {
        let entries = Array(model.cursor.entries.enumerated()).filter { $0.element.role != .journeyCover }
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .center, spacing: StoryTheme.grid(5)) {
                    Text(model.journey.title).font(StoryTheme.serif(.largeTitle)).multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isHeader).onThread()
                    let journeyNote = model.journey.note.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !journeyNote.isEmpty {
                        Text(journeyNote).font(StoryTheme.serif(.body)).lineSpacing(6).foregroundStyle(StoryTheme.muted)
                            .multilineTextAlignment(.center).onThread()
                    }
                    ForEach(entries, id: \.element.id) { index, entry in
                        row(index, entry, previous: index > 0 ? model.cursor.entries[index - 1] : nil).id(entry.id)
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: StreamRowKey.self,
                                                       value: [entry.id: geometry.frame(in: .named("story.stream.content")).minY])
                            })
                    }
                    if !model.journal.isEmpty { journal.background(StoryTheme.background) }
                }
                .padding(.horizontal, StoryTheme.edge).padding(.vertical, StoryTheme.grid(4))
                .frame(maxWidth: 680)
                .coordinateSpace(name: "story.stream.content")
                .onPreferenceChange(StreamRowKey.self) { rowY.merge($0) { _, new in new } }
                .background { thread }
                // The reading point, as a 1pt marker the scroll view follows during playback.
                .overlay(alignment: .top) {
                    Color.clear.frame(height: 1).padding(.top, max(0, reading)).id(Self.marker).allowsHitTesting(false)
                }
                .frame(maxWidth: .infinity)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: StreamOffsetKey.self, value: -geometry.frame(in: .named("story.stream")).minY)
                })
            }
            .coordinateSpace(name: "story.stream")
            .background(GeometryReader { geometry in Color.clear.onAppear { viewport = geometry.size.height }
                .onChange(of: geometry.size.height) { viewport = $0 } })
            .onPreferenceChange(StreamOffsetKey.self) { scrolled = $0 }
            .takeoverPausesPlayback(playing) { model.setPaused(true) }
            .onChange(of: model.playback?.index) { _ in
                guard playing else { glide = nil; return }
                glide = (reading, Date()); follow(proxy)
            }
            .onChange(of: model.playback?.elapsedMS) { _ in follow(proxy) }
            // Resuming after a takeover glides back from wherever the reader scrolled.
            .onChange(of: model.paused) { paused in
                if !paused && playing { glide = (scrolled + viewport * StreamFlow.readingLine, Date()) }
            }
            .accessibilityElement(children: .contain).accessibilityIdentifier("story.stream")
            .onAppear {
                model.loadJournal()
                if let current = model.cursor.current, current.role != .journeyCover { proxy.scrollTo(current.id, anchor: .top) }
                if reduceMotion { poured = true } else { withAnimation(.easeOut(duration: 0.6)) { poured = true } }
            }
        }
    }

    /// The spine: a faint full-length line plus a gold fill down to the reading point.
    private var thread: some View {
        GeometryReader { geometry in
            let height = geometry.size.height
            let reach = reduceMotion ? height
                : min(height, max(0, playing ? reading : scrolled + viewport * 0.6))
            let fade = Gradient(stops: [.init(color: .clear, location: 0), .init(color: StoryTheme.accent, location: 0.04),
                                        .init(color: StoryTheme.accent, location: 0.96), .init(color: .clear, location: 1)])
            ZStack(alignment: .top) {
                LinearGradient(gradient: fade, startPoint: .top, endPoint: .bottom).opacity(0.32)
                LinearGradient(gradient: fade, startPoint: .top, endPoint: .bottom).opacity(0.9)
                    .frame(height: height)
                    .mask(alignment: .top) { Rectangle().frame(height: poured ? reach : 0) }
            }
            .frame(width: 1, height: height)
            .frame(maxWidth: .infinity)
        }
        .allowsHitTesting(false)
        .streamThreadIdentifier()
    }

    private static let marker = "story.stream.reading"

    /// One playback tick: move the reading point along the thread and keep it on the reading line.
    private func follow(_ proxy: ScrollViewProxy) {
        guard let clock = model.playback, let beat = clock.current else { return }
        let entries = streamEntries
        let here = StreamFlow.row(for: beat, in: entries)
        func y(_ row: Int?) -> CGFloat? { row.map { rowY[entries[$0].id] } ?? 0 }
        guard let from = y(here) else {
            // Not laid out yet (lazy): bring the row in, the next tick continues smoothly.
            if let here { proxy.scrollTo(entries[here].id, anchor: UnitPoint(x: 0.5, y: StreamFlow.readingLine)) }
            return
        }
        let next = StreamFlow.nextRow(after: clock.index, beats: clock.beats, entries: entries)
        let to: CGFloat? = next.flatMap { y($0) }
        let fraction = beat.durationMS > 0 ? clock.elapsedMS / beat.durationMS : 0
        var target = reduceMotion ? from : StreamFlow.reading(from: from, to: to, fraction: fraction)
        if let glide {
            let elapsed = Date().timeIntervalSince(glide.start)
            target = StreamFlow.glide(from: glide.from, to: target, elapsed: elapsed, reduceMotion: reduceMotion)
            if elapsed >= StreamFlow.seekSeconds { self.glide = nil }
        }
        reading = target
        proxy.scrollTo(Self.marker, anchor: UnitPoint(x: 0.5, y: StreamFlow.readingLine))
    }

    private func point(_ id: String?) -> MediaRoutePoint? { id.flatMap { id in model.journey.routePoints.first { $0.id == id } } }

    /// A route point's place and note are said once, at its first row, as a mark on the thread.
    @ViewBuilder private func row(_ index: Int, _ entry: StoryEntry, previous: StoryEntry?) -> some View {
        let opensPoint = entry.routePointId != nil && entry.routePointId != previous?.routePointId
        // While playing, the place being read is in full ink; the others step back.
        let quiet = playing && currentRow.map { streamEntries[$0].chapterRoutePointId ?? streamEntries[$0].routePointId }
            != .some(entry.chapterRoutePointId ?? entry.routePointId)
        VStack(alignment: .center, spacing: StoryTheme.grid(3)) {
            if opensPoint, let point = point(entry.routePointId) {
                VStack(spacing: StoryTheme.grid(2)) {
                    Capsule().fill(StoryTheme.accent).frame(width: StoryTheme.grid(4), height: 1)
                        .accessibilityHidden(true)
                    Text(point.label).font(StoryTheme.serif(.title3)).foregroundStyle(StoryTheme.ink)
                        .multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
                }
                .opacity(quiet ? 0.55 : 1)
                .onThread().padding(.top, StoryTheme.grid(3))
            }
            if let asset = entry.asset { StoryStreamMedia(model: model, asset: asset, index: index, entryID: entry.id) }
            if opensPoint, let note = point(entry.routePointId)?.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
                Text(note).font(StoryTheme.serif(.body)).lineSpacing(6).multilineTextAlignment(.center)
                    .opacity(quiet ? 0.55 : 1).onThread()
            }
        }
    }

    private var journal: some View {
        VStack(alignment: .leading, spacing: StoryTheme.grid(4)) {
            Divider().overlay(StoryTheme.line).padding(.vertical, StoryTheme.grid(3))
            Text("每日手记").font(StoryTheme.serif(.title2)).accessibilityAddTraits(.isHeader)
            ForEach(model.journal) { chapter in
                VStack(alignment: .leading, spacing: StoryTheme.grid(3)) {
                    Text([chapter.date, chapter.title].filter { !$0.isEmpty }.joined(separator: "  "))
                        .font(StoryTheme.serif(.headline)).foregroundStyle(StoryTheme.muted).accessibilityAddTraits(.isHeader)
                    ForEach(chapter.events) { event in
                        VStack(alignment: .leading, spacing: StoryTheme.grid(1)) {
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

private struct StreamRowKey: PreferenceKey {
    static var defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

private extension View {
    /// Touching the stream during playback takes over: playback pauses, play resumes the flow.
    @ViewBuilder func takeoverPausesPlayback(_ playing: Bool, pause: @escaping () -> Void) -> some View {
        if #available(iOS 18.0, *) {
            onScrollPhaseChange { _, phase in if playing && phase == .interacting { pause() } }
        } else {
            simultaneousGesture(DragGesture(minimumDistance: 12).onChanged { _ in if playing { pause() } })
        }
    }
}

private struct StreamOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private extension View {
    /// Text breaks the thread instead of being struck through by it.
    func onThread() -> some View {
        padding(.vertical, StoryTheme.grid(1)).padding(.horizontal, StoryTheme.grid(2)).background(StoryTheme.background)
    }

    /// Exposed to UI tests only; the thread is decoration for VoiceOver.
    @ViewBuilder func streamThreadIdentifier() -> some View {
        #if DEBUG
        accessibilityElement().accessibilityIdentifier("story.stream.thread")
        #else
        accessibilityHidden(true)
        #endif
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
                // During playback the beat's video plays in place through the shared foreground player.
                if model.playback.map({ $0.current?.asset?.id == asset.id }) ?? (model.cursor.index == index) {
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
        .task(id: model.image(for: asset.id) == nil) {
            if !asset.isVideo, model.image(for: asset.id) == nil { model.requestLibraryImage(asset) }
        }
        .onDisappear { model.cancelLibraryImage(asset.id) }
    }
}
