import AVFoundation
import Combine
import Foundation

/// One instance is shared by the product composition, across Story presentations.
@MainActor public final class PlaybackOwnership {
    public static let shared = PlaybackOwnership()
    private var token: UUID?
    private var stop: (() -> Void)?
    public init() {}
    public func claim(stop: @escaping () -> Void) -> UUID {
        let previous = self.stop
        self.stop = nil; token = nil
        previous?()
        let next = UUID(); token = next; self.stop = stop
        return next
    }
    public func owns(_ candidate: UUID) -> Bool { token == candidate }
    public func release(_ candidate: UUID) {
        guard owns(candidate) else { return }
        let previous = stop; stop = nil; token = nil; previous?()
    }
}

public enum SoundtrackGain {
    public static func target(baseline: Float, audible: Bool) -> Float { baseline * (audible ? 0.3 : 1) }
    public static func ramp(from: Float, to: Float, elapsed: Double) -> Float {
        let seconds = to < from ? 0.220 : 0.450
        return from + (to - from) * Float(min(1, max(0, elapsed / seconds)))
    }
}

@MainActor public final class ForegroundPlayback: ObservableObject {
    @Published public private(set) var player: AVPlayer?
    @Published public private(set) var ready = false
    @Published public private(set) var failure: String?
    public var onEnded: (() -> Void)?
    public var onOwnershipLost: (() -> Void)?
    private let ownership: PlaybackOwnership
    private var lease: UUID?
    private var generation = 0
    private var loading: Task<Void, Never>?
    private var rampTask: Task<Void, Never>?
    private var observation: NSKeyValueObservation?
    private var itemObservation: NSKeyValueObservation?
    private var endedObserver: NSObjectProtocol?
    private var failedObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private var soundtrack: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var baseline: Float = 0.8
    private var paused = false
    private var muted = false
    private var playRange: ClosedRange<Double>?

    /// How far the current clip has played (0...1 within its trim), for the stream's even flow.
    public var progress: Double? {
        guard ready, let player, let range = playRange, range.upperBound > range.lowerBound else { return nil }
        let seconds = player.currentTime().seconds
        guard seconds.isFinite else { return nil }
        return min(1, max(0, (seconds - range.lowerBound) / (range.upperBound - range.lowerBound)))
    }

    public init(ownership: PlaybackOwnership? = nil) { self.ownership = ownership ?? .shared }
    public func takeOwnership() {
        if lease.map({ ownership.owns($0) }) != true {
            lease = ownership.claim { [weak self] in self?.stop(); self?.onOwnershipLost?() }
        }
    }
    public func activate(url: URL, trim: VideoTrim? = nil) {
        stopVideo()
        takeOwnership()
        generation += 1
        let epoch = generation
        loading = Task { [weak self] in
            guard let self else { return }
            do {
                let asset = AVURLAsset(url: url)
                let duration = try await asset.load(.duration).seconds
                try Task.checkCancellation()
                guard epoch == self.generation else { return }
                let bounds = trim?.resolved(sourceSeconds: duration)
                self.playRange = bounds ?? (duration.isFinite && duration > 0 ? 0...duration : nil)
                let item = AVPlayerItem(asset: asset)
                if let bounds { item.forwardPlaybackEndTime = CMTime(seconds: bounds.upperBound, preferredTimescale: 600) }
                let player = AVPlayer(playerItem: item)
                self.player = player; player.isMuted = self.muted
                self.itemObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                    Task { @MainActor in
                        guard let self, epoch == self.generation else { return }
                        if item.status == .failed { self.failure = MediaFailure.unavailable.localizedDescription; self.duck(false) }
                    }
                }
                self.endedObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, epoch == self.generation else { return }
                        self.duck(false); self.onEnded?()
                    }
                }
                self.failedObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, epoch == self.generation else { return }
                        self.failure = MediaFailure.unavailable.localizedDescription; self.duck(false)
                    }
                }
                self.observation = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
                    Task { @MainActor in
                        guard let self, epoch == self.generation else { return }
                        self.duck(player.timeControlStatus == .playing && !player.isMuted && player.volume > 0)
                    }
                }
                if let bounds {
                    await player.seek(to: CMTime(seconds: bounds.lowerBound, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
                }
                try Task.checkCancellation()
                guard epoch == self.generation else { return }
                self.ready = true
                if !self.paused { player.play() }
            } catch is CancellationError {} catch {
                guard epoch == self.generation else { return }
                self.failure = error.localizedDescription; self.duck(false)
            }
        }
    }
    public func setPaused(_ value: Bool) {
        paused = value
        if value { player?.pause(); soundtrack?.pause(); duck(false) }
        else { player?.play(); soundtrack?.play() }
    }
    public func setMuted(_ value: Bool) {
        muted = value; player?.isMuted = value
        duck(!value && player?.timeControlStatus == .playing)
    }
    public func setSoundtrack(url: URL?, volume: Float) {
        baseline = min(1, max(0, volume))
        soundtrack?.pause(); looper = nil; soundtrack = nil
        guard let url else { return }
        takeOwnership()
        let queue = AVQueuePlayer()
        soundtrack = queue; looper = AVPlayerLooper(player: queue, templateItem: AVPlayerItem(url: url))
        queue.volume = baseline
        if !paused { queue.play() }
        duck(player?.timeControlStatus == .playing && !muted)
    }
    public func setBaseline(_ value: Float) {
        baseline = min(1, max(0, value)); duck(player?.timeControlStatus == .playing && !muted)
    }
    private func duck(_ audible: Bool) {
        rampTask?.cancel()
        guard let soundtrack else { return }
        let from = soundtrack.volume, to = SoundtrackGain.target(baseline: baseline, audible: audible)
        let start = ProcessInfo.processInfo.systemUptime
        rampTask = Task {
            while !Task.isCancelled {
                let elapsed = ProcessInfo.processInfo.systemUptime - start
                soundtrack.volume = SoundtrackGain.ramp(from: from, to: to, elapsed: elapsed)
                if elapsed >= 0.450 { break }
                do { try await Task.sleep(nanoseconds: 16_000_000) } catch { break }
            }
        }
    }
    public func stopVideo() {
        generation += 1; loading?.cancel(); loading = nil
        player?.pause()
        if let timeObserver { player?.removeTimeObserver(timeObserver) }; timeObserver = nil
        observation = nil; itemObservation = nil
        if let endedObserver { NotificationCenter.default.removeObserver(endedObserver) }; endedObserver = nil
        if let failedObserver { NotificationCenter.default.removeObserver(failedObserver) }; failedObserver = nil
        player?.replaceCurrentItem(with: nil); player = nil; ready = false; failure = nil
        duck(false)
    }
    public func stop() {
        stopVideo(); rampTask?.cancel(); soundtrack?.pause(); soundtrack = nil; looper = nil
        if let lease { self.lease = nil; ownership.release(lease) }
    }
}
