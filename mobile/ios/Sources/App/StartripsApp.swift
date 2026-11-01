import SwiftUI

@main
struct StartripsApp: App {
    @StateObject private var router = AppRouter()
    @StateObject private var session = AtlasSession()
    var body: some Scene {
        WindowGroup {
            AtlasRootView(router: router, session: session)
        }
    }
}
