import SwiftUI

@main
struct StartripsApp: App {
    @UIApplicationDelegateAdaptor(TransferAppDelegate.self) private var transferDelegate
    @StateObject private var router: AppRouter
    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-atlas-fixture") {
            // Each simulator case starts at Atlas; real navigation restoration stays enabled.
            let defaults = UserDefaults(suiteName: "app.startrips.fixture." + UUID().uuidString)!
            _router = StateObject(wrappedValue: AppRouter(defaults: defaults))
            return
        }
        #endif
        _router = StateObject(wrappedValue: AppRouter())
    }
    @StateObject private var session = AtlasSession()
    var body: some Scene {
        WindowGroup {
            AtlasRootView(router: router, session: session)
                .preferredColorScheme(.dark)
        }
    }
}
