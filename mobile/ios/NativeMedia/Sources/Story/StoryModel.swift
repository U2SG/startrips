import Combine
import Foundation
import ImageIO
import UIKit

@MainActor public final class StoryModel: ObservableObject {
    private(set) var pageGeneration = 0
    @Published public private(set) var cursor: StoryCursor
    @Published public private(set) var images: [String: UIImage] = [:]
    @Published public private(set) var failure: String?
    @Published public private(set) var playback: PlaybackClock?
    @Published public var expanded = true
    @Published public private(set) var paused = false
    @Published public private(set) var tempo: NarrativeTempo = .standard
    /// Decoded pictures for the book and stream layouts; never signed URLs.
    @Published public private(set) var library: [String: UIImage] = [:]
    @Published public private(set) var journal: [StoryJournalChapter] = []
    private var libraryTasks: [String: Task<Void, Never>] = [:]
    private var libraryOrder: [String] = []
    private var libraryEpoch = 0
    private var journalTask: Task<Void, Never>?
    public let foreground: ForegroundPlayback
    public private(set) var intent: StoryIntent
    public private(set) var journey: MediaJourney
    public let session: ScopedMediaSession
    private let currentIntent: () -> StoryIntent
    private let latestJourney: () -> MediaJourney?
    private let onReturn: (MediaReturn) -> Void
    private let onBeat: (PlaybackBeat) -> Void
    private var soundtrackRead: (() async throws -> URL)?
    private var soundtrackTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var prewarmTask: Task<Void, Never>?
    private var clockTask: Task<Void, Never>?
    private var epoch = 0
    private var closed = false
    private var committed: PlaybackPosition?

    public init(journey: MediaJourney, intent: StoryIntent, session: ScopedMediaSession,
                ownership: PlaybackOwnership? = nil,
                currentIntent: @escaping () -> StoryIntent,
                latestJourney: @escaping () -> MediaJourney?,
                soundtrackRead: (() async throws -> URL)? = nil,
                onBeat: @escaping (PlaybackBeat) -> Void = { _ in },
                onReturn: @escaping (MediaReturn) -> Void) throws {
        self.journey = journey; self.intent = intent; self.session = session
        self.cursor = try StoryCursor(journey: journey, intent: intent)
        self.foreground = ForegroundPlayback(ownership: ownership)
        self.currentIntent = currentIntent; self.latestJourney = latestJourney
        self.onReturn = onReturn; self.onBeat = onBeat
        self.soundtrackRead = soundtrackRead
        foreground.onEnded = { [weak self] in self?.videoEnded() }
        foreground.onOwnershipLost = { [weak self] in
            guard let self else { return }
            self.epoch += 1; self.loadTask?.cancel(); self.prewarmTask?.cancel()
            self.clockTask?.cancel(); self.soundtrackTask?.cancel()
            self.paused = true; self.playback?.paused = true
        }
        commitCurrent()
    }
    var committedRoutePointID: String? { committed?.routePointId }
    public var activeAsset: MediaAsset? { playback == nil ? cursor.current?.asset : playback?.current?.asset }
    public var activeText: String { playback == nil ? cursor.current?.note ?? journey.note : playback?.current?.text ?? "" }
    public func appear() { guard !closed else { return }; loadCurrent(); loadSoundtrack() }
    public func disappear() {
        epoch += 1; loadTask?.cancel(); prewarmTask?.cancel(); clockTask?.cancel(); soundtrackTask?.cancel(); foreground.stop()
        images.removeAll(); clearLibrary(); journalTask?.cancel(); journalTask = nil
    }
    /// Loads one picture for a book page or stream row. Bounded; the caller cancels when its row leaves.
    /// Pixel size of a picture as soon as its display read answers, before its bytes arrive.
    @Published public private(set) var displaySizes: [String: CGSize] = [:]
    static let libraryLimit = 16

    /// Prefetches and pre-decodes upcoming pictures (stream lookahead). Bounded by the library cache.
    public func prefetchLibrary(_ assets: [MediaAsset]) { assets.forEach(requestLibraryImage) }

    public func requestLibraryImage(_ asset: MediaAsset) {
        guard !closed, !asset.isVideo, library[asset.id] == nil, images[asset.id] == nil, libraryTasks[asset.id] == nil,
              journey.media.contains(where: { $0.id == asset.id }) else { return }
        let ticket = libraryEpoch
        libraryTasks[asset.id] = Task { [weak self] in
            guard let self else { return }
            defer { if ticket == self.libraryEpoch && !Task.isCancelled { self.libraryTasks[asset.id] = nil } }
            guard let image = try? await self.loadImage(asset, maxPixel: 1600, display: true),
                  !Task.isCancelled, ticket == self.libraryEpoch, !self.closed,
                  self.journey.media.contains(where: { $0.id == asset.id }) else { return }
            self.library[asset.id] = image
            self.libraryOrder.removeAll { $0 == asset.id }; self.libraryOrder.append(asset.id)
            while self.libraryOrder.count > Self.libraryLimit { self.library[self.libraryOrder.removeFirst()] = nil }
        }
    }
    public func cancelLibraryImage(_ assetID: String) { libraryTasks.removeValue(forKey: assetID)?.cancel() }
    public func image(for assetID: String) -> UIImage? { images[assetID] ?? library[assetID] }
    private func clearLibrary() {
        libraryEpoch += 1; libraryTasks.values.forEach { $0.cancel() }; libraryTasks.removeAll()
        library.removeAll(); libraryOrder.removeAll()
    }
    /// Owner-only, read-only, and silent on failure: the stream simply omits the journal.
    public func loadJournal() {
        guard session.access == .owner, !closed, journalTask == nil else { return }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard let id = journey.id.addingPercentEncoding(withAllowedCharacters: allowed), !id.isEmpty else { return }
        journalTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.session.revalidate()
                let data = try await self.session.request("/api/journeys/\(id)/journal", "GET", nil)
                let chapters = try JSONDecoder().decode(StoryJournalChapter.Envelope.self, from: data).journal.chapters
                try Task.checkCancellation(); try await self.session.revalidate()
                guard !self.closed else { return }
                self.journal = chapters
            } catch { /* The journal is optional reading; never a Story failure. */ }
        }
    }
    public func beginPaging(_ index: Int) -> Int {
        foreground.setPaused(true)
        return cursor.propose(index)
    }
    public func finishPaging(_ token: Int, completed: Bool) {
        guard token == cursor.generation else { return }
        cursor.settle(token, completed: completed)
        if completed { commitCurrent(); loadCurrent() }
        else { foreground.setPaused(paused) }
    }
    public func cancelPaging() { cursor.cancel(); foreground.setPaused(paused) }
    public func select(_ index: Int) { let token = beginPaging(index); finishPaging(token, completed: true) }
    public func collapse() { cancelPaging(); expanded = false }
    public func setPaused(_ value: Bool) {
        paused = value; playback?.paused = value; foreground.setPaused(value)
    }
    public func playJourney() {
        cursor.cancel(); playback = PlaybackClock(beats: JourneyPlaybackPlan.build(journey, tempo: tempo))
        paused = false; foreground.setPaused(false); activateBeat(); startClock()
    }
    func replaceSoundtrack(_ read: (() async throws -> URL)?) {
        soundtrackTask?.cancel()
        foreground.setSoundtrack(url: nil, volume: 0.8)
        soundtrackRead = read
        loadSoundtrack()
    }
    private func loadSoundtrack() {
        guard let soundtrackRead else { return }
        soundtrackTask?.cancel()
        soundtrackTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.session.revalidate()
                let url = try await soundtrackRead()
                try Task.checkCancellation(); try await self.session.revalidate()
                guard url.scheme == "https", !self.closed else { return }
                self.foreground.setSoundtrack(url: url, volume: 0.8)
            } catch is CancellationError {} catch { self.failure = MediaFailure.unavailable.localizedDescription }
        }
    }
    public func changeTempo(_ value: NarrativeTempo) {
        tempo = value
        playback?.changeTempo(to: JourneyPlaybackPlan.build(journey, tempo: value))
    }
    public func skip(_ direction: Int) {
        guard playback != nil else { select(cursor.index + direction); return }
        playback?.nextMeaningful(direction); activateBeat()
    }
    private func startClock() {
        clockTask?.cancel()
        clockTask = Task { [weak self] in
            var last = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 50_000_000) } catch { return }
                guard let self, self.playback != nil, !self.closed else { return }
                let now = ProcessInfo.processInfo.systemUptime
                let delta = (now - last) * 1000; last = now
                let previous = self.playback?.index
                let asset = self.activeAsset
                let ready = asset == nil || (asset?.isVideo == true ? self.foreground.ready : self.image(for: asset!.id) != nil)
                self.playback?.tick(milliseconds: delta, mediaReady: ready, videoOwnsCompletion: asset?.isVideo == true)
                if self.playback?.completed == true { self.finish(.completed); return }
                if previous != self.playback?.index { self.activateBeat() }
            }
        }
    }
    private func videoEnded() {
        guard playback != nil, !paused else { return }
        playback?.advance()
        if playback?.completed == true { finish(.completed) } else { activateBeat() }
    }
    private func activateBeat() {
        let live = currentIntent()
        guard live.requestId == intent.requestId, live.revision == intent.revision, let beat = playback?.current else { return }
        if beat.asset != nil || beat.routePointId != nil {
            committed = PlaybackPosition(journeyId: journey.id, routePointId: beat.asset?.routePointId ?? beat.routePointId, assetId: beat.asset?.id)
        }
        onBeat(beat); loadCurrent()
    }
    private func commitCurrent() {
        committed = PlaybackPosition(journeyId: journey.id, routePointId: cursor.current?.routePointId, assetId: cursor.current?.asset?.id)
    }
    public func retry() { loadCurrent() }
    public func invalidate() {
        closed = true; cursor.cancel(); disappear(); journal = []; failure = MediaFailure.accessChanged.localizedDescription
    }
    public func update(_ value: MediaJourney) throws {
        guard value.id == journey.id else { throw MediaFailure.staleIntent }
        let selected = cursor.current
        let position = playback == nil ? nil : committed
        let refreshed = StoryIntent(journeyId: value.id, routePointId: position?.routePointId ?? selected?.routePointId,
                                    assetId: playback == nil ? selected?.asset?.id : position?.assetId,
                                    revision: value.revision, requestId: intent.requestId)
        let refreshedCursor = try StoryCursor(journey: value, intent: refreshed)
        // UIKit retains already-created neighbors. An authoritative refresh replaces
        // their source entries and invalidates any outstanding page-turn callbacks.
        pageGeneration += 1
        cursor = refreshedCursor
        intent = refreshed; journey = value
        let present = Set(value.media.map(\.id))
        for id in libraryTasks.keys where !present.contains(id) { cancelLibraryImage(id) }
        library = library.filter { present.contains($0.key) }; libraryOrder.removeAll { !present.contains($0) }
        playback = nil; clockTask?.cancel(); commitCurrent(); loadCurrent()
    }
    private func loadCurrent() {
        epoch += 1; let ticket = epoch
        loadTask?.cancel(); prewarmTask?.cancel(); foreground.takeOwnership(); foreground.stopVideo(); failure = nil
        let asset = activeAsset
        var warm: [MediaAsset] = []
        if playback == nil {
            warm = [cursor.index - 1, cursor.index + 1].compactMap { index in
                cursor.entries.indices.contains(index) ? cursor.entries[index].asset : nil
            }.filter { !$0.isVideo }
        }
        let keep = Set(warm.map(\.id) + (asset.map { [$0.id] } ?? []))
        images = images.filter { keep.contains($0.key) }
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.session.revalidate()
                guard !Task.isCancelled, ticket == self.epoch else { return }
                if let asset {
                    if asset.isVideo {
                        let url = try await self.session.mediaURL(asset.id)
                        guard ticket == self.epoch, !Task.isCancelled else { return }
                        self.foreground.activate(url: url, trim: self.playback?.current?.trim)
                        self.foreground.setPaused(self.paused)
                    } else if self.images[asset.id] == nil, let decoded = self.library[asset.id], self.playback != nil {
                        // A prefetched stream picture is already decoded: never download it twice.
                        self.images[asset.id] = decoded
                    } else if self.images[asset.id] == nil {
                        let image = try await self.loadImage(asset)
                        guard ticket == self.epoch, !Task.isCancelled else { return }
                        self.images[asset.id] = image
                    }
                }
                self.prewarmTask = Task { [weak self] in
                    guard let self else { return }
                    for neighbor in warm where self.images[neighbor.id] == nil {
                        do {
                            let image = try await self.loadImage(neighbor)
                            guard ticket == self.epoch, !Task.isCancelled else { return }
                            self.images[neighbor.id] = image
                        } catch { /* Neighbors are speculative; the foreground has a retry surface. */ }
                    }
                }
            } catch is CancellationError {} catch {
                guard ticket == self.epoch else { return }
                self.failure = error.localizedDescription; self.setPaused(true)
            }
        }
    }
    private func loadImage(_ asset: MediaAsset, maxPixel: Int = 2560, display: Bool = false) async throws -> UIImage {
        let read = display ? try await session.mediaDisplay(asset.id) : MediaDisplayRead(url: try await session.mediaURL(asset.id))
        if let width = read.width, let height = read.height, width > 0, height > 0 {
            displaySizes[asset.id] = CGSize(width: width, height: height)
        }
        let (file, response) = try await session.imageTransport.download(from: read.url)
        defer { try? FileManager.default.removeItem(at: file) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw MediaFailure.unavailable }
        try Task.checkCancellation(); try await session.revalidate()
        // Decode off the main actor: a camera original decoded here stalls every frame of the stream.
        let image = try await Task.detached(priority: .userInitiated) { try Self.decode(file, maxPixel: maxPixel) }.value
        if displaySizes[asset.id] == nil { displaySizes[asset.id] = image.size }
        return image
    }

    /// Downsampled and fully decoded (`ShouldCacheImmediately`), so drawing it costs nothing later.
    nonisolated static func decode(_ file: URL, maxPixel: Int) throws -> UIImage {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixel
              ] as CFDictionary) else { throw MediaFailure.unavailable }
        return UIImage(cgImage: image)
    }
    public func leave() {
        guard playback != nil else { finish(); return }
        let live = currentIntent()
        guard let result = resolveMediaReturn(entry: intent, committed: committed, reason: .exited,
            currentRequestID: live.requestId, currentIntentRevision: live.revision, journey: latestJourney(), expanded: expanded),
              result.surface == .story, let journey = latestJourney() else { finish(); return }
        let restored = StoryIntent(journeyId: journey.id, routePointId: result.routePointId, assetId: result.assetId,
                                   revision: journey.revision, requestId: intent.requestId)
        do {
            let restoredCursor = try StoryCursor(journey: journey, intent: restored)
            disappear()
            playback = nil; self.journey = journey; cursor = restoredCursor
            paused = false; expanded = result.expanded; commitCurrent(); appear()
        } catch { finish() }
    }

    public func finish(_ reason: MediaReturn.Reason = .exited) {
        guard !closed else { return }
        let current = currentIntent()
        guard current.revision == intent.revision, let result = resolveMediaReturn(entry: intent, committed: committed, reason: reason,
                                              currentRequestID: current.requestId, currentIntentRevision: current.revision,
                                              journey: latestJourney(), expanded: expanded) else { return }
        closed = true; cursor.cancel(); disappear()
        onReturn(result)
    }
}
