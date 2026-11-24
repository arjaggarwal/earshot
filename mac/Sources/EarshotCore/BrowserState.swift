import Foundation

/// How a browser meeting's captions are doing, as the extension reports it.
public enum CaptionState: String, Codable, Sendable {
    case waiting, off, arriving, lost
}

/// One live browser meeting from `~/Earshot/run/browser.json`.
public struct BrowserMeeting: Codable, Equatable, Sendable {
    public var meetingId: String
    public var tabId: Int
    public var platform: String
    public var title: String?
    public var captions: CaptionState
    /// ISO 8601, as the extension stores it.
    public var startedAt: String
    /// The tab is paused (off the record). Absent in older files, so it defaults to false.
    public var paused: Bool

    public init(meetingId: String, tabId: Int, platform: String, title: String?, captions: CaptionState,
                startedAt: String, paused: Bool = false) {
        self.meetingId = meetingId
        self.tabId = tabId
        self.platform = platform
        self.title = title
        self.captions = captions
        self.startedAt = startedAt
        self.paused = paused
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        meetingId = try c.decode(String.self, forKey: .meetingId)
        tabId = try c.decode(Int.self, forKey: .tabId)
        platform = try c.decode(String.self, forKey: .platform)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        captions = try c.decode(CaptionState.self, forKey: .captions)
        startedAt = try c.decode(String.self, forKey: .startedAt)
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
    }
}

/// Reads the browser meetings the extension reports through the helper's `browser-state` op.
public enum BrowserState {
    /// The extension rewrites the file every 30 s while a meeting is live; older than this, Chrome is gone.
    public static let staleAfter: TimeInterval = 90

    /// The live meetings in `file`, or `[]` when it is missing, unreadable or older than 90 s.
    /// An entry that doesn't parse is skipped rather than spoiling the rest.
    public static func read(from file: URL, now: Date) -> [BrowserMeeting] {
        guard let data = try? Data(contentsOf: file),
              let state = try? JSONDecoder().decode(File.self, from: data) else { return [] }
        let at = Date(timeIntervalSince1970: state.at / 1000)
        guard now.timeIntervalSince(at) <= staleAfter else { return [] }
        return state.meetings.compactMap(\.meeting)
    }

    private struct File: Decodable {
        var at: Double
        var meetings: [Entry]
    }

    private struct Entry: Decodable {
        var meeting: BrowserMeeting?
        init(from decoder: Decoder) throws {
            meeting = try? BrowserMeeting(from: decoder)
        }
    }
}
