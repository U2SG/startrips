import AVFoundation
import UIKit
import XCTest
@testable import StartripsMedia

private struct FilmFixture: Decodable {
    let manifest: FilmManifest
    let plan: FilmSourcePlan
    let captions: [String: String]
}

@MainActor private final class SolidFrames: FilmFrameRendering {
    let first: CGImage
    let last: CGImage
    var calls = 0
    var didRender: (() -> Void)?
    init(size: CGSize) {
        first = Self.image(.red, size: size); last = Self.image(.blue, size: size)
    }
    static func image(_ color: UIColor, size: CGSize) -> CGImage {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            color.setFill(); context.fill(CGRect(origin: .zero, size: size))
        }.cgImage!
    }
    func render(_ frame: FilmFrame) async throws -> CGImage {
        calls += 1; didRender?()
        return frame.sourceSceneIndex == 0 ? first : last
    }
}

final class FilmExportTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func fixture(long: Bool = false) throws -> FilmFixture {
        if !long { return try MediaFixtures.decode("film") }
        let url = try XCTUnwrap(Bundle.module.url(forResource: "film", withExtension: "json", subdirectory: "Fixtures"))
        var root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        var manifest = root["manifest"] as! [String: Any], plan = root["plan"] as! [String: Any]
        manifest["totalFrames"] = 2904; manifest["actualDurationMs"] = 121000; manifest["sourceDurationMs"] = 121000
        var shots = manifest["shots"] as! [[String: Any]]; shots[2]["endFrame"] = 2904; manifest["shots"] = shots
        var scenes = plan["scenes"] as! [[String: Any]]
        scenes[2]["endMs"] = 121000
        var scene = scenes[2]["scene"] as! [String: Any]; scene["durationMs"] = 117000; scenes[2]["scene"] = scene
        plan["scenes"] = scenes; plan["actualDurationMs"] = 121000
        root["manifest"] = manifest; root["plan"] = plan
        return try JSONDecoder().decode(FilmFixture.self, from: JSONSerialization.data(withJSONObject: root))
    }
    func testExistingManifestFrameBoundariesOpeningAndCaptions() throws {
        let film = try fixture()
        try film.manifest.validate(plan: film.plan, captions: film.captions)
        XCTAssertTrue(film.manifest.narrativeSnapshot.matches(try MediaFixtures.journey()))
        XCTAssertEqual(try film.manifest.sample(frame: 0).sourceSceneIndex, 0)
        XCTAssertEqual(try film.manifest.sample(frame: 24).openingOpacity, 1)
        XCTAssertEqual(try film.manifest.sample(frame: 95).openingOpacity, 0)
        XCTAssertEqual(try film.manifest.sample(frame: 24).captionID, "caption:1:0")
        XCTAssertNil(try film.manifest.sample(frame: 96).captionID)
        XCTAssertEqual(try film.manifest.sample(frame: 119).progress, 1)
        XCTAssertThrowsError(try film.manifest.sample(frame: 120))
        XCTAssertThrowsError(try film.manifest.validate(plan: film.plan, captions: [:]))
    }
    func testNativePreparationKeepsAllAssetsCanonicalOwnersAndTransitNotes() throws {
        let journey = try MediaFixtures.journey()
        let prepared = try FilmPreparation.prepare(journey: journey)
        try prepared.manifest.validate(plan: prepared.plan, captions: prepared.captions)
        XCTAssertEqual(prepared.plan.scenes.compactMap { $0.scene.mediaAssetId }, ["intro-photo", "photo-one", "video-two"])
        XCTAssertTrue(prepared.captions.values.contains("路上的风"))
        XCTAssertTrue(prepared.captions.values.contains("海边"))
        XCTAssertEqual(prepared.plan.scenes.first?.scene.role, "intro")
        XCTAssertEqual(prepared.plan.scenes.last?.scene.role, "outro")
        XCTAssertEqual(prepared.manifest.narrativeSnapshot.visualMedia.map(\.mediaAssetId), ["intro-photo", "photo-one", "video-two"])
    }
    func testReadableMinimumsCanExceedTwoMinutesWithoutDroppingMedia() throws {
        var journey = try MediaFixtures.journey()
        let photo = journey.media[1]
        journey.media = (0..<100).map { index in
            var value = photo; value.id = "photo-\(index)"; value.sortOrder = index; return value
        }
        let prepared = try FilmPreparation.prepare(journey: journey, presetSeconds: 15)
        XCTAssertGreaterThan(prepared.manifest.actualDurationMs, 120000)
        XCTAssertEqual(prepared.plan.scenes.filter { $0.scene.kind == "media" }.count, 100)
        XCTAssertEqual(prepared.manifest.shots.last?.endFrame, prepared.manifest.totalFrames)
    }
    @MainActor func testRealRendererCompositesOpeningAndCaptionOnOriginalPhoto() async throws {
        let film = try fixture(), root = try directory(), size = CGSize(width: 64, height: 96)
        let photo = root.appendingPathComponent("photo.png"), opening = root.appendingPathComponent("opening.png")
        try UIImage(cgImage: SolidFrames.image(.red, size: size)).pngData()!.write(to: photo)
        try UIImage(cgImage: SolidFrames.image(.green, size: size)).pngData()!.write(to: opening)
        let renderer = try NativeFilmRenderer(manifest: film.manifest, plan: film.plan, journey: MediaFixtures.journey(),
            files: ["photo-one": photo], captions: film.captions, derivatives: ["cover-one": opening])
        let first = try await renderer.render(film.manifest.sample(frame: 24))
        let last = try await renderer.render(film.manifest.sample(frame: 95))
        XCTAssertEqual(first.width, 64); XCTAssertEqual(last.height, 96)
        XCTAssertNotEqual(UIImage(cgImage: first).pngData(), UIImage(cgImage: last).pngData())
    }
    @MainActor func testCompleteMP4LongerThanTwoMinutesHasBeginningAndFinalFrame() async throws {
        let film = try fixture(long: true), root = try directory()
        try film.manifest.validate(plan: film.plan, captions: film.captions)
        let renderer = SolidFrames(size: CGSize(width: 64, height: 96))
        let output = root.appendingPathComponent("complete.mp4")
        var authorizations = 0
        _ = try await NativeMP4Exporter().export(manifest: film.manifest, renderer: renderer, destination: output,
            authorize: { authorizations += 1 }, availableBytes: { Int64.max })
        XCTAssertEqual(renderer.calls, 2904)
        XCTAssertGreaterThanOrEqual(authorizations, 6)
        let asset = AVURLAsset(url: output)
        let duration = try await asset.load(.duration)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        XCTAssertTrue(audio.isEmpty)
        XCTAssertEqual(duration.seconds, 121, accuracy: 1.0 / 24)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        let beginning = try await generator.image(at: .zero).image
        let ending = try await generator.image(at: CMTime(value: 2903, timescale: 24)).image
        XCTAssertNotEqual(UIImage(cgImage: beginning).pngData(), UIImage(cgImage: ending).pngData())
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["complete.mp4"])
    }
    @MainActor func testCancellationAndDiskFailureLeaveNoArtifact() async throws {
        let film = try fixture(), root = try directory(), output = root.appendingPathComponent("cancelled.mp4")
        let renderer = SolidFrames(size: CGSize(width: 64, height: 96))
        do {
            _ = try await NativeMP4Exporter().export(manifest: film.manifest, renderer: renderer, destination: output,
                authorize: {}, availableBytes: { 0 })
            XCTFail("Disk budget ignored")
        } catch { XCTAssertEqual(error as? MediaFailure, .diskFull) }
        XCTAssertEqual(renderer.calls, 0)
        var operation: Task<URL, Error>!
        renderer.didRender = { if renderer.calls == 2 { operation.cancel() } }
        operation = Task {
            try await NativeMP4Exporter().export(manifest: film.manifest, renderer: renderer, destination: output,
                authorize: {}, availableBytes: { Int64.max })
        }
        do { _ = try await operation.value; XCTFail("Cancelled export succeeded") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }
    @MainActor func testAuthorizationRevocationAfterEncodeDeletesOutput() async throws {
        let film = try fixture(), root = try directory(), output = root.appendingPathComponent("revoked.mp4")
        var checks = 0
        do {
            _ = try await NativeMP4Exporter().export(manifest: film.manifest,
                renderer: SolidFrames(size: CGSize(width: 64, height: 96)), destination: output,
                authorize: { checks += 1; if checks == 6 { throw MediaFailure.accessChanged } }, availableBytes: { Int64.max })
            XCTFail("Revoked artifact was published")
        } catch { XCTAssertEqual(error as? MediaFailure, .accessChanged) }
        XCTAssertEqual(checks, 6)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }
    @MainActor func testBGMIsMuxedForTheWholeFilm() async throws {
        let film = try fixture(), root = try directory(), wav = root.appendingPathComponent("tone.wav")
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 24000))
        buffer.frameLength = 24000
        let samples = try XCTUnwrap(buffer.floatChannelData)[0]
        for index in 0..<24000 { samples[index] = Float(sin(Double(index) * 2 * .pi * 440 / 48000)) * 0.05 }
        do { let audio = try AVAudioFile(forWriting: wav, settings: format.settings); try audio.write(from: buffer) }
        let output = root.appendingPathComponent("soundtrack.mp4")
        _ = try await NativeMP4Exporter().export(manifest: film.manifest, renderer: SolidFrames(size: CGSize(width: 64, height: 96)),
            destination: output, soundtrack: wav, authorize: {}, availableBytes: { Int64.max })
        let asset = AVURLAsset(url: output)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 1)
        let span = try await XCTUnwrap(tracks.first).load(.timeRange)
        XCTAssertEqual(span.duration.seconds, 5, accuracy: 0.1)
    }
}
