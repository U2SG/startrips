import SafariServices
import SwiftUI
import UIKit

/// Native owner sign-in: email/password and Google. Registration and password
/// reset stay on the web and open in the system Safari surface.
struct NativeSignInView: View {
    @ObservedObject var session: AtlasSession
    let origin: URL
    @StateObject private var model: NativeSignInModel
    @State private var google: NativeGoogleLogin?
    @State private var safariURL: WebAccountPage?
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    init(session: AtlasSession, origin: URL) {
        self.session = session
        self.origin = origin
        _model = StateObject(wrappedValue: NativeSignInModel(session: session, origin: origin))
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.organizations.isEmpty { form } else { organizations }
            }
            .scrollContentBackground(.hidden)
            .background(NightFlight.background.ignoresSafeArea())
            .foregroundStyle(NightFlight.ink)
            .navigationTitle(model.organizations.isEmpty ? "登录" : "选择图谱")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { session.loginPresented = false }.accessibilityIdentifier("login.cancel")
                }
            }
            .disabled(model.busy)
        }
        .tint(NightFlight.ink)
        .presentationBackground(NightFlight.background)
        .sheet(item: $safariURL) { SafariView(url: $0.url).ignoresSafeArea() }
        .onDisappear { model.cancel(); google?.invalidate() }
    }

    private var form: some View {
        Form {
            Section {
                TextField("邮箱", text: $model.email)
                    .textContentType(.username).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.next).focused($focus, equals: .email)
                    .onSubmit { focus = .password }
                    .frame(minHeight: NightFlight.hitTarget)
                    .accessibilityIdentifier("login.email")
                SecureField("密码", text: $model.password)
                    .textContentType(.password)
                    .submitLabel(.go).focused($focus, equals: .password)
                    .onSubmit { model.submit() }
                    .frame(minHeight: NightFlight.hitTarget)
                    .accessibilityIdentifier("login.password")
            }
            if let message = model.message {
                Section {
                    Text(message).foregroundStyle(NightFlight.ink)
                        .accessibilityIdentifier("login.message")
                }
            }
            Section {
                VStack(spacing: NightFlight.grid(3)) {
                    Button { focus = nil; model.submit() } label: {
                        HStack {
                            Text("登录")
                            if model.busy { Spacer(); ProgressView().tint(NightFlight.background) }
                        }
                    }
                    .buttonStyle(NightFlightPillButtonStyle())
                    .accessibilityIdentifier("login.submit")
                    Button { startGoogle() } label: { Label("使用 Google 登录", systemImage: "g.circle") }
                        .buttonStyle(NightFlightPillButtonStyle(prominent: false))
                        .accessibilityIdentifier("login.google")
                }
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            }
            Section {
                Button("注册") { safariURL = WebAccountPage(url: origin) }
                    .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                    .accessibilityIdentifier("login.register")
                Button("忘记密码") { safariURL = WebAccountPage(url: origin) }
                    .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                    .accessibilityIdentifier("login.forgot")
            }
        }
    }

    private var organizations: some View {
        Form {
            Section {
                ForEach(model.organizations) { organization in
                    Button(organization.name) { model.choose(organization) }
                        .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
                        .accessibilityIdentifier("login.organization." + organization.id)
                }
            }
            if let message = model.message {
                Section { Text(message).accessibilityIdentifier("login.message") }
            }
        }
    }

    private func startGoogle() {
        guard let anchor = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        focus = nil
        let generation = session.generation
        google?.invalidate()
        let login = NativeGoogleLogin(origin: origin, anchor: anchor, access: .init(
            isCurrent: { session.isOwnerLoginCurrent(generation, at: origin) },
            install: { cookie, pending in
                guard await session.publishGoogleSession(cookie, at: origin, generation: generation, pending: pending) else {
                    return false
                }
                model.sessionInstalled()
                return true
            },
            failed: { model.message = "Google 登录未完成" }
        ), setBusy: { _ in })
        google = login
        login.begin()
    }
}

/// The web sign-in page hosts registration and password reset (mode buttons, no route of their own).
private struct WebAccountPage: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// The system browser surface for web-only account flows (register, reset, verify).
private struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.preferredControlTintColor = UIColor(NightFlight.ink)
        controller.preferredBarTintColor = NightFlight.backgroundUIColor
        return controller
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
