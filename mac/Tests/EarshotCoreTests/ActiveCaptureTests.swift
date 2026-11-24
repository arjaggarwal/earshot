import Foundation
import Testing
@testable import EarshotCore

@Suite struct ActiveCaptureTests {
    func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-active-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func capture(folder: URL) -> ActiveCapture {
        ActiveCapture(meetingId: "teams-desktop-mac-20261104-101500", captureId: "mhk2x1a0", kind: .desktop,
                      folder: folder.path, startedAt: "2026-11-04T15:15:00.123Z",
                      tracks: [.init(id: "mic", speaker: "Alex"), .init(id: "call", speaker: "Call")])
    }

    func writeWav(_ url: URL, bytes: Int = 1000) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(count: bytes).write(to: url)
    }

    @Test func leftoverReturnsTheWrittenRecordAndNilOnceCleared() throws {
        let run = try tempDir(), folder = try tempDir()
        try writeWav(folder.appendingPathComponent("audio/mic.wav"))
        let active = capture(folder: folder)
        try active.write(in: run)
        #expect(ActiveCapture.leftover(in: run) == .capture(active))
        ActiveCapture.clear(in: run)
        #expect(ActiveCapture.leftover(in: run) == nil)
        #expect(!FileManager.default.fileExists(atPath: run.appendingPathComponent("active.json").path))
    }

    @Test func aLeftoverWithoutItsAudioFolderIsNothingToRecover() throws {
        let run = try tempDir(), folder = try tempDir()
        let active = capture(folder: folder)
        try active.write(in: run)
        #expect(ActiveCapture.leftover(in: run) == .nothingToRecover(active))
        // An audio folder holding only empty WAVs (a header at most) has nothing either.
        try writeWav(folder.appendingPathComponent("audio/mic.wav"), bytes: 44)
        #expect(ActiveCapture.leftover(in: run) == .nothingToRecover(active))
        try writeWav(folder.appendingPathComponent("audio/call.wav"), bytes: 4000)
        #expect(ActiveCapture.leftover(in: run) == .capture(active))
    }

    @Test func theFileHasTheBriefsShapeAndIsWrittenAtomically() throws {
        let run = try tempDir(), folder = try tempDir()
        try capture(folder: folder).write(in: run)
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: run.appendingPathComponent("active.json"))) as? [String: Any]
        #expect(json?["meetingId"] as? String == "teams-desktop-mac-20261104-101500")
        #expect(json?["captureId"] as? String == "mhk2x1a0")
        #expect(json?["kind"] as? String == "desktop")
        #expect(json?["folder"] as? String == folder.path)
        #expect(json?["startedAt"] as? String == "2026-11-04T15:15:00.123Z")
        let tracks = json?["tracks"] as? [[String: Any]]
        #expect(tracks?.map { $0["id"] as? String } == ["mic", "call"])
        #expect(tracks?.map { $0["speaker"] as? String } == ["Alex", "Call"])
        // Only the file itself: no temporary file left behind.
        #expect(try FileManager.default.contentsOfDirectory(atPath: run.path) == ["active.json"])
    }

    @Test func kindsUseTheirFileNames() throws {
        #expect(ActiveCapture.Kind.captionsOff.rawValue == "captions-off")
        #expect(ActiveCapture.Kind.manual.rawValue == "manual")
        #expect(ActiveCapture.Kind.desktop.rawValue == "desktop")
    }

    @Test func clearingForAnotherCaptureLeavesTheFile() throws {
        let run = try tempDir(), folder = try tempDir()
        try capture(folder: folder).write(in: run)
        ActiveCapture.clear(in: run, captureId: "someoneelse")
        #expect(ActiveCapture.leftover(in: run) != nil)
        ActiveCapture.clear(in: run, captureId: "mhk2x1a0")
        #expect(ActiveCapture.leftover(in: run) == nil)
    }

    @Test func anUnreadableFileIsNoLeftover() throws {
        let run = try tempDir()
        try Data("{not json".utf8).write(to: run.appendingPathComponent("active.json"))
        #expect(ActiveCapture.leftover(in: run) == nil)
    }

    @Test func macSegmentFilesAreWrittenWholeWithTheirShape() throws {
        let run = try tempDir()
        let seg = Segment(id: "mac-abc-mic-1", speaker: "Alex", speakerId: "mic", speakerResolved: true,
                          startedAt: 1_800_000_000_000, lastAt: 1_800_000_002_000, text: "Hello")
        let url = try MacSegmentsFile.write(run: run, meetingId: "zoom-123-20261104-101500", captureId: "abc", segments: [seg], done: false)
        #expect(url.lastPathComponent == "mac-segments-zoom-123-20261104-101500-abc.json")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        #expect(json?["meetingId"] as? String == "zoom-123-20261104-101500")
        #expect(json?["captureId"] as? String == "abc")
        #expect(json?["done"] as? Bool == false)
        let segs = json?["segments"] as? [[String: Any]]
        #expect(segs?.first?["id"] as? String == "mac-abc-mic-1")
        #expect((segs?.first?["startedAt"] as? NSNumber)?.int64Value == 1_800_000_000_000)
        #expect(MacSegmentsFile.read(url) == [seg])
        _ = try MacSegmentsFile.write(run: run, meetingId: "zoom-123-20261104-101500", captureId: "abc", segments: [], done: true)
        #expect(try FileManager.default.contentsOfDirectory(atPath: run.path) == [url.lastPathComponent])
        #expect(MacSegmentsFile.read(url) == [])
    }

    @Test func isoTimesHaveMilliseconds() {
        let d = Date(timeIntervalSince1970: 1_800_000_000.25)
        #expect(ISOTime.string(d) == "2027-01-15T08:00:00.250Z")
        #expect(ISOTime.date("2027-01-15T08:00:00.250Z") == d)
        #expect(ISOTime.date("2027-01-15T08:00:00Z") == Date(timeIntervalSince1970: 1_800_000_000))
    }
}
