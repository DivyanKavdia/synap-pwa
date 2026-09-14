// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SynapCaptureCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "SynapCaptureCore", targets: ["SynapCaptureCore"])],
    targets: [
        .target(name: "SynapCaptureCore", path: "Core"),
        .testTarget(name: "SynapCaptureCoreTests", dependencies: ["SynapCaptureCore"],
                    path: "Tests", resources: [.copy("Fixtures")])
    ],
    swiftLanguageVersions: [.v5]
)
