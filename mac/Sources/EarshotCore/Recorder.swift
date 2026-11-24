import AVFAudio
import Foundation

/// Hands over captured buffers. Called on the source's own thread; the buffer is only valid during the call
/// unless the source made it for us (the Recorder copies nothing, so sources pass buffers they own).
public typealias BufferHandler = @Sendable (AVAudioPCMBuffer) -> Void

/// A running audio input: the mic, or a process tap.
public protocol AudioSource: AnyObject {
    func start() throws
    func stop()
    /// For a tap: whether the tapped app is playing audio right now (used to spot a tap that hears nothing).
    var outputProbe: (@Sendable () -> Bool)? { get }
}

extension AudioSource {
    public var outputProbe: (@Sendable () -> Bool)? { nil }
}

/// Whether live speech is available, decided once per capture.
public enum SpeechSetup {
    /// One engine per track.
    case on((Track) -> SpeechEngine)
    case off(reason: String)
}

public struct RecorderError: Error, CustomStringConvertible, Sendable {
    public let trackId: String
    public let source: Recorder.Source
    public let reason: String
    public var description: String { "Could not start \(source.label) (\(trackId) track): \(reason)" }
}

/// Records a capture's tracks to `<folder>/audio/<track>.wav` and streams live segments and levels.
///
/// The audio hardware lives behind `makeSource` (the app passes the real mic and tap; the tests pass fakes),
/// so everything here runs without devices. Each track gets a serial queue, so a slow disk or recognizer on
/// one track never holds up the capture thread or the other track.
public final class Recorder: @unchecked Sendable {
    public enum Source: Equatable, Sendable {
        case mic
        case tap(TapTarget)

        public var label: String {
            switch self {
            case .mic: return "the microphone"
            case .tap(let t): return "the audio tap on \(t.label)"
            }
        }

        /// The mic with voice processing can carry extra raw channels; a tap is a real stereo mix.
        public var channels: ChannelPolicy {
            switch self {
            case .mic: return .first
            case .tap: return .mixdown
            }
        }
    }

    public static let liveTextOff = "Live text off: the full transcript comes after the call"
    /// Apple's recognizer refuses to run while Siri and Dictation are both off.
    public static let dictationOff = "Live text needs Dictation: turn it on in System Settings → Keyboard → Dictation. The full transcript still comes after the call"
    public static let callAudioMissing = "Call audio isn't reaching Earshot: check Screen & System Audio Recording in System Settings"

    public typealias SourceFactory = (Source, Track, @escaping BufferHandler) throws -> AudioSource
    public typealias WriterFactory = (URL, Date) throws -> TrackFile

    public static func defaultWriter(url: URL, now: Date) throws -> TrackFile {
        try TrackWriter(url: url, now: now)
    }

    public let folder: URL
    public let tracks: [(Track, Source)]
    public let captureId: String
    public let startedAt: Date
    public let segments: AsyncStream<Segment>
    public let level: AsyncStream<(trackId: String, rms: Float)>
    /// Status lines for the panel, e.g. `Recorder.liveTextOff`.
    public let status: AsyncStream<String>

    private let speech: SpeechSetup
    private let makeSource: SourceFactory
    private let makeWriter: WriterFactory
    private let clock: @Sendable () -> Date
    private let uptime: @Sendable () -> TimeInterval
    private let segmentsOut: AsyncStream<Segment>.Continuation
    private let levelOut: AsyncStream<(trackId: String, rms: Float)>.Continuation
    private let statusOut: AsyncStream<String>.Continuation

    private let lock = NSLock()
    private var running: [Running] = []
    private var stopped = false
    private var paused = false
    /// Bumped on every pause and resume, so a queued resume that a later pause overtook does nothing.
    private var pauseEpoch = 0
    private var failedWrites: [String: Error] = [:]
    // Its own lock (live-text and write-failure reports): pipelines report from inside their own lock,
    // which pause() takes while holding `lock`.
    private let liveLock = NSLock()
    private var liveTracks = 0
    private var reportedLiveOff = false
    private var files: [(Track, URL)] = []

    private struct Running {
        let track: Track
        let source: AudioSource
        let pipeline: TrackPipeline
        let queue: DispatchQueue
    }

    public init(folder: URL, tracks: [(Track, Source)], captureId: String, startedAt: Date,
                speech: SpeechSetup, makeSource: @escaping SourceFactory,
                makeWriter: @escaping WriterFactory = Recorder.defaultWriter,
                clock: @escaping @Sendable () -> Date = { Date() },
                uptime: @escaping @Sendable () -> TimeInterval = { TrackPipeline.systemUptime() }) {
        self.folder = folder
        self.tracks = tracks
        self.captureId = captureId
        self.startedAt = startedAt
        self.speech = speech
        self.makeSource = makeSource
        self.makeWriter = makeWriter
        self.clock = clock
        self.uptime = uptime
        (segments, segmentsOut) = AsyncStream.makeStream(of: Segment.self)
        (level, levelOut) = AsyncStream.makeStream(of: (trackId: String, rms: Float).self, bufferingPolicy: .bufferingNewest(64))
        (status, statusOut) = AsyncStream.makeStream(of: String.self)
    }

    /// A recorder dropped while running stops its sources (a tap's IOProc would otherwise keep writing).
    /// It never waits: the last reference can go away inside a pipeline's lock (a callback on the
    /// recognizer's thread) while that track's queue is blocked on the lock, so the files are finished on
    /// their queues afterwards instead.
    deinit {
        lock.lock()
        let wasStopped = stopped
        stopped = true
        let all = running
        running = []
        lock.unlock()
        guard !wasStopped else { return }
        for r in all { r.source.stop() }
        for r in all {
            let pipeline = r.pipeline
            r.queue.async { pipeline.finish() }
        }
        segmentsOut.finish()
        levelOut.finish()
        statusOut.finish()
    }

    public var audioFolder: URL { folder.appendingPathComponent("audio", isDirectory: true) }

    /// Why live text is off for this capture, when it was off from the start.
    public var speechOffReason: String? {
        if case .off(let reason) = speech { return reason }
        return nil
    }

    public var isPaused: Bool {
        lock.lock(); defer { lock.unlock() }
        return paused
    }

    /// Tracks whose file stopped on a write error, with the error. Their partial files are still returned by `stop()`.
    public var writeErrors: [String: Error] {
        liveLock.lock(); defer { liveLock.unlock() }
        return failedWrites
    }

    /// Opens every track's WAV and starts every source. If one fails, the ones already started are stopped
    /// and the error names the source that failed.
    public func start() throws {
        lock.lock(); defer { lock.unlock() }
        guard running.isEmpty, !stopped else { return }
        if case .on = speech { liveLock.lock(); liveTracks = tracks.count; liveLock.unlock() }
        var started: [Running] = []
        var created: [URL] = []
        func rollBack() {
            for r in started { r.source.stop() }
            for r in started { Self.wait(for: r.queue); r.pipeline.finish() }
            for url in created { try? FileManager.default.removeItem(at: url) }
        }
        for (track, source) in tracks {
            do {
                let url = audioFolder.appendingPathComponent("\(track.id).wav")
                let writer = try makeWriter(url, clock())
                created.append(url)
                var engine: SpeechEngine?
                if case .on(let make) = speech { engine = make(track) }
                let trackId = track.id
                let pipeline = TrackPipeline(
                    track: track, captureId: captureId, startedAt: startedAt, writer: writer, channels: source.channels,
                    speech: engine, clock: clock, uptime: uptime,
                    onSegment: { [segmentsOut] in segmentsOut.yield($0) },
                    onLevel: { [levelOut] in levelOut.yield((trackId: trackId, rms: $0)) },
                    onLiveTextOff: { [weak self] reason in self?.trackLiveTextOff(reason) },
                    onWriteFailed: { [weak self] in self?.trackWriteFailed(trackId, $0) })
                let queue = DispatchQueue(label: "earshot.capture.\(track.id)")
                queue.setSpecific(key: Self.queueKey, value: ObjectIdentifier(queue))
                let uptime = self.uptime
                let src = try makeSource(source, track) { buffer in
                    let box = BufferBox(buffer)
                    let at = uptime()
                    queue.async { pipeline.process(box.buffer, capturedAt: at) }
                }
                if let probe = src.outputProbe {
                    pipeline.watchForSilentTap(probe: probe, onSilent: { [statusOut] in statusOut.yield(Recorder.callAudioMissing) })
                }
                let r = Running(track: track, source: src, pipeline: pipeline, queue: queue)
                try src.start()
                started.append(r)
            } catch {
                rollBack()
                throw RecorderError(trackId: track.id, source: source, reason: "\(error)")
            }
        }
        running = started
        if case .off = speech {
            liveLock.lock(); reportLiveOff(); liveLock.unlock()
        }
    }

    public func pause() {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return }
        paused = true
        pauseEpoch += 1
        for r in running { r.pipeline.pause() }
    }

    /// Resumes each track behind the buffers already queued, so audio captured during the pause but not
    /// processed yet is still zeroed.
    public func resume() {
        lock.lock(); defer { lock.unlock() }
        guard !stopped, paused else { return }
        paused = false
        pauseEpoch += 1
        let epoch = pauseEpoch
        for r in running {
            let pipeline = r.pipeline
            r.queue.async { [weak self] in self?.resumeIfCurrent(pipeline, epoch: epoch) }
        }
    }

    private func resumeIfCurrent(_ pipeline: TrackPipeline, epoch: Int) {
        lock.lock(); defer { lock.unlock() }
        if !stopped, !paused, pauseEpoch == epoch { pipeline.resume() }
    }

    /// Waits until every buffer handed over so far has been processed.
    public func drain() {
        let queues: [DispatchQueue] = { lock.lock(); defer { lock.unlock() }; return running.map(\.queue) }()
        for q in queues { Self.wait(for: q) }
    }

    /// Stops the sources, writes out the queued audio, closes the WAVs and ends the streams.
    /// Returns the tracks whose files were written. Safe to call twice.
    @discardableResult
    public func stop() -> [(Track, URL)] {
        lock.lock()
        if stopped { lock.unlock(); return files }
        stopped = true
        let all = running
        running = []
        lock.unlock()

        for r in all { r.source.stop() }
        var out: [(Track, URL)] = []
        for r in all {
            Self.wait(for: r.queue)
            out.append((r.track, r.pipeline.finish()))
        }
        segmentsOut.finish()
        levelOut.finish()
        statusOut.finish()
        lock.lock(); files = out; lock.unlock()
        return out
    }

    /// Called from inside a pipeline's lock, so it takes `liveLock`, never `lock` (pause() holds `lock`
    /// while it takes the pipelines' locks).
    private static let queueKey = DispatchSpecificKey<ObjectIdentifier>()

    /// Waits for the queue's pending work, unless we're on it: a callback holding the last reference can
    /// run `deinit` → `stop()` on a track queue, and syncing onto your own queue deadlocks.
    private static func wait(for queue: DispatchQueue) {
        if DispatchQueue.getSpecific(key: queueKey) == ObjectIdentifier(queue) { return }
        queue.sync {}
    }

    private func trackWriteFailed(_ trackId: String, _ error: Error) {
        liveLock.lock()
        failedWrites[trackId] = error
        liveLock.unlock()
        statusOut.yield("The \(trackId) track stopped recording: \(error)")
    }

    private var liveOffReason: String?

    private func trackLiveTextOff(_ reason: String?) {
        liveLock.lock(); defer { liveLock.unlock() }
        if let reason { liveOffReason = reason }
        liveTracks -= 1
        if liveTracks <= 0 { reportLiveOff() }
    }

    /// Call with `liveLock` held.
    private func reportLiveOff() {
        guard !reportedLiveOff else { return }
        reportedLiveOff = true
        let dictation = liveOffReason?.localizedCaseInsensitiveContains("Dictation are disabled") == true
        statusOut.yield(dictation ? Self.dictationOff : Self.liveTextOff)
    }
}

/// Carries a buffer onto the track queue. The source hands it over and doesn't touch it again.
private struct BufferBox: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
}
