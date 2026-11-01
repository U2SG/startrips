import AVFoundation
import CoreVideo
import Foundation

@MainActor public final class NativeMP4Exporter {
    public init() {}
    public func export(manifest: FilmManifest, renderer: FilmFrameRendering, destination: URL,
                       soundtrack: URL? = nil, soundtrackVolume: Float = 0.8,
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
            if let soundtrack {
                try await mux(video: silent, output: destination, soundtrack: soundtrack, volume: soundtrackVolume)
            } else {
                try FileManager.default.moveItem(at: silent, to: destination)
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
    private func mux(video: URL, output: URL, soundtrack: URL, volume: Float) async throws {
        let composition = AVMutableComposition(), source = AVURLAsset(url: video)
        let duration = try await source.load(.duration)
        guard let sourceVideo = try await source.loadTracks(withMediaType: .video).first,
              let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailure.encoding }
        try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceVideo, at: .zero)
        let asset = AVURLAsset(url: soundtrack)
        let length = try await asset.load(.duration)
        guard length.seconds.isFinite, length.seconds > 0,
              let track = try await asset.loadTracks(withMediaType: .audio).first,
              let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw MediaFailure.unavailable
        }
        var cursor = CMTime.zero
        while cursor < duration {
            try Task.checkCancellation()
            let span = CMTimeMinimum(length, duration - cursor)
            try target.insertTimeRange(CMTimeRange(start: .zero, duration: span), of: track, at: cursor)
            cursor = cursor + span
        }
        let mix = AVMutableAudioMix()
        let parameters = AVMutableAudioMixInputParameters(track: target)
        parameters.setVolume(min(1, max(0, volume)), at: .zero)
        mix.inputParameters = [parameters]
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { throw MediaFailure.encoding }
        exporter.outputURL = output; exporter.outputFileType = .mp4; exporter.audioMix = mix
        await withTaskCancellationHandler(operation: { await exporter.export() }, onCancel: { exporter.cancelExport() })
        try Task.checkCancellation()
        guard exporter.status == .completed else { throw exporter.error ?? MediaFailure.encoding }
    }
}
