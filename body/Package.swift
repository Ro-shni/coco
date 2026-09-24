// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "CocoBody",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CocoCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "CocoBody", dependencies: ["CocoCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "CocoCoreTests", dependencies: ["CocoCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
