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
/// Playing flows down the stream itself: a display-link driver moves the
/// scroll view every frame, and upcoming pictures are fetched and decoded ahead.
struct StoryStream: View {
    @ObservedObject var model: StoryModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var driver = StreamFlowDriver()
    /// Content frames (minY...maxY) of the rows SwiftUI currently has laid out. Only these are
    /// fresh: a row LazyVStack has dropped keeps no entry, so a stale position is never used.
    @State private var rowFrames: [String: ClosedRange<CGFloat>] = [:]

    private var playing: Bool { model.playback != nil }
    private var streamEntries: [StoryEntry] { model.cursor.entries.filter { $0.role != .journeyCover } }
    private var currentRow: Int? { model.playback?.current.flatMap { StreamFlow.row(for: $0, in: streamEntries) } }

    var body: some View {
        let entries = Array(model.cursor.entries.enumerated()).filter { $0.element.role != .journeyCover }
        let current = currentRow.map { streamEntries[$0] }
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
                        row(index, entry, previous: index > 0 ? model.cursor.entries[index - 1] : nil, current: current)
                            .id(entry.id)
                            .background(GeometryReader { geometry in
                                let frame = geometry.frame(in: .named("story.stream.content"))
                                Color.clear.preference(key: StreamRowKey.self, value: [entry.id: frame.minY...max(frame.minY, frame.maxY)])
                            })
                            .onDisappear { rowFrames[entry.id] = nil }
                    }
                    if !model.journal.isEmpty { journal.background(StoryTheme.background) }
                }
                .padding(.horizontal, StoryTheme.edge).padding(.vertical, StoryTheme.grid(4))
                .frame(maxWidth: 680)
                .coordinateSpace(name: "story.stream.content")
                .onPreferenceChange(StreamRowKey.self) { rowFrames.merge($0) { _, new in new } }
                .frame(maxWidth: .infinity)
                .background(StreamScrollViewFinder { driver.scrollView = $0 })
            }
            // The thread is fixed to the viewport, behind the content: rows cover it, and
            // its gold reach is the reading line. Nothing in it changes per frame.
            .background { StreamThread(reach: playing ? StreamFlow.readingLine : 0.6, reduceMotion: reduceMotion) }
            .accessibilityElement(children: .contain).accessibilityIdentifier("story.stream")
            .onAppear {
                model.loadJournal()
                model.streamPlayback = true
                driver.reduceMotion = reduceMotion
                driver.onTakeover = { [weak model] in model?.setPaused(true) }
                driver.clock = { [weak model] in
                    guard let clock = model?.playback, clock.current != nil else { return nil }
                    return (clock.index, clock.elapsedMS)
                }
                if let current = model.cursor.current, current.role != .journeyCover { proxy.scrollTo(current.id, anchor: .top) }
            }
            .onDisappear { driver.stop(); model.streamPlayback = false }
            .onChange(of: model.playback?.index) { _ in prefetch(); sync(proxy) }
            .onChange(of: model.paused) { _ in sync(proxy) }
            // Rows realised or resized during a long beat (a video) refresh the anchors.
            .onChange(of: rowFrames) { _ in if playing { sync(proxy) } }
            .onChange(of: playing) { _ in prefetch(); sync(proxy) }
            .onChange(of: reduceMotion) { driver.reduceMotion = $0 }
        }
    }

    /// Fetch and decode the next pictures before the flow reaches them.
    private func prefetch() {
        guard let clock = model.playback else { return }
        model.prefetchLibrary(StreamFlow.lookahead(beats: clock.beats, index: clock.index, elapsedMS: clock.elapsedMS))
    }

    /// Hands one clock sample and the next two anchors to the driver; it moves per display frame.
    /// Anchors come only from rows that are laid out now (or the row right after one), so a
    /// lazily estimated or stale position far down the stream can never become the target.
    private func sync(_ proxy: ScrollViewProxy) {
        guard let clock = model.playback, clock.current != nil else { driver.stop(); return }
        let entries = streamEntries
        let frames = entries.indices.map { rowFrames[entries[$0].id] }
        let knots = StreamFlow.nearKnots(index: clock.index, beats: clock.beats, entries: entries, frames: frames,
                                         spacing: StoryTheme.grid(5))
        guard driver.attached else {
            if let here = clock.current.flatMap({ StreamFlow.row(for: $0, in: entries) }) {
                proxy.scrollTo(entries[here].id, anchor: UnitPoint(x: 0.5, y: StreamFlow.readingLine))
            }
            return
        }
        let start = StreamFlow.beatStarts(clock.beats)[clock.index]
        let beat = clock.beats[clock.index]
        // Only a measured row can tell a relayout apart from a refined estimate.
        let here = StreamFlow.row(for: beat, in: entries)
        let anchor = here.flatMap { frames[$0] != nil ? entries[$0].id : nil }
        // A playing video row holds the flow in place (its frame must be laid out to do so).
        let videoRow = beat.asset?.isVideo == true ? here.flatMap { frames[$0] } : nil
        driver.update(.init(beat: clock.index, scheduleMS: start + clock.elapsedMS, beatStartMS: start, paused: model.paused,
                            knots: knots, anchor: anchor, videoRow: videoRow))
    }

    private func point(_ id: String?) -> MediaRoutePoint? { id.flatMap { id in model.journey.routePoints.first { $0.id == id } } }

    /// A route point's place and note are said once, at its first row, as a mark on the thread.
    @ViewBuilder private func row(_ index: Int, _ entry: StoryEntry, previous: StoryEntry?, current: StoryEntry?) -> some View {
        let opensPoint = entry.routePointId != nil && entry.routePointId != previous?.routePointId
        // While playing, the place being read is in full ink; the others step back.
        let quiet = playing && (current?.chapterRoutePointId ?? current?.routePointId) != (entry.chapterRoutePointId ?? entry.routePointId)
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
            if let asset = entry.asset {
                let playsVideo = asset.isVideo && (model.playback.map { $0.current?.asset?.id == asset.id } ?? (model.cursor.index == index))
                StoryStreamMedia(asset: asset, entryID: entry.id, image: model.image(for: asset.id),
                                 size: model.displaySizes[asset.id], playsVideo: playsVideo,
                                 foreground: playsVideo ? model.foreground : nil) { model.play(entry: index) }
                    .equatable()
                    .onAppear { model.requestLibraryImage(asset) }
                    .onDisappear { if !playing { model.cancelLibraryImage(asset.id) } }
            }
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
    static var defaultValue: [String: ClosedRange<CGFloat>] = [:]
    static func reduce(value: inout [String: ClosedRange<CGFloat>], nextValue: () -> [String: ClosedRange<CGFloat>]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// The spine, fixed to the viewport: a faint full line and a gold reach down to the reading line.
private struct StreamThread: View {
    let reach: CGFloat
    let reduceMotion: Bool
    @State private var poured = false
    var body: some View {
        GeometryReader { geometry in
            let height = geometry.size.height
            ZStack(alignment: .top) {
                Rectangle().fill(StoryTheme.accent.opacity(0.32))
                Rectangle().fill(LinearGradient(colors: [StoryTheme.accent.opacity(0), StoryTheme.accent.opacity(0.9)],
                                                startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.15)))
                    .frame(height: poured ? height * reach : 0)
            }
            .frame(width: 1, height: height)
            .frame(maxWidth: .infinity)
        }
        .allowsHitTesting(false)
        .onAppear { if reduceMotion { poured = true } else { withAnimation(.easeOut(duration: 0.6)) { poured = true } } }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: reach)
        .streamThreadIdentifier()
    }
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

/// One picture in the stream. Its frame is reserved from the picture's pixel size as soon
/// as that is known, so rows never jump when bytes arrive; equatable, so a playback tick
/// does not redraw pictures that did not change.
private struct StoryStreamMedia: View, Equatable {
    let asset: MediaAsset
    let entryID: String
    let image: UIImage?
    let size: CGSize?
    let playsVideo: Bool
    let foreground: ForegroundPlayback?
    let select: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.asset == rhs.asset && lhs.entryID == rhs.entryID && lhs.image === rhs.image
            && lhs.size == rhs.size && lhs.playsVideo == rhs.playsVideo
    }

    private var aspect: CGFloat {
        let known = size ?? image?.size
        guard let known, known.width > 0, known.height > 0 else { return asset.isVideo ? 16 / 9 : 4 / 3 }
        return known.width / known.height
    }

    var body: some View {
        Group {
            if asset.isVideo {
                // The poster (preview or first frame) is always underneath, so a video row is a
                // picture before and while its clip loads, never a dark block.
                ZStack {
                    if let image { Image(uiImage: image).resizable().scaledToFill()
                        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity).clipped() } else { StoryTheme.surface }
                    if playsVideo, let foreground {
                        ForegroundVideo(playback: foreground, fill: true)
                    } else {
                        Button(action: select) {
                            Image(systemName: "play.circle").font(.largeTitle).foregroundStyle(StoryTheme.ink.opacity(0.85))
                                .shadow(color: .black.opacity(0.5), radius: 6)
                        }.accessibilityLabel("播放视频：\(asset.fileName)")
                    }
                }
            } else if let image {
                Image(uiImage: image).resizable().scaledToFill()
                        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity).clipped()
                    .accessibilityLabel(asset.fileName).accessibilityAddTraits(.isImage)
            } else {
                ZStack { StoryTheme.surface; ProgressView() }
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(aspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityIdentifier("story.stream.\(entryID)")
    }
}
