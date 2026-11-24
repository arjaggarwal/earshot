import Foundation
import Testing
@testable import EarshotCore

@Suite struct RetentionTests {
    let fm = FileManager.default
    let home: URL
    let now = Date()
    let day: TimeInterval = 86_400

    init() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-retention-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }

    func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    /// A saved meeting folder (meetings/<year>/<month>/<name>/) with meeting.json and an audio/ folder.
    @discardableResult
    func savedMeeting(_ name: String, endedDaysAgo: Double?) throws -> URL {
        let folder = home.appendingPathComponent("meetings/2026/10 October/\(name)")
        try fm.createDirectory(at: folder.appendingPathComponent("audio"), withIntermediateDirectories: true)
        var json: [String: Any] = ["id": name, "startedAt": iso(now.addingTimeInterval(-40 * day))]
        if let d = endedDaysAgo { json["endedAt"] = iso(now.addingTimeInterval(-d * day)) }
        try JSONSerialization.data(withJSONObject: json).write(to: folder.appendingPathComponent("meeting.json"))
        try Data("RIFF".utf8).write(to: folder.appendingPathComponent("audio/mic.wav"))
        try Data("notes".utf8).write(to: folder.appendingPathComponent("notes.md"))
        return folder
    }

    /// run/audio/<id>/ with one WAV, everything last modified `daysAgo`.
    @discardableResult
    func runAudio(_ id: String, modifiedDaysAgo: Double) throws -> URL {
        let dir = home.appendingPathComponent("run/audio/\(id)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let wav = dir.appendingPathComponent("mic.wav")
        try Data("RIFF".utf8).write(to: wav)
        let when = now.addingTimeInterval(-modifiedDaysAgo * day)
        try fm.setAttributes([.modificationDate: when], ofItemAtPath: wav.path)
        try fm.setAttributes([.modificationDate: when], ofItemAtPath: dir.path)
        return dir
    }

    func exists(_ url: URL) -> Bool { fm.fileExists(atPath: url.path) }

    @Test func deletesOldAudioKeepsTheRest() throws {
        let old = try savedMeeting("2026-10-01 1000 Old call", endedDaysAgo: 31)
        let recent = try savedMeeting("2026-10-05 1000 Recent call", endedDaysAgo: 29)
        let open = try savedMeeting("2026-10-02 1000 Never ended", endedDaysAgo: nil)
        let oldRun = try runAudio("x", modifiedDaysAgo: 31)
        let newRun = try runAudio("y", modifiedDaysAgo: 29)

        let removed = Retention.sweep(home: home, keepDays: 30, now: now)

        #expect(Set(removed.map(\.standardizedFileURL.path)) ==
                Set([old.appendingPathComponent("audio"), oldRun].map(\.standardizedFileURL.path)))
        #expect(!exists(old.appendingPathComponent("audio")))
        #expect(exists(old.appendingPathComponent("meeting.json")), "only audio/ goes")
        #expect(exists(old.appendingPathComponent("notes.md")))
        #expect(exists(recent.appendingPathComponent("audio/mic.wav")))
        #expect(exists(open.appendingPathComponent("audio/mic.wav")))
        #expect(!exists(oldRun))
        #expect(exists(newRun.appendingPathComponent("mic.wav")))
    }

    @Test func aRecentlyWrittenFileKeepsARunFolder() throws {
        // A capture still appending to its WAV doesn't touch the folder's own date.
        let dir = try runAudio("live", modifiedDaysAgo: 31)
        try fm.setAttributes([.modificationDate: now.addingTimeInterval(-60)], ofItemAtPath: dir.appendingPathComponent("mic.wav").path)
        try fm.setAttributes([.modificationDate: now.addingTimeInterval(-31 * day)], ofItemAtPath: dir.path)
        #expect(Retention.sweep(home: home, keepDays: 30, now: now) == [])
        #expect(exists(dir.appendingPathComponent("mic.wav")))
    }

    @Test func keepDaysIsHonoured() throws {
        let m = try savedMeeting("2026-10-20 1000 Ten days", endedDaysAgo: 10)
        #expect(Retention.sweep(home: home, keepDays: 30, now: now) == [])
        #expect(Retention.sweep(home: home, keepDays: 7, now: now).count == 1)
        #expect(!exists(m.appendingPathComponent("audio")))
    }

    @Test func emptyHomeIsFine() {
        #expect(Retention.sweep(home: home.appendingPathComponent("nothing-here"), keepDays: 30, now: now) == [])
    }

    @Test func audioACaptureStillNeedsIsKept() throws {
        // A capture cut off long ago (its recovery keeps failing) or still recording: its WAVs stay until
        // it's finished, however old.
        let pending = try savedMeeting("2026-10-01 1000 Pending write-up", endedDaysAgo: 40)
        let recording = try runAudio("rec", modifiedDaysAgo: 40)
        let gone = try savedMeeting("2026-10-01 1100 Done", endedDaysAgo: 40)
        let run = home.appendingPathComponent("run")
        try ActiveCapture(meetingId: "a", captureId: "c1", kind: .desktop, folder: pending.path, startedAt: iso(now), tracks: [])
            .write(in: run)
        try FileManager.default.moveItem(at: ActiveCapture.file(in: run), to: ActiveCapture.finishingFile(in: run, captureId: "c1"))
        try ActiveCapture(meetingId: "rec", captureId: "c2", kind: .captionsOff, folder: recording.path, startedAt: iso(now), tracks: [])
            .write(in: run)

        let removed = Retention.sweep(home: home, keepDays: 30, now: now)

        #expect(exists(pending.appendingPathComponent("audio")))
        #expect(exists(recording))
        #expect(!exists(gone.appendingPathComponent("audio")))
        #expect(removed.map(\.standardizedFileURL.path) == [gone.appendingPathComponent("audio").standardizedFileURL.path])
    }
}
