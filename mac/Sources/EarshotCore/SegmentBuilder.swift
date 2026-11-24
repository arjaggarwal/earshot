import Foundation

/// One recorded audio track: `id` is "mic" | "call" | "system" | "browser".
public struct Track: Equatable, Sendable {
    public var id: String
    public var speaker: String
    public init(id: String, speaker: String) { self.id = id; self.speaker = speaker }
}

/// A transcript line, shaped like the browser extension's (it sorts and merges on the ms-since-epoch times).
public struct Segment: Codable, Equatable, Sendable {
    public var id: String
    public var speaker: String
    public var speakerId: String
    public var speakerResolved: Bool
    public var startedAt: Int64
    public var lastAt: Int64
    public var text: String

    public init(id: String, speaker: String, speakerId: String, speakerResolved: Bool, startedAt: Int64, lastAt: Int64, text: String) {
        self.id = id; self.speaker = speaker; self.speakerId = speakerId
        self.speakerResolved = speakerResolved; self.startedAt = startedAt; self.lastAt = lastAt; self.text = text
    }
}

public enum SegmentIds {
    /// A capture's start time in base 36, so `mergeMacSegments` replaces exactly one capture's lines.
    public static func captureId(for start: Date) -> String {
        String(epochMs(start), radix: 36)
    }
    public static func make(captureId: String, track: Track, n: Int) -> String { "mac-\(captureId)-\(track.id)-\(n)" }
}

func epochMs(_ d: Date) -> Int64 { Int64((d.timeIntervalSince1970 * 1000).rounded()) }

/// Turns the speech recognizer's partial and final results into segments with stable ids.
public final class SegmentBuilder {
    public static let silenceGap: TimeInterval = 1.2

    private let captureId: String
    private let track: Track
    private var counter = 0
    private var open: Segment?
    private var lastTextAt: Date
    private var closedBySilence: Segment?
    /// The recognizer sends the whole request's text each time. `requestText` is the latest of it; a line
    /// opened mid-request (after a pause) leaves out `openPrefix`, the words earlier lines already show.
    private var requestText = ""
    private var openPrefix = ""
    private var closedPrefix = ""

    public init(captureId: String, track: Track, startedAt: Date) {
        self.captureId = captureId
        self.track = track
        self.lastTextAt = startedAt
    }

    /// Updates the open segment (same id), or opens a new one after a final or 1.2 s of silence.
    /// Empty text returns nil and allocates no id.
    public func partial(_ text: String, at: Date) -> Segment? {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        closedBySilence = nil
        if opens(at: at) { openPrefix = requestText }
        var seg = current(at: at)
        seg.text = Self.after(openPrefix, in: text)
        requestText = text
        seg.lastAt = epochMs(at)
        open = seg
        lastTextAt = at
        return seg
    }

    /// Sets the text and closes the segment; the next text starts a new one. A final that arrives after
    /// `silence()` closed the segment, with no new partial in between, finishes that same segment.
    public func final(_ text: String, at: Date) -> Segment? {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var seg: Segment
        let prefix: String
        if open == nil, let closed = closedBySilence {
            seg = closed
            prefix = closedPrefix
        } else {
            if opens(at: at) { openPrefix = requestText }
            seg = current(at: at)
            prefix = openPrefix
        }
        seg.text = Self.after(prefix, in: text)
        requestText = ""
        openPrefix = ""
        seg.lastAt = epochMs(at)
        open = nil
        closedBySilence = nil
        lastTextAt = at
        return seg
    }

    /// Closes the open segment once the quiet has lasted 1.2 s since its last text.
    public func silence(at: Date) {
        if let o = open, at.timeIntervalSince(lastTextAt) >= Self.silenceGap {
            closedBySilence = o
            closedPrefix = openPrefix
            open = nil
        }
    }

    private func opens(at: Date) -> Bool {
        open == nil || at.timeIntervalSince(lastTextAt) >= Self.silenceGap
    }

    /// `text` without its leading `prefix` words (compared ignoring case and punctuation). If the recognizer
    /// revised those words, or nothing follows them, the whole text stands.
    static func after(_ prefix: String, in text: String) -> String {
        let norm = { (w: Substring) in w.lowercased().filter { $0.isLetter || $0.isNumber } }
        let head = prefix.split(whereSeparator: \.isWhitespace).map(norm).filter { !$0.isEmpty }
        guard !head.isEmpty else { return text }
        let words = text.split(whereSeparator: \.isWhitespace)
        guard words.count > head.count, zip(words, head).allSatisfy({ norm($0) == $1 }) else { return text }
        return words[head.count...].joined(separator: " ")
    }

    private func current(at: Date) -> Segment {
        if open != nil, at.timeIntervalSince(lastTextAt) >= Self.silenceGap { open = nil }
        if let open { return open }
        counter += 1
        return Segment(id: SegmentIds.make(captureId: captureId, track: track, n: counter),
                       speaker: track.speaker, speakerId: track.id, speakerResolved: !track.speaker.isEmpty,
                       startedAt: epochMs(at), lastAt: epochMs(at), text: "")
    }
}

/// Command-line argument parsing shared with the CLI.
public enum CLIArgs {
    public static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// "mic=Alex:/path/mic.wav" -> (Track(mic, Alex), file). The speaker is everything between "=" and the
    /// first ":"; a missing speaker ("mic=/path") is rejected.
    public static func parseTrack(_ s: String) -> (Track, URL)? {
        guard let eq = s.firstIndex(of: "="), let colon = s[eq...].firstIndex(of: ":") else { return nil }
        let id = String(s[..<eq])
        let speaker = String(s[s.index(after: eq)..<colon])
        let path = String(s[s.index(after: colon)...])
        guard !id.isEmpty, !speaker.isEmpty, !speaker.hasPrefix("/"), !path.isEmpty else { return nil }
        return (Track(id: id, speaker: speaker), URL(fileURLWithPath: (path as NSString).expandingTildeInPath))
    }
}
