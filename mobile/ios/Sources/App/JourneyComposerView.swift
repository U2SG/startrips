import SwiftUI
import MapKit

/// What the owner opened the composer for.
enum ComposerTarget: Identifiable {
    case create
    case edit(AtlasJourney)

    var id: String {
        switch self {
        case .create: return "create"
        case .edit(let journey): return "edit:" + journey.id
        }
    }
}

/// Native create/edit of one Journey and its Route Points (owner only). The
/// layout carries meaning: no section titles or helper copy.
struct JourneyComposerView: View {
    let target: ComposerTarget
    let store: any JourneyStore
    let onSaved: (AtlasJourney) -> Void
    let onDeleted: (AtlasJourney) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var base: JourneyDraft
    @State private var draft: JourneyDraft
    @State private var editing: PointEditing?
    @State private var saving = false
    @State private var message: String?
    /// Counts refused saves, so the same message scrolls back into view each time.
    @State private var refusals = 0
    @State private var latest: JourneyDraft?
    @State private var confirmDiscard = false
    @State private var confirmDelete = false

    init(target: ComposerTarget, store: any JourneyStore,
         onSaved: @escaping (AtlasJourney) -> Void, onDeleted: @escaping (AtlasJourney) -> Void) {
        self.target = target; self.store = store; self.onSaved = onSaved; self.onDeleted = onDeleted
        let initial: JourneyDraft
        switch target {
        case .create: initial = .new()
        case .edit(let journey): initial = JourneyDraft(journey)
        }
        _base = State(initialValue: initial)
        _draft = State(initialValue: initial)
    }

    private var journey: AtlasJourney? {
        if case .edit(let journey) = target { return journey }
        return nil
    }
    private var dirty: Bool { draft != base }
    private static let errorRow = "composer.error-row"

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            Form {
                // First row, scrolled into view when Save is refused, however long the route is.
                if let message {
                    Section {
                        Text(message)
                            .foregroundStyle(Color(hex: 0xFF9F8F))
                            .accessibilityIdentifier("composer.error")
                    }
                    .id(Self.errorRow)
                }
                Section {
                    TextField("旅程标题", text: $draft.title)
                        .font(NightFlight.serif(.title3))
                        .submitLabel(.done)
                        .frame(minHeight: NightFlight.hitTarget)
                        .accessibilityIdentifier("composer.title")
                    DatePicker("开始日期", selection: day(\.startedOn), displayedComponents: .date)
                        .frame(minHeight: NightFlight.hitTarget)
                        .accessibilityIdentifier("composer.started")
                    Toggle("结束日期", isOn: Binding(
                        get: { draft.endedOn != nil },
                        set: { draft.endedOn = $0 ? (draft.endedOn ?? draft.startedOn) : nil }))
                        .tint(NightFlight.accent)
                        .frame(minHeight: NightFlight.hitTarget)
                        .accessibilityIdentifier("composer.has-end")
                    if draft.endedOn != nil {
                        DatePicker("结束日期", selection: endDay, in: (JourneyDraft.calendarDay.date(from: draft.startedOn) ?? .distantPast)...,
                                   displayedComponents: .date)
                            .frame(minHeight: NightFlight.hitTarget)
                            .accessibilityIdentifier("composer.ended")
                    }
                    colors
                }
                Section {
                    ForEach(Array(draft.points.enumerated()), id: \.element.id) { index, point in
                        pointRow(index, point)
                    }
                    .onMove { draft.points.move(fromOffsets: $0, toOffset: $1) }
                    .onDelete { draft.points.remove(atOffsets: $0) }
                    if draft.points.count < JourneyDraft.maxRoutePoints {
                        Button { editing = PointEditing(index: nil) } label: {
                            Label("添加路线点", systemImage: "plus")
                                .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("composer.add-point")
                    }
                }
                Section {
                    TextField("旅程故事", text: $draft.note, axis: .vertical)
                        .lineLimit(4...12)
                        .font(NightFlight.serif(.body))
                        .accessibilityIdentifier("composer.note")
                }
                if journey != nil {
                    Section {
                        Button("删除旅程", role: .destructive) { confirmDelete = true }
                            .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                            .contentShape(Rectangle())
                            .accessibilityIdentifier("composer.delete")
                    }
                }
            }
            .onChange(of: refusals) { _, _ in
                withAnimation { proxy.scrollTo(Self.errorRow, anchor: .top) }
            }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(NightFlight.background.ignoresSafeArea())
            .foregroundStyle(NightFlight.ink)
            .disabled(saving)
            .navigationTitle(journey == nil ? "新建旅程" : "编辑旅程")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { if dirty { confirmDiscard = true } else { dismiss() } }
                        .accessibilityIdentifier("composer.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView().accessibilityLabel("正在保存")
                    } else {
                        Button("保存") { Task { await save() } }
                            .fontWeight(.semibold)
                            .disabled(journey != nil && !dirty)
                            .accessibilityIdentifier("composer.save")
                    }
                }
            }
            .navigationDestination(item: $editing) { editing in
                RoutePointEditor(point: editing.index.flatMap { draft.points.indices.contains($0) ? draft.points[$0] : nil },
                                 near: nearby(editing.index), store: store) { point in
                    if let index = editing.index, draft.points.indices.contains(index) { draft.points[index] = point }
                    else { draft.points.append(point) }
                }
            }
        }
        .tint(NightFlight.ink)
        .interactiveDismissDisabled(dirty || saving)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(NightFlight.radiusLarge)
        .presentationBackground(NightFlight.background)
        .accessibilityIdentifier("composer")
        .confirmationDialog("放弃修改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { dismiss() }
            Button("继续编辑", role: .cancel) {}
        }
        .confirmationDialog("删除旅程？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除旅程", role: .destructive) { Task { await delete() } }
            Button("取消", role: .cancel) {}
        }
        // A stale save never overwrites: reload the newer Journey, or merge the
        // member's edits into it for review before saving again.
        .alert(JourneyWriteFailure.routeChanged.localizedDescription,
               isPresented: Binding(get: { latest != nil }, set: { if !$0 { latest = nil } })) {
            Button("合并我的修改") { resolve(merge: true) }
                .accessibilityIdentifier("composer.conflict.merge")
            Button("载入最新") { resolve(merge: false) }
                .accessibilityIdentifier("composer.conflict.reload")
            Button("取消", role: .cancel) {}
        }
    }

    // MARK: Fields

    /// Spoken names for `JourneyDraft.lightColors`, in the same order.
    private static let colorNames = ["金色", "珊瑚色", "青色", "蓝色", "紫色"]

    private var colors: some View {
        HStack(spacing: NightFlight.grid(3)) {
            ForEach(Array(zip(JourneyDraft.lightColors, Self.colorNames)), id: \.0) { color, name in
                let selected = draft.lightColor.lowercased() == color
                Button { draft.lightColor = color } label: {
                    Circle().fill(Color(cssHex: color))
                        .frame(width: NightFlight.grid(7), height: NightFlight.grid(7))
                        .overlay(Circle().stroke(NightFlight.ink, lineWidth: 2)
                            .frame(width: NightFlight.grid(9), height: NightFlight.grid(9))
                            .opacity(selected ? 1 : 0))
                        .frame(width: NightFlight.hitTarget, height: NightFlight.hitTarget)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(name)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("composer.color." + String(color.dropFirst()))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pointRow(_ index: Int, _ point: RouteDraftPoint) -> some View {
        let name = point.label.trimmingCharacters(in: .whitespaces).isEmpty ? "路线点 \(index + 1)" : point.label
        return Button { editing = PointEditing(index: index) } label: {
            HStack(spacing: NightFlight.grid(3)) {
                Text(String(format: "%02d", index + 1)).font(.footnote.monospacedDigit()).nightFlightMuted()
                    .accessibilityHidden(true)
                Text(name).foregroundStyle(NightFlight.ink).lineLimit(2)
                Spacer(minLength: 0)
                if point.isStop { Image(systemName: "mappin").foregroundStyle(NightFlight.accent).accessibilityHidden(true) }
            }
            .frame(minHeight: NightFlight.hitTarget)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(point.isStop ? "停靠点：" + name : name)
        .accessibilityIdentifier("composer.point.\(index)")
        .accessibilityAction(named: "上移") { move(index, by: -1) }
        .accessibilityAction(named: "下移") { move(index, by: 1) }
        .contextMenu {
            if index > 0 { Button("上移", systemImage: "arrow.up") { move(index, by: -1) } }
            if index < draft.points.count - 1 { Button("下移", systemImage: "arrow.down") { move(index, by: 1) } }
            Button("删除", systemImage: "trash", role: .destructive) { draft.points.remove(at: index) }
        }
    }

    private func move(_ index: Int, by step: Int) {
        let target = index + step
        guard draft.points.indices.contains(index), draft.points.indices.contains(target) else { return }
        draft.points.swapAt(index, target)
    }

    private func nearby(_ index: Int?) -> CLLocationCoordinate2D? {
        let source = index.flatMap { draft.points.indices.contains($0) ? draft.points[$0] : nil } ?? draft.points.last
        return source.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) }
    }

    private func day(_ keyPath: WritableKeyPath<JourneyDraft, String>) -> Binding<Date> {
        Binding(get: { JourneyDraft.calendarDay.date(from: draft[keyPath: keyPath]) ?? Date() },
                set: {
                    draft[keyPath: keyPath] = JourneyDraft.calendarDay.string(from: $0)
                    if let endedOn = draft.endedOn, endedOn < draft.startedOn { draft.endedOn = draft.startedOn }
                })
    }

    private var endDay: Binding<Date> {
        Binding(get: { draft.endedOn.flatMap { JourneyDraft.calendarDay.date(from: $0) } ?? Date() },
                set: { draft.endedOn = JourneyDraft.calendarDay.string(from: $0) })
    }

    // MARK: Actions

    private func save() async {
        if let error = draft.validationErrors.first { refuse(error); return }
        message = nil; saving = true
        defer { saving = false }
        do {
            let saved: AtlasJourney
            if let journey { saved = try await store.update(journey.id, draft) } else { saved = try await store.create(draft) }
            onSaved(saved)
            base = draft
            dismiss()
        } catch JourneyWriteFailure.routeChanged {
            await conflict()
        } catch {
            refuse(error.localizedDescription)
        }
    }

    private func refuse(_ text: String) {
        message = text
        refusals += 1
    }

    private func conflict() async {
        guard let journey else { refuse(JourneyWriteFailure.invalid.localizedDescription); return }
        do {
            let fresh = JourneyDraft(try await store.load(journey.id))
            // Same revision: nothing newer exists, the route itself was refused
            // (a moved or demoted Stop that other points still belong to).
            guard fresh.revision != base.revision else { refuse("路线点的停留归属需要重新确认"); return }
            latest = fresh
        } catch {
            refuse(error.localizedDescription)
        }
    }

    private func resolve(merge: Bool) {
        guard let fresh = latest else { return }
        draft = merge ? JourneyDraft.merge(base: base, mine: draft, theirs: fresh) : fresh
        base = fresh
        latest = nil
    }

    private func delete() async {
        guard let journey else { return }
        saving = true
        defer { saving = false }
        do {
            try await store.delete(journey.id)
            onDeleted(journey)
            base = draft
            dismiss()
        } catch {
            refuse(error.localizedDescription)
        }
    }
}

/// Which Route Point the editor shows; `index == nil` adds one.
struct PointEditing: Hashable, Identifiable {
    let id = UUID()
    let index: Int?
}

/// One Route Point: place search, a MapKit map to place it by its centre, its
/// name and whether it is a Stop.
struct RoutePointEditor: View {
    let near: CLLocationCoordinate2D?
    let store: any JourneyStore
    let onCommit: (RouteDraftPoint) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var point: RouteDraftPoint?
    @State private var label: String
    @State private var isStop: Bool
    @State private var query = ""
    @State private var results: [PlaceResult] = []
    @State private var attribution: PlaceAttribution?
    @State private var searching = false
    @State private var message: String?
    @State private var camera: MapCameraPosition
    @State private var center: CLLocationCoordinate2D?

    init(point: RouteDraftPoint?, near: CLLocationCoordinate2D?, store: any JourneyStore,
         onCommit: @escaping (RouteDraftPoint) -> Void) {
        self.near = near; self.store = store; self.onCommit = onCommit
        _point = State(initialValue: point)
        _label = State(initialValue: point?.label ?? "")
        _isStop = State(initialValue: point?.isStop ?? true)
        let focus = point.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) } ?? near
        _camera = State(initialValue: focus.map {
            .region(MKCoordinateRegion(center: $0, span: MKCoordinateSpan(latitudeDelta: 0.6, longitudeDelta: 0.6)))
        } ?? .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 30, longitude: 110),
                                        span: MKCoordinateSpan(latitudeDelta: 60, longitudeDelta: 60))))
    }

    var body: some View {
        Form {
            Section {
                TextField("搜索地点", text: $query)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .onSubmit { Task { await search() } }
                    .frame(minHeight: NightFlight.hitTarget)
                    .accessibilityIdentifier("composer.search")
                if searching { ProgressView().frame(maxWidth: .infinity) }
                ForEach(results) { result in
                    Button { choose(result) } label: {
                        VStack(alignment: .leading, spacing: NightFlight.grid(0.5)) {
                            Text(result.preferredLabel).foregroundStyle(NightFlight.ink)
                            if !result.context.isEmpty { Text(result.context).font(.footnote).nightFlightMuted() }
                        }
                        .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("composer.place." + result.id)
                }
                if !results.isEmpty, let attribution {
                    // Required data attribution for the place provider.
                    Text("地点数据 " + attribution.label).font(.caption).nightFlightMuted()
                }
            }
            Section {
                ZStack {
                    Map(position: $camera) {
                        if let point {
                            Marker(label.isEmpty ? "路线点" : label,
                                   coordinate: CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude))
                                .tint(NightFlight.accent)
                        }
                    }
                    .mapStyle(.standard(pointsOfInterest: .excludingAll))
                    .onMapCameraChange(frequency: .onEnd) { center = $0.region.center }
                    Image(systemName: "plus").font(.title3.weight(.light)).foregroundStyle(NightFlight.ink)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
                .frame(height: 240)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("composer.map")
                Button { Task { await placeAtCenter() } } label: {
                    Label("放在地图中心", systemImage: "scope")
                        .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .disabled(center == nil)
                .accessibilityIdentifier("composer.place-center")
            }
            Section {
                TextField("地点名称", text: $label)
                    .frame(minHeight: NightFlight.hitTarget)
                    .accessibilityIdentifier("composer.point-label")
                Toggle("停靠点", isOn: $isStop)
                    .tint(NightFlight.accent)
                    .frame(minHeight: NightFlight.hitTarget)
                    .accessibilityIdentifier("composer.point-stop")
            }
            if let message {
                Section { Text(message).foregroundStyle(Color(hex: 0xFF9F8F)).accessibilityIdentifier("composer.point-error") }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .background(NightFlight.background.ignoresSafeArea())
        .foregroundStyle(NightFlight.ink)
        .navigationTitle(label.isEmpty ? "路线点" : label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { commit() }
                    .fontWeight(.semibold)
                    .disabled(point == nil)
                    .accessibilityIdentifier("composer.point-done")
            }
        }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2 else { return }
        searching = true; message = nil
        defer { searching = false }
        do {
            let found = try await store.search(String(text.prefix(120)), near: near.map { (latitude: $0.latitude, longitude: $0.longitude) })
            results = found.results; attribution = found.attribution
            if found.results.isEmpty { message = "没有找到这个地点" }
        } catch {
            message = "地点搜索暂不可用"
        }
    }

    private func choose(_ result: PlaceResult) {
        label = result.preferredLabel
        place(result.latitude, result.longitude)
        results = []
        camera = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: result.latitude, longitude: result.longitude),
                                            span: MKCoordinateSpan(latitudeDelta: 0.4, longitudeDelta: 0.4)))
    }

    private func placeAtCenter() async {
        guard let center else { return }
        place(center.latitude, center.longitude)
        // A blank name may be filled from the coordinate; a typed name is never replaced.
        guard label.trimmingCharacters(in: .whitespaces).isEmpty,
              let found = try? await store.reverse(latitude: center.latitude, longitude: center.longitude),
              label.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        label = found.preferredLabel
    }

    private func place(_ latitude: Double, _ longitude: Double) {
        if var existing = point {
            existing.latitude = latitude; existing.longitude = longitude
            point = existing
        } else {
            point = RouteDraftPoint(latitude: latitude, longitude: longitude, label: label, isStop: isStop)
        }
    }

    private func commit() {
        guard var result = point else { return }
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if isStop && name.isEmpty { message = "停靠点需要地点名称"; return }
        result.label = name; result.isStop = isStop
        onCommit(result)
        dismiss()
    }
}
