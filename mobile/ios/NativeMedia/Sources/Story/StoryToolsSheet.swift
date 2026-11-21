import SwiftUI

/// What the tools sheet hands to the Story once it has closed. Nothing is ever
/// presented from inside the tools sheet itself (#818).
enum StoryToolsHandOff: Equatable {
    case journalImport
    case shareFilm(URL)
}

/// An authorized film file waiting for the Story-level share sheet.
struct SharedFilm: Identifiable {
    let url: URL
    var id: URL { url }
}

/// 整理与导出: one grouped list, leading-aligned rows, one primary action.
struct StoryToolsSheet: View {
    let importer: PhotosImportModel?
    let moveModel: MediaMoveModel?
    let journalImport: JournalImportModel?
    let exporter: FilmExportModel?
    let thumbnail: (MediaAsset) async -> UIImage?
    let handOff: (StoryToolsHandOff) -> Void
    let close: () -> Void

    var body: some View {
        NavigationStack {
            List {
                if let importer { PhotosImportSection(model: importer) }
                if let moveModel { MediaMoveSection(model: moveModel, thumbnail: thumbnail) }
                if journalImport != nil {
                    Section("手记") {
                        Button { handOff(.journalImport) } label: { Label("导入手记", systemImage: "text.book.closed") }
                            .storyToolRow()
                            .accessibilityIdentifier("story.journal-import")
                    }
                }
                if let exporter { FilmExportSection(model: exporter, share: { handOff(.shareFilm($0)) }) }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(StoryTheme.background.ignoresSafeArea())
            .foregroundStyle(StoryTheme.ink)
            .navigationTitle("整理与导出")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成", action: close).fontWeight(.semibold)
                }
            }
        }
        .tint(StoryTheme.ink)
    }
}

extension View {
    /// A standard tools row: surface background, 44pt minimum, leading content.
    func storyToolRow() -> some View {
        frame(maxWidth: .infinity, minHeight: StoryTheme.hitTarget, alignment: .leading)
            .contentShape(Rectangle())
            .listRowBackground(StoryTheme.surface)
    }
}

/// Status and failure text that stays readable with Increase Contrast.
struct StoryToolNote: View {
    let text: String
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        Text(text).font(.callout)
            .foregroundStyle(contrast == .increased ? StoryTheme.ink : StoryTheme.muted)
            .storyToolRow()
    }
}

/// The single prominent action of the sheet (生成 MP4): a full-width ink pill.
struct StoryPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .multilineTextAlignment(.center)
            .padding(.horizontal, StoryTheme.grid(5)).padding(.vertical, StoryTheme.grid(2))
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(StoryTheme.background)
            .background(Capsule().fill(StoryTheme.ink))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.72 : enabled ? 1 : 0.4)
    }
}
