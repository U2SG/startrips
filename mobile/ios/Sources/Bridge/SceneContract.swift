import Foundation

enum AtlasAccess: String, Codable { case owner, guest }
enum SceneEventKind: String, Codable { case ready, select, story, invalidate, cameraInterrupted, rendered, switchAccess, sceneFailed }

struct SceneEvent: Codable, Equatable {
    let version: Int
    let kind: SceneEventKind
    let scopeId: String
    let requestId: String
    let revision: Int
    var journeyId: String?
    var routePointId: String?
    var assetId: String?
    var focusRequestId: String? = nil
}

extension SceneEvent {
    // A scene that could not decode its snapshot has no trusted scope or revision
    // to echo, so `sceneFailed` alone may omit them; every other kind still must carry both.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try values.decode(SceneEventKind.self, forKey: .kind)
        let unscoped = kind == .sceneFailed
        self.init(version: try values.decode(Int.self, forKey: .version), kind: kind,
                  scopeId: unscoped ? try values.decodeIfPresent(String.self, forKey: .scopeId) ?? ""
                                    : try values.decode(String.self, forKey: .scopeId),
                  requestId: try values.decode(String.self, forKey: .requestId),
                  revision: unscoped ? try values.decodeIfPresent(Int.self, forKey: .revision) ?? -1
                                     : try values.decode(Int.self, forKey: .revision),
                  journeyId: try values.decodeIfPresent(String.self, forKey: .journeyId),
                  routePointId: try values.decodeIfPresent(String.self, forKey: .routePointId),
                  assetId: try values.decodeIfPresent(String.self, forKey: .assetId),
                  focusRequestId: try values.decodeIfPresent(String.self, forKey: .focusRequestId))
    }
}

struct AtlasRoutePoint: Codable, Identifiable, Equatable {
    let id: String
    let latitude: Double
    let longitude: Double
    let label: String
    let isStop: Bool
    let occurredAt: String?
}

struct AtlasAsset: Codable, Identifiable, Equatable {
    let id: String
    let routePointId: String?
    let fileName: String
    let mimeType: String
    let bytes: Int
}

// Deliberate projection: no owner identity, session, share token or signed URL
// can be encoded into the local scene. Server order remains authoritative.
struct AtlasJourney: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let startedOn: String
    let endedOn: String?
    let note: String
    let lightColor: String
    let lightEffect: String?
    let routeSegments: [SceneJSON]?
    let revision: Int
    let routePoints: [AtlasRoutePoint]
    let media: [AtlasAsset]
}

// Preserve the existing server-projected segment geometry/provenance. Do not
// rebuild it from endpoint coordinates or promote sparse relations to tracks.
indirect enum SceneJSON: Codable, Equatable {
    case object([String: SceneJSON]), array([SceneJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let decoded = try? value.decode(Bool.self) { self = .bool(decoded) }
        else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
        else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
        else if let decoded = try? value.decode([SceneJSON].self) { self = .array(decoded) }
        else { self = .object(try value.decode([String: SceneJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let data): try value.encode(data)
        case .array(let data): try value.encode(data)
        case .string(let data): try value.encode(data)
        case .number(let data): try value.encode(data)
        case .bool(let data): try value.encode(data)
        case .null: try value.encodeNil()
        }
    }
}

struct StoryHandoff: Codable, Hashable {
    let journeyId: String
    var routePointId: String?
    var assetId: String?
    let revision: Int
    let requestId: String
}

struct SceneSnapshot: Codable {
    let version: Int
    let scopeId: String
    let revision: Int
    let access: AtlasAccess
    let earthExperience: String
    let journeys: [AtlasJourney]
    let selection: StoryHandoff?
    let active: Bool
}

enum BridgeFailure: Error { case invalidMessage, stale, unknownTarget }

func validateSceneEvent(_ event: SceneEvent, snapshot: SceneSnapshot) throws {
    guard event.version == 1, UUID(uuidString: event.requestId) != nil else { throw BridgeFailure.invalidMessage }
    if event.kind == .sceneFailed {
        // Origin and main-frame checks already happened in the message handler.
        guard event.journeyId == nil, event.routePointId == nil, event.assetId == nil,
              event.focusRequestId == nil else { throw BridgeFailure.invalidMessage }
        return
    }
    guard event.scopeId == snapshot.scopeId, event.revision == snapshot.revision else { throw BridgeFailure.stale }
    if event.kind == .rendered && event.focusRequestId != snapshot.selection?.requestId { throw BridgeFailure.stale }
    if [.select, .story].contains(event.kind) {
        guard let journey = snapshot.journeys.first(where: { $0.id == event.journeyId }) else { throw BridgeFailure.unknownTarget }
        if let point = event.routePointId, !journey.routePoints.contains(where: { $0.id == point }) { throw BridgeFailure.unknownTarget }
        if let asset = event.assetId {
            guard let media = journey.media.first(where: { $0.id == asset }),
                  event.routePointId == nil || media.routePointId == event.routePointId else { throw BridgeFailure.unknownTarget }
        }
    } else if event.journeyId != nil || event.routePointId != nil || event.assetId != nil {
        throw BridgeFailure.invalidMessage
    }
}
