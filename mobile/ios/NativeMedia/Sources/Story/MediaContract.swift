import Foundation

/// Narrow decoding of the existing projected Journey; never a second domain store.
public struct MediaJourney: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var note: String
    public var revision: Int
    public var coverMediaAssetId: String?
    public var routePoints: [MediaRoutePoint]
    public var media: [MediaAsset]
}

public struct MediaRoutePoint: Codable, Equatable, Sendable {
    public var id: String
    public var latitude: Double
    public var longitude: Double
    public var label: String
    public var isStop: Bool
    public var note: String?
    public var stayAnchorRoutePointId: String?
}

public struct MediaAsset: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var journeyId: String
    public var routePointId: String?
    public var fileName: String
    public var mimeType: String
    public var bytes: Int64
    public var sortOrder: Int
    public var isVideo: Bool { mimeType.hasPrefix("video/") }
    public var isVisual: Bool { isVideo || mimeType.hasPrefix("image/") }
}

public enum MediaFailure: Error, Equatable, LocalizedError {
    case unavailable, staleIntent, accessChanged, readOnly, invalidManifest, diskFull
    case invalidUpload, uploadPending, uploadStartUnknown, uploadAborted, uploadedAssetRemoved, missingETag, http(Int), encoding
    public var errorDescription: String? {
        switch self {
        case .unavailable: return "素材暂不可用，请重试。"
        case .staleIntent: return "旅程已更新，请重新打开。"
        case .accessChanged: return "访问权限已变化，请重新打开旅程。"
        case .readOnly: return "此分享仅支持查看。"
        case .invalidManifest: return "影片内容已变化，请重新生成。"
        case .diskFull: return "设备空间不足，请清理后重试。"
        case .invalidUpload: return "上传记录不完整，请重新选择素材。"
        case .uploadPending: return "服务器正在确认上传，请稍后恢复。"
        case .uploadStartUnknown: return "未收到上传编号，无法确认创建结果。请取消此项后重新选择素材。"
        case .uploadAborted: return "上传已取消，请重新选择素材。"
        case .uploadedAssetRemoved: return "素材已在上传完成后删除。"
        case .missingETag: return "存储服务未确认分片，请恢复上传。"
        case .http(let status): return "请求失败（\(status)），请重试。"
        case .encoding: return "无法生成影片，请重试。"
        }
    }
}

public struct StoryIntent: Codable, Equatable, Sendable {
    public var journeyId: String
    public var routePointId: String?
    public var assetId: String?
    public var revision: Int
    public var requestId: String
    public init(journeyId: String, routePointId: String?, assetId: String?, revision: Int, requestId: String) {
        self.journeyId = journeyId; self.routePointId = routePointId; self.assetId = assetId
        self.revision = revision; self.requestId = requestId
    }
}

/// Closures MUST capture one AtlasSession scope (including its generation). No global
/// cookie session or fallback owner signer is installed by this library.
@MainActor public struct ScopedMediaSession {
    public enum Access: String, Codable, Sendable { case owner, guest }
    public let scopeID: String
    public let access: Access
    public let read: (String) async throws -> URL
    public let request: (String, String, Data?) async throws -> Data
    public let imageTransport: URLSession
    public let revalidate: () async throws -> Void
    public init(scopeID: String, access: Access,
                imageTransport: URLSession = URLSession(configuration: .ephemeral),
                read: @escaping (String) async throws -> URL,
                request: @escaping (String, String, Data?) async throws -> Data,
                revalidate: @escaping () async throws -> Void) {
        self.scopeID = scopeID; self.access = access; self.read = read; self.imageTransport = imageTransport
        self.request = request; self.revalidate = revalidate
    }
    public func write(_ path: String, method: String = "POST", body: Data? = nil) async throws -> Data {
        guard access == .owner else { throw MediaFailure.readOnly }
        try await revalidate()
        try Task.checkCancellation()
        return try await request(path, method, body)
    }
    public func mediaURL(_ assetID: String) async throws -> URL {
        try await revalidate()
        let url = try await read(assetID)
        try Task.checkCancellation()
        try await revalidate()
        guard url.scheme == "https" else { throw MediaFailure.unavailable }
        return url
    }
}
