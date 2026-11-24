import Foundation

/// ISO 8601 with milliseconds in UTC, as JavaScript's `toISOString` writes it: the helper's save guards
/// compare `updatedAt` stamps, so every time the app writes into a record has this form.
public enum ISOTime {
    public static func string(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date)
    }

    public static func date(_ text: String) -> Date? {
        CLIArgs.parseISO(text)
    }
}

/// Writes `data` to `url` whole: a temporary file next to it (a dot name, so nothing watching the folder
/// reads it half-written), then a rename over the old one.
func writeAtomically(_ data: Data, to url: URL) throws {
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
    try data.write(to: tmp)
    guard rename(tmp.path, url.path) == 0 else {
        let code = errno
        try? FileManager.default.removeItem(at: tmp)
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path, NSUnderlyingErrorKey: POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)])
    }
}

/// `~/Earshot/run/active.json`: the capture that is recording right now, written when it starts and removed
/// after its Whisper pass. One left behind at launch means the app quit, crashed or lost power mid-capture;
/// the app then finishes it as a stopped capture from the WAVs on disk (Review Focus 2).
public struct ActiveCapture: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// A Teams or Zoom desktop call (prompt Capture).
        case desktop
        /// Start recording or ⌥⇧R.
        case manual
        /// A browser meeting without captions (its prompt's Capture): lines go to the browser's record.
        case captionsOff = "captions-off"
    }

    public struct TrackInfo: Codable, Equatable, Sendable {
        public var id: String
        public var speaker: String
        public init(id: String, speaker: String) { self.id = id; self.speaker = speaker }
    }

    public var meetingId: String
    /// Chosen once at the start; the live lines and the Whisper pass both use it.
    public var captureId: String
    public var kind: Kind
    /// The meeting folder the audio went to (`<folder>/audio/<track>.wav`).
    public var folder: String
    /// ISO 8601 with milliseconds.
    public var startedAt: String
    public var tracks: [TrackInfo]

    public init(meetingId: String, captureId: String, kind: Kind, folder: String, startedAt: String, tracks: [TrackInfo]) {
        self.meetingId = meetingId
        self.captureId = captureId
        self.kind = kind
        self.folder = folder
        self.startedAt = startedAt
        self.tracks = tracks
    }

    public enum Leftover: Equatable, Sendable {
        /// Audio is on disk: run Whisper on it, then end the meeting.
        case capture(ActiveCapture)
        /// The record is there but its audio isn't (no `audio/`, or only empty WAVs).
        case nothingToRecover(ActiveCapture)
    }

    public static func file(in run: URL) -> URL { run.appendingPathComponent("active.json") }

    public func write(in run: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try writeAtomically(try encoder.encode(self), to: Self.file(in: run))
    }

    /// The capture a previous run left, if any. A file that can't be read is no leftover.
    public static func leftover(in run: URL) -> Leftover? {
        guard let data = try? Data(contentsOf: file(in: run)),
              let active = try? JSONDecoder().decode(ActiveCapture.self, from: data) else { return nil }
        return active.audioFiles(in: URL(fileURLWithPath: active.folder)).isEmpty ? .nothingToRecover(active) : .capture(active)
    }

    /// Removes the file (only if it still belongs to `captureId`, when given: a capture started since has
    /// written its own).
    public static func clear(in run: URL, captureId: String? = nil) {
        let url = file(in: run)
        if let captureId {
            guard let data = try? Data(contentsOf: url),
                  let active = try? JSONDecoder().decode(ActiveCapture.self, from: data),
                  active.captureId == captureId else { return }
        }
        try? FileManager.default.removeItem(at: url)
    }

    // A capture being written up moves to `run/finishing-<captureId>.json`, so the next capture can write
    // its own active.json meanwhile. The file goes once the meeting has its Whisper lines and its end; one
    // left at launch (a write-up that failed or was cut off) is finished then, like active.json.

    public static func finishingFile(in run: URL, captureId: String) -> URL {
        run.appendingPathComponent("finishing-\(captureId).json")
    }

    /// Moves active.json to its finishing file (only if it belongs to `captureId`, when given).
    /// Returns the capture that was moved.
    @discardableResult
    public static func handOver(in run: URL, captureId: String? = nil) -> ActiveCapture? {
        let url = file(in: run)
        guard let data = try? Data(contentsOf: url),
              let active = try? JSONDecoder().decode(ActiveCapture.self, from: data) else { return nil }
        if let captureId, active.captureId != captureId { return nil }
        guard rename(url.path, finishingFile(in: run, captureId: active.captureId).path) == 0 else { return nil }
        return active
    }

    /// A leftover whose meeting can't be found: kept as `run/dropped-<captureId>.json` (never recovered
    /// again, but not lost, in case the meeting was only unreadable).
    public static func setAside(in run: URL, captureId: String) {
        let from = finishingFile(in: run, captureId: captureId)
        let to = run.appendingPathComponent("dropped-\(captureId).json")
        if rename(from.path, to.path) != 0 {
            FileHandle.standardError.write(Data("earshot: couldn't set \(from.lastPathComponent) aside (errno \(errno)); it stays\n".utf8))
        }
    }

    public static func clearFinishing(in run: URL, captureId: String) {
        try? FileManager.default.removeItem(at: finishingFile(in: run, captureId: captureId))
    }

    /// Every capture waiting in a finishing file, oldest first. Unreadable files are skipped.
    public static func finishing(in run: URL) -> [Leftover] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: run.path)) ?? []
        return names.filter { $0.hasPrefix("finishing-") && $0.hasSuffix(".json") }
            .compactMap { name -> ActiveCapture? in
                guard let data = try? Data(contentsOf: run.appendingPathComponent(name)) else { return nil }
                return try? JSONDecoder().decode(ActiveCapture.self, from: data)
            }
            .sorted { ($0.startedAt, $0.captureId) < ($1.startedAt, $1.captureId) }
            .map { $0.audioFiles(in: URL(fileURLWithPath: $0.folder)).isEmpty ? .nothingToRecover($0) : .capture($0) }
    }

    /// Each track's WAV in `<folder>/audio/` that holds audio (more than its 44-byte header).
    public func audioFiles(in folder: URL) -> [(Track, URL)] {
        tracks.compactMap { t in
            let url = folder.appendingPathComponent("audio/\(t.id).wav")
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
            return size > TrackWriter.headerSize ? (Track(id: t.id, speaker: t.speaker), url) : nil
        }
    }
}

/// `~/Earshot/run/mac-segments-<meetingId>-<captureId>.json`: a captions-off capture's lines for the browser
/// meeting's record, `{meetingId, captureId, segments, done}`. The helper pushes it to the extension, which
/// merges the capture's lines whole each time; `done: true` is the last write, after the Whisper pass.
public enum MacSegmentsFile {
    public static func url(run: URL, meetingId: String, captureId: String) -> URL {
        run.appendingPathComponent("mac-segments-\(meetingId)-\(captureId).json")
    }

    private struct Body: Codable {
        var meetingId: String
        var captureId: String
        var segments: [Segment]
        var done: Bool
    }

    @discardableResult
    public static func write(run: URL, meetingId: String, captureId: String, segments: [Segment], done: Bool) throws -> URL {
        let url = url(run: run, meetingId: meetingId, captureId: captureId)
        let body = Body(meetingId: meetingId, captureId: captureId, segments: segments, done: done)
        try writeAtomically(try JSONEncoder().encode(body), to: url)
        return url
    }

    public static func read(_ url: URL) -> [Segment]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONDecoder().decode(Body.self, from: data))?.segments
    }
}
