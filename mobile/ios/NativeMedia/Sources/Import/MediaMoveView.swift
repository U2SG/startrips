import SwiftUI
import UIKit

@MainActor public final class MediaMoveModel: ObservableObject {
    @Published public var selected = Set<String>()
    @Published public var targetJourneyID: String
    @Published public var targetPointID: String?
    @Published public private(set) var journeys: [MediaJourney] = []
    @Published public private(set) var source: MediaJourney
    @Published public private(set) var busy = false
    @Published public private(set) var canUndo = false
    @Published public private(set) var failure: String?
    private let session: ScopedMediaSession
    private let refresh: (MediaJourney, MediaJourney) -> Void
    private lazy var controller = MediaMoveController(session: session) { [weak self] source, destination in
        guard let self else { return }
        self.source = source
        self.journeys = self.journeys.map { journey in
            journey.id == source.id ? source : journey.id == destination.id ? destination : journey
        }
        self.refresh(source, destination)
    }
    public init(session: ScopedMediaSession, journey: MediaJourney, refresh: @escaping (MediaJourney, MediaJourney) -> Void) {
        self.session = session; self.source = journey; self.targetJourneyID = journey.id; self.refresh = refresh
    }
    func updateSource(_ journey: MediaJourney) {
        source = journey
        selected.formIntersection(journey.media.map(\.id))
        if let index = journeys.firstIndex(where: { $0.id == journey.id }) { journeys[index] = journey }
        if targetJourneyID == journey.id, let targetPointID, !journey.routePoints.contains(where: { $0.id == targetPointID }) {
            self.targetPointID = nil
        }
    }
    public func load() async {
        guard session.access == .owner else { failure = MediaFailure.readOnly.localizedDescription; return }
        do {
            struct Response: Decodable { let journeys: [MediaJourney] }
            let data = try await session.write("/api/journeys", method: "GET")
            journeys = try JSONDecoder().decode(Response.self, from: data).journeys
        } catch { failure = error.localizedDescription }
    }
    public func move() async {
        guard !busy else { return }; busy = true; failure = nil
        defer { busy = false }
        do {
            try await controller.move(source: source, targetJourneyID: targetJourneyID, routePointID: targetPointID, assetIDs: selected.sorted())
            canUndo = true; selected = []
        } catch { failure = error.localizedDescription }
    }
    public func undo() async {
        guard !busy else { return }; busy = true; failure = nil
        defer { busy = false }
        do { try await controller.undo(); canUndo = false } catch { failure = error.localizedDescription }
    }
}

/// 整理 in the Story tools: pick media by picture; the destination and the move
/// button only appear once something is picked.
struct MediaMoveSection: View {
    @ObservedObject var model: MediaMoveModel
    let thumbnail: (MediaAsset) async -> UIImage?
    @ScaledMetric(relativeTo: .body) private var cell: CGFloat = 72
    private var visual: [MediaAsset] { model.source.media.filter(\.isVisual) }
    private var points: [MediaRoutePoint] {
        model.journeys.first(where: { $0.id == model.targetJourneyID })?.routePoints ?? []
    }

    var body: some View {
        if !visual.isEmpty || model.canUndo || model.failure != nil {
            Section("整理") {
                if !visual.isEmpty { grid }
                if !model.selected.isEmpty {
                    Picker("旅程", selection: $model.targetJourneyID) {
                        ForEach(model.journeys, id: \.id) { journey in Text(journey.title).tag(journey.id) }
                    }
                    .storyToolRow()
                    .accessibilityIdentifier("story.move.journey")
                    .onChange(of: model.targetJourneyID) { _ in model.targetPointID = nil }
                    Picker("途径点", selection: $model.targetPointID) {
                        Text("整个旅程").tag(String?.none)
                        ForEach(points, id: \.id) { point in Text(point.label).tag(Optional(point.id)) }
                    }
                    .storyToolRow()
                    .accessibilityIdentifier("story.move.point")
                    Button { Task { await model.move() } } label: {
                        Label("移动 \(model.selected.count) 项", systemImage: "arrow.right.circle")
                    }
                    .disabled(model.busy)
                    .storyToolRow()
                    .accessibilityIdentifier("story.move")
                }
                if model.canUndo {
                    Button { Task { await model.undo() } } label: { Label("撤销移动", systemImage: "arrow.uturn.backward") }
                        .disabled(model.busy)
                        .storyToolRow()
                        .accessibilityIdentifier("story.move.undo")
                }
                if let failure = model.failure { StoryToolNote(text: failure) }
            }
        }
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: cell), spacing: StoryTheme.grid(2))], spacing: StoryTheme.grid(2)) {
            ForEach(Array(visual.enumerated()), id: \.element.id) { index, asset in
                let chosen = model.selected.contains(asset.id)
                Button {
                    if chosen { model.selected.remove(asset.id) } else { model.selected.insert(asset.id) }
                } label: {
                    MoveThumbnail(asset: asset, load: thumbnail)
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: StoryTheme.grid(2), style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: StoryTheme.grid(2), style: .continuous)
                            .strokeBorder(chosen ? StoryTheme.accent : Color.clear, lineWidth: 2))
                        .overlay(alignment: .topTrailing) {
                            Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(chosen ? StoryTheme.accent : StoryTheme.ink)
                                .shadow(color: .black.opacity(0.5), radius: 2)
                                .padding(StoryTheme.grid(1))
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(asset.isVideo ? "视频" : "照片") \(index + 1)")
                .accessibilityAddTraits(chosen ? .isSelected : [])
                .accessibilityIdentifier("story.move.asset." + asset.id)
            }
        }
        .padding(.vertical, StoryTheme.grid(2))
        .listRowBackground(StoryTheme.surface)
        .task { await model.load() }
    }
}

/// A square picture of one asset, read through the Story's own image loading.
private struct MoveThumbnail: View {
    let asset: MediaAsset
    let load: (MediaAsset) async -> UIImage?
    @State private var image: UIImage?
    var body: some View {
        Rectangle().fill(StoryTheme.line)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Image(systemName: asset.isVideo ? "video" : "photo").foregroundStyle(StoryTheme.muted)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if asset.isVideo, image != nil {
                    Image(systemName: "video.fill").font(.caption).foregroundStyle(StoryTheme.ink)
                        .shadow(color: .black.opacity(0.5), radius: 2).padding(StoryTheme.grid(1))
                }
            }
            .clipped()
            .task(id: asset.id) { if image == nil { image = await load(asset) } }
    }
}
