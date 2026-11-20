import ImageIO
import SwiftUI
import UIKit
import StartripsMedia

/// Owner-only share links for one Journey: choose an expiry, optionally the
/// media, create, hand the link to the system share sheet, and revoke the
/// links that still open this Journey. No section titles or helper copy.
struct JourneyShareView: View {
    let journey: AtlasJourney
    let store: any ShareStore
    /// Thumbnails for the media picker; nil draws placeholders.
    let media: ScopedMediaSession?

    @Environment(\.dismiss) private var dismiss
    @State private var request: ShareRequest
    @State private var selected: Set<String>
    @State private var grants: [ShareGrant]?
    @State private var creating = false
    @State private var revoking = false
    @State private var message: String?
    /// The only place the raw token lives: dropped with this sheet.
    @State private var created: CreatedShare?
    @State private var activity: CreatedShare?
    @State private var pendingRevoke: ShareGrant?

    init(journey: AtlasJourney, store: any ShareStore, media: ScopedMediaSession?) {
        self.journey = journey; self.store = store; self.media = media
        _request = State(initialValue: ShareRequest(journeyId: journey.id, customExpiry: Date().addingTimeInterval(7 * 86_400)))
        _selected = State(initialValue: Set(journey.media.map(\.id)))
    }

    private var scoped: Binding<Bool> {
        Binding(get: { request.mediaAssetIds != nil },
                set: { request.mediaAssetIds = $0 ? journey.media.map(\.id).filter(selected.contains) : nil })
    }

    private var working: Bool { creating || revoking }
    private var active: [ShareGrant] { ShareGrant.active(grants ?? [], journeyId: journey.id, now: Date()) }

    var body: some View {
        NavigationStack {
            Form {
                if let message {
                    Section {
                        Text(message)
                            .foregroundStyle(Color(hex: 0xFF9F8F))
                            .accessibilityIdentifier("share.error")
                    }
                }
                if let created {
                    Section {
                        ShareLink(item: created.link) {
                            Label("分享链接", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("share.send")
                    }
                }
                Section {
                    Picker("有效期", selection: $request.expiry) {
                        ForEach(ShareExpiry.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(minHeight: NightFlight.hitTarget)
                    .accessibilityIdentifier("share.expiry")
                    if request.expiry == .custom {
                        DatePicker("失效时间", selection: $request.customExpiry,
                                   in: Date().addingTimeInterval(ShareRequest.minimumLifetime)...Date().addingTimeInterval(ShareRequest.maximumLifetime))
                            .frame(minHeight: NightFlight.hitTarget)
                            .accessibilityIdentifier("share.custom-expiry")
                    }
                }
                if !journey.media.isEmpty { mediaSection }
                Section {
                    Button { Task { await create() } } label: {
                        if creating {
                            ProgressView().tint(NightFlight.background)
                        } else {
                            Label("创建分享链接", systemImage: "link")
                        }
                    }
                    .buttonStyle(NightFlightPillButtonStyle())
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("share.create")
                }
                if grants == nil {
                    Section { ProgressView().frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget) }
                } else if !active.isEmpty {
                    Section { ForEach(active) { linkRow($0) } }
                }
            }
            .scrollContentBackground(.hidden)
            .background(NightFlight.background.ignoresSafeArea())
            .foregroundStyle(NightFlight.ink)
            .disabled(working)
            .navigationTitle("分享旅程")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                        .accessibilityIdentifier("share.done")
                }
            }
        }
        .tint(NightFlight.ink)
        .interactiveDismissDisabled(working)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(NightFlight.radiusLarge)
        .presentationBackground(NightFlight.background)
        .accessibilityIdentifier("share")
        .confirmationDialog("撤销这个链接？", isPresented: Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } }),
                            titleVisibility: .visible, presenting: pendingRevoke) { grant in
            Button("撤销链接", role: .destructive) { Task { await revoke(grant) } }
            Button("取消", role: .cancel) { pendingRevoke = nil }
        }
        .sheet(item: $activity) { share in
            ActivitySheet(link: share.link) { activity = nil }
                .presentationDetents([.medium, .large])
                .ignoresSafeArea()
        }
        .task { await reload() }
    }

    // MARK: Media

    private var mediaSection: some View {
        Section {
            Toggle("选择媒体", isOn: scoped)
                .tint(NightFlight.accent)
                .frame(minHeight: NightFlight.hitTarget)
                .accessibilityIdentifier("share.media-scope")
            if request.mediaAssetIds != nil {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: NightFlight.grid(2))], spacing: NightFlight.grid(2)) {
                    ForEach(journey.media) { asset in
                        let chosen = selected.contains(asset.id)
                        Button { toggle(asset.id) } label: {
                            ShareThumbnail(asset: asset, media: media)
                                .aspectRatio(1, contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: NightFlight.radiusSmall, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: NightFlight.radiusSmall, style: .continuous)
                                    .strokeBorder(chosen ? NightFlight.accent : Color.clear, lineWidth: 2))
                                .overlay(alignment: .topTrailing) {
                                    Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(chosen ? NightFlight.accent : NightFlight.ink)
                                        .padding(NightFlight.grid(1))
                                }
                                .opacity(chosen ? 1 : 0.55)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(asset.fileName)
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                        .accessibilityIdentifier("share.media." + asset.id)
                    }
                }
                .padding(.vertical, NightFlight.grid(1))
            }
        }
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
        // Server order is the Journey's media order, whatever order they were tapped in.
        request.mediaAssetIds = journey.media.map(\.id).filter(selected.contains)
    }

    // MARK: Links

    private func linkRow(_ grant: ShareGrant) -> some View {
        let expiry = ShareDates.parse(grant.expiresAt).map(ShareDates.display) ?? grant.expiresAt
        let text = grant.journeyCount > 1 ? "有效至 \(expiry) · \(grant.journeyCount) 段旅程" : "有效至 \(expiry)"
        return HStack(spacing: NightFlight.grid(3)) {
            Text(text).font(.body.monospacedDigit()).lineLimit(2)
                .accessibilityIdentifier("share.link." + grant.id)
            Spacer(minLength: NightFlight.grid(2))
            Button("撤销", role: .destructive) { pendingRevoke = grant }
                .buttonStyle(.borderless)
                .foregroundStyle(Color(hex: 0xFF9F8F))
                .frame(minWidth: NightFlight.hitTarget, minHeight: NightFlight.hitTarget)
                .accessibilityIdentifier("share.revoke." + grant.id)
        }
    }

    private func reload() async {
        do { grants = try await store.list() }
        catch { if grants == nil { grants = [] }; message = error.localizedDescription }
    }

    private func create() async {
        guard !working else { return }
        creating = true; message = nil
        defer { creating = false }
        do {
            let share = try await store.create(request)
            created = share
            activity = share
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }

    private func revoke(_ grant: ShareGrant) async {
        pendingRevoke = nil
        guard !working else { return }
        revoking = true; message = nil
        defer { revoking = false }
        do {
            try await store.revoke(grant.id)
            // A revoked link can no longer be sent, whether or not the list reload below succeeds.
            created = created?.unlessRevoked(grant.id)
            activity = activity?.unlessRevoked(grant.id)
            await reload()
        } catch {
            message = "撤销失败，请重试。"
        }
    }
}

/// A small, lazily read picture for the media picker; videos keep their glyph.
private struct ShareThumbnail: View {
    let asset: AtlasAsset
    let media: ScopedMediaSession?
    @State private var image: UIImage?

    var body: some View {
        Rectangle().fill(NightFlight.stroke)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Image(systemName: asset.mimeType.hasPrefix("video/") ? "video" : "photo").nightFlightMuted()
                }
            }
            .clipped()
            .task(id: asset.id) {
                guard image == nil, let media, asset.mimeType.hasPrefix("image/") else { return }
                image = await Self.read(asset.id, from: media)
            }
    }

    @MainActor
    private static func read(_ id: String, from media: ScopedMediaSession) async -> UIImage? {
        guard let display = try? await media.mediaDisplay(id),
              let download = try? await media.imageTransport.download(from: display.url) else { return nil }
        defer { try? FileManager.default.removeItem(at: download.0) }
        guard let http = download.1 as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let source = CGImageSourceCreateWithURL(download.0 as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 240
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// The system share sheet (Copy, Messages, AirDrop...) for one link.
private struct ActivitySheet: UIViewControllerRepresentable {
    let link: URL
    let onFinish: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [link], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in onFinish() }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
