// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "StartripsMedia",
    platforms: [.iOS(.v16)],
    products: [.library(name: "StartripsMedia", targets: ["StartripsMedia"])],
    targets: [
        .target(name: "StartripsMedia", path: "Sources"),
        .testTarget(name: "StartripsMediaTests", dependencies: ["StartripsMedia"],
                    path: "Tests", resources: [.copy("Fixtures")])
    ]
)
