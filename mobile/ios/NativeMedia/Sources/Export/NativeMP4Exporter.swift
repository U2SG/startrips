import AVFoundation
import CoreVideo
import Foundation

public struct FilmAudioSource {
    public let file: URL
    public let startSeconds: Double
    public let sourceSeconds: Double
    public let outputSeconds: Double
    public init(file: URL, startSeconds: Double, sourceSeconds: Double, outputSeconds: Double) {
        self.file = file; self.startSeconds = startSeconds; self.sourceSeconds = sourceSeconds; self.outputSeconds = outputSeconds
    }
}

@MainActor public final class NativeMP4Exporter {
    public init() {}
    public func export(manifest: FilmManifest, renderer: FilmFrameRendering, destination: URL,
                       foregroundAudio: [FilmAudioSource] = [], soundtrack: URL? = nil, soundtrackVolume: Float = 0.8,
                       authorize: @escaping () async throws -> Void,
                       availableBytes: () throws -> Int64,
                       progress: (Double) -> Void = { _ in }) async throws -> URL {
        try await authorize(); try Task.checkCancellation()
        // Reserve compressed video + mux copy; stream frames rather than retaining a movie.
        let estimate = max(Int64(16 * 1024 * 1024), Int64(manifest.actualDurationMs / 1000 * 2_000_000))
        guard try availableBytes() >= estimate else { throw MediaFailure.diskFull }
        guard !FileManager.default.fileExists(atPath: destination.path) else { throw MediaFailure.encoding }
        let silent = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".silent.mp4")
        var succeeded = false
        defer {
            try? FileManager.default.removeItem(at: silent)
            if !succeeded { try? FileManager.default.removeItem(at: destination) }
        }
        let writer = try AVAssetWriter(outputURL: silent, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: manifest.output.width, AVVideoHeightKey: manifest.output.height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000]
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: manifest.output.width,
            kCVPixelBufferHeightKey as String: manifest.output.height,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
        ])
        guard writer.canAdd(input) else { throw MediaFailure.encoding }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? MediaFailure.encoding }
        writer.startSession(atSourceTime: .zero)
        do {
            var lastScene = -1
            for number in 0..<manifest.totalFrames {
                try Task.checkCancellation()
                let frame = try manifest.sample(frame: number)
                if frame.sourceSceneIndex != lastScene {
                    try await authorize(); lastScene = frame.sourceSceneIndex
                    guard try availableBytes() > 8 * 1024 * 1024 else { throw MediaFailure.diskFull }
                }
                let image = try await renderer.render(frame)
                let started = ProcessInfo.processInfo.systemUptime
                while !input.isReadyForMoreMediaData {
                    try Task.checkCancellation()
                    guard writer.status == .writing else { throw writer.error ?? MediaFailure.encoding }
                    guard ProcessInfo.processInfo.systemUptime - started < 30 else { throw MediaFailure.encoding }
                    try await Task.sleep(nanoseconds: 2_000_000)
                }
                guard let pool = adaptor.pixelBufferPool else { throw MediaFailure.encoding }
                var buffer: CVPixelBuffer?
                guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else { throw MediaFailure.diskFull }
                try Self.draw(image, into: buffer)
                guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(number), timescale: Int32(manifest.fps))) else { throw writer.error ?? MediaFailure.encoding }
                progress(Double(number + 1) / Double(manifest.totalFrames) * 0.9)
            }
            writer.endSession(atSourceTime: CMTime(value: Int64(manifest.totalFrames), timescale: Int32(manifest.fps)))
            input.markAsFinished()
            await withTaskCancellationHandler(operation: { await writer.finishWriting() }, onCancel: { writer.cancelWriting() })
            try Task.checkCancellation()
            guard writer.status == .completed else { throw writer.error ?? MediaFailure.encoding }
            try await authorize()
            if foregroundAudio.isEmpty && soundtrack == nil {
                try FileManager.default.moveItem(at: silent, to: destination)
            } else {
                try await mux(video: silent, output: destination, foreground: foregroundAudio,
                              soundtrack: soundtrack, volume: soundtrackVolume)
            }
            try Task.checkCancellation(); try await authorize()
            succeeded = true; progress(1); return destination
        } catch {
            writer.cancelWriting()
            let nsError = error as NSError
            if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileWriteOutOfSpaceError { throw MediaFailure.diskFull }
            throw error
        }
    }
    private static func draw(_ image: CGImage, into buffer: CVPixelBuffer) throws {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: CVPixelBufferGetWidth(buffer),
                                      height: CVPixelBufferGetHeight(buffer), bitsPerComponent: 8,
                                      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { throw MediaFailure.encoding }
        context.draw(image, in: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer)))
    }
    private func mux(video: URL, output: URL, foreground: [FilmAudioSource], soundtrack: URL?, volume: Float) async throws {
        let composition = AVMutableComposition(), source = AVURLAsset(url: video)
        let duration = try await source.load(.duration)
        guard let sourceVideo = try await source.loadTracks(withMediaType: .video).first,
              let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailure.encoding }
        try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceVideo, at: .zero)
        var audible: [(Double, Double)] = []
        for clip in foreground {
            try Task.checkCancellation()
            let asset = AVURLAsset(url: clip.file)
            guard let track = try await asset.loadTracks(withMediaType: .audio).first else { continue }
            let sourceDuration = try await asset.load(.duration).seconds
            let seconds = min(sourceDuration, clip.sourceSeconds)
            guard seconds > 0, clip.outputSeconds > 0, clip.startSeconds >= 0,
                  clip.startSeconds + clip.outputSeconds <= duration.seconds + 0.001,
                  let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailure.invalidManifest }
            let start = CMTime(seconds: clip.startSeconds, preferredTimescale: 600)
            let span = CMTime(seconds: seconds, preferredTimescale: 600)
            try target.insertTimeRange(CMTimeRange(start: .zero, duration: span), of: track, at: start)
            target.scaleTimeRange(CMTimeRange(start: start, duration: span), toDuration: CMTime(seconds: clip.outputSeconds, preferredTimescale: 600))
            audible.append((clip.startSeconds, clip.startSeconds + clip.outputSeconds))
        }
        let mix = AVMutableAudioMix()
        if let soundtrack {
            let asset = AVURLAsset(url: soundtrack)
            let length = try await asset.load(.duration)
            guard length.seconds.isFinite, length.seconds > 0,
                  let track = try await asset.loadTracks(withMediaType: .audio).first,
                  let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailure.unavailable }
            var cursor = CMTime.zero
            while cursor < duration {
                try Task.checkCancellation()
                let span = CMTimeMinimum(length, duration - cursor)
                try target.insertTimeRange(CMTimeRange(start: .zero, duration: span), of: track, at: cursor)
                cursor = cursor + span
            }
            let parameters = AVMutableAudioMixInputParameters(track: target)
            let baseline = min(1, max(0, volume))
            parameters.setVolume(baseline, at: .zero)
            // Sample the same time-based duck envelope as live playback. This also handles
            // adjacent videos without overlapping release/attack ramps or a loud gap.
            var from = baseline, previous = 0.0
            var rampStart = 0.0, rampFrom = baseline, lastAudible = false
            let count = Int(ceil(duration.seconds / 0.02))
            for step in 0...count {
                let now = min(duration.seconds, Double(step) * 0.02)
                let isAudible = audible.contains { now >= $0.0 && now < $0.1 }
                if isAudible != lastAudible { rampStart = now; rampFrom = from; lastAudible = isAudible }
                let to = SoundtrackGain.ramp(from: rampFrom, to: SoundtrackGain.target(baseline: baseline, audible: isAudible), elapsed: now - rampStart)
                if now > previous {
                    parameters.setVolumeRamp(fromStartVolume: from, toEndVolume: to,
                        timeRange: CMTimeRange(start: CMTime(seconds: previous, preferredTimescale: 600), duration: CMTime(seconds: now - previous, preferredTimescale: 600)))
                }
                previous = now; from = to
            }
            mix.inputParameters = [parameters]
        }
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { throw MediaFailure.encoding }
        exporter.outputURL = output; exporter.outputFileType = .mp4; exporter.audioMix = mix
        await withTaskCancellationHandler(operation: { await exporter.export() }, onCancel: { exporter.cancelExport() })
        try Task.checkCancellation()
        guard exporter.status == .completed else { throw exporter.error ?? MediaFailure.encoding }
    }
}
