import SwiftUI
import UIKit

struct AtlasRootView: View {
    @ObservedObject var router: AppRouter
    @ObservedObject var session: AtlasSession
    @Environment(\.scenePhase) private var phase
    @State private var connected = false
    @State private var launching = true
    @State private var sceneIdentity = UUID()
    @State private var fixtureMode = false
    @State private var sceneRecoveryRequired = false
    @State private var settingsPresented = false
    @State private var pendingSettingsAction: SettingsAction?
    @StateObject private var covers = JourneyCoverStore()
    @Namespace private var storyNamespace

    private var shell: AtlasShell {
        AtlasShell(launching: launching, connected: connected, installed: router.installed,
                   busy: session.busy, failed: router.error != nil)
    }
    private var loading: Bool { shell == .loading }

    var body: some View {
        // System pops (the zoom transition's interactive dismiss, edge swipe)
        // go through Story's own exit so #788's position commit still runs.
        NavigationStack(path: Binding(get: { router.path }, set: { router.navigate($0) })) {
            ZStack {
                AtlasPalette.background.ignoresSafeArea()
                if connected {
                    // The scene draws under the status bar and home indicator;
                    // its CSS already pads with env(safe-area-inset-*).
                    AtlasSceneView(router: router, mapOrigin: session.origin)
                        .id(sceneIdentity)
                        .ignoresSafeArea()
                    // The top bar (wordmark + Settings) is always reachable once connected;
                    // the card and ribbon need an installed Atlas.
                    if shell == .stalled {
                        AtlasStalledView(guest: router.access == .guest, retry: restartScene, signOut: signOut)
                    }
                    AtlasChrome(router: router, session: session, covers: covers, storyNamespace: storyNamespace,
                                installed: router.installed) { settingsPresented = true }
                } else if !launching {
                    #if DEBUG
                    WelcomeView(signIn: signIn, pasteShare: pasteShare, debugOrigin: $session.originText)
                    #else
                    WelcomeView(signIn: signIn, pasteShare: pasteShare)
                    #endif
                }
                if loading { AtlasLoadingView() }
            }
            .navigationTitle(router.snapshot.access == .guest ? "分享图谱" : "图谱")
            .navigationBarTitleDisplayMode(.inline)
            // The Atlas draws its own native wordmark/account bar over the globe.
            // Story keeps native navigation, while the Atlas has only one header.
            .toolbar(router.path.isEmpty ? .hidden : .visible, for: .navigationBar)
            .navigationDestination(for: StoryHandoff.self) { target in
                StoryDestination(target: target, router: router, session: session).id(target.requestId)
                    .storyZoomTransition(id: target.journeyId, in: storyNamespace)
            }
            .overlay(alignment: .top) {
                if connected && router.path.isEmpty && sceneRecoveryRequired {
                    // Independent of the local WKWebView: available even when
                    // JavaScript and the loopback scene are no longer running.
                    Button("重新加载地球") { restartScene() }
                        .accessibilityIdentifier("atlas.native-scene-reload")
                        .font(.headline)
                        .foregroundStyle(AtlasPalette.ink)
                        .padding(.horizontal, NightFlight.edge)
                        .frame(minHeight: NightFlight.hitTarget)
                        .background(Capsule().fill(AtlasPalette.background.opacity(0.92)))
                        .overlay(Capsule().stroke(AtlasPalette.line))
                        .padding(.top, NightFlight.grid(2))
                }
                #if DEBUG
                if fixtureMode {
                    // Accessibility-only probes for XCUITest; never drawn in screenshots.
                    VStack {
                        if router.rendered { Text("地球已就绪").accessibilityIdentifier("earth-rendered") }
                        Text(String(router.completedFocusCount)).accessibilityIdentifier("atlas.focus.count")
                        Text(router.selection?.routePointId ?? "").accessibilityIdentifier("atlas.selection.point")
                        Text(router.selection?.assetId ?? "").accessibilityIdentifier("atlas.selection.asset")
                    }
                    .foregroundStyle(.clear)
                    .allowsHitTesting(false)
                }
                #endif
            }
        }
        .tint(NightFlight.ink)
        // Settings closes before an account action runs, so sign-in can present its own sheet.
        .sheet(isPresented: $settingsPresented, onDismiss: runSettingsAction) {
            SettingsView(router: router) { action in
                pendingSettingsAction = action
                settingsPresented = false
            }
        }
        .sheet(isPresented: $session.loginPresented, onDismiss: { connectOwner() }) {
            if let origin = session.origin {
                NativeSignInView(session: session, origin: origin)
            }
        }
        .alert("图谱暂不可用", isPresented: Binding(get: { router.error != nil }, set: { if !$0 { router.error = nil } })) {
            if connected { Button("重新加载地球") { restartScene() } }
            Button("关闭", role: .cancel) { router.error = nil }
        } message: { Text(router.error ?? "") }
        .onChange(of: router.error) { _, error in
            if connected && error != nil { sceneRecoveryRequired = true }
        }
        // A different owner or share never keeps the previous scope's covers.
        .onChange(of: router.scopeId) { _, _ in covers.reset() }
        .onChange(of: router.rendered) { _, rendered in
            if rendered { sceneRecoveryRequired = false }
        }
        .onChange(of: session.signInRequired) { _, required in
            // An expired or missing owner session returns to sign-in, not an error alert.
            guard required else { return }
            session.signInRequired = false
            leaveAtlas { session.disconnect() }
        }
        .task {
            router.onInvalidation = { refresh() }
            router.onSwitchAccess = { settingsPresented = true }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-atlas-login-probe") {
                // Screenshot probe only: the native sign-in sheet without a tap.
                launching = false
                signIn()
                return
            }
            if ProcessInfo.processInfo.arguments.contains("-atlas-loading-probe") {
                // Test-only: hold the branded launch state for a screenshot.
                return
            }
            if ProcessInfo.processInfo.arguments.contains("-atlas-fixture") {
                fixtureMode = true
                launching = false
                do {
                    let url = Bundle.main.url(forResource: "bridge", withExtension: "json")!
                    let data = try Data(contentsOf: url)
                    let fixture = try JSONDecoder().decode(BridgeFixture.self, from: data)
                    try session.installFixture(data, scope: "synthetic-ci")
                    var fixtureJourneys = fixture.snapshot.journeys
                    if ProcessInfo.processInfo.arguments.contains("-atlas-empty-fixture") {
                        fixtureJourneys = []
                    }
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
                    if ProcessInfo.processInfo.arguments.contains("-atlas-stalled-probe") {
                        // Test-only: connected without an installed Atlas, the former dead end.
                        router.clear()
                    }
                    if ProcessInfo.processInfo.arguments.contains("-atlas-open-settings") {
                        // Screenshot probe only: open Settings without a tap.
                        settingsPresented = true
                    }
                    if ProcessInfo.processInfo.arguments.contains("-atlas-open-story") {
                        // Screenshot probe only: open Story without a gesture.
                        router.openStory(journeyId: fixture.snapshot.journeys[0].id, routePointId: "point-a")
                    }
                    if ProcessInfo.processInfo.arguments.contains("-atlas-scene-recovery-probe") {
                        // Test-only failure path: WKWebView may be unusable while
                        // native recovery controls still have to work.
                        router.error = "地球已暂停，请刷新重试。"
                    }
                } catch { router.error = "测试图谱无法读取。" }
                return
            }
            #endif
            await restoreOwner()
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

    /// Reopens the owner's Atlas when the persistent profile still holds a
    /// session cookie; a missing or rejected session lands on sign-in.
    private func restoreOwner() async {
        defer { launching = false }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-allow-server-override") { return }
        #endif
        do { try session.configureOwner() } catch { return }
        guard await session.hasOwnerCredentials() else { session.disconnect(); return }
        router.clear(); connected = true; sceneIdentity = UUID()
        refresh()
    }

    private func runSettingsAction() {
        guard let action = pendingSettingsAction else { return }
        pendingSettingsAction = nil
        switch action {
        case .signIn: signIn()
        case .pasteShare: pasteShare()
        case .signOut: signOut()
        }
    }

    private func signIn() {
        do { try session.configureOwner(); session.loginPresented = true }
        catch { router.error = error.localizedDescription }
    }

    private func pasteShare() {
        let link = (UIPasteboard.general.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try session.configureGuest(link)
            fixtureMode = false
            router.clear(); sceneRecoveryRequired = false
            connected = true; sceneIdentity = UUID()
            Task { await session.refresh(router) }
        } catch { router.error = error.localizedDescription }
    }

    private func signOut() {
        // The branded loading surface covers the short server sign-out request.
        leaveAtlas { launching = true }
        Task { await session.signOut(); launching = false }
    }

    private func leaveAtlas(_ end: () -> Void) {
        end()
        fixtureMode = false
        covers.reset()
        router.clear()
        sceneRecoveryRequired = false
        sceneIdentity = UUID()
        connected = false
    }

    private func connectOwner() {
        do {
            // A real owner session ends any synthetic fixture: refresh() must run.
            try session.configureOwner(); fixtureMode = false
            router.clear(); connected = true; sceneIdentity = UUID()
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

/// First launch / signed-out entry: the wordmark and two actions, no helper copy.
private struct WelcomeView: View {
    let signIn: () -> Void
    let pasteShare: () -> Void
    var debugOrigin: Binding<String>? = nil

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: NightFlight.grid(12))
                    AtlasWordmark()
                    Spacer(minLength: NightFlight.grid(12))
                    VStack(spacing: NightFlight.grid(3)) {
                        #if DEBUG
                        // Only explicit developer launches expose a server override.
                        if let debugOrigin, ProcessInfo.processInfo.arguments.contains("-allow-server-override") {
                            TextField("调试服务器（仅开发版）", text: debugOrigin)
                                .textContentType(.URL).keyboardType(.URL)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .padding(NightFlight.grid(3))
                                .nightFlightSurface(radius: NightFlight.radiusSmall)
                        }
                        #endif
                        Button(action: signIn) {
                            Text("登录").padding(.vertical, NightFlight.grid(2))
                        }
                        .buttonStyle(NightFlightPillButtonStyle())
                        .accessibilityIdentifier("welcome.sign-in")
                        Button(action: pasteShare) {
                            Label("粘贴分享链接", systemImage: "doc.on.clipboard")
                                .multilineTextAlignment(.center)
                                .padding(.vertical, NightFlight.grid(2))
                        }
                        .buttonStyle(NightFlightPillButtonStyle(prominent: false))
                        .accessibilityIdentifier("welcome.paste-share")
                    }
                    .padding(.bottom, NightFlight.grid(6))
                }
                .padding(.horizontal, NightFlight.edge)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

/// Which surface the root shows. Connected without an installed Atlas, not
/// loading, is never a blank globe: it is `stalled`, with a way out.
enum AtlasShell: Equatable {
    case loading, welcome, atlas, stalled

    init(launching: Bool, connected: Bool, installed: Bool, busy: Bool, failed: Bool) {
        if launching { self = .loading }
        else if !connected { self = .welcome }
        else if installed { self = .atlas }
        else if busy && !failed { self = .loading }
        else { self = .stalled }
    }
}

/// Retry or leave; no helper copy. The top bar above it still opens Settings.
private struct AtlasStalledView: View {
    let guest: Bool
    let retry: () -> Void
    let signOut: () -> Void
    var body: some View {
        VStack(spacing: NightFlight.grid(3)) {
            Button("重试", action: retry)
                .buttonStyle(NightFlightPillButtonStyle())
                .accessibilityIdentifier("atlas.stalled.retry")
            Button(guest ? "退出分享" : "退出登录", action: signOut)
                .buttonStyle(NightFlightPillButtonStyle(prominent: false))
                .accessibilityIdentifier("atlas.stalled.sign-out")
        }
        .frame(maxWidth: 520)
        .padding(.horizontal, NightFlight.edge)
        .frame(maxHeight: .infinity)
        .background(NightFlight.background.opacity(0.6).ignoresSafeArea())
    }
}

/// Full-bleed launch / loading surface; replaces the old material progress box.
private struct AtlasLoadingView: View {
    var body: some View {
        ZStack {
            AtlasPalette.background.ignoresSafeArea()
            VStack(spacing: NightFlight.grid(7)) {
                AtlasWordmark()
                ProgressView().tint(NightFlight.muted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在打开图谱")
        .accessibilityIdentifier("atlas.loading")
    }
}

private struct AtlasWordmark: View {
    var body: some View {
        Text("startrips")
            .font(.system(.largeTitle, design: .serif))
            .foregroundStyle(AtlasPalette.ink)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("atlas.wordmark")
    }
}

struct BridgeFixture: Decodable { let snapshot: SceneSnapshot; let event: SceneEvent; let commands: [SceneCommand] }
