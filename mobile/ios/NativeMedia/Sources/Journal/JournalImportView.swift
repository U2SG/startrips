import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Story-level host of the journal import sheet. The tools sheet's 导入手记 row
/// only closes the tools; the Story then calls `open()` from the tools sheet's
/// `onDismiss`, so this sheet never stacks on (or races) the tools sheet. An
/// import still running reopens on its current stage.
struct JournalImportPresenter: View {
    @ObservedObject var model: JournalImportModel
    var body: some View {
        Color.clear.sheet(isPresented: $model.presented) { JournalImportSheet(model: model) }
    }
}

struct JournalImportSheet: View {
    @ObservedObject var model: JournalImportModel
    @State private var picking = false
    @Environment(\.colorSchemeContrast) private var contrast

    private var muted: Color { contrast == .increased ? StoryTheme.ink : StoryTheme.muted }

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(StoryTheme.background.ignoresSafeArea())
                .navigationTitle("导入手记")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
        .foregroundStyle(StoryTheme.ink).tint(StoryTheme.accent)
        .interactiveDismissDisabled(model.stage == .review || model.stage == .saving)
        .confirmationDialog("撤销导入", isPresented: Binding(get: { model.undoConfirmation != nil },
                                                          set: { if !$0 { model.undoConfirmation = nil } }),
                            titleVisibility: .visible) {
            Button("确认撤销", role: .destructive) { model.confirmUndo() }
                .accessibilityIdentifier("journal-import.undo.confirm")
            Button("取消", role: .cancel) { model.undoConfirmation = nil }
        } message: {
            switch model.undoConfirmation {
            case .chapters(let count)?: Text("撤销这次导入会移除 \(count) 章。")
            case .edited?: Text("部分导入的章节之后有修改，撤销会一并丢失。")
            case nil: EmptyView()
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: Self.textTypes) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let text = try? String(contentsOf: url, encoding: .utf8) { model.source = text }
        }
        .accessibilityIdentifier("journal-import")
    }

    private static let textTypes: [UTType] = [.plainText, .text] + [UTType(filenameExtension: "md")].compactMap { $0 }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            switch model.stage {
            case .review: Button("取消") { model.discard() }.accessibilityIdentifier("journal-import.discard")
            case .saving: EmptyView()
            case .saved: EmptyView()
            default: Button("关闭") { model.presented = false }
            }
        }
        ToolbarItem(placement: .confirmationAction) {
            switch model.stage {
            case .review:
                Button("保存") { model.apply() }.fontWeight(.semibold).disabled(!model.canApply)
                    .accessibilityIdentifier("journal-import.apply")
            case .saved:
                Button("完成") { model.finish() }.fontWeight(.semibold).accessibilityIdentifier("journal-import.finish")
            default: EmptyView()
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.stage {
        case .compose: compose
        case .starting, .stopping, .saving: progress(nil)
        case .running(let value): progress(value)
        case .interrupted(let stopping): interrupted(stopping)
        case .review: review
        case .saved: saved
        }
    }

    private var notice: some View {
        Group {
            if let message = model.message {
                Text(message).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("journal-import.message")
            }
        }
    }

    private var compose: some View {
        VStack(spacing: StoryTheme.grid(3)) {
            notice
            TextEditor(text: $model.source)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(StoryTheme.grid(2))
                .background(StoryTheme.surface, in: RoundedRectangle(cornerRadius: StoryTheme.grid(2)))
                .accessibilityLabel("原文")
                .accessibilityIdentifier("journal-import.source")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: StoryTheme.grid(3)) { sourceButtons }
                VStack(spacing: StoryTheme.grid(2)) { sourceButtons }
            }
            Button { model.start() } label: { Text("用 AI 导入").fontWeight(.semibold).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent)
                .foregroundStyle(StoryTheme.background)
                .frame(minHeight: StoryTheme.hitTarget)
                .disabled(!model.canStart)
                .accessibilityIdentifier("journal-import.start")
            if model.canUndo && model.source.isEmpty {
                Button("撤销上次导入") { model.requestUndo() }
                    .frame(minHeight: StoryTheme.hitTarget)
                    .accessibilityIdentifier("journal-import.undo")
            }
        }
        .padding(StoryTheme.grid(4))
        .disabled(model.busy)
    }

    @ViewBuilder private var sourceButtons: some View {
        Button {
            if let text = UIPasteboard.general.string { model.source = text }
        } label: { Label("粘贴", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity) }
            .buttonStyle(.bordered).frame(minHeight: StoryTheme.hitTarget)
            .accessibilityIdentifier("journal-import.paste")
        Button { picking = true } label: { Label("文件", systemImage: "doc.text").frame(maxWidth: .infinity) }
            .buttonStyle(.bordered).frame(minHeight: StoryTheme.hitTarget)
            .accessibilityIdentifier("journal-import.file")
    }

    private func progress(_ value: JournalImportProgress?) -> some View {
        let label: String
        switch model.stage {
        case .starting: label = "正在开始导入…"
        case .stopping: label = "正在停止…"
        case .saving: label = "正在保存…"
        default: label = value?.label ?? "正在等待处理…"
        }
        return VStack(spacing: StoryTheme.grid(4)) {
            if let total = value?.segments, total > 0 {
                let done = value?.segmentsDone ?? 0
                ProgressView(value: Double(done), total: Double(total))
                    .accessibilityLabel(label).accessibilityValue("\(done)/\(total)")
                Text("\(done)/\(total)").font(.title3.monospacedDigit())
                    .accessibilityHidden(true)
                    .accessibilityIdentifier("journal-import.count")
            } else {
                ProgressView().accessibilityLabel(label)
            }
            Text(label).font(.body).foregroundStyle(muted)
            if model.stage != .stopping && model.stage != .saving {
                Button("停止", role: .destructive) { model.stop() }
                    .frame(minHeight: StoryTheme.hitTarget)
                    .accessibilityIdentifier("journal-import.stop")
            }
        }
        .padding(StoryTheme.grid(6))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("journal-import.progress")
    }

    private func interrupted(_ stopping: Bool) -> some View {
        VStack(spacing: StoryTheme.grid(4)) {
            notice
            Button(stopping ? "重试停止" : "继续接收") { model.resume() }
                .buttonStyle(.borderedProminent).foregroundStyle(StoryTheme.background)
                .frame(minHeight: StoryTheme.hitTarget)
                .accessibilityIdentifier("journal-import.resume")
            if !stopping {
                Button("停止", role: .destructive) { model.stop() }.frame(minHeight: StoryTheme.hitTarget)
            }
        }
        .padding(StoryTheme.grid(6))
    }

    private var review: some View {
        List {
            if let message = model.message {
                Text(message).font(.callout).listRowBackground(StoryTheme.surface)
            }
            ForEach(model.newChapters) { chapter in
                JournalChapterReviewSection(model: model, chapter: chapter, muted: muted)
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("journal-import.review")
    }

    private var saved: some View {
        VStack(spacing: StoryTheme.grid(4)) {
            Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(StoryTheme.accent)
                .accessibilityHidden(true)
            Text("已保存").font(StoryTheme.serif(.title3))
            if model.canUndo {
                Button("撤销") { model.requestUndo() }
                    .frame(minHeight: StoryTheme.hitTarget)
                    .accessibilityIdentifier("journal-import.undo")
            }
            notice
        }
        .padding(StoryTheme.grid(6))
        .accessibilityIdentifier("journal-import.saved")
    }
}

/// One proposed chapter: keep or skip it, edit each line, answer 待确认 lines.
private struct JournalChapterReviewSection: View {
    @ObservedObject var model: JournalImportModel
    let chapter: JournalChapter
    let muted: Color

    private var included: Bool { !model.skipped.contains(chapter.id) }

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { included }, set: { model.setIncluded(chapter.id, $0) })) {
                VStack(alignment: .leading, spacing: StoryTheme.grid(1)) {
                    Text(chapter.date).font(.footnote.monospacedDigit()).foregroundStyle(muted)
                    if !chapter.title.isEmpty { Text(chapter.title).font(StoryTheme.serif(.headline)) }
                }
            }
            .tint(StoryTheme.accent)
            .frame(minHeight: StoryTheme.hitTarget)
            .accessibilityIdentifier("journal-import.chapter.\(chapter.id)")
            if included {
                ForEach(chapter.events) { event in
                    JournalEventReviewRow(model: model, chapterID: chapter.id, event: event,
                                          questions: chapter.questions(for: event.id), muted: muted)
                }
            }
        }
        .listRowBackground(StoryTheme.surface)
    }
}

private struct JournalEventReviewRow: View {
    @ObservedObject var model: JournalImportModel
    let chapterID: String
    let event: JournalEvent
    let questions: [String]
    let muted: Color

    var body: some View {
        VStack(alignment: .leading, spacing: StoryTheme.grid(2)) {
            HStack(alignment: .firstTextBaseline, spacing: StoryTheme.grid(2)) {
                if let time = event.localTime { Text(time).font(.footnote.monospacedDigit()).foregroundStyle(muted) }
                Spacer(minLength: 0)
                Picker("状态", selection: Binding(get: { event.status }, set: { model.setStatus(chapterID, event.id, $0) })) {
                    ForEach(JournalEvent.Status.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.menu)
                .tint(event.status == .uncertain ? StoryTheme.accent : StoryTheme.ink)
                .frame(minHeight: StoryTheme.hitTarget)
                .accessibilityIdentifier("journal-import.status.\(event.id)")
            }
            TextField("正文", text: Binding(get: { event.text }, set: { model.editText(chapterID, event.id, $0) }), axis: .vertical)
                .font(StoryTheme.serif(.body))
                .accessibilityIdentifier("journal-import.text.\(event.id)")
            if event.status == .uncertain {
                ForEach(questions, id: \.self) { question in
                    Label(question, systemImage: "questionmark.circle")
                        .font(.callout)
                        .foregroundStyle(StoryTheme.accent)
                }
            }
        }
        .padding(.vertical, StoryTheme.grid(1))
    }
}
