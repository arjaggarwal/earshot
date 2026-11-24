// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "EarshotMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "EarshotMac", targets: ["EarshotMac"]),
        .library(name: "EarshotCore", targets: ["EarshotCore"]),
    ],
    targets: [
        // Pure, testable logic: no AppKit or UI. Foundation, CoreGraphics (window geometry), CoreAudio and
        // AVFAudio (buffers, conversion) only; the devices, taps, recognizer and windows live in EarshotMac.
        .target(name: "EarshotCore"),
        .executableTarget(
            name: "EarshotMac", dependencies: ["EarshotCore"],
            // The binary carries mac/Info.plist (the app's, with the privacy usage strings) in its own
            // __info_plist section, so `record-test` can ask for the mic, audio capture and speech recognition
            // without an app bundle (the Speech framework stops a process whose Info.plist lacks its usage
            // string). bundle.sh copies the same file into Earshot.app: one copy of the strings.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                                           "-Xlinker", Context.packageDirectory + "/Info.plist"])]),
        .testTarget(name: "EarshotCoreTests", dependencies: ["EarshotCore"], resources: [.copy("Fixtures")]),
    ]
)
