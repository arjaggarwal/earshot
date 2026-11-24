import AVFAudio
import EarshotCore
import Foundation

// `record-test`: records the mic plus the Mac's (or one app's) audio for a few seconds, prints the live
// lines, and leaves the WAVs for listening. It raises macOS's permission prompts, so it is run by hand.

func recordTestCommand(_ args: [String]) -> Never {
    var seconds: Double = 15
    var app: String?
    var out: String?
    var i = 0
    func value() -> String {
        i += 1
        guard i < args.count else { fail("missing value for \(args[i - 1])\n" + usageText) }
        return args[i]
    }
    while i < args.count {
        switch args[i] {
        case "--seconds":
            let v = value()
            guard let s = Double(v), s > 0 else { fail("bad --seconds: \(v)") }
            seconds = s
        case "--app": app = value()
        case "--out": out = value()
        default: fail("unknown argument \(args[i])\n" + usageText)
        }
        i += 1
    }
    guard #available(macOS 14.2, *) else { fail("record-test needs macOS 14.2 or later (Core Audio process taps)", code: 1) }

    let folder: URL
    if let out {
        folder = URL(fileURLWithPath: (out as NSString).expandingTildeInPath)
    } else {
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        folder = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Earshot/record-test/\(stamp.string(from: Date()))", isDirectory: true)
    }
    let second: (Track, Recorder.Source) = app.map { (Track(id: "call", speaker: "Call"), .tap(.processes(bundlePrefix: $0))) }
        ?? (Track(id: "system", speaker: "System"), .tap(.systemExcludingSelf))

    Task {
        let allowed = await Recorder.requestPermissions()
        print("microphone \(allowed.mic ? "allowed" : "NOT allowed"), speech recognition \(allowed.speech ? "allowed" : "NOT allowed")")
        let recorder = Recorder(folder: folder, tracks: [(Track(id: "mic", speaker: "Me"), .mic), second])
        if let reason = recorder.speechOffReason { print("live text off: \(reason)") }
        do { try recorder.start() } catch { fail("\(error)", code: 1) }
        print("recording \(Int(seconds)) s: mic + \(second.0.id) (\(second.1.label)) into \(recorder.audioFolder.path)")

        let lines = Task { () -> [Segment] in
            // A line is printed once the next line on its track starts; the rest at the end.
            var latest: [String: Segment] = [:]
            var all: [String: Segment] = [:]
            for await seg in recorder.segments {
                if let prev = latest[seg.speakerId], prev.id != seg.id { print("  [\(prev.speakerId)] \(prev.text)") }
                latest[seg.speakerId] = seg
                all[seg.id] = seg
            }
            return all.values.sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }
        }
        let levels = Task {
            var peak: [String: Float] = [:]
            var last = Date()
            for await l in recorder.level {
                peak[l.trackId] = max(peak[l.trackId] ?? 0, l.rms)
                if Date().timeIntervalSince(last) >= 1 {
                    print("  level " + peak.keys.sorted().map { "\($0) \(String(format: "%.3f", peak[$0]!))" }.joined(separator: "  "))
                    peak = [:]
                    last = Date()
                }
            }
        }
        let statuses = Task { for await s in recorder.status { print("status: \(s)") } }

        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        let files = recorder.stop()
        let transcript = await lines.value
        await levels.value
        await statuses.value

        print("\nlive lines (\(transcript.count)):")
        for seg in transcript { print("  [\(seg.speakerId)] \(seg.text)") }
        print("\nfiles:")
        for (track, url) in files {
            if let f = try? AVAudioFile(forReading: url) {
                let rate = f.fileFormat.sampleRate
                print("  \(track.id): \(url.path)  \(Int(rate)) Hz, \(f.fileFormat.channelCount) ch, \(String(format: "%.1f", Double(f.length) / rate)) s")
            } else {
                print("  \(track.id): \(url.path)  (could not be read)")
            }
        }
        exit(0)
    }
    dispatchMain()
}
