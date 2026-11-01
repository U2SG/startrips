import AVFoundation
import MapKit
import UIKit

@MainActor public protocol FilmFrameRendering {
    func render(_ frame: FilmFrame) async throws -> CGImage
}

/// Materialized private files are scoped to one export. Only one video generator,
/// image and map snapshot are retained at a time, independent of film duration.
@MainActor public final class NativeFilmRenderer: FilmFrameRendering {
    private let manifest: FilmManifest
    private let plan: FilmSourcePlan
    private let journey: MediaJourney
    private let files: [String: URL]
    private let captions: [String: String]
    private let derivatives: [String: URL]
    private var sceneIndex = -1
    private var image: UIImage?
    private var mapSnapshot: MKMapSnapshotter.Snapshot?
    private var generator: AVAssetImageGenerator?
    private var videoDuration: Double = 0
    public init(manifest: FilmManifest, plan: FilmSourcePlan, journey: MediaJourney,
                files: [String: URL], captions: [String: String], derivatives: [String: URL]) throws {
        try manifest.validate(plan: plan, captions: captions)
        guard journey.id == manifest.journeyId, journey.revision == manifest.journeyRevision,
              manifest.narrativeSnapshot.matches(journey) else { throw MediaFailure.staleIntent }
        self.manifest = manifest; self.plan = plan; self.journey = journey
        self.files = files; self.captions = captions; self.derivatives = derivatives
    }
    public func render(_ frame: FilmFrame) async throws -> CGImage {
        try Task.checkCancellation()
        let scene = plan.scenes[frame.sourceSceneIndex].scene
        let size = CGSize(width: manifest.output.width, height: manifest.output.height)
        if sceneIndex != frame.sourceSceneIndex {
            sceneIndex = frame.sourceSceneIndex; image = nil; mapSnapshot = nil
            generator?.cancelAllCGImageGeneration(); generator = nil
            if scene.kind == "media" {
                guard let id = scene.mediaAssetId, let file = files[id] else { throw MediaFailure.unavailable }
                if scene.mediaType == "video" {
                    let asset = AVURLAsset(url: file)
                    videoDuration = try await asset.load(.duration).seconds
                    guard videoDuration.isFinite, videoDuration > 0 else { throw MediaFailure.unavailable }
                    let generator = AVAssetImageGenerator(asset: asset)
                    generator.appliesPreferredTrackTransform = true
                    generator.maximumSize = size
                    generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
                    self.generator = generator
                } else {
                    guard let image = UIImage(contentsOfFile: file.path) else { throw MediaFailure.unavailable }
                    self.image = image
                }
            } else {
                let options = MKMapSnapshotter.Options()
                options.size = size; options.scale = 1; options.mapType = .mutedStandard
                let points = journey.routePoints.map { MKMapPoint(CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)) }
                guard !points.isEmpty else { throw MediaFailure.invalidManifest }
                let rect = points.reduce(MKMapRect.null) { $0.union(MKMapRect(x: $1.x, y: $1.y, width: 1, height: 1)) }
                options.mapRect = rect.insetBy(dx: -max(rect.width * 0.15, 20_000), dy: -max(rect.height * 0.15, 20_000))
                let snapshotter = MKMapSnapshotter(options: options)
                mapSnapshot = try await withTaskCancellationHandler(operation: { try await snapshotter.start() }, onCancel: { snapshotter.cancel() })
            }
        }
        if let generator {
            // Last rendered video frame must be reachable; the exact EOF has no frame.
            let span = min(videoDuration, scene.durationMs / 1000)
            let time = min(max(0, span - 1 / Double(manifest.fps)), frame.progress * span)
            let generated = try await generator.image(at: CMTime(seconds: time, preferredTimescale: 600))
            image = UIImage(cgImage: generated.image)
        }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let output = UIGraphicsImageRenderer(size: size, format: format).image { renderer in
            let context = renderer.cgContext
            UIColor(white: 0.04, alpha: 1).setFill(); context.fill(CGRect(origin: .zero, size: size))
            if let image { drawFit(image, size: size) }
            if let snapshot = mapSnapshot {
                snapshot.image.draw(in: CGRect(origin: .zero, size: size))
                drawRoute(snapshot, scene: scene, progress: frame.progress, context: context)
                if scene.role == "intro" || scene.role == "outro" { drawCaption(journey.title, size: size) }
            }
            if let id = frame.openingDerivativeID, frame.openingOpacity > 0,
               let file = derivatives[id], let opening = UIImage(contentsOfFile: file.path) {
                context.saveGState(); context.setAlpha(frame.openingOpacity); drawFit(opening, size: size); context.restoreGState()
            }
            if let id = frame.captionID, let text = captions[id] { drawCaption(text, size: size) }
        }
        guard let result = output.cgImage else { throw MediaFailure.encoding }
        return result
    }
    private func drawFit(_ image: UIImage, size: CGSize) {
        let scale = min(size.width / image.size.width, size.height / image.size.height)
        let rect = CGRect(x: (size.width - image.size.width * scale) / 2,
                          y: (size.height - image.size.height * scale) / 2,
                          width: image.size.width * scale, height: image.size.height * scale)
        image.draw(in: rect)
    }
    private func drawCaption(_ text: String, size: CGSize) {
        let font = UIFont.systemFont(ofSize: max(18, size.width * 0.033), weight: .medium)
        let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white, .paragraphStyle: paragraph]
        let width = size.width * 0.84
        let bounds = (text as NSString).boundingRect(with: CGSize(width: width, height: size.height * 0.65), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes, context: nil)
        let rect = CGRect(x: size.width * 0.08, y: size.height * 0.87 - bounds.height, width: width, height: ceil(bounds.height))
        UIColor(white: 0.04, alpha: 0.8).setFill(); UIBezierPath(roundedRect: rect.insetBy(dx: -16, dy: -12), cornerRadius: 8).fill()
        (text as NSString).draw(in: rect, withAttributes: attributes)
    }
    private func drawRoute(_ snapshot: MKMapSnapshotter.Snapshot, scene: FilmScene, progress: Double, context: CGContext) {
        let points = journey.routePoints
        var last = points.count - 1
        if let target = scene.toRoutePointId ?? scene.routePointId, let index = points.firstIndex(where: { $0.id == target }) { last = index }
        context.setStrokeColor(UIColor.systemOrange.cgColor); context.setLineWidth(4)
        for index in 0...max(0, last) {
            let point = points[index]
            var position = snapshot.point(for: CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude))
            if index == last && scene.role == "travel" && index > 0 {
                let before = points[index - 1]
                let previous = snapshot.point(for: CLLocationCoordinate2D(latitude: before.latitude, longitude: before.longitude))
                position = CGPoint(x: previous.x + (position.x - previous.x) * progress, y: previous.y + (position.y - previous.y) * progress)
            }
            if index == 0 { context.move(to: position) } else { context.addLine(to: position) }
        }
        context.strokePath()
    }
}
