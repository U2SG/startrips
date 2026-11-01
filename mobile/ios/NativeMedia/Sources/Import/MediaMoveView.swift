import SwiftUI

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

public struct MediaMoveView: View {
    @ObservedObject var model: MediaMoveModel
    public init(model: MediaMoveModel) { self.model = model }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("移动素材").font(.headline)
            ForEach(model.source.media.filter(\.isVisual)) { asset in
                Toggle(asset.fileName, isOn: Binding(get: { model.selected.contains(asset.id) }, set: { selected in
                    if selected { model.selected.insert(asset.id) } else { model.selected.remove(asset.id) }
                })).frame(minHeight: 44)
            }
            Picker("旅程", selection: $model.targetJourneyID) {
                ForEach(model.journeys, id: \.id) { journey in Text(journey.title).tag(journey.id) }
            }
            Picker("途径点", selection: $model.targetPointID) {
                Text("整个旅程").tag(String?.none)
                ForEach(model.journeys.first(where: { $0.id == model.targetJourneyID })?.routePoints ?? [], id: \.id) { point in
                    Text(point.label).tag(Optional(point.id))
                }
            }
            Button("移动所选素材") { Task { await model.move() } }.disabled(model.busy || model.selected.isEmpty).frame(minHeight: 44)
            if model.canUndo { Button("撤销移动") { Task { await model.undo() } }.disabled(model.busy).frame(minHeight: 44) }
            if let failure = model.failure { Text(failure).font(.callout) }
        }.task { await model.load() }
            .onChange(of: model.targetJourneyID) { _ in model.targetPointID = nil }
    }
}
