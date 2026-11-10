import SwiftUI

struct AtlasRootView: View {
    @ObservedObject var router: AppRouter
    @ObservedObject var session: AtlasSession
    @Environment(\.scenePhase) private var phase
    @State private var connected = false
    @State private var sceneIdentity = UUID()
    @State private var fixtureMode = false
    @State private var googleLoginFailed = false
    @State private var sceneRecoveryRequired = false

    var body: some View {
        NavigationStack(path: $router.path) {
            Group {
                if connected {
                    AtlasSceneView(router: router, mapOrigin: session.origin).id(sceneIdentity)
                } else {
                    Form {
                        Section("我的图谱") {
                            Text("登录 Startrips，查看已经保存的旅程。")
                            #if DEBUG
                            // Only explicit developer launches expose a server override.
                            if ProcessInfo.processInfo.arguments.contains("-allow-server-override") {
                                TextField("调试服务器（仅开发版）", text: $session.originText)
                                    .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            }
                            #endif
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
            // Web Mobile V2 draws its own compact brand/header in the local scene.
            // Story keeps native navigation, while the Atlas has only one header.
            .toolbar(connected && router.path.isEmpty ? .hidden : .visible, for: .navigationBar)
            .navigationDestination(for: StoryHandoff.self) { target in
                StoryDestination(target: target, router: router, session: session).id(target.requestId)
            }
            .overlay(alignment: .top) {
                if connected && router.path.isEmpty && sceneRecoveryRequired {
                    // Independent of the local WKWebView: available even when
                    // JavaScript and the loopback scene are no longer running.
                    Button("重新加载地球") { restartScene() }
                        .accessibilityIdentifier("atlas.native-scene-reload")
                        .padding(10)
                        .background(.regularMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                } else if session.busy {
                    ProgressView("正在读取图谱…").padding().background(.regularMaterial)
                }
                #if DEBUG
                if fixtureMode {
                    VStack {
                        if router.rendered { Text("地球已就绪").accessibilityIdentifier("earth-rendered") }
                        Text(String(router.completedFocusCount)).accessibilityIdentifier("atlas.focus.count")
                        Text(router.selection?.routePointId ?? "").accessibilityIdentifier("atlas.selection.point")
                        Text(router.selection?.assetId ?? "").accessibilityIdentifier("atlas.selection.asset")
                    }
                }
                #endif
            }
        }
        .sheet(isPresented: $session.loginPresented, onDismiss: { connectOwner() }) {
            if let origin = session.origin {
                let generation = session.generation
                NavigationStack {
                    PrivateWebView(url: origin, store: session.cookieStore, googleLogin: .init(
                        isCurrent: { session.isOwnerLoginCurrent(generation, at: origin) },
                        install: { cookie, pending in
                            await session.publishGoogleSession(cookie, at: origin, generation: generation, pending: pending)
                        },
                        failed: { googleLoginFailed = true }
                    ))
                    .id(generation)
                    .toolbar { Button("返回图谱") { session.loginPresented = false } }
                    .alert("Google 登录未完成", isPresented: $googleLoginFailed) {
                        Button("好", role: .cancel) { }
                    } message: { Text("请确认此 Startrips 站点支持 App 登录，然后重试。") }
                }
            }
        }
        .alert("图谱暂不可用", isPresented: Binding(get: { router.error != nil }, set: { if !$0 { router.error = nil } })) {
            Button("重新加载地球") { restartScene() }
            Button("关闭", role: .cancel) { router.error = nil }
        } message: { Text(router.error ?? "") }
        .onChange(of: router.error) { _, error in
            if connected && error != nil { sceneRecoveryRequired = true }
        }
        .onChange(of: router.rendered) { _, rendered in
            if rendered { sceneRecoveryRequired = false }
        }
        .task {
            router.onInvalidation = { refresh() }
            router.onSwitchAccess = {
                session.disconnect()
                router.clear()
                sceneRecoveryRequired = false
                sceneIdentity = UUID()
                connected = false
            }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-atlas-fixture") {
                fixtureMode = true
                do {
                    let url = Bundle.main.url(forResource: "bridge", withExtension: "json")!
                    let data = try Data(contentsOf: url)
                    let fixture = try JSONDecoder().decode(BridgeFixture.self, from: data)
                    try session.installFixture(data, scope: "synthetic-ci")
                    var fixtureJourneys = fixture.snapshot.journeys
                    if ProcessInfo.processInfo.arguments.contains("-atlas-multi-journey-fixture") {
                        // A second realistic Journey is needed for a real touch
                        // swipe assertion; the normal Story fixture stays unchanged.
                        fixtureJourneys.append(AtlasJourney(
                            id: "journey-fixture-valley", title: "山谷旅程",
                            startedOn: "2025-02-01", endedOn: "2025-02-03",
                            note: "另一段旅程", lightColor: "#86d4c5",
                            lightEffect: nil, routeSegments: nil, revision: 1,
                            routePoints: [AtlasRoutePoint(
                                id: "point-valley", latitude: 40.1, longitude: -105.2,
                                label: "山谷", isStop: true, occurredAt: nil)],
                            media: []))
                    }
                    router.install(fixtureJourneys, identity: "synthetic-ci", access: .owner, earthExperience: "default")
                    connected = true
                    if ProcessInfo.processInfo.arguments.contains("-atlas-scene-recovery-probe") {
                        // Test-only failure path: WKWebView may be unusable while
                        // native recovery controls still have to work.
                        router.error = "地球已暂停，请刷新重试。"
                    }
                } catch { router.error = "测试图谱无法读取。" }
                return
            }
            #endif
            // A fixed server address does not prove the owner is signed in.
            // First launch shows login / share rather than issuing a 401 Atlas request.
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
    private func restartScene() {
        // Recreates WKWebView AND its BundledSceneServer, unlike a data-only
        // refresh, which cannot recover a crashed WebKit content process.
        router.error = nil
        sceneRecoveryRequired = false
        sceneIdentity = UUID()
        refresh()
    }
    private func refresh() {
        guard !fixtureMode else { return }
        Task { await session.refresh(router) }
    }
}

struct BridgeFixture: Decodable { let snapshot: SceneSnapshot; let event: SceneEvent }
