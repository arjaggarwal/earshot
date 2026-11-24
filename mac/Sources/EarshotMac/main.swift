import EarshotCore
import Foundation

// Earshot for Mac. With no arguments (as Earshot.app opens): the menu-bar app. With a command: the
// command-line checks, which work without the app.

setvbuf(stdout, nil, _IOLBF, 0)

func probeAudio() -> Never {
    // Prints Core Audio's process list every 2 s, for checking what Teams and Zoom look like during a real call.
    let source = CoreAudioClientSource()
    let stamp = ISO8601DateFormatter()
    stamp.formatOptions = [.withInternetDateTime]
    stamp.timeZone = .current
    while true {
        let clients = source.clients()
        print("— \(stamp.string(from: Date()))  \(clients.count) audio clients")
        for client in clients.sorted(by: { ($0.inputRunning ? 0 : 1, $0.bundleId) < ($1.inputRunning ? 0 : 1, $1.bundleId) }) {
            let app = CallApp(bundleId: client.bundleId).map { "  [\($0.rawValue)]" } ?? ""
            print("  \(client)\(app)")
        }
        Thread.sleep(forTimeInterval: 2)
    }
}

// Older macOS passes Finder launches a -psn_ process serial number; it isn't a command.
let args = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }
switch args.first {
case nil:
    MainActor.assumeIsolated { EarshotApp.run() }
case "help", "-h", "--help":
    FileHandle.standardError.write(Data(usageText.utf8))
    exit(0)
case "probe-audio":
    probeAudio()
case "transcribe":
    transcribeCommand(Array(args.dropFirst()))
case "record-test":
    recordTestCommand(Array(args.dropFirst()))
case "live-test":
    liveTestCommand(Array(args.dropFirst()))
default:
    FileHandle.standardError.write(Data(usageText.utf8))
    exit(64)
}
