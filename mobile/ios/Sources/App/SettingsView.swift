import SwiftUI

/// Account actions the Settings page hands back to the root view after it closes.
enum SettingsAction { case signIn, pasteShare, signOut }

/// Native Settings, opened by the avatar: the account and every map label
/// control. The globe screen itself keeps only the wordmark and the avatar.
struct SettingsView: View {
    @ObservedObject var router: AppRouter
    let perform: (SettingsAction) -> Void
    @Environment(\.dismiss) private var dismiss

    private var labels: Binding<SceneLabelPreferences> {
        Binding(get: { router.presentation.labels }, set: { router.setLabels($0) })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("账户") {
                    if router.access == .owner {
                        action("切换图谱", "settings.switch-atlas", .signIn)
                        action("粘贴分享链接", "settings.paste-share", .pasteShare)
                        action("退出登录", "settings.sign-out", .signOut, role: .destructive)
                    } else {
                        action("登录", "settings.sign-in", .signIn)
                        action("粘贴分享链接", "settings.paste-share", .pasteShare)
                        action("退出分享", "settings.leave-share", .signOut, role: .destructive)
                    }
                }
                Section("地图标签") {
                    Picker("语言", selection: labels.language) {
                        Text("中文").tag("zh")
                        Text("双语").tag("bilingual")
                    }
                    .pickerStyle(.menu)
                    .frame(minHeight: NightFlight.hitTarget)
                    .accessibilityIdentifier("settings.label-language")
                    Toggle("城市名称", isOn: labels.showPlaceNames)
                        .tint(NightFlight.accent)
                        .frame(minHeight: NightFlight.hitTarget)
                        .accessibilityIdentifier("settings.place-names")
                }
            }
            .scrollContentBackground(.hidden)
            .background(NightFlight.background.ignoresSafeArea())
            .foregroundStyle(NightFlight.ink)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }.accessibilityIdentifier("settings.done")
                }
            }
        }
        .tint(NightFlight.ink)
        .presentationBackground(NightFlight.background)
        .accessibilityIdentifier("settings")
    }

    private func action(_ title: String, _ id: String, _ action: SettingsAction,
                        role: ButtonRole? = nil) -> some View {
        Button(title, role: role) { perform(action) }
            .frame(maxWidth: .infinity, minHeight: NightFlight.hitTarget, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityIdentifier(id)
    }
}
