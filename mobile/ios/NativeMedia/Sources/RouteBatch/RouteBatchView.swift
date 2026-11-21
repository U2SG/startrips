import ImageIO
import SwiftUI
import UIKit

/// Reopens a batch that is still open. The review sheet itself is presented
/// by `RouteBatchPresenter` at Story level, never from inside the tools sheet.
struct RouteBatchEntry: View {
    @ObservedObject var model: RoutePointBatchModel
    var body: some View {
        if model.showsReopen {
            Button("继续整理照片") { model.requestReview() }
                .frame(minHeight: StoryTheme.hitTarget)
                .accessibilityIdentifier("route-batch.reopen")
        }
    }
}

/// Story-level host of the review sheet. A review request first closes the
/// tools sheet (and the photo picker above it); the tools sheet's `onDismiss`
/// then calls `presentRequestedReview()`, so the review never races another
/// presentation.
struct RouteBatchPresenter: View {
    @ObservedObject var model: RoutePointBatchModel
    @Binding var toolsPresented: Bool
    var body: some View {
        Color.clear
            .onChange(of: model.reviewRequests) { _ in
                if toolsPresented { toolsPresented = false } else { model.presentRequestedReview() }
            }
            .sheet(isPresented: $model.presented) {
                RouteBatchSheet(model: model)
                    .onAppear { model.sheetVisibilityChanged(true) }
                    .onDisappear { model.sheetVisibilityChanged(false) }
            }
    }
}

/// Native review of photo Route Point drafts (#337). The layout carries the
/// meaning: numbered groups, a photo strip, a name and a destination.
struct RouteBatchSheet: View {
    @ObservedObject var model: RoutePointBatchModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(StoryTheme.background.ignoresSafeArea())
                .navigationTitle("照片途径点")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
        .foregroundStyle(StoryTheme.ink).tint(StoryTheme.ink)
        .interactiveDismissDisabled()
        .accessibilityIdentifier("route-batch")
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            switch model.stage {
            case .review: Button("取消") { model.cancelReview() }.accessibilityIdentifier("route-batch.cancel")
            case .uploading, .applying, .reading: Button("隐藏") { model.presented = false }
            default: EmptyView()
            }
        }
        ToolbarItem(placement: .confirmationAction) {
            switch model.stage {
            case .review:
                Button("确认") { Task { await model.confirm() } }
                    .fontWeight(.semibold)
                    .disabled(model.busy || model.draft?.isComplete != true)
                    .accessibilityIdentifier("route-batch.confirm")
            case .applied, .partiallyUndone, .done, .unknown, .interrupted:
                Button("完成") { model.finish() }.fontWeight(.semibold).accessibilityIdentifier("route-batch.finish")
            default: EmptyView()
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.stage {
        case .idle, .reading, .applying:
            ProgressView()
        case .uploading(let fraction):
            ProgressView(value: fraction).padding(StoryTheme.grid(6)).accessibilityLabel("正在上传")
        case .review:
            if let draft = model.draft { review(draft) }
        case .applied:
            VStack(spacing: StoryTheme.grid(4)) {
                Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(StoryTheme.accent)
                    .accessibilityHidden(true)
                Text("已整理").font(StoryTheme.serif(.title3))
                if model.operation?.undo.eligible == true {
                    Button("撤销") { Task { await model.undo() } }
                        .disabled(model.busy)
                        .frame(minHeight: StoryTheme.hitTarget)
                        .accessibilityIdentifier("route-batch.undo")
                }
                if let message = model.message { Text(message).font(.callout) }
            }.padding(StoryTheme.grid(6))
        case .partiallyUndone:
            VStack(spacing: StoryTheme.grid(4)) {
                Image(systemName: "exclamationmark.circle").font(.largeTitle).foregroundStyle(StoryTheme.accent)
                    .accessibilityHidden(true)
                Text("部分未撤销").font(StoryTheme.serif(.title3))
                ForEach(RouteBatchConflictSummary.lines(model.operation?.outcome?.conflicts ?? []), id: \.self) { line in
                    Text(line)
                }
            }.padding(StoryTheme.grid(6)).accessibilityElement(children: .combine)
        case .interrupted(let text), .unknown(let text), .done(let text):
            VStack(spacing: StoryTheme.grid(4)) {
                Text(text).multilineTextAlignment(.center)
                if case .interrupted = model.stage {
                    Button("继续上传") { Task { await model.resume() } }
                        .disabled(model.busy).frame(minHeight: StoryTheme.hitTarget)
                }
                if case .unknown = model.stage {
                    Button("重新读取") { Task { await model.reconcile() } }
                        .disabled(model.busy).frame(minHeight: StoryTheme.hitTarget)
                }
            }.padding(StoryTheme.grid(6))
        }
    }

    private func review(_ draft: RouteBatchDraft) -> some View {
        List {
            if let message = model.message {
                Text(message).foregroundStyle(Color(red: 1, green: 0.62, blue: 0.56)).accessibilityIdentifier("route-batch.error")
            }
            ForEach(Array(draft.groups.enumerated()), id: \.element.id) { index, group in
                RouteBatchGroupRow(model: model, group: group, index: index, count: draft.groups.count,
                                   next: draft.groups.indices.contains(index + 1) ? draft.groups[index + 1].id : nil,
                                   animation: reduceMotion ? nil : .default)
                    .listRowBackground(StoryTheme.surface)
            }
            Toggle("仅本批自动整理", isOn: Binding(get: { draft.autoOrganize },
                                                set: { model.edit(.autoOrganize($0)) }))
                .tint(StoryTheme.accent)
                .frame(minHeight: StoryTheme.hitTarget)
                .listRowBackground(StoryTheme.surface)
                .accessibilityIdentifier("route-batch.auto")
        }
        .scrollContentBackground(.hidden)
        .disabled(model.busy)
    }
}

private struct RouteBatchGroupRow: View {
    @ObservedObject var model: RoutePointBatchModel
    let group: RouteBatchGroup
    let index: Int
    let count: Int
    let next: String?
    let animation: Animation?

    private static let journeyLevel = "journey"
    private static let newPoint = "new"

    private var points: [MediaRoutePoint] { model.journey?.routePoints ?? [] }

    private var title: String {
        switch group.destination {
        case .new: return group.label
        case .existing: return points.first { $0.id == group.routePointId }?.label ?? group.label
        case .unplaced: return "整段旅程"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: StoryTheme.grid(2)) {
            HStack(spacing: StoryTheme.grid(3)) {
                Text(String(format: "%02d", index + 1)).font(.footnote.monospacedDigit()).foregroundStyle(StoryTheme.muted)
                    .accessibilityHidden(true)
                if group.destination == .new {
                    TextField("途径点名称", text: Binding(get: { group.label }, set: { model.edit(.rename(group.id, $0)) }))
                        .font(StoryTheme.serif(.headline))
                        .accessibilityIdentifier("route-batch.name.\(index)")
                } else {
                    Text(title.isEmpty ? "途径点" : title).font(StoryTheme.serif(.headline))
                }
                Spacer(minLength: 0)
                if group.needsConfirmation {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(StoryTheme.accent)
                        .accessibilityLabel("需要确认")
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: StoryTheme.grid(1)) {
                    ForEach(group.files, id: \.self) { file in RouteBatchThumbnail(url: model.files[file]?.url) }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(group.files.count) 张")
            Picker("去向", selection: Binding(get: { selection }, set: choose)) {
                if group.destination == .new || model.photoCoordinate(group) != nil {
                    Text("新途径点").tag(Self.newPoint)
                }
                ForEach(points, id: \.id) { point in Text(point.label.isEmpty ? "途径点" : point.label).tag(point.id) }
                Text("整段旅程").tag(Self.journeyLevel)
            }
            .pickerStyle(.menu)
            .frame(minHeight: StoryTheme.hitTarget)
            .accessibilityIdentifier("route-batch.destination.\(index)")
        }
        .padding(.vertical, StoryTheme.grid(2))
        .contextMenu { actions }
        .accessibilityActions { actions }
        .accessibilityIdentifier("route-batch.group.\(index)")
    }

    @ViewBuilder private var actions: some View {
        if index > 0 { action("上移", "arrow.up", .move(group.id, by: -1)) }
        if index < count - 1 { action("下移", "arrow.down", .move(group.id, by: 1)) }
        if group.files.count > 1, let last = group.files.last { action("拆出最后一张", "square.split.2x1", .split(group.id, file: last)) }
        if let next { action("与下一组合并", "square.stack", .merge(group.id, other: next)) }
    }

    private func action(_ title: String, _ symbol: String, _ edit: RouteBatchAction) -> some View {
        Button { perform(edit) } label: { Label(title, systemImage: symbol) }
    }

    private var selection: String {
        switch group.destination {
        case .new: return Self.newPoint
        case .existing: return group.routePointId ?? Self.journeyLevel
        case .unplaced: return Self.journeyLevel
        }
    }

    private func choose(_ value: String) {
        guard value != selection else { return }
        if value == Self.newPoint {
            // Confirms the photo's own recorded location; never a neighbour's.
            guard let coordinate = model.photoCoordinate(group) else { return }
            perform(.reposition(group.id, latitude: coordinate.latitude, longitude: coordinate.longitude))
        } else {
            perform(.assign(group.id, routePointId: value == Self.journeyLevel ? nil : value))
        }
    }

    private func perform(_ action: RouteBatchAction) {
        withAnimation(animation) { model.edit(action) }
    }
}

/// A small, downsampled preview of a picked file; empty once it has been staged.
private struct RouteBatchThumbnail: View {
    let url: URL?
    @State private var image: UIImage?
    @ScaledMetric private var side: CGFloat = 56

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: StoryTheme.grid(1)).fill(StoryTheme.line)
            if let image { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: "photo").foregroundStyle(StoryTheme.muted) }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: StoryTheme.grid(1)))
        .task(id: url) {
            guard let url else { return }
            let pixels = side * 3
            image = await Task.detached(priority: .utility) { () -> UIImage? in
                guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                      let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                          kCGImageSourceCreateThumbnailFromImageAlways: true,
                          kCGImageSourceCreateThumbnailWithTransform: true,
                          kCGImageSourceThumbnailMaxPixelSize: pixels,
                      ] as CFDictionary) else { return nil }
                return UIImage(cgImage: thumbnail)
            }.value
        }
    }
}
