import AVKit
import StartripsMedia
import SwiftUI
import WebKit

struct StoryBook3DView: View {
    let model: StoryModel
    let startedOn: String
    let endedOn: String?
    let useFlatBook: () -> Void
    @State private var failed = false
    @State private var video: MediaAsset?

    var body: some View {
        Group {
            if failed {
                VStack(spacing: 12) {
                    Text("立体之书暂时无法打开。")
                    Button("改用旅程之书", action: useFlatBook).frame(minHeight: 44)
                }
            } else {
                BookScene(model: model, startedOn: startedOn, endedOn: endedOn,
                          useFlatBook: useFlatBook, fail: { failed = true }, play: { video = $0 })
            }
        }
        .sheet(item: $video) { asset in
            BookVideo(model: model, playback: model.foreground, asset: asset)
        }
    }
}

private struct BookVideo: View {
    let model: StoryModel
    @ObservedObject var playback: ForegroundPlayback
    let asset: MediaAsset
    @Environment(\.dismiss) private var dismiss
    @State private var loadFailed = false
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            Group {
                if loadFailed || playback.failure != nil {
                    VStack(spacing: 12) {
                        Text("视频暂时无法播放。")
                        Button("重试") { attempt += 1 }.frame(minHeight: 44)
                    }
                } else if let player = playback.player {
                    VideoPlayer(player: player)
                } else {
                    ProgressView("正在加载视频…")
                }
            }
            .navigationTitle(asset.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { dismiss() } }
        }
        .task(id: attempt) {
            playback.stopVideo()
            loadFailed = false
            do { try await model.play3DBookVideo(asset.id) }
            catch { if !Task.isCancelled { loadFailed = true } }
        }
        .onDisappear { playback.stopVideo() }
    }
}

private struct BookScene: UIViewRepresentable {
    let model: StoryModel
    let startedOn: String
    let endedOn: String?
    let useFlatBook: () -> Void
    let fail: () -> Void
    let play: (MediaAsset) -> Void

    struct Snapshot: Encodable {
        struct Asset: Encodable {
            let id: String
            let journeyId: String
            let routePointId: String?
            let fileName: String
            let mimeType: String
            let bytes: Int64
            let sortOrder: Int

            init(_ asset: MediaAsset) {
                id = asset.id; journeyId = asset.journeyId; routePointId = asset.routePointId
                fileName = asset.fileName; mimeType = asset.mimeType; bytes = asset.bytes; sortOrder = asset.sortOrder
            }
        }
        struct Journey: Encodable {
            let id: String
            let title: String
            let note: String
            let startedOn: String
            let endedOn: String?
            let coverMediaAssetId: String?
            let routePoints: [MediaRoutePoint]
            let media: [Asset]
        }
        let journey: Journey
        let routePointId: String?
        let assetId: String?
    }

    func makeCoordinator() -> Coordinator {
        let journey = model.journey
        let current = model.cursor.current
        let snapshot = Snapshot(journey: .init(id: journey.id, title: journey.title, note: journey.note,
            startedOn: startedOn, endedOn: endedOn, coverMediaAssetId: journey.coverMediaAssetId,
            routePoints: journey.routePoints, media: journey.media.filter(\.isVisual).map(Snapshot.Asset.init)),
            routePointId: current?.routePointId, assetId: current?.role == .journeyCover ? nil : current?.asset?.id)
        return Coordinator(snapshot: snapshot, model: model, useFlatBook: useFlatBook, fail: fail, play: play)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "storyBook")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.start(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "storyBook", contentWorld: .page)
        view.navigationDelegate = nil
        view.stopLoading()
        coordinator.stop()
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        private let snapshot: Snapshot
        private let model: StoryModel
        private let pageGeneration: Int
        private let useFlatBook: () -> Void
        private let fail: () -> Void
        private let play: (MediaAsset) -> Void
        private var server: BundledSceneServer?
        private var localURL: URL?
        private var pictures: [UUID: Task<Void, Never>] = [:]
        private var stopped = false

        init(snapshot: Snapshot, model: StoryModel, useFlatBook: @escaping () -> Void,
             fail: @escaping () -> Void, play: @escaping (MediaAsset) -> Void) {
            self.snapshot = snapshot; self.model = model; self.useFlatBook = useFlatBook
            pageGeneration = model.pageGeneration
            self.fail = fail; self.play = play
        }

        private var isCurrent: Bool { !stopped && pageGeneration == model.pageGeneration }

        func start(_ view: WKWebView) {
            guard let root = Bundle.main.url(forResource: "Scene", withExtension: nil) else {
                Task { @MainActor in if isCurrent { fail() } }
                return
            }
            let server = BundledSceneServer(root: root, mapOrigin: nil)
            self.server = server
            do {
                try server.start { [weak self, weak view] result in
                    Task { @MainActor in
                        guard let self, self.isCurrent, let view else { return }
                        guard case .success(let index) = result else { self.fail(); return }
                        let url = index.deletingLastPathComponent().appendingPathComponent("book3d.html")
                        self.localURL = url
                        view.load(URLRequest(url: url))
                    }
                }
            } catch { Task { @MainActor in if isCurrent { fail() } } }
        }

        func stop() {
            stopped = true
            pictures.values.forEach { $0.cancel() }
            pictures.removeAll()
            server?.stop()
            server = nil
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url == localURL ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard isCurrent, webView.url == localURL else { return }
            guard let data = try? JSONEncoder().encode(snapshot) else { fail(); return }
            // Encode again as a string literal before evaluating any user text.
            guard let quoted = try? JSONEncoder().encode(String(decoding: data, as: UTF8.self)) else { fail(); return }
            let script = "window.startStoryBook(JSON.parse(" + String(decoding: quoted, as: UTF8.self) + "))"
            webView.evaluateJavaScript(script) { [weak self] _, error in
                if error != nil { Task { @MainActor in if let self, self.isCurrent { self.fail() } } }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if isCurrent { fail() } }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if isCurrent { fail() } }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if isCurrent { fail() } }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            let origin = message.frameInfo.securityOrigin
            guard isCurrent, message.frameInfo.isMainFrame, origin.protocol == "http",
                  origin.host == "127.0.0.1", origin.port == localURL?.port,
                  let body = message.body as? [String: Any], let kind = body["kind"] as? String
            else { replyHandler(nil, "Book message rejected"); return }

            let assetID = body["assetId"] as? String
            switch kind {
            case "position":
                model.follow3DBookPage(routePointID: body["routePointId"] as? String,
                                      assetID: assetID, isCover: body["isCover"] as? Bool == true)
                replyHandler(true, nil)
            case "fallback":
                replyHandler(true, nil)
                useFlatBook()
            case "close":
                replyHandler(true, nil)
                model.leave()
            case "video":
                guard let asset = snapshot.journey.media.first(where: { $0.id == assetID && $0.mimeType.hasPrefix("video/") }) else {
                    replyHandler(nil, "Video unavailable"); return
                }
                model.follow3DBookPage(routePointID: asset.routePointId, assetID: asset.id, isCover: false)
                guard let current = model.activeAsset, current.id == asset.id else {
                    replyHandler(nil, "Video unavailable"); return
                }
                replyHandler(true, nil)
                play(current)
            case "picture":
                guard let assetID, assetID.utf8.count <= 256, pictures.count < 16 else {
                    replyHandler(nil, "Picture unavailable"); return
                }
                let request = UUID()
                pictures[request] = Task { [weak self, model] in
                    defer { self?.pictures[request] = nil }
                    do {
                        let image = try await model.bookPicture(assetID)
                        try Task.checkCancellation()
                        guard self?.isCurrent == true else { throw MediaFailure.unavailable }
                        replyHandler(image.base64EncodedString(), nil)
                    } catch { replyHandler(nil, "Picture unavailable") }
                }
            default:
                replyHandler(nil, "Book message rejected")
            }
        }
    }
}
