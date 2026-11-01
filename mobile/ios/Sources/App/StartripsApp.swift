import SwiftUI

@main
struct StartripsApp: App {
    @UIApplicationDelegateAdaptor(TransferAppDelegate.self) private var transferDelegate
    @StateObject private var router = AppRouter()
    @StateObject private var session = AtlasSession()
    var body: some Scene {
        WindowGroup {
            AtlasRootView(router: router, session: session)
        }
    }
}
