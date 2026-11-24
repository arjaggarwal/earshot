import Foundation
@testable import EarshotCore

/// What happened, in order, across the fakes (the recorder stops on another thread).
final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
    func index(of s: String) -> Int? { all.firstIndex(of: s) }
    func index(where p: (String) -> Bool) -> Int? { all.firstIndex(where: p) }
    /// The index of the (n+1)-th `s`.
    func index(of s: String, after n: Int) -> Int? {
        let hits = all.indices.filter { all[$0] == s }
        return hits.count > n ? hits[n] : nil
    }
}

final class FakeRecorder: CaptureRecorder, @unchecked Sendable {
    let request: RecorderRequest
    let segments: AsyncStream<Segment>
    let status: AsyncStream<String>
    private let segmentsOut: AsyncStream<Segment>.Continuation
    private let statusOut: AsyncStream<String>.Continuation
    private let log: EventLog
    private let lock = NSLock()
    var failStart: Error?
    private(set) var started = false
    private(set) var stopped = false
    private(set) var paused = false
    /// Bytes of audio each track's WAV gets on start (0: no file).
    var wavBytes = 4000

    init(_ request: RecorderRequest, log: EventLog) {
        self.request = request
        self.log = log
        (segments, segmentsOut) = AsyncStream.makeStream(of: Segment.self)
        (status, statusOut) = AsyncStream.makeStream(of: String.self)
    }

    var onStart: (@MainActor () -> Void)?

    func start() throws {
        if let onStart { MainActor.assumeIsolated { onStart() } }
        if let failStart { throw failStart }
        let audio = request.folder.appendingPathComponent("audio")
        try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
        if wavBytes > 0 {
            for (track, _) in request.tracks { try Data(count: wavBytes).write(to: audio.appendingPathComponent("\(track.id).wav")) }
        }
        lock.lock(); started = true; lock.unlock()
        log.add("recorder.start")
    }

    func pause() { lock.lock(); paused = true; lock.unlock(); log.add("recorder.pause") }
    func resume() { lock.lock(); paused = false; lock.unlock(); log.add("recorder.resume") }

    func stop() -> [(Track, URL)] {
        lock.lock(); stopped = true; lock.unlock()
        log.add("recorder.stop")
        segmentsOut.finish()
        statusOut.finish()
        return request.tracks.map { ($0.0, request.folder.appendingPathComponent("audio/\($0.0.id).wav")) }
    }

    var isPaused: Bool { lock.lock(); defer { lock.unlock() }; return paused }
    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    func emit(_ track: String, _ n: Int, _ text: String, at: Int64, speaker: String? = nil) {
        let t = request.tracks.first { $0.0.id == track }!.0
        segmentsOut.yield(Segment(id: SegmentIds.make(captureId: request.captureId, track: t, n: n), speaker: speaker ?? t.speaker,
                                  speakerId: track, speakerResolved: true, startedAt: at, lastAt: at + 1000, text: text))
    }

    func say(_ status: String) { statusOut.yield(status) }
}

@MainActor final class FakePanel: SessionPanel {
    let log: EventLog
    var failStart: Error?
    var started: [[String: Any]] = []
    var startStatuses: [[String: Any]?] = []
    var segmentCalls: [[Segment]] = []
    var statuses: [(level: String, text: String, meetingId: String)] = []
    var renames: [(String, String)] = []
    var pausedCalls: [Bool] = []
    /// finish calls that landed; `failFinish` makes the next ones throw.
    var finished: [(meeting: [String: Any], segments: [Segment]?, endedAt: String?, rename: SpeakerRename?)] = []
    var finishAttempts = 0
    var failFinish = 0
    var releaseChecks = 0
    /// Runs (once) inside the next finish, before it lands.
    var duringFinish: (() async -> Void)?
    var endedCount: Int { finished.count }
    var finishedIds: [String] { finished.map { $0.meeting["id"] as? String ?? "?" } }

    init(log: EventLog) { self.log = log }

    func start(meeting: [String: Any], status: [String: Any]?) async throws {
        log.add("panel.start")
        if let failStart { throw failStart }
        started.append(meeting)
        startStatuses.append(status)
    }
    /// A slow page: each segments call takes this long.
    var segmentDelay: UInt64 = 0
    var segmentMeetings: [String] = []
    func segments(_ list: [Segment], meetingId: String) async throws {
        if segmentDelay > 0 { try await Task.sleep(nanoseconds: segmentDelay) }
        log.add("panel.segments:" + list.map(\.text).joined(separator: "|"))
        segmentCalls.append(list)
        segmentMeetings.append(meetingId)
    }
    func status(level: String, text: String, meetingId: String) async throws {
        log.add("panel.status:\(level):\(text)")
        statuses.append((level, text, meetingId))
    }
    func renameSpeaker(speakerId: String, name: String) async throws {
        log.add("panel.rename:\(speakerId)=\(name)")
        renames.append((speakerId, name))
    }
    func showPaused(_ value: Bool) async throws {
        log.add("panel.showPaused:\(value)")
        pausedCalls.append(value)
    }
    func finish(meeting: [String: Any], segments: [Segment]?, endedAt: String?, rename: SpeakerRename?) async throws {
        finishAttempts += 1
        if let hook = duringFinish {
            duringFinish = nil
            await hook()
        }
        if failFinish > 0 {
            failFinish -= 1
            log.add("panel.finish-failed")
            throw Boom(description: "the page didn't answer")
        }
        log.add("panel.finish:\(meeting["id"] as? String ?? "?")")
        finished.append((meeting, segments, endedAt, rename))
    }
    func releaseIfIdle() { releaseChecks += 1 }
}

@MainActor final class FakeShell: SessionShell {
    var recording = false
    var paused = false
    var prompts: [PromptKind?] = []
    var screenshotApp: String?
    var errors: [String] = []
    let log: EventLog
    init(log: EventLog) { self.log = log }
    func setRecording(_ on: Bool) { recording = on; log.add("shell.recording:\(on)") }
    func setPaused(_ on: Bool) { paused = on }
    func showPrompt(_ kind: PromptKind?) { prompts.append(kind) }
    func setScreenshotApp(_ prefix: String?) { screenshotApp = prefix }
    func showError(_ message: String) { errors.append(message) }
}

/// Answers like helper/host.js for the ops the sessions use.
final class FakeHelper: SessionHelper, @unchecked Sendable {
    private let lock = NSLock()
    let home: URL
    private(set) var calls: [(op: String, payload: [String: Any])] = []
    var meetings: [String: [String: Any]] = [:]
    var folders: [String: URL] = [:]
    var rows: [[String: Any]] = []
    var config: [String: Any] = ["mac": ["myName": "Alex", "audioKeepDays": 30, "whisperModel": "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin"]]
    var failGetMeeting = false
    /// Ids the helper indexes but whose meeting.json is gone: get-meeting answers null.
    var nullMeetings: Set<String> = []
    let log: EventLog

    init(home: URL, log: EventLog) { self.home = home; self.log = log }

    func ops() -> [String] { lock.lock(); defer { lock.unlock() }; return calls.map(\.op) }
    func payloads(_ op: String) -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return calls.filter { $0.op == op }.map(\.payload) }
    func setMeeting(_ m: [String: Any]) { lock.lock(); meetings[m["id"] as! String] = m; lock.unlock() }

    func call(_ op: String, _ payload: [String: Any]) async throws -> Any {
        try answer(op, payload)
    }

    private func answer(_ op: String, _ payload: [String: Any]) throws -> Any {
        lock.lock(); defer { lock.unlock() }
        calls.append((op, payload))
        log.add("helper.\(op)")
        switch op {
        case "get-config": return config
        case "save-meeting":
            let m = payload["meeting"] as! [String: Any]
            meetings[m["id"] as! String] = m
            return ["folder": folder(for: m["id"] as! String).path]
        case "meeting-folder":
            return folder(for: payload["id"] as! String).path
        case "get-meeting":
            if failGetMeeting { throw HelperError.exited } // the helper itself is down
            if nullMeetings.contains(payload["id"] as? String ?? "") { return NSNull() }
            guard let m = meetings[payload["id"] as! String] else { throw HelperError.failed("unknown meeting \(payload["id"] as! String)") }
            return m
        case "list-meetings": return rows
        case "delete-meeting":
            meetings[payload["id"] as! String] = nil
            return ["ok": true]
        default: throw HelperError.failed("unknown op \(op)")
        }
    }

    /// Call with the lock held.
    private func folder(for id: String) -> URL {
        if let f = folders[id] { return f }
        let f = home.appendingPathComponent("meetings/2026/November/\(id)")
        try? FileManager.default.createDirectory(at: f, withIntermediateDirectories: true)
        folders[id] = f
        return f
    }
}

final class FakeTranscriber: SessionTranscriber, @unchecked Sendable {
    struct Run { let captureId: String; let tracks: [(Track, URL)]; let startedAt: Date; let model: String }
    private let lock = NSLock()
    private(set) var runs: [Run] = []
    var result: Result<[Segment], Error> = .success([])
    /// Runs (once) while Whisper "works", on the main actor.
    var during: (@MainActor () async -> Void)?
    let log: EventLog
    init(log: EventLog) { self.log = log }

    private func record(_ run: Run) -> (Result<[Segment], Error>, (@MainActor () async -> Void)?) {
        lock.lock(); defer { lock.unlock() }
        runs.append(run)
        let hook = during
        during = nil
        return (result, hook)
    }

    func run(captureId: String, tracks: [(Track, URL)], startedAt: Date, model: String) async throws -> [Segment] {
        let (r, hook) = record(Run(captureId: captureId, tracks: tracks, startedAt: startedAt, model: model))
        log.add("whisper")
        if let hook { await hook() }
        return try r.get()
    }
}

struct Boom: Error, CustomStringConvertible {
    let description: String
}

/// One controller with fakes all round, in a fresh EARSHOT_HOME.
@MainActor final class Rig {
    let home: URL
    let log = EventLog()
    let helper: FakeHelper
    let panel: FakePanel
    let shell: FakeShell
    let transcriber: FakeTranscriber
    var recorders: [FakeRecorder] = []
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    var sleeps: [TimeInterval] = []
    let sweepLog = SweepLog()
    var sweeps: [(URL, Int, Date)] { sweepLog.all }
    var failRecorderStart: Error?
    /// Whether run/active.json existed when each recorder started.
    var activeFileAtStart: [Bool] = []
    var wavBytes = 4000
    private(set) var controller: SessionController!

    var run: URL { home.appendingPathComponent("run") }
    var recorder: FakeRecorder { recorders.last! }

    init() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-session-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        helper = FakeHelper(home: home, log: log)
        panel = FakePanel(log: log)
        shell = FakeShell(log: log)
        transcriber = FakeTranscriber(log: log)
        controller = SessionController(
            home: home, helper: helper, panel: panel, shell: shell,
            makeRecorder: { [unowned self] request in
                let r = FakeRecorder(request, log: self.log)
                r.failStart = self.failRecorderStart
                r.wavBytes = self.wavBytes
                let active = self.run.appendingPathComponent("active.json")
                r.onStart = { self.activeFileAtStart.append(FileManager.default.fileExists(atPath: active.path)) }
                self.recorders.append(r)
                return r
            },
            transcriber: transcriber,
            // Weak: a task the controller left running may outlive the test's rig.
            now: { [weak self] in self?.now ?? Date(timeIntervalSince1970: 1_800_000_000) },
            sleep: { [weak self] seconds in self?.sleeps.append(seconds) },
            sweep: { [sweepLog] home, days, at in sweepLog.add((home, days, at)) })
    }

    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }

    /// Lets the controller's own tasks (the segment and status pumps) run until `done` holds.
    func until(_ what: String = "condition", _ done: () -> Bool) async throws {
        for _ in 0..<2000 {
            if done() { return }
            await Task.yield()
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        throw Boom(description: "timed out waiting for \(what)")
    }

    func browserMeeting(_ id: String, _ captions: CaptionState, paused: Bool = false) -> BrowserMeeting {
        BrowserMeeting(meetingId: id, tabId: 7, platform: "zoom", title: "Weekly", captions: captions,
                       startedAt: "2026-11-04T15:00:00.000Z", paused: paused)
    }

    func activeJSON() -> [String: Any]? {
        guard let data = try? Data(contentsOf: run.appendingPathComponent("active.json")) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    func segmentFile(_ meetingId: String, _ captureId: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: run.appendingPathComponent("mac-segments-\(meetingId)-\(captureId).json")) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

func seg(_ id: String, _ speakerId: String, _ text: String, at: Int64, speaker: String = "Whisper") -> Segment {
    Segment(id: id, speaker: speaker, speakerId: speakerId, speakerResolved: true, startedAt: at, lastAt: at + 1000, text: text)
}

final class SweepLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(URL, Int, Date)] = []
    func add(_ x: (URL, Int, Date)) { lock.lock(); items.append(x); lock.unlock() }
    var all: [(URL, Int, Date)] { lock.lock(); defer { lock.unlock() }; return items }
}

extension Rig {
    func finishingFiles() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: run.path)) ?? []).filter { $0.hasPrefix("finishing-") }.sorted()
    }
}
