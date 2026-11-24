import EarshotCore
import Foundation

// Command-line commands that work from files, with no running app.

func fail(_ message: String, code: Int32 = 64) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let usageText = """
usage: EarshotMac [<command>]
  (none)        the menu-bar app (what Earshot.app runs)
  probe-audio   print Core Audio's clients (pid, bundle id, inputRunning) every 2 s
  transcribe    --started <ISO> [--capture-id <id>] --track <id>=<Speaker>:<audio file> [--track ...] [--model <path>] [--out <file>]
                run whisper-cli over recorded tracks and write the segments as JSON (stdout without --out).
                Pass the capture's own --capture-id when the output will replace its live lines.
  record-test   [--seconds 15] [--app <bundle id prefix, e.g. us.zoom>] [--out <folder>]
                record the mic plus the whole Mac's audio (or only that app's, as call.wav), print the live
                lines, and leave the WAVs in <folder>/audio (default ~/Earshot/record-test/<time>).
                Raises macOS's microphone, audio capture and speech recognition prompts.
  live-test     <wav> [--speed 1]  play a recorded track through the live-text pipeline and print each
                line and event. Run as the app for its speech permission: open -a Earshot --args live-test …

"""

func transcribeCommand(_ args: [String]) -> Never {
    var started: Date?
    var tracks: [(Track, URL)] = []
    var out: String?
    var captureIdArg: String?
    var modelPath = "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin"
    var i = 0
    func value() -> String {
        i += 1
        guard i < args.count else { fail("missing value for \(args[i - 1])\n" + usageText) }
        return args[i]
    }
    while i < args.count {
        switch args[i] {
        case "--started":
            let v = value()
            guard let d = CLIArgs.parseISO(v) else { fail("bad --started (want ISO 8601): \(v)") }
            started = d
        case "--track":
            let v = value()
            guard let t = CLIArgs.parseTrack(v) else { fail("bad --track (want id=Speaker:/path, speaker required): \(v)") }
            if tracks.contains(where: { $0.0.id == t.0.id }) { fail("duplicate track id \(t.0.id)") }
            tracks.append(t)
        case "--out": out = value()
        case "--capture-id": captureIdArg = value()
        case "--model": modelPath = value()
        default: fail("unknown argument \(args[i])\n" + usageText)
        }
        i += 1
    }
    guard let started else { fail("--started is required\n" + usageText) }
    guard !tracks.isEmpty else { fail("at least one --track is required\n" + usageText) }

    let transcriber = Transcriber(modelPath: modelPath)
    guard FileManager.default.fileExists(atPath: transcriber.model.path) else {
        fail("model not found at \(transcriber.model.path); copy it to ~/Earshot/models", code: 1)
    }
    let captureId = captureIdArg ?? SegmentIds.captureId(for: started)
    let sem = DispatchSemaphore(value: 0)
    var result: Result<[Segment], Error> = .success([])
    Task {
        result = await Result.async { try await transcriber.run(captureId: captureId, tracks: tracks, startedAt: started) }
        sem.signal()
    }
    sem.wait()
    switch result {
    case .failure(let e): fail("transcribe failed: \(e)", code: 1)
    case .success(let segments):
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try enc.encode(segments)
            if let out {
                try data.write(to: URL(fileURLWithPath: (out as NSString).expandingTildeInPath), options: .atomic)
                print("wrote \(segments.count) segments to \(out)")
            } else {
                FileHandle.standardOutput.write(data + Data("\n".utf8))
            }
        } catch { fail("could not write output: \(error)", code: 1) }
        exit(0)
    }
}

extension Result where Failure == Error {
    static func async(_ body: () async throws -> Success) async -> Result {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
