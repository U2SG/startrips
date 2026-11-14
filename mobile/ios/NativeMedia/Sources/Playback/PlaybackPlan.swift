import Foundation

public enum NarrativeTempo: String, Codable, CaseIterable, Sendable { case fast, standard, immersive }

public struct PlaybackBeat: Equatable, Identifiable, Sendable {
    public enum Kind: String, Sendable { case homePrelude, intro, travel, arrival, media, note, homeEpilogue, outro }
    public let id: String
    public let kind: Kind
    public let routePointId: String?
    public let asset: MediaAsset?
    public let text: String
    public let durationMS: Double
    public let trim: VideoTrim?
    public var meaningful: Bool { kind != .travel }
}

public struct VideoTrim: Equatable, Codable, Sendable {
    public let inMs: Double
    public let outMs: Double
    public init(inMs: Double, outMs: Double) { self.inMs = inMs; self.outMs = outMs }
    public func resolved(sourceSeconds: Double) -> ClosedRange<Double>? {
        guard inMs.isFinite, outMs.isFinite, inMs >= 0, outMs > inMs,
              sourceSeconds.isFinite, sourceSeconds > 0, inMs / 1000 < sourceSeconds else { return nil }
        let end = min(outMs / 1000, sourceSeconds)
        guard end - inMs / 1000 > 0.12 else { return nil }
        return inMs / 1000 ... end
    }
}

public enum NarrativeTiming {
    // Literal parity with narrativeTiming.ts FULL_PROFILES, not a global rate multiplier.
    static func profile(_ tempo: NarrativeTempo) -> [Double] {
        switch tempo {
        case .fast: return [800, 420, 300, 1000, 650, 10, 1000, 1700, 4200, 1000]
        case .standard: return [1100, 650, 450, 1400, 950, 14, 1500, 2800, 6000, 1500]
        case .immersive: return [1400, 900, 650, 1900, 1500, 18, 2600, 4500, 8000, 2000]
        }
    }
    public static func note(_ text: String) -> Double {
        min(9000, 3500 + Double(text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count) * 18)
    }
    public static func duration(_ kind: PlaybackBeat.Kind, tempo: NarrativeTempo,
                                radians: Double = 0, text: String = "", video: Bool = false) -> Double {
        let p = profile(tempo)
        switch kind {
        case .homePrelude, .intro: return p[0]
        case .travel: return min(p[3], p[1] + max(0, radians) * p[2])
        case .arrival: return min(p[6], p[4] + Double(text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count) * p[5])
        case .media: return video ? p[8] : p[7]
        case .note: return note(text)
        case .homeEpilogue, .outro: return p[9]
        }
    }
}

public enum JourneyPlaybackPlan {
    public static func build(_ journey: MediaJourney, tempo: NarrativeTempo = .standard,
                             preludeID: String? = nil, epilogueID: String? = nil,
                             overrides: [String: Double] = [:], trims: [String: VideoTrim] = [:]) -> [PlaybackBeat] {
        var beats: [PlaybackBeat] = []
        func append(_ kind: PlaybackBeat.Kind, id: String, point: MediaRoutePoint? = nil,
                    asset: MediaAsset? = nil, radians: Double = 0, text: String? = nil) {
            let content = text ?? point?.note ?? ""
            let duration = overrides[id].flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
                ?? NarrativeTiming.duration(kind, tempo: tempo, radians: radians, text: content, video: asset?.isVideo == true)
            beats.append(PlaybackBeat(id: id, kind: kind, routePointId: point?.id, asset: asset,
                                      text: content, durationMS: duration, trim: trims[id]))
        }
        if let preludeID { append(.homePrelude, id: "home-prelude:\(preludeID)") }
        append(.intro, id: "intro", text: journey.title)
        var previousChapter = 0
        for (index, point) in journey.routePoints.enumerated() {
            guard journey.chapterID(for: point) == point.id else { continue }
            let members = journey.routePoints.filter { journey.chapterID(for: $0) == point.id }
            let assets = members.flatMap { journey.ownedMedia($0.id) }
            if !point.isStop && assets.isEmpty {
                let note = (point.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !note.isEmpty { append(.note, id: "note:\(point.id)", point: point, text: note) }
                continue
            }
            if index > 0 {
                let distance = (previousChapter..<index).reduce(0.0) { value, offset in
                    value + angularDistance(journey.routePoints[offset], journey.routePoints[offset + 1])
                }
                append(.travel, id: "travel:\(point.id)", point: point, radians: distance, text: point.label)
            }
            previousChapter = index
            if point.isStop { append(.arrival, id: "arrival:\(point.id)", point: point) }
            for member in members {
                let media = journey.ownedMedia(member.id)
                let note = (member.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !member.isStop && !note.isEmpty && (media.isEmpty || note.utf16.count > 140) {
                    append(.note, id: "note:\(member.id)", point: member, text: note)
                }
                for asset in media { append(.media, id: "media:\(asset.id)", point: point, asset: asset) }
            }
        }
        if let epilogueID { append(.homeEpilogue, id: "home-epilogue:\(epilogueID)") }
        append(.outro, id: "outro", text: journey.title)
        return beats
    }
    static func angularDistance(_ a: MediaRoutePoint, _ b: MediaRoutePoint) -> Double {
        let lat1 = a.latitude * .pi / 180, lat2 = b.latitude * .pi / 180
        let dLat = lat2 - lat1, dLon = (b.longitude - a.longitude) * .pi / 180
        let h = min(1, max(0, pow(sin(dLat / 2), 2) + cos(lat1) * cos(lat2) * pow(sin(dLon / 2), 2)))
        return 2 * atan2(sqrt(h), sqrt(1 - h))
    }
}

/// Time is injected; tests never sleep. Healthy video owns completion, including buffering.
public struct PlaybackClock {
    public private(set) var beats: [PlaybackBeat]
    public private(set) var index = 0
    public private(set) var elapsedMS: Double = 0
    public var paused = false
    public var completed: Bool { index >= beats.count }
    public var current: PlaybackBeat? { completed ? nil : beats[index] }
    public init(beats: [PlaybackBeat]) { self.beats = beats }
    public mutating func tick(milliseconds: Double, mediaReady: Bool, videoOwnsCompletion: Bool) {
        guard !paused, !completed, mediaReady, !videoOwnsCompletion, milliseconds.isFinite else { return }
        elapsedMS += max(0, milliseconds)
        if elapsedMS >= beats[index].durationMS { advance() }
    }
    public mutating func advance() { if !completed { index += 1; elapsedMS = 0 } }
    public mutating func seek(_ target: Int) {
        guard beats.indices.contains(target) else { return }
        index = target; elapsedMS = 0
    }
    public mutating func changeTempo(to newBeats: [PlaybackBeat]) {
        let identity = current?.id
        let fraction = (current?.durationMS ?? 0) > 0 ? elapsedMS / beats[index].durationMS : 0
        beats = newBeats
        index = newBeats.firstIndex { $0.id == identity } ?? min(index, newBeats.count)
        elapsedMS = (current?.durationMS ?? 0) * fraction
    }
    /// Equal except for time spent inside the current beat.
    public static func sameForViews(_ lhs: PlaybackClock?, _ rhs: PlaybackClock?) -> Bool {
        guard let lhs, let rhs else { return lhs == nil && rhs == nil }
        return lhs.index == rhs.index && lhs.paused == rhs.paused && lhs.beats == rhs.beats
    }
    /// The beat that shows this asset, if the plan has one.
    public func beatIndex(for assetID: String) -> Int? { beats.firstIndex { $0.asset?.id == assetID } }
    public mutating func nextMeaningful(_ direction: Int) {
        let candidates = beats.indices.filter { beats[$0].meaningful && (direction > 0 ? $0 > index : $0 < index) }
        if let target = direction > 0 ? candidates.first : candidates.last { seek(target) }
    }
}
