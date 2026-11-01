import SwiftUI

// App-owned handoff boundary. B installs the Story/Playback implementation here
// without taking ownership of navigation, identity or the local scene lifetime.
@MainActor
enum FeatureDestinations {
    static var story: ((StoryHandoff, AtlasJourney, AtlasAccess, @escaping () -> Void) -> AnyView)?
}

struct StoryDestination: View {
    let target: StoryHandoff
    @ObservedObject var router: AppRouter
    var body: some View {
        Group {
            if let current = router.current(target), let journey = router.journeys.first(where: { $0.id == current.journeyId }) {
                if let story = FeatureDestinations.story {
                    story(current, journey, router.snapshot.access, { router.returnToAtlas() })
                } else {
                    // Truthful shell handoff while B's independent module is absent.
                    // This is not presented as completed media/playback acceptance.
                    VStack(alignment: .leading, spacing: 16) {
                        Text(journey.title).font(.title).accessibilityAddTraits(.isHeader)
                                .accessibilityIdentifier("story-handoff-title")
                        Text(journey.startedOn).font(.subheadline)
                        Text("故事模块尚未接入此版本。")
                        Button("返回图谱") { router.returnToAtlas() }.accessibilityIdentifier("return-to-atlas")
                    }.padding()
                }
            } else {
                ContentUnavailableView("旅程已不可用", systemImage: "map")
            }
        }.navigationTitle("旅程").navigationBarTitleDisplayMode(.inline)
    }
}
