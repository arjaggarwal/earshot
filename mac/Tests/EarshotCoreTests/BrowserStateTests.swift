import Foundation
import Testing
@testable import EarshotCore

@Suite struct BrowserStateTests {
    let dir: URL
    let file: URL

    init() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-browser-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("browser.json")
    }

    // The shape helper/host.js writes for the extension's browser-state op (Task 3).
    func write(at: Date, meetings: String) throws {
        let ms = Int(at.timeIntervalSince1970 * 1000)
        try #"{"at": \#(ms), "meetings": \#(meetings)}"#.write(to: file, atomically: true, encoding: .utf8)
    }

    let sample = """
    [
      {"meetingId": "zoom-123-20261104-101500", "tabId": 7, "platform": "zoom", "title": "Standup",
       "captions": "arriving", "startedAt": "2026-11-04T15:15:00.000Z", "paused": false},
      {"meetingId": "meet-abc-20261104-110000", "tabId": 9, "platform": "meet", "title": null,
       "captions": "off", "startedAt": "2026-11-04T16:00:00.000Z", "paused": true},
      {"meetingId": "teams-x-20261104-120000", "tabId": 11, "platform": "teams", "title": "Weekly",
       "captions": "lost", "startedAt": "2026-11-04T17:00:00.000Z"}
    ]
    """

    @Test func parsesWhatTheHelperWrites() throws {
        let now = Date()
        try write(at: now.addingTimeInterval(-5), meetings: sample)
        let meetings = BrowserState.read(from: file, now: now)
        #expect(meetings.count == 3)
        #expect(meetings[0] == BrowserMeeting(meetingId: "zoom-123-20261104-101500", tabId: 7, platform: "zoom", title: "Standup",
                                              captions: .arriving, startedAt: "2026-11-04T15:15:00.000Z", paused: false))
        #expect(meetings[1].title == nil)
        #expect(meetings[1].captions == .off)
        #expect(meetings[1].paused == true)
        #expect(meetings[2].captions == .lost)
        #expect(meetings[2].paused == false, "paused defaults to false when absent")
    }

    @Test func staleFileGivesNothing() throws {
        let now = Date()
        try write(at: now.addingTimeInterval(-91), meetings: sample)
        #expect(BrowserState.read(from: file, now: now) == [])
        try write(at: now.addingTimeInterval(-89), meetings: sample)
        #expect(BrowserState.read(from: file, now: now).count == 3)
    }

    @Test func missingOrBrokenFileGivesNothing() throws {
        #expect(BrowserState.read(from: dir.appendingPathComponent("nope.json"), now: Date()) == [])
        try "{\"at\": 1, \"meet".write(to: file, atomically: true, encoding: .utf8)
        #expect(BrowserState.read(from: file, now: Date()) == [])
    }

    @Test func skipsAnEntryItCannotRead() throws {
        let now = Date()
        try write(at: now, meetings: """
        [{"meetingId": "a", "tabId": 1, "platform": "meet", "title": "A", "captions": "sideways", "startedAt": "x"},
         {"meetingId": "b", "tabId": 2, "platform": "meet", "title": "B", "captions": "off", "startedAt": "y"}]
        """)
        #expect(BrowserState.read(from: file, now: now).map(\.meetingId) == ["b"])
    }
}
