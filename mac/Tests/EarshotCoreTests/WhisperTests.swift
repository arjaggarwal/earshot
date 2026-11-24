import Foundation
import Testing
@testable import EarshotCore

@Suite struct WhisperTests {
    let offset = Date(timeIntervalSince1970: 1_800_000_000)
    let mic = Track(id: "mic", speaker: "Me")

    func fixture() throws -> Data {
        try Data(contentsOf: #require(Bundle.module.url(forResource: "whisper-sample", withExtension: "json", subdirectory: "Fixtures")))
    }

    @Test func joinsCloseNeighboursUpToThirtySeconds() throws {
        let segs = try WhisperResult.segments(json: try fixture(), captureId: "cap", track: mic, offset: offset)
        let base: Int64 = 1_800_000_000_000
        #expect(segs.map(\.text) == [
            "Thanks everyone for joining. Let's start with the budget.",
            "Sure.",
            "Long one.",
            "After the cap.",
        ])
        #expect(segs.map(\.id) == (1...4).map { "mac-cap-mic-\($0)" })
        #expect(segs[0].startedAt == base && segs[0].lastAt == base + 4000)
        #expect(segs[1].startedAt == base + 6500 && segs[1].lastAt == base + 8000)
        #expect(segs[2].startedAt == base + 8900 && segs[2].lastAt == base + 40_000)
        #expect(segs[3].startedAt == base + 40_100)
        #expect(segs.allSatisfy { $0.speakerId == "mic" && $0.speaker == "Me" && $0.speakerResolved })
    }

    /// Whisper invents "Thank you." on silent audio (e.g. three of them on a silent call track).
    @Test func linesOverSilentAudioAreDropped() throws {
        let rate = 16_000.0
        // 0–2 s silence, 2–4 s a quiet voice (about -30 dB), 4–6 s a near-silent hiss (about -70 dB).
        var samples = [Float](repeating: 0, count: Int(rate * 6))
        for i in Int(rate * 2)..<Int(rate * 4) { samples[i] = 0.045 * sin(Float(i) * 0.05) }
        for i in Int(rate * 4)..<Int(rate * 6) { samples[i] = 0.0004 * sin(Float(i) * 0.3) }
        let base: Int64 = 1_800_000_000_000
        func seg(_ from: Int64, _ to: Int64, _ text: String) -> Segment {
            Segment(id: text, speaker: "Call", speakerId: "call", speakerResolved: true, startedAt: base + from, lastAt: base + to, text: text)
        }
        let segs = [seg(0, 2000, "Thank you."), seg(2000, 4000, "Real words."), seg(4000, 6000, "Hiss."), seg(1500, 2500, "Straddles.")]
        let kept = WhisperResult.droppingSilent(segs, samples: samples, sampleRate: rate, offset: offset)
        #expect(kept.map(\.text) == ["Real words.", "Straddles."])
    }

    @Test func corruptJsonThrowsButEmptyTranscriptionIsEmpty() throws {
        #expect(throws: (any Error).self) {
            _ = try WhisperResult.segments(json: Data("nope".utf8), captureId: "c", track: mic, offset: offset)
        }
        let empty = try WhisperResult.segments(json: Data(#"{"transcription": []}"#.utf8), captureId: "c", track: mic, offset: offset)
        #expect(empty.isEmpty)
    }

    /// A fake whisper-cli that records its pid and sleeps, to check cancellation terminates the child.
    @Test func cancellingARunTerminatesTheChild() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fake-whisper-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let pidFile = dir.appendingPathComponent("pid")
        let script = dir.appendingPathComponent("fake-whisper")
        try "#!/bin/bash\necho $$ > '\(pidFile.path)'\nexec sleep 60\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let t = Transcriber(binary: script.path, model: URL(fileURLWithPath: "/nonexistent"))
        let mic = self.mic, offset = self.offset
        let task = Task { try await t.run(captureId: "c", tracks: [(mic, URL(fileURLWithPath: "/x.wav"))], startedAt: offset) }
        var pid: Int32 = 0
        for _ in 0..<100 {
            if let s = try? String(contentsOf: pidFile, encoding: .utf8), let p = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) { pid = p; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try #require(pid > 0)
        let began = Date()
        task.cancel()
        _ = await task.result
        #expect(Date().timeIntervalSince(began) < 5)
        var gone = false
        for _ in 0..<40 {
            if kill(pid, 0) != 0 { gone = true; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(gone)
    }

    @Test func tildeInModelPathIsExpanded() {
        let t = Transcriber(modelPath: "~/Earshot/models/m.bin")
        #expect(t.model.path == NSHomeDirectory() + "/Earshot/models/m.bin")
    }

    @Test func missingBinaryThrows() async {
        let t = Transcriber(binary: "no-such-whisper-binary", model: URL(fileURLWithPath: "/nonexistent"))
        await #expect(throws: TranscriberError.self) {
            _ = try await t.run(captureId: "c", tracks: [(mic, URL(fileURLWithPath: "/nonexistent.wav"))], startedAt: offset)
        }
    }

    /// The "for-tests" tiny model is a stub that transcribes nothing, so use the real turbo model.
    static let jfkModel = NSHomeDirectory() + "/Earshot/models/ggml-large-v3-turbo-q5_0.bin"
    static let jfkReady = ["/opt/homebrew/share/whisper-cpp/jfk.wav", jfkModel, "/opt/homebrew/bin/whisper-cli"]
        .allSatisfy { FileManager.default.fileExists(atPath: $0) }

    @Test(.enabled(if: WhisperTests.jfkReady, "needs jfk.wav, the turbo model and whisper-cli"))
    func transcribesJFK() async throws {
        let wav = URL(fileURLWithPath: "/opt/homebrew/share/whisper-cpp/jfk.wav")
        let model = URL(fileURLWithPath: NSHomeDirectory() + "/Earshot/models/ggml-large-v3-turbo-q5_0.bin")
        let segs = try await Transcriber(model: model).run(captureId: "cap", tracks: [(mic, wav)], startedAt: offset)
        #expect(segs.contains { $0.text.contains("country") })
    }
}
