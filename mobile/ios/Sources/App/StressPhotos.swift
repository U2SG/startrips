#if DEBUG
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import StartripsMedia
import UniformTypeIdentifiers

/// DEBUG-only performance probe (`-story-stress-photos`): adds many large camera-sized
/// JPEGs to the fixture Journey so stream playback exposes real image loading.
enum StressPhotos {
    static let count = 50
    /// Mixed shapes: landscape, portrait, wide and square, like a real camera roll.
    static let shapes = [(4032, 3024), (3024, 4032), (4032, 2268), (3024, 3024)]
    static func originalSize(_ id: String) -> (width: Int, height: Int) { shapes[index(id) % shapes.count] }
    static func previewSize(_ id: String) -> (width: Int, height: Int) {
        let original = originalSize(id)
        let scale = 1600.0 / Double(max(original.0, original.1))
        return (Int(Double(original.0) * scale), Int(Double(original.1) * scale))
    }
    static func index(_ id: String) -> Int { Int(id.split(separator: "-").last ?? "0") ?? 0 }
    static let notes = ["清晨的海面很安静。", "沿着海岸线走了很久，风一直很大，云在不停地变化，远处的灯塔一会儿出现一会儿又被雾遮住。",
                        "午饭。", "日落之前赶到了山顶，天色从金色慢慢变成紫色，再变成深蓝。所有人都没有说话，只是站在那里看着。",
                        "夜里下了一场雨。", "最后一天。"]
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("-story-stress-photos") }

    static func isStress(_ id: String) -> Bool { id.hasPrefix("stress-") }
    static func isVideo(_ id: String) -> Bool { id.hasPrefix("stress-video-") }
    /// Clips of different lengths; the second one's read is slow, the third is portrait.
    static let videos: [(seconds: Int, width: Int, height: Int, readDelay: Double)] =
        [(4, 640, 360, 0.3), (8, 640, 360, 2.5), (12, 360, 640, 0.6)]

    /// The fixture Journey with `count` extra pictures spread over its route points.
    static func augment(_ journey: MediaJourney) -> MediaJourney {
        guard !journey.media.contains(where: { isStress($0.id) }),
              var object = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(journey))) as? [String: Any],
              var media = object["media"] as? [[String: Any]] else { return journey }
        // Extra stops with notes of very different lengths, so rows range from a line of text to a tall photo.
        var routePoints = object["routePoints"] as? [[String: Any]] ?? []
        for (index, note) in (notes + notes.map { $0 + $0 }).enumerated() {
            routePoints.append(["id": "stress-point-\(index)", "latitude": 1.3 + Double(index) * 0.1, "longitude": 104.0 + Double(index) * 0.1,
                                "label": "停靠 \(index + 1)", "isStop": true, "note": note])
        }
        object["routePoints"] = routePoints
        let points = routePoints.compactMap { $0["id"] as? String }
        for index in 0..<count {
            media.append(["id": "stress-\(index)", "journeyId": journey.id, "routePointId": points[index % max(1, points.count)],
                          "fileName": "stress-\(index).jpg", "mimeType": "image/jpeg", "bytes": 4_000_000,
                          "sortOrder": 100 + index])
        }
        for (index, clip) in videos.enumerated() {
            media.append(["id": "stress-video-\(index)", "journeyId": journey.id, "routePointId": points[(index * 7 + 3) % max(1, points.count)],
                          "fileName": "clip-\(index).mp4", "mimeType": "video/mp4", "bytes": clip.seconds * 300_000,
                          "sortOrder": 50 + index * 9])
        }
        object["media"] = media
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let augmented = try? JSONDecoder().decode(MediaJourney.self, from: data) else { return journey }
        return augmented
    }

    /// A deterministic, detailed JPEG (gradients and stripes so frames can be told apart).
    static func jpeg(_ id: String, preview: Bool) -> Data? {
        var size = preview ? previewSize(id) : originalSize(id)
        // Some previews arrive in a different shape than reported, as a real cache can.
        if preview && index(id) % 5 == 0 { size = (size.height, size.width) }
        let cache = FileManager.default.temporaryDirectory
            .appendingPathComponent("stress-\(id)-\(size.width).jpg")
        if let data = try? Data(contentsOf: cache) { return data }
        let seed = Double(abs(id.hashValue % 360)) / 360
        guard let context = CGContext(data: nil, width: size.width, height: size.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let colors = [CGColor(red: seed, green: 0.4, blue: 1 - seed, alpha: 1),
                      CGColor(red: 1 - seed, green: 0.7, blue: seed, alpha: 1)] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
        }
        let band = size.height / 48
        for row in 0..<48 where row % 2 == 0 {
            context.setFillColor(CGColor(gray: Double(row % 7) / 7, alpha: 0.35))
            context.fill(CGRect(x: 0, y: row * band, width: size.width, height: band / 2))
        }
        guard let image = context.makeImage() else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        try? (data as Data).write(to: cache)
        return data as Data
    }

    /// A generated H.264 clip (colour bands moving each frame), cached; the read waits like a slow server.
    static func video(_ id: String) async throws -> URL {
        let index = Int(id.split(separator: "-").last ?? "0") ?? 0
        let clip = videos[index % videos.count]
        try await Task.sleep(for: .seconds(clip.readDelay))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(id).mp4")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        try await Task.detached(priority: .userInitiated) { try writeClip(to: url, seconds: clip.seconds, width: clip.width, height: clip.height) }.value
        return url
    }

    private static func writeClip(to url: URL, seconds: Int, width: Int, height: Int) throws {
        let temp = url.appendingPathExtension("tmp.mp4")
        try? FileManager.default.removeItem(at: temp)
        let writer = try AVAssetWriter(outputURL: temp, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                                                                             AVVideoWidthKey: width, AVVideoHeightKey: height])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height])
        writer.add(input)
        writer.startWriting(); writer.startSession(atSourceTime: .zero)
        let fps = 30
        for frame in 0..<(seconds * fps) {
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
            guard let pool = adaptor.pixelBufferPool else { break }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { break }
            CVPixelBufferLockBaseAddress(buffer, [])
            let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(buffer)
            for y in 0..<height {
                let band = ((y + frame * 4) / 24) % 2
                for x in 0..<width {
                    let p = base + y * row + x * 4
                    p[0] = UInt8(band == 0 ? 180 : 60); p[1] = UInt8((x * 255) / max(1, width)); p[2] = UInt8((frame * 3) % 255); p[3] = 255
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps)))
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: temp, to: url)
    }
}
#endif
