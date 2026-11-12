#if DEBUG
import CoreGraphics
import Foundation
import ImageIO
import StartripsMedia
import UniformTypeIdentifiers

/// DEBUG-only performance probe (`-story-stress-photos`): adds many large camera-sized
/// JPEGs to the fixture Journey so stream playback exposes real image loading.
enum StressPhotos {
    static let count = 30
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

    /// The fixture Journey with `count` extra pictures spread over its route points.
    static func augment(_ journey: MediaJourney) -> MediaJourney {
        guard !journey.media.contains(where: { isStress($0.id) }),
              var object = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(journey))) as? [String: Any],
              var media = object["media"] as? [[String: Any]] else { return journey }
        // Extra stops with notes of very different lengths, so rows range from a line of text to a tall photo.
        var routePoints = object["routePoints"] as? [[String: Any]] ?? []
        for (index, note) in notes.enumerated() {
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
        object["media"] = media
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let augmented = try? JSONDecoder().decode(MediaJourney.self, from: data) else { return journey }
        return augmented
    }

    /// A deterministic, detailed JPEG (gradients and stripes so frames can be told apart).
    static func jpeg(_ id: String, preview: Bool) -> Data? {
        let size = preview ? previewSize(id) : originalSize(id)
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
}
#endif
