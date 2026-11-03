import AVFoundation
import CoreVideo
import Foundation

/// AVFoundation may backpressure every input at once. Only a readiness or writer
/// state transition (or task cancellation) needs to wake the producer.
private final class WriterReadiness {
    let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private let observations: [NSKeyValueObservation]

    init(_ writer: AVAssetWriter, inputs: [AVAssetWriterInput]) {
        let (events, sink) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        stream = events
        continuation = sink
        observations = inputs.map { input in
            input.observe(\.isReadyForMoreMediaData, options: [.initial, .new]) { _, _ in sink.yield(()) }
        } + [writer.observe(\.status, options: [.new]) { _, _ in sink.yield(()) }]
    }
    func finish() {
        observations.forEach { $0.invalidate() }
        continuation.finish()
    }
}

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
        let muxed = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".mux.mp4")
        defer {
            try? FileManager.default.removeItem(at: silent)
            try? FileManager.default.removeItem(at: muxed)
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
        let demand = WriterReadiness(writer, inputs: [input])
        defer { demand.finish() }
        var readiness = demand.stream.makeAsyncIterator()
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
                while !input.isReadyForMoreMediaData {
                    try Task.checkCancellation()
                    guard writer.status == .writing else { throw writer.error ?? MediaFailure.encoding }
                    guard await readiness.next() != nil else { throw CancellationError() }
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
                try await mux(video: silent, output: muxed, soundtrack: soundtrack, volume: soundtrackVolume)
            }
            try Task.checkCancellation(); try await authorize(); try Task.checkCancellation()
            try FileManager.default.moveItem(at: soundtrack == nil ? silent : muxed, to: destination)
            progress(1); return destination
        } catch {
            if writer.status == .writing { writer.cancelWriting() }
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
    private nonisolated func mux(video: URL, output: URL, soundtrack: URL, volume: Float) async throws {
        let composition = AVMutableComposition(), source = AVURLAsset(url: video)
        let duration = try await source.load(.duration)
        guard let sourceVideo = try await source.loadTracks(withMediaType: .video).first else { throw MediaFailure.encoding }
        let asset = AVURLAsset(url: soundtrack)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first,
              let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw MediaFailure.unavailable
        }
        let audioRange = try await track.load(.timeRange)
        guard audioRange.start.seconds.isFinite, audioRange.duration.seconds.isFinite, audioRange.duration > .zero else {
            throw MediaFailure.unavailable
        }
        var cursor = CMTime.zero
        while cursor < duration {
            try Task.checkCancellation()
            let span = CMTimeMinimum(audioRange.duration, duration - cursor)
            try target.insertTimeRange(CMTimeRange(start: audioRange.start, duration: span), of: track, at: cursor)
            cursor = cursor + span
        }
        let mix = AVMutableAudioMix()
        let parameters = AVMutableAudioMixInputParameters(track: target)
        parameters.setVolume(min(1, max(0, volume)), at: .zero)
        mix.inputParameters = [parameters]
        // The silent track is already H.264. Copy its compressed samples and
        // encode only the looped soundtrack, avoiding a second video encoder.
        let videoReader = try AVAssetReader(asset: source)
        let picture = AVAssetReaderTrackOutput(track: sourceVideo, outputSettings: nil)
        let musicReader = try AVAssetReader(asset: composition)
        let music = AVAssetReaderAudioMixOutput(audioTracks: [target], audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ])
        music.audioMix = mix
        guard videoReader.canAdd(picture), musicReader.canAdd(music),
              let hint = try await sourceVideo.load(.formatDescriptions).first else { throw MediaFailure.encoding }
        picture.alwaysCopiesSampleData = false; music.alwaysCopiesSampleData = false
        videoReader.add(picture); musicReader.add(music)
        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: hint)
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192000
        ])
        guard writer.canAdd(videoInput), writer.canAdd(audioInput) else { throw MediaFailure.encoding }
        writer.add(videoInput); writer.add(audioInput)
        defer {
            if videoReader.status == .reading { videoReader.cancelReading() }
            if musicReader.status == .reading { musicReader.cancelReading() }
            if writer.status == .writing { writer.cancelWriting() }
        }
        guard videoReader.startReading(), musicReader.startReading(), writer.startWriting() else {
            throw videoReader.error ?? musicReader.error ?? writer.error ?? MediaFailure.encoding
        }
        writer.startSession(atSourceTime: .zero)
        var tracks: [(AVAssetReader, AVAssetReaderOutput, AVAssetWriterInput)] = [
            (videoReader, picture, videoInput), (musicReader, music, audioInput)
        ]
        let demand = WriterReadiness(writer, inputs: [videoInput, audioInput])
        defer { demand.finish() }
        var readiness = demand.stream.makeAsyncIterator()
        while !tracks.isEmpty {
            try Task.checkCancellation()
            guard writer.status == .writing else { throw writer.error ?? MediaFailure.encoding }
            var progressed = false
            for index in tracks.indices.reversed() {
                let (reader, samples, input) = tracks[index]
                guard input.isReadyForMoreMediaData else { continue }
                if let sample = samples.copyNextSampleBuffer() {
                    guard input.append(sample) else { throw writer.error ?? MediaFailure.encoding }
                } else {
                    guard reader.status == .completed else { throw reader.error ?? MediaFailure.encoding }
                    input.markAsFinished(); tracks.remove(at: index)
                }
                progressed = true
            }
            if !progressed {
                guard await readiness.next() != nil else { throw CancellationError() }
            }
        }
        writer.endSession(atSourceTime: duration)
        await writer.finishWriting()
        try Task.checkCancellation()
        guard writer.status == .completed else { throw writer.error ?? MediaFailure.encoding }
    }
}
