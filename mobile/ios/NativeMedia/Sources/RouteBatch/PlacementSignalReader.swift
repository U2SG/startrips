import CoreLocation
import Foundation
import ImageIO
import Photos

/// Reads normalized placement evidence from a picked photo (HEIC, JPEG or any
/// ImageIO still), like the web `parseJpegExifPlacementSignal`. Only the
/// normalized signal is kept; raw metadata is discarded.
public enum PlacementSignalReader {
    public static func signal(at url: URL, libraryIdentifier: String? = nil) -> PlacementSignal? {
        var signal: PlacementSignal?
        if let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
           CGImageSourceGetCount(source) > 0,
           let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] {
            signal = Self.signal(properties: properties)
        }
        return merging(signal, library: libraryIdentifier.flatMap(libraryLocation))
    }

    /// The Photos library location of an already-authorized asset. Never asks
    /// for library access: without it the file's own metadata is all we read.
    static func libraryLocation(_ identifier: String) -> CLLocation? {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return nil }
        return PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil).firstObject?.location
    }

    /// A library coordinate only fills a missing file coordinate. Its time is
    /// not used: a library date has no wall clock or offset of the place.
    static func merging(_ file: PlacementSignal?, library: CLLocation?) -> PlacementSignal? {
        if file?.hasCoordinateEvidence == true { return file }
        guard let library, CLLocationCoordinate2DIsValid(library.coordinate),
              library.coordinate.latitude != 0 || library.coordinate.longitude != 0 else { return file }
        var merged = file ?? PlacementSignal(spatialSource: "unknown", spatialGranularity: "unknown",
                                             captureTimeSource: "unknown", timezoneState: "unknown")
        merged.latitude = library.coordinate.latitude
        merged.longitude = library.coordinate.longitude
        merged.spatialSource = "imported"
        merged.spatialGranularity = "coordinate"
        let accuracy = library.horizontalAccuracy
        merged.accuracyMeters = accuracy > 0 && accuracy <= 1_000_000 ? accuracy : nil
        return merged
    }

    public static func signal(properties: [String: Any]) -> PlacementSignal? {
        var signal = PlacementSignal(spatialSource: "unknown", spatialGranularity: "unknown", accuracyMeters: nil,
                                     captureTimeSource: "unknown", timezoneState: "unknown", offsetMinutes: nil)
        var hasEvidence = false
        var gpsTime: NormalizedTime?
        if let gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any] {
            let latRef = gps[kCGImagePropertyGPSLatitudeRef as String] as? String
            let lonRef = gps[kCGImagePropertyGPSLongitudeRef as String] as? String
            let lat = number(gps[kCGImagePropertyGPSLatitude as String])
            let lon = number(gps[kCGImagePropertyGPSLongitude as String])
            gpsTime = normalizeGps(date: gps[kCGImagePropertyGPSDateStamp as String] as? String,
                                   time: gps[kCGImagePropertyGPSTimeStamp as String])
            if let latRef, ["N", "S"].contains(latRef), let lonRef, ["E", "W"].contains(lonRef),
               let lat, let lon, lat.isFinite, lon.isFinite, (0...90).contains(lat), (0...180).contains(lon) {
                signal.latitude = latRef == "S" ? -lat : lat
                signal.longitude = lonRef == "W" ? -lon : lon
                signal.spatialSource = "exif"
                signal.spatialGranularity = "coordinate"
                if let accuracy = number(gps[kCGImagePropertyGPSHPositioningError as String]),
                   accuracy.isFinite, accuracy >= 0, accuracy <= 1_000_000 { signal.accuracyMeters = accuracy }
                hasEvidence = true
            }
        }
        var time: NormalizedTime?
        var source = "unknown"
        if let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any] {
            if let original = normalizeExif(exif[kCGImagePropertyExifDateTimeOriginal as String] as? String,
                                            offset: exif[kCGImagePropertyExifOffsetTimeOriginal as String] as? String) {
                time = original; source = "exif-original"
            } else if let digitized = normalizeExif(exif[kCGImagePropertyExifDateTimeDigitized as String] as? String,
                                                    offset: exif[kCGImagePropertyExifOffsetTimeDigitized as String] as? String) {
                time = digitized; source = "exif-digitized"
            }
        }
        if time == nil, let gpsTime { time = gpsTime; source = "gps" }
        if let time {
            signal.capturedAt = time.capturedAt
            signal.capturedLocal = time.capturedLocal
            signal.timezoneState = time.timezoneState
            signal.offsetMinutes = time.offsetMinutes
            signal.captureTimeSource = source
            hasEvidence = true
        }
        return hasEvidence ? signal : nil
    }

    struct NormalizedTime: Equatable {
        var capturedAt: String?
        var capturedLocal: String
        var timezoneState: String
        var offsetMinutes: Int?
    }

    private static func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) }
        return nil
    }

    static func normalizeExif(_ value: String?, offset: String?) -> NormalizedTime? {
        guard let p = PlacementTime.groups(#"^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$"#, value),
              let y = Int(p[1]!), let mo = Int(p[2]!), let d = Int(p[3]!),
              let h = Int(p[4]!), let mi = Int(p[5]!), let s = Int(p[6]!),
              PlacementTime.isValidDate(y, mo, d), h <= 23, mi <= 59, s <= 59 else { return nil }
        let local = "\(p[1]!)-\(p[2]!)-\(p[3]!)T\(p[4]!):\(p[5]!):\(p[6]!)"
        if let o = PlacementTime.groups(#"^([+-])(\d{2}):(\d{2})$"#, offset), let offset,
           let hours = Int(o[2]!), let minutes = Int(o[3]!),
           minutes <= 59, hours < 14 || (hours == 14 && minutes == 0) {
            let sign = o[1] == "-" ? -1 : 1
            return NormalizedTime(capturedAt: local + offset, capturedLocal: local,
                                  timezoneState: "offset-known", offsetMinutes: sign * (hours * 60 + minutes))
        }
        return NormalizedTime(capturedAt: nil, capturedLocal: local, timezoneState: "local-only", offsetMinutes: nil)
    }

    /// GPS time is UTC by definition. ImageIO reports `HH:mm:ss(.SS)` text.
    static func normalizeGps(date: String?, time: Any?) -> NormalizedTime? {
        guard let p = PlacementTime.groups(#"^(\d{4}):(\d{2}):(\d{2})$"#, date),
              let y = Int(p[1]!), let mo = Int(p[2]!), let d = Int(p[3]!) else { return nil }
        let parts: [Double]
        if let text = time as? String { parts = text.split(separator: ":").compactMap { Double($0) } }
        else if let array = time as? [NSNumber] { parts = array.map(\.doubleValue) }
        else { return nil }
        guard parts.count >= 3 else { return nil }
        let (hour, minute, secondValue) = (parts[0], parts[1], parts[2])
        guard PlacementTime.isValidDate(y, mo, d), hour >= 0, hour < 24, minute >= 0, minute < 60,
              secondValue >= 0, secondValue < 60, hour == hour.rounded(.down), minute == minute.rounded(.down) else { return nil }
        let second = secondValue.rounded(.down)
        let ms = ((secondValue - second) * 1000).rounded()
        let instant = PlacementTime.millis(y, mo, d, Int(hour), Int(minute), Int(second), 0) + ms
        let capturedAt = PlacementTime.isoString(instant)
        let capturedLocal = capturedAt.hasSuffix(".000Z") ? String(capturedAt.dropLast(5)) : String(capturedAt.dropLast())
        return NormalizedTime(capturedAt: capturedAt, capturedLocal: capturedLocal, timezoneState: "offset-known", offsetMinutes: 0)
    }
}

/// The optional `recordedEvidence` document of `POST /api/uploads/start`
/// (server/media/media-evidence.ts), built like the web
/// `recordedEvidenceForPlacementRead`. Metadata about the bytes, never authority.
public struct RecordedEvidence: Codable, Equatable, Sendable {
    public struct Spatial: Codable, Equatable, Sendable {
        public var source: String
        public var granularity: String
        public var latitude: Double
        public var longitude: Double
        public var accuracyMeters: Double?
    }
    public struct CaptureTime: Codable, Equatable, Sendable {
        public var source: String
        public var timezone: String
        public var local: String?
        public var instant: String?
        public var offsetMinutes: Int?
    }
    public var spatial: Spatial
    public var captureTime: CaptureTime

    public init?(_ signal: PlacementSignal?) {
        guard let signal, signal.spatialGranularity == "coordinate", let source = signal.spatialSource, source != "unknown",
              let latitude = signal.latitude, let longitude = signal.longitude, latitude.isFinite, longitude.isFinite else { return nil }
        spatial = Spatial(source: source, granularity: "coordinate", latitude: latitude, longitude: longitude,
                          accuracyMeters: signal.accuracyMeters)
        let timeSource = signal.captureTimeSource ?? "unknown"
        if signal.timezoneState == "offset-known", timeSource != "unknown", let local = signal.capturedLocal,
           let instant = signal.capturedAt, let offset = signal.offsetMinutes {
            captureTime = CaptureTime(source: timeSource, timezone: "offset-known", local: local, instant: instant, offsetMinutes: offset)
        } else if signal.timezoneState == "local-only", timeSource != "unknown", let local = signal.capturedLocal {
            captureTime = CaptureTime(source: timeSource, timezone: "local-only", local: local, instant: nil, offsetMinutes: nil)
        } else {
            captureTime = CaptureTime(source: "unknown", timezone: "unknown", local: nil, instant: nil, offsetMinutes: nil)
        }
    }

    /// Explicit nulls, matching the web document byte for byte in shape.
    public func encode(to encoder: Encoder) throws {
        enum Keys: String, CodingKey { case spatial, captureTime, source, granularity, latitude, longitude, accuracyMeters, label
            case timezone, local, instant, offsetMinutes }
        var root = encoder.container(keyedBy: Keys.self)
        var space = root.nestedContainer(keyedBy: Keys.self, forKey: .spatial)
        try space.encode(spatial.source, forKey: .source)
        try space.encode(spatial.granularity, forKey: .granularity)
        try space.encode(spatial.latitude, forKey: .latitude)
        try space.encode(spatial.longitude, forKey: .longitude)
        try space.encode(spatial.accuracyMeters, forKey: .accuracyMeters)
        try space.encodeNil(forKey: .label)
        var time = root.nestedContainer(keyedBy: Keys.self, forKey: .captureTime)
        try time.encode(captureTime.source, forKey: .source)
        try time.encode(captureTime.timezone, forKey: .timezone)
        try time.encode(captureTime.local, forKey: .local)
        try time.encode(captureTime.instant, forKey: .instant)
        try time.encode(captureTime.offsetMinutes, forKey: .offsetMinutes)
    }
}
