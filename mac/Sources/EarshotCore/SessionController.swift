import Foundation

// The sessions: what Capture (on a prompt), Start recording / ⌥⇧R and Stop do, how a capture ends, and how
// one cut off by a quit or crash is finished on the next launch. Everything here runs against protocols
// (recorder, panel, helper, Whisper, the shell, the clock), so it is tested with fakes; EarshotMac plugs
// in the real ones (Session.swift).

// MARK: - What the controller drives

/// A capture's recorder (EarshotCore `Recorder`; fakes in the tests).
public protocol CaptureRecorder: AnyObject, Sendable {
    var segments: AsyncStream<Segment> { get }
    var status: AsyncStream<String> { get }
    func start() throws
    func pause()
    func resume()
    /// Stops, writes out the files and ends the streams; returns the tracks written.
    func stop() -> [(Track, URL)]
}

extension Recorder: CaptureRecorder {}

/// What a recorder is made for: one capture, with its id chosen once at the start.
public struct RecorderRequest: Sendable {
    public var folder: URL
    public var tracks: [(Track, Recorder.Source)]
    public var captureId: String
    public var startedAt: Date
}

/// Makes the recorder (the app asks macOS for the mic and speech first, so this is async).
public typealias RecorderFactory = @MainActor (RecorderRequest) async -> CaptureRecorder

/// The Earshot helper (`HelperClient`).
public protocol SessionHelper: AnyObject, Sendable {
    func call(_ op: String, _ payload: [String: Any]) async throws -> Any
}

extension HelperClient: SessionHelper {}

/// The post-call Whisper pass. `model` is config.json's `mac.whisperModel` (may start with `~`).
public protocol SessionTranscriber: Sendable {
    func run(captureId: String, tracks: [(Track, URL)], startedAt: Date, model: String) async throws -> [Segment]
}

/// whisper-cli through `Transcriber`.
public struct WhisperTranscriber: SessionTranscriber {
    public init() {}
    public func run(captureId: String, tracks: [(Track, URL)], startedAt: Date, model: String) async throws -> [Segment] {
        let transcriber = Transcriber(modelPath: model)
        guard FileManager.default.fileExists(atPath: transcriber.model.path) else {
            throw TranscriberError(description: "the Whisper model isn't at \(transcriber.model.path)")
        }
        return try await transcriber.run(captureId: captureId, tracks: tracks, startedAt: startedAt)
    }
}

/// A `rename-speaker` the panel applies only if Alex hasn't named that speaker himself.
public struct SpeakerRename: Equatable, Sendable {
    public var speakerId: String
    public var name: String
    public init(speakerId: String, name: String) { self.speakerId = speakerId; self.name = name }
}

/// The panel's page (mac/Web/mac-background.js `earshotMac`), through the app's web view.
@MainActor
public protocol SessionPanel: AnyObject {
    /// Shows a meeting (new, or the same id again after a reload); `meeting` holds only JSON values.
    func start(meeting: [String: Any], status: [String: Any]?) async throws
    /// Live lines for `meetingId`; the page drops them if another meeting is on show by then.
    func segments(_ list: [Segment], meetingId: String) async throws
    /// A status line for `meetingId`'s panel; the page ignores it once it shows another meeting.
    func status(level: String, text: String, meetingId: String) async throws
    func renameSpeaker(speakerId: String, name: String) async throws
    /// The menu paused or resumed: the page's pause button follows.
    func showPaused(_ value: Bool) async throws
    /// Ends a meeting by its id, whether or not it's the one on show: its Whisper lines if any (replacing
    /// that capture's live ones), `endedAt` if it has none, then minutes when they're due. If the meeting
    /// is on show the panel ends as after a call; otherwise nothing appears on screen.
    func finish(meeting: [String: Any], segments: [Segment]?, endedAt: String?, rename: SpeakerRename?) async throws
    /// Nothing needs the page now (no capture, no write-up): the app may let its web view go once the page
    /// says it's idle too.
    func releaseIfIdle()
}

/// The menu bar, the prompt and the screenshot target.
@MainActor
public protocol SessionShell: AnyObject {
    /// The red dot: on while audio is being recorded.
    func setRecording(_ on: Bool)
    func setPaused(_ on: Bool)
    /// `PromptPolicy.next`'s answer (nil closes the prompt).
    func showPrompt(_ kind: PromptKind?)
    /// Which app 📷 captures (a bundle id prefix), nil for the main display.
    func setScreenshotApp(_ prefix: String?)
    /// Something Alex must know (a capture that couldn't start, a write-up that failed). Never steals
    /// focus from the call: a line in the menu.
    func showError(_ message: String)
}

public enum SessionError: Error, Equatable, LocalizedError {
    case notRecording
    public var errorDescription: String? {
        switch self {
        case .notRecording: return "Nothing is being recorded."
        }
    }
}

// MARK: - The controller

@MainActor
public final class SessionController {
    public static let writingStatus = "Writing the full transcript…"
    /// How long a Whisper failure stays on the panel before the meeting ends (the ended panel replaces it).
    public static let errorHold: TimeInterval = 8
    /// A captions-off capture stops once its meeting has been missing from browser.json this long
    /// (a refresh or a rejoin comes back sooner).
    public static let absenceGrace: TimeInterval = 60
    public static let sweepEvery: TimeInterval = 24 * 3600
    /// Mac meetings that ended this recently without minutes get their ending resumed at launch.
    public static let resumeMinutesWithin: TimeInterval = 24 * 3600
    public static let defaultModel = "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin"
    public static let defaultKeepDays = 30
    public static let macPlatforms: Set<String> = ["teams-desktop", "zoom-desktop", "mac"]
    static let chromePrefix = "com.google.chrome"

    public enum Phase: Equatable, Sendable { case running, ending }
    public enum PauseSource: Sendable { case menu, panel }

    /// A capture: recording, then (`ending`) stopping and handing its last live lines over, then written up
    /// in the background while the next capture may already run.
    public final class Capture {
        public let kind: ActiveCapture.Kind
        public let meetingId: String
        public let captureId: String
        public let startedAt: Date
        public internal(set) var folder: URL
        public internal(set) var phase: Phase = .running
        public internal(set) var paused = false
        let app: CallApp?
        let tracks: [(Track, Recorder.Source)]
        let recorder: CaptureRecorder
        let record: [String: Any]?
        let myName: String
        let model: String
        var live: [String: Segment] = [:]
        var liveOrder: [String] = []
        var micNamed = false
        var dirty = false
        var lastSeen: Date
        var browserPaused = false
        var pumps: [Task<Void, Never>] = []
        /// Stopping: the recorder stops and the live lines drain; then the capture lets go of `session`.
        var drain: Task<Void, Never>?
        /// The whole ending, write-up included.
        var ending: Task<Void, Never>?
        var written: [(Track, URL)] = []

        init(kind: ActiveCapture.Kind, meetingId: String, captureId: String, startedAt: Date, folder: URL, app: CallApp?,
             tracks: [(Track, Recorder.Source)], recorder: CaptureRecorder, record: [String: Any]?, myName: String, model: String) {
            self.kind = kind
            self.meetingId = meetingId
            self.captureId = captureId
            self.startedAt = startedAt
            self.folder = folder
            self.app = app
            self.tracks = tracks
            self.recorder = recorder
            self.record = record
            self.myName = myName
            self.model = model
            lastSeen = startedAt
        }

        public var liveCount: Int { live.count }
        var hasPanel: Bool { kind != .captionsOff }
        var liveLines: [Segment] { liveOrder.compactMap { live[$0] }.sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) } }
        var startMs: Int64 { Int64((startedAt.timeIntervalSince1970 * 1000).rounded()) }
    }

    /// The capture that is recording (or, for a moment, stopping).
    public private(set) var session: Capture?
    /// Captures being written up, by capture id. They don't block the next capture.
    private var writeUps: [String: Task<Void, Never>] = [:]
    /// True from a click until its capture is running or has failed: a second click does nothing.
    private var starting = false
    /// Recording (or starting): no prompt and no second capture (Review Focus 5). A write-up doesn't count.
    public var isBusy: Bool { starting || session != nil }
    /// Whether anything still needs the panel's page: a capture, or one being written up.
    public var needsPanel: Bool { session != nil || !writeUps.isEmpty }

    private let home: URL
    private let helper: SessionHelper
    private let panel: SessionPanel
    private let shell: SessionShell
    private let makeRecorder: RecorderFactory
    private let transcriber: SessionTranscriber
    private let now: @MainActor () -> Date
    private let sleep: (TimeInterval) async -> Void
    private let sweep: @Sendable (URL, Int, Date) -> Void
    private var policy = PromptPolicy()
    private var lastCalls: Set<CallApp> = []
    private var lastBrowser: [BrowserMeeting] = []
    private var nextSweep: Date?
    private var sweeping: Task<Void, Never>?
    private var resuming: Task<Void, Never>?

    private var run: URL { home.appendingPathComponent("run") }

    public init(home: URL, helper: SessionHelper, panel: SessionPanel, shell: SessionShell,
                makeRecorder: @escaping RecorderFactory, transcriber: SessionTranscriber = WhisperTranscriber(),
                now: @escaping @MainActor () -> Date = { Date() },
                sleep: @escaping (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
                sweep: @escaping @Sendable (URL, Int, Date) -> Void = { Retention.sweep(home: $0, keepDays: $1, now: $2) }) {
        self.home = home
        self.helper = helper
        self.panel = panel
        self.shell = shell
        self.makeRecorder = makeRecorder
        self.transcriber = transcriber
        self.now = now
        self.sleep = sleep
        self.sweep = sweep
    }

    // MARK: - The three ways in

    /// The prompt's Capture.
    public func capture(_ kind: PromptKind) async {
        switch kind {
        case .desktopCall(let app):
            await begin(.desktop, app: app, browserMeetingId: nil)
        case .captionsOff(let meetingId, _, _):
            await begin(.captionsOff, app: nil, browserMeetingId: meetingId)
        }
    }

    /// Start recording, or ⌥⇧R.
    public func startManual() async {
        await begin(.manual, app: nil, browserMeetingId: nil)
    }

    /// The prompt's Not now: that app or meeting isn't offered again for 10 minutes.
    public func notNow(_ kind: PromptKind) {
        policy.dismissed(kind, at: now())
        refreshPrompt()
    }

    /// Stop (menu or panel): ends the capture and waits for its write-up. Stopping a call's capture counts
    /// as Not now for it, so its prompt doesn't come straight back.
    public func stop() async {
        guard let s = session else { return }
        if s.phase == .running {
            switch s.kind {
            case .desktop: if let app = s.app { policy.dismissed(.desktopCall(app), at: now()) }
            case .captionsOff: policy.dismissed(.captionsOff(meetingId: s.meetingId, title: nil, lost: false), at: now())
            case .manual: break
            }
            beginEnding(s)
        }
        await s.ending?.value
    }

    /// The app is quitting: the WAVs are closed properly (their headers written) and `active.json` stays,
    /// so the next launch finishes the capture from them.
    public func prepareForQuit() {
        guard let s = session, s.phase == .running else { return }
        _ = s.recorder.stop()
    }

    /// Waits for every capture that is ending to be written up.
    public func settled() async {
        await session?.ending?.value
        while let next = writeUps.values.first { await next.value }
        await resuming?.value
        await sweeping?.value
    }

    /// Pause/Resume. From the menu the panel's button follows; from the panel the page already shows it.
    /// Throws when nothing is recording, so the page doesn't show Paused for nothing.
    public func setPaused(_ value: Bool, from source: PauseSource) async throws {
        guard let s = session, s.phase == .running else { throw SessionError.notRecording }
        applyPause(s, value)
        if source == .menu, s.hasPanel {
            do { try await panel.showPaused(value) } catch { log("panel pause: \(error)") }
        }
    }

    /// The panel's web process died and the page reloaded: show the meeting again, with the lines so far.
    /// Minutes that were waiting in the page went with it, so their endings are resumed too.
    public func panelReloaded() async {
        defer {
            let skip = Set([session?.meetingId].compactMap { $0 })
            resuming = Task { [weak self] in await self?.resumeMinutes(except: skip) }
        }
        guard let s = session, s.phase == .running, s.hasPanel, var meeting = s.record else { return }
        meeting["segments"] = (try? PageValue.from(s.liveLines)) ?? []
        let status: [String: Any] = s.paused ? ["level": "paused", "text": "Paused. Click play to resume."] : ["level": "live", "text": "Capturing"]
        do {
            try await panel.start(meeting: meeting, status: status)
            // A fresh page starts unpaused: its pause button follows the recorder.
            if s.paused { try await panel.showPaused(true) }
        } catch { log("panel restart: \(error)") }
    }

    // MARK: - Every 2 s

    /// The app calls this every 2 s with `CallWatcher.active` and `BrowserState.read`.
    public func tick(calls: Set<CallApp>, browser: [BrowserMeeting]) async {
        lastCalls = calls
        lastBrowser = browser
        let t = now()
        if let next = nextSweep, t >= next {
            nextSweep = t.addingTimeInterval(Self.sweepEvery)
            startSweep(at: t)
        }
        if let s = session, s.phase == .running {
            switch s.kind {
            case .desktop:
                if let app = s.app, !calls.contains(app) { beginEnding(s) }
            case .manual:
                break
            case .captionsOff:
                await watchBrowser(s, browser, at: t)
                if s.phase == .running { flushSegmentFile(s) }
            }
        }
        refreshPrompt()
    }

    private func watchBrowser(_ s: Capture, _ browser: [BrowserMeeting], at t: Date) async {
        guard let m = browser.first(where: { $0.meetingId == s.meetingId }) else {
            if t.timeIntervalSince(s.lastSeen) >= Self.absenceGrace { beginEnding(s) }
            return
        }
        s.lastSeen = t
        if m.paused != s.browserPaused {
            s.browserPaused = m.paused
            applyPause(s, m.paused)
        }
        if m.captions == .arriving, await captionSince(s) { beginEnding(s) }
    }

    /// Whether the browser meeting's record has a caption (not a Mac line) that began after this capture
    /// did. If the record can't be read, browser.json's word is taken.
    private func captionSince(_ s: Capture) async -> Bool {
        guard let meeting = try? await helper.call("get-meeting", ["id": s.meetingId]) as? [String: Any] else { return true }
        let segments = meeting["segments"] as? [[String: Any]] ?? []
        return segments.contains { seg in
            guard let id = seg["id"] as? String, !id.hasPrefix("mac-"),
                  let started = (seg["startedAt"] as? NSNumber)?.int64Value else { return false }
            return started >= s.startMs
        }
    }

    private func refreshPrompt() {
        shell.showPrompt(policy.next(calls: lastCalls, browser: lastBrowser, recording: isBusy, now: now()))
    }

    // MARK: - Starting

    private func begin(_ kind: ActiveCapture.Kind, app: CallApp?, browserMeetingId: String?) async {
        // A capture that is stopping lets go in a moment (its last live lines drain): this click waits for
        // that rather than being lost. Its write-up then goes on alongside.
        if let s = session, s.phase == .ending { await s.drain?.value }
        guard !isBusy else { return } // Review Focus 5: one capture at a time
        starting = true
        refreshPrompt()
        defer {
            starting = false
            refreshPrompt()
        }

        let config = (try? await helper.call("get-config", [:])) as? [String: Any]
        let mac = config?["mac"] as? [String: Any]
        let myName = nonEmpty(mac?["myName"] as? String) ?? "Me"
        let model = nonEmpty(mac?["whisperModel"] as? String) ?? Self.defaultModel

        let startedAt = now()
        let captureId = SegmentIds.captureId(for: startedAt)
        let tracks: [(Track, Recorder.Source)]
        let platform: String?
        let screenshotApp: String?
        switch kind {
        case .desktop:
            let app = app ?? .teams
            platform = app == .teams ? "teams-desktop" : "zoom-desktop"
            tracks = [(Track(id: "mic", speaker: myName), .mic), (Track(id: "call", speaker: "Call"), .tap(.processes(bundlePrefix: app.bundlePrefix)))]
            screenshotApp = app.bundlePrefix
        case .manual:
            platform = "mac"
            tracks = [(Track(id: "mic", speaker: "Speaker"), .mic), (Track(id: "system", speaker: "Call"), .tap(.systemExcludingSelf))]
            screenshotApp = nil
        case .captionsOff:
            platform = nil
            tracks = [(Track(id: "mic", speaker: myName), .mic), (Track(id: "browser", speaker: "Meeting audio"), .tap(.processes(bundlePrefix: Self.chromePrefix)))]
            screenshotApp = Self.chromePrefix
        }

        // A desktop or manual capture is a new record, saved before anything records into its folder.
        var record: [String: Any]?
        let meetingId: String
        if let platform {
            meetingId = "\(platform)-mac-\(Self.idStamp(startedAt))"
            let rec = Self.newRecord(id: meetingId, platform: platform, startedAt: startedAt)
            do {
                _ = try await helper.call("save-meeting", ["meeting": rec, "base": NSNull()])
            } catch {
                shell.showError("Couldn't start recording: the meeting couldn't be saved (\(message(error))).")
                return
            }
            record = rec
        } else {
            meetingId = browserMeetingId ?? ""
        }

        let folder: URL
        do {
            folder = try await meetingFolder(meetingId)
        } catch {
            await discard(record)
            shell.showError("Couldn't start recording: no folder for the audio (\(message(error))).")
            return
        }

        let recorder = await makeRecorder(RecorderRequest(folder: folder, tracks: tracks, captureId: captureId, startedAt: startedAt))
        // On disk before the first sample, so a crash at any point after can be finished at the next launch.
        let active = ActiveCapture(meetingId: meetingId, captureId: captureId, kind: kind, folder: folder.path,
                                   startedAt: ISOTime.string(startedAt),
                                   tracks: tracks.map { .init(id: $0.0.id, speaker: $0.0.speaker) })
        do { try active.write(in: run) } catch { log("active.json: \(error)") }
        do {
            try recorder.start()
        } catch {
            ActiveCapture.clear(in: run, captureId: captureId)
            await discard(record)
            shell.showError("Couldn't start recording: \(message(error))")
            return
        }

        let s = Capture(kind: kind, meetingId: meetingId, captureId: captureId, startedAt: startedAt, folder: folder, app: app,
                        tracks: tracks, recorder: recorder, record: record, myName: myName, model: model)
        session = s
        shell.setRecording(true)
        shell.setPaused(false)
        shell.setScreenshotApp(screenshotApp)

        if let record {
            do {
                try await panel.start(meeting: record, status: ["level": "live", "text": "Capturing"])
            } catch {
                // Still recording: the menu bar's red dot stays on, and Stop works from the menu.
                shell.showError("The Earshot panel didn't open (\(message(error))). Recording goes on; stop it from the menu bar.")
            }
        }
        startPumps(s)
    }

    /// A record nothing was recorded into goes again (to ~/Earshot/.trash, through the helper).
    private func discard(_ record: [String: Any]?) async {
        guard let id = record?["id"] as? String else { return }
        _ = try? await helper.call("delete-meeting", ["id": id])
    }

    private func meetingFolder(_ id: String) async throws -> URL {
        guard let path = try await helper.call("meeting-folder", ["id": id]) as? String, !path.isEmpty else {
            throw HelperError.failed("meeting-folder gave no folder")
        }
        return URL(fileURLWithPath: path)
    }

    private func startPumps(_ s: Capture) {
        let segments = s.recorder.segments
        let statuses = s.recorder.status
        s.pumps = [
            Task { [weak self] in
                for await seg in segments { await self?.took(seg, s) }
            },
            Task { [weak self] in
                for await line in statuses { await self?.said(line, s) }
            },
        ]
    }

    private func took(_ seg: Segment, _ s: Capture) async {
        if s.live[seg.id] == nil { s.liveOrder.append(seg.id) }
        s.live[seg.id] = seg
        switch s.kind {
        case .captionsOff:
            s.dirty = true
        case .manual:
            // Something came through the Mac's audio: this is a call, and the mic is Alex.
            if seg.speakerId == "system", !s.micNamed {
                s.micNamed = true
                do { try await panel.renameSpeaker(speakerId: "mic", name: s.myName) } catch { log("rename: \(error)") }
            }
            fallthrough
        case .desktop:
            do { try await panel.segments([seg], meetingId: s.meetingId) } catch { log("panel segments: \(error)") }
        }
    }

    private func said(_ line: String, _ s: Capture) async {
        guard s.hasPanel else { log(line); return }
        let level = line == Recorder.liveTextOff ? "live" : "problem"
        do { try await panel.status(level: level, text: line, meetingId: s.meetingId) } catch { log("panel status: \(error)") }
    }

    private func applyPause(_ s: Capture, _ value: Bool) {
        guard s.paused != value else { return }
        s.paused = value
        value ? s.recorder.pause() : s.recorder.resume()
        shell.setPaused(value)
    }

    private func flushSegmentFile(_ s: Capture, done: Bool = false, lines: [Segment]? = nil) {
        guard done || s.dirty else { return }
        s.dirty = false
        do {
            try MacSegmentsFile.write(run: run, meetingId: s.meetingId, captureId: s.captureId, segments: lines ?? s.liveLines, done: done)
        } catch {
            s.dirty = true
            log("segment file: \(error)")
        }
    }

    // MARK: - Ending

    private func beginEnding(_ s: Capture) {
        guard s.phase == .running else { return }
        s.phase = .ending
        let endedAt = now()
        let drain = Task { [weak self] () -> Void in await self?.drain(s) }
        s.drain = drain
        let ending = Task { [weak self] () -> Void in
            await drain.value
            await self?.writeUp(s, endedAt: endedAt)
        }
        s.ending = ending
        writeUps[s.captureId] = ending
    }

    /// Stops the recorder and lets every live line reach the panel (or the segment file), then lets go:
    /// the red dot goes, active.json becomes the capture's finishing file, and a new capture may start.
    /// The page's live calls act on the meeting on show, so none of this capture's lines can reach the
    /// next one: they've all been delivered before it starts.
    private func drain(_ s: Capture) async {
        let recorder = s.recorder
        s.written = await Task.detached { recorder.stop() }.value
        for pump in s.pumps { await pump.value }
        if s.kind == .captionsOff { flushSegmentFile(s) }
        ActiveCapture.handOver(in: run, captureId: s.captureId)
        if session === s { session = nil }
        shell.setRecording(false)
        shell.setPaused(false)
        shell.setScreenshotApp(nil)
        refreshPrompt()
    }

    /// "Writing the full transcript…", Whisper, then the meeting ended by its id (Whisper's lines, endedAt,
    /// minutes when due), whatever the panel shows by then. The finishing file goes only once that has
    /// landed; otherwise the next launch finishes the capture.
    private func writeUp(_ s: Capture, endedAt: Date) async {
        defer {
            writeUps[s.captureId] = nil
            refreshPrompt()
            if !needsPanel { panel.releaseIfIdle() }
        }
        if s.hasPanel {
            do { try await panel.status(level: "waiting", text: Self.writingStatus, meetingId: s.meetingId) } catch { log("panel status: \(error)") }
        }

        // The title may have changed meanwhile, and the folder with it.
        if let moved = try? await meetingFolder(s.meetingId) { s.folder = moved }
        let written = s.written
        let tracks = s.tracks.compactMap { track, _ -> (Track, URL)? in
            var t = track
            if s.kind == .manual, t.id == "mic", s.micNamed { t.speaker = s.myName }
            let url = s.folder.appendingPathComponent("audio/\(t.id).wav")
            if hasAudio(url) { return (t, url) }
            return written.first { $0.0.id == t.id && hasAudio($0.1) }.map { (t, $0.1) }
        }
        let result = await whisper(captureId: s.captureId, tracks: tracks, startedAt: s.startedAt, model: s.model,
                                   manual: s.kind == .manual, named: s.micNamed, myName: s.myName)

        let landed: Bool
        switch s.kind {
        case .captionsOff:
            if case .success(let lines) = result, !lines.isEmpty {
                flushSegmentFile(s, done: true, lines: lines)
            } else {
                flushSegmentFile(s, done: true)
            }
            landed = !s.dirty
        case .desktop, .manual:
            var lines: [Segment]?
            var rename: SpeakerRename?
            switch result {
            case .success(let l):
                lines = l.isEmpty ? nil : l
                if s.kind == .manual, !s.micNamed, l.contains(where: { $0.speakerId == "system" }) {
                    rename = SpeakerRename(speakerId: "mic", name: s.myName)
                }
            case .failure(let error):
                let text = "Couldn't write the full transcript (\(message(error))). The live lines are kept."
                do { try await panel.status(level: "problem", text: text, meetingId: s.meetingId) } catch { log("panel status: \(error)") }
                shell.showError(text)
                await sleep(Self.errorHold)
            }
            landed = await finishWithRetry(meeting: s.record ?? ["id": s.meetingId], segments: lines,
                                           endedAt: ISOTime.string(endedAt), rename: rename)
        }
        if landed {
            ActiveCapture.clearFinishing(in: run, captureId: s.captureId)
        } else {
            shell.showError("Couldn't finish the meeting just recorded; Earshot will finish it the next time it opens.")
        }
    }

    /// `panel.finish`, tried a second time if the first fails.
    private func finishWithRetry(meeting: [String: Any], segments: [Segment]?, endedAt: String?, rename: SpeakerRename?) async -> Bool {
        for attempt in 1...2 {
            do {
                try await panel.finish(meeting: meeting, segments: segments, endedAt: endedAt, rename: rename)
                return true
            } catch {
                log("finish \(meeting["id"] as? String ?? "?") (attempt \(attempt)): \(error)")
            }
        }
        return false
    }

    /// Whisper over `tracks`; for a manual capture the mic takes `myName` if the Mac's audio has lines.
    private func whisper(captureId: String, tracks: [(Track, URL)], startedAt: Date, model: String,
                         manual: Bool, named: Bool, myName: String) async -> Result<[Segment], Error> {
        guard !tracks.isEmpty else { return .failure(TranscriberError(description: "no audio was recorded")) }
        do {
            var lines = try await transcriber.run(captureId: captureId, tracks: tracks, startedAt: startedAt, model: model)
            if manual, !named, lines.contains(where: { $0.speakerId == "system" }) {
                for i in lines.indices where lines[i].speakerId == "mic" { lines[i].speaker = myName }
            }
            return .success(lines)
        } catch {
            return .failure(error)
        }
    }

    private func hasAudio(_ url: URL) -> Bool {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        return size > TrackWriter.headerSize
    }

    // MARK: - Launch

    /// At launch: the retention sweep (then every 24 h), a capture a quit or crash cut off, and Mac meetings
    /// whose minutes were still waiting when the app quit.
    public func launch() async {
        let t = now()
        nextSweep = t.addingTimeInterval(Self.sweepEvery)
        let config = (try? await helper.call("get-config", [:])) as? [String: Any]
        let mac = config?["mac"] as? [String: Any]
        let keepDays = (mac?["audioKeepDays"] as? NSNumber)?.intValue ?? Self.defaultKeepDays
        let myName = nonEmpty(mac?["myName"] as? String) ?? "Me"
        let model = nonEmpty(mac?["whisperModel"] as? String) ?? Self.defaultModel
        self.keepDays = keepDays
        startSweep(at: t)

        let recovered = await recoverLeftovers(myName: myName, model: model)
        await resumeMinutes(except: recovered)
        if !needsPanel { panel.releaseIfIdle() }
        await sweeping?.value
    }

    private var keepDays = SessionController.defaultKeepDays

    private func startSweep(at t: Date) {
        let sweep = self.sweep, home = self.home, days = keepDays
        sweeping = Task.detached { sweep(home, days, t) }
    }

    /// Finishes every capture a previous run left: the one active.json says was recording, and any whose
    /// write-up didn't land (finishing files). Each file goes only once its meeting has been finished.
    /// active.json is moved aside first, so a capture started meanwhile writes its own. Returns their ids.
    private func recoverLeftovers(myName: String, model: String) async -> Set<String> {
        let url = ActiveCapture.file(in: run)
        if ActiveCapture.handOver(in: run) == nil, FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url) // unreadable
        }
        var ids: Set<String> = []
        for leftover in ActiveCapture.finishing(in: run) {
            let active: ActiveCapture
            switch leftover {
            case .capture(let a), .nothingToRecover(let a): active = a
            }
            ids.insert(active.meetingId)
            switch await recover(active, myName: myName, model: model) {
            case .finished:
                ActiveCapture.clearFinishing(in: run, captureId: active.captureId)
            case .dropped:
                ActiveCapture.setAside(in: run, captureId: active.captureId)
            case .retry:
                shell.showError("Couldn't finish a recording cut off earlier; Earshot will try again the next time it opens.")
            }
        }
        return ids
    }

    enum Recovery { case finished, retry, dropped }

    /// Whisper on the WAVs on disk, then the normal ending.
    private func recover(_ leftover: ActiveCapture, myName: String, model: String) async -> Recovery {
        var active = leftover
        // The helper knows where the meeting's folder is now (a retitled meeting's folder moves).
        var folder = URL(fileURLWithPath: active.folder)
        if let now = try? await meetingFolder(active.meetingId), !active.audioFiles(in: now).isEmpty {
            folder = now
            active.folder = now.path
        }
        let startedAt = ISOTime.date(active.startedAt) ?? now()
        let manual = active.kind == .manual

        // A desktop or manual capture ends its own record: read it first.
        var meeting: [String: Any] = [:]
        if active.kind != .captionsOff {
            do {
                guard let m = try await helper.call("get-meeting", ["id": active.meetingId]) as? [String: Any] else {
                    // The helper has the id but not its meeting.json: nothing left to finish into.
                    log("recover \(active.meetingId): the meeting is gone; setting its leftover capture aside")
                    return .dropped
                }
                meeting = m
            } catch HelperError.failed(let why) where why.hasPrefix("unknown meeting") {
                // Deleted (the meetings page sends it to .trash): its leftover would wait for ever.
                log("recover \(active.meetingId): the meeting isn't known (deleted?); setting its leftover capture aside")
                return .dropped
            } catch {
                log("recover \(active.meetingId): the meeting couldn't be read (\(error)); trying again next launch")
                return .retry
            }
        }
        // Whisper lines that already landed (a write-up whose save came through late) aren't redone: the
        // lines may have been edited since. The meeting is still ended, with minutes, if it isn't yet.
        let whisperDone = (meeting["macWhisperDone"] as? [String])?.contains(active.captureId) ?? false

        let tracks = whisperDone ? [] : active.audioFiles(in: folder)
        var lines: [Segment]?
        if !tracks.isEmpty, case .success(let l) = await whisper(captureId: active.captureId, tracks: tracks, startedAt: startedAt,
                                                                   model: model, manual: manual, named: false, myName: myName) {
            lines = l
        }
        // A manual capture whose Mac audio has lines was a call: the mic is Alex (Whisper's lines say so already).
        let systemSpoke = lines?.contains { $0.speakerId == "system" } ?? false

        switch active.kind {
        case .captionsOff:
            var final = lines ?? []
            if final.isEmpty { final = await liveLines(of: active) ?? [] }
            do {
                try MacSegmentsFile.write(run: run, meetingId: active.meetingId, captureId: active.captureId, segments: final, done: true)
                return .finished
            } catch {
                log("segment file: \(error)")
                return .retry
            }
        case .desktop, .manual:
            let ended = (meeting["endedAt"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let endedAt = ended == nil ? ISOTime.string(lastWrite(folder: folder, tracks: active.tracks) ?? now()) : nil
            let rename = manual && systemSpoke ? SpeakerRename(speakerId: "mic", name: myName) : nil
            let ok = await finishWithRetry(meeting: meeting, segments: (lines?.isEmpty ?? true) ? nil : lines, endedAt: endedAt, rename: rename)
            return ok ? .finished : .retry
        }
    }

    /// A captions-off capture's live lines: its segment file, else its lines in the browser meeting's record.
    private func liveLines(of active: ActiveCapture) async -> [Segment]? {
        if let lines = MacSegmentsFile.read(MacSegmentsFile.url(run: run, meetingId: active.meetingId, captureId: active.captureId)) {
            return lines
        }
        guard let meeting = try? await helper.call("get-meeting", ["id": active.meetingId]) as? [String: Any],
              let segments = meeting["segments"] as? [[String: Any]] else { return nil }
        let prefix = "mac-\(active.captureId)-"
        let mine = segments.filter { ($0["id"] as? String)?.hasPrefix(prefix) == true }
        guard let data = try? JSONSerialization.data(withJSONObject: mine) else { return nil }
        return try? JSONDecoder().decode([Segment].self, from: data)
    }

    /// When the capture's audio was last written: about when it was cut off.
    private func lastWrite(folder: URL, tracks: [ActiveCapture.TrackInfo]) -> Date? {
        tracks.compactMap { t in
            try? FileManager.default.attributesOfItem(atPath: folder.appendingPathComponent("audio/\(t.id).wav").path)[.modificationDate] as? Date
        }.max()
    }

    /// Mac meetings that ended in the last 24 h without minutes: the minutes delay was a timer in the page,
    /// lost when the app quit. The page's own ending flow picks them up again (it checks autoMinutes).
    private func resumeMinutes(except skip: Set<String>) async {
        guard let rows = try? await helper.call("list-meetings", [:]) as? [[String: Any]] else { return }
        let t = now()
        for row in rows {
            guard let id = row["id"] as? String, !skip.contains(id),
                  let platform = row["platform"] as? String, Self.macPlatforms.contains(platform),
                  row["hasMinutes"] as? Bool != true,
                  let endedText = row["endedAt"] as? String, let ended = ISOTime.date(endedText),
                  t.timeIntervalSince(ended) <= Self.resumeMinutesWithin else { continue }
            guard let meeting = try? await helper.call("get-meeting", ["id": id]) as? [String: Any] else { continue }
            if let minutes = meeting["minutes"] as? String, !minutes.isEmpty { continue }
            do { try await panel.finish(meeting: meeting, segments: nil, endedAt: nil, rename: nil) } catch {
                log("minutes for \(id): \(error)")
            }
        }
    }

    // MARK: - Records

    /// `20261104-101500` in local time, as the extension's `newMeetingId` stamps.
    static func idStamp(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: d)
    }

    /// A new record in the extension's shape (`meeting.json`); only JSON values.
    static func newRecord(id: String, platform: String, startedAt: Date) -> [String: Any] {
        let iso = ISOTime.string(startedAt)
        return [
            "id": id, "platform": platform, "meetingRef": NSNull(), "refs": [], "title": "", "url": NSNull(),
            "startedAt": iso, "endedAt": NSNull(), "captionLanguage": NSNull(), "participants": [:], "segments": [],
            "speakerNames": [:], "notes": "", "screenshots": [], "titleEdited": false, "tags": [], "tagsAuto": true,
            "chats": [], "minutes": NSNull(), "updatedAt": iso,
        ]
    }

    private func nonEmpty(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }

    private func log(_ s: String) {
        FileHandle.standardError.write(Data("earshot: \(s)\n".utf8))
    }
}
