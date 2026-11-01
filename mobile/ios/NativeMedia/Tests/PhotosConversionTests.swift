import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import StartripsMedia

final class PhotosConversionTests: XCTestCase {
    @MainActor func testHEICConvertsToJPEGAndPreservesOrientation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("fixture.heic")
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 48), format: format).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 32, height: 48))
        }
        guard let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.heic.identifier as CFString, 1, nil) else {
            throw XCTSkip("This Apple runtime does not provide a HEIC encoder")
        }
        CGImageDestinationAddImage(destination, try XCTUnwrap(image.cgImage), [kCGImagePropertyOrientation: 6] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw XCTSkip("HEIC fixture encoding unavailable on this simulator") }
        let converted = try PhotosImportModel.prepare(file, type: .heic)
        XCTAssertEqual(converted.mime, "image/jpeg")
        let decoded = try XCTUnwrap(CGImageSourceCreateWithURL(converted.url as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(decoded) as String?, UTType.jpeg.identifier)
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil) as? [CFString: Any])
        XCTAssertEqual(properties[kCGImagePropertyOrientation] as? Int, 6)
    }
}
