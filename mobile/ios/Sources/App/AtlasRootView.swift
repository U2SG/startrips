import SwiftUI

struct AtlasRootView: View {
    @ObservedObject var router: AppRouter
    @ObservedObject var session: AtlasSession
    @Environment(\.scenePhase) private var phase
    @State private var connected = false
    @State private var sceneIdentity = UUID()
    @State private var fixtureMode = false

    var body: some View {
        NavigationStack(path: $router.path) {
            Group {
                if connected {
                    AtlasSceneView(router: router, mapOrigin: session.origin).id(sceneIdentity)
                } else {
                    Form {
                        Section("我的图谱") {
                            TextField("https://your-startrips.example", text: $session.originText)
                                .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button("登录并选择图谱") {
                                do { try session.configureOwner(); router.clear(); session.loginPresented = true }
                                catch { router.error = error.localizedDescription }
                            }
                            Button("打开图谱") { connectOwner() }
                        }
                        Section("打开分享") {
                            TextField("分享链接", text: $session.shareText).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button("查看分享") {
                                do {
                                    try session.configureGuest(session.shareText); session.shareText = ""; router.clear()
                                    connected = true; sceneIdentity = UUID()
                                    Task { await session.refresh(router) }
                                } catch { router.error = error.localizedDescription }
                            }
                        }
                    }
                }
            }
            .navigationTitle(router.snapshot.access == .guest ? "分享图谱" : "图谱")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if connected {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("切换") { session.disconnect(); router.clear(); connected = false }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("刷新") { sceneIdentity = UUID(); refresh() }.disabled(session.busy)
                    }
                }
            }
            .navigationDestination(for: StoryHandoff.self) { target in
                StoryDestination(target: target, router: router, session: session).id(target.requestId)
            }
            .overlay(alignment: .top) {
                if session.busy { ProgressView("正在读取图谱…").padding().background(.regularMaterial) }
                #if DEBUG
                if fixtureMode && router.rendered { Text("地球已就绪").accessibilityIdentifier("earth-rendered") }
                #endif
            }
        }
        .sheet(isPresented: $session.loginPresented, onDismiss: { connectOwner() }) {
            if let origin = session.origin {
                NavigationStack {
                    PrivateWebView(url: origin, store: session.cookieStore)
                        .toolbar { Button("返回图谱") { session.loginPresented = false } }
                }
            }
        }
        .alert("图谱暂不可用", isPresented: Binding(get: { router.error != nil }, set: { if !$0 { router.error = nil } })) {
            Button("重试") { refresh() }
            Button("关闭", role: .cancel) { router.error = nil }
        } message: { Text(router.error ?? "") }
        .task {
            router.onInvalidation = { refresh() }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-atlas-fixture") {
                fixtureMode = true
                do {
                    let url = Bundle.main.url(forResource: "bridge", withExtension: "json")!
                    let data = try Data(contentsOf: url)
                    let fixture = try JSONDecoder().decode(BridgeFixture.self, from: data)
                    try session.installFixture(data, scope: "synthetic-ci")
                    router.install(fixture.snapshot.journeys, identity: "synthetic-ci", access: .owner, earthExperience: "default")
                    connected = true
                } catch { router.error = "测试图谱无法读取。" }
                return
            }
            #endif
            if !session.originText.isEmpty { connectOwner() }
        }
        .onChange(of: phase) { _, value in
            if value == .active && connected { refresh() }
        }
        .onChange(of: router.path.isEmpty) { oldValue, newValue in
            if newValue && !oldValue { refresh() }
        }
        .task(id: connected) {
            // Revalidate open grants/session even when the person stays in one scene.
            while connected && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                if phase == .active { refresh() }
            }
        }
    }

    private func connectOwner() {
        do {
            try session.configureOwner(); router.clear(); connected = true; sceneIdentity = UUID()
            refresh()
        } catch { router.error = error.localizedDescription }
    }
    private func refresh() {
        guard !fixtureMode else { return }
        Task { await session.refresh(router) }
    }
}

struct BridgeFixture: Decodable { let snapshot: SceneSnapshot; let event: SceneEvent }
