import AVFAudio
import Foundation

/// Everything one track does with its audio, minus the hardware: convert to 16 kHz mono, write the WAV,
/// report the level, feed live speech (rotating requests on a pause or at 55 s) and turn the results into
/// segments. Pausing writes silence in place of the audio and drops live results until `resume()`.
///
/// `process` is called from the track's capture queue; speech results arrive on the recognizer's thread.
/// A recursive lock covers both (a recognizer may report a failure from inside `startRequest`).
public final class TrackPipeline: @unchecked Sendable {
    /// Requests that fail with less than this much audio in a row mean on-device speech isn't working.
    public static let maxQuickFailures = 3
    /// A track without a request starts one only once it hears this (RMS, about -60 dBFS).
    public static let speechStartLevel: Float = 0.001
    static let quickFailureSeconds: Double = 2
    /// How long a rotated-out request may take to send its final result before its last text is used.
    static let finalWait: TimeInterval = 2
    /// When wall time runs further ahead of the written audio than this (a source stall, the mic engine
    /// restarting on a new device), the gap is filled with silence so file time stays wall time for Whisper.
    static let maxStall: TimeInterval = 0.5
    /// The most silence one stall adds. Longer gaps (a stuck source) are logged and only this much is padded.
    static let maxPad: TimeInterval = 30

    /// Seconds since boot, not counting sleep (mach_absolute_time): what the stall padding measures, so a
    /// wall-clock jump (sleep/wake, an NTP step) never pads.
    public static func systemUptime() -> TimeInterval {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    }

    public let track: Track
    private let writer: TrackFile
    private let converter: PCMConverter
    private let builder: SegmentBuilder
    private var speech: SpeechEngine?
    private let clock: @Sendable () -> Date
    private let onSegment: @Sendable (Segment) -> Void
    private let onLevel: @Sendable (Float) -> Void
    /// Called once when live text gives up, with the recognizer's last error.
    private let onLiveTextOff: @Sendable (String?) -> Void
    private let onWriteFailed: @Sendable (Error) -> Void
    private let lock = NSRecursiveLock()
    private let uptime: @Sendable () -> TimeInterval
    /// The file's time zero on the uptime clock (moved forward when a pad is capped).
    private var origin: TimeInterval

    private var rotation = RequestRotation()
    private var paused = false
    private var finished = false
    private var firstWriteError: Error?
    private var silentWatch = SilentTapWatch()
    private var silentProbe: (@Sendable () -> Bool)?
    private var onSilentTap: (@Sendable () -> Void)?

    // Live speech state. Each request has a generation number; results from older ones are ignored
    // unless that request is the one we're still waiting on for a final result.
    private var generation = 0
    private var session: SpeechSession?
    private var needsSession = true
    private var sessionSeconds: Double = 0
    private var quickFailures = 0
    /// The latest unfinished text per generation, with when it arrived.
    private var lastText: [Int: (text: String, at: Date)] = [:]
    /// A rotated-out request with text whose final result hasn't come yet.
    private var waitingFor: Int?
    private var waitDeadline = Date.distantPast
    /// Results of newer requests (the newest per request), held while `waitingFor` is set.
    private var held: [(event: SpeechEvent, at: Date, generation: Int)] = []

    public init(track: Track, captureId: String, startedAt: Date, writer: TrackFile, channels: ChannelPolicy,
                speech: SpeechEngine?, clock: @escaping @Sendable () -> Date = { Date() },
                uptime: @escaping @Sendable () -> TimeInterval = { TrackPipeline.systemUptime() },
                onSegment: @escaping @Sendable (Segment) -> Void = { _ in },
                onLevel: @escaping @Sendable (Float) -> Void = { _ in },
                onLiveTextOff: @escaping @Sendable (String?) -> Void = { _ in },
                onWriteFailed: @escaping @Sendable (Error) -> Void = { _ in }) {
        self.track = track
        self.writer = writer
        self.converter = PCMConverter(channels: channels)
        self.builder = SegmentBuilder(captureId: captureId, track: track, startedAt: startedAt)
        self.speech = speech
        self.clock = clock
        self.onSegment = onSegment
        self.onLevel = onLevel
        self.onLiveTextOff = onLiveTextOff
        self.onWriteFailed = onWriteFailed
        self.uptime = uptime
        self.origin = uptime()
    }

    /// The first error writing the file, after which the track stopped recording (the file keeps what was
    /// written before it).
    public var writeError: Error? {
        lock.lock(); defer { lock.unlock() }
        return firstWriteError
    }

    /// For a tap: calls `onSilent` when the track has had only exact-zero samples for 10 s while `probe`
    /// says the target app is playing.
    public func watchForSilentTap(probe: @escaping @Sendable () -> Bool, onSilent: @escaping @Sendable () -> Void) {
        lock.lock(); defer { lock.unlock() }
        silentProbe = probe
        onSilentTap = onSilent
    }

    public var isLiveTextOn: Bool {
        lock.lock(); defer { lock.unlock() }
        return speech != nil
    }

    // MARK: Audio in

    /// `capturedAt` is the uptime when the source handed the buffer over, so a backlog on the track queue
    /// isn't mistaken for a stall (default: now).
    public func process(_ buffer: AVAudioPCMBuffer, capturedAt: TimeInterval? = nil) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        let at = capturedAt ?? uptime()
        // While paused the audio is zeroed before conversion: the file keeps its length (file time stays wall
        // time for Whisper), the resampler stays continuous, and what it still held from before the pause is kept.
        let wasPaused = paused
        let samples = converter.convert(wasPaused ? Self.zeroed(buffer) : buffer)
        guard !samples.isEmpty else { return }
        let now = clock()
        // Callbacks (the clock included) can stop the recorder from this very queue; check again after each.
        guard !finished else { return }
        let seconds = Double(samples.count) / PCMConverter.sampleRate
        padStall(before: samples.count, at: at, now: now)
        write { try writer.append(samples, now: now) }
        if wasPaused {
            onLevel(0)
            return
        }
        let rms = AudioLevel.rms(samples)
        onLevel(rms)
        if let probe = silentProbe,
           silentWatch.feed(allZero: samples.allSatisfy { $0 == 0 }, seconds: seconds, targetPlaying: probe) {
            onSilentTap?()
        }
        guard !finished else { return }

        if let w = waitingFor, now >= waitDeadline { closeWaiting(w) }
        guard let engine = speech else { return }
        if needsSession {
            // Silence starts no request: Apple answers it at once with "No speech detected", and a silent
            // track doing that every buffer starved the other track's recognizer.
            guard rms >= Self.speechStartLevel else { return }
            startSession(engine)
        }
        guard !finished, let current = session else { return }
        current.append(PCMConverter.buffer(samples))
        sessionSeconds += seconds
        switch rotation.feed(rms: rms, seconds: seconds) {
        case .speech:
            break
        case .silence:
            builder.silence(at: now)
        case .rotate:
            builder.silence(at: now)
            rotate(engine, now: now)
        }
    }

    public func pause() {
        lock.lock(); defer { lock.unlock() }
        guard !paused, !finished else { return }
        closeOpenLines()
        session?.cancel()
        session = nil
        needsSession = true
        paused = true
    }

    public func resume() {
        lock.lock(); defer { lock.unlock() }
        paused = false
    }

    /// Writes the resampler's tail, closes the WAV and closes any open line. Later results are ignored.
    /// Returns the file even after a write error (it holds what was written before; see `writeError`).
    @discardableResult
    public func finish() -> URL {
        lock.lock(); defer { lock.unlock() }
        if !finished {
            finished = true
            if !paused { closeOpenLines() }
            session?.cancel()
            session = nil
            let tail = converter.finish()
            let now = clock()
            if !tail.isEmpty, firstWriteError == nil {
                do { try writer.append(tail, now: now) } catch { failed(error) }
            }
            // Closed even after a write error, so the header covers what was written.
            do { try writer.close() } catch { failed(error) }
        }
        return writer.url
    }

    /// A copy of the buffer's shape filled with silence.
    static func zeroed(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        guard let z = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return buffer }
        z.frameLength = buffer.frameLength
        for b in UnsafeMutableAudioBufferListPointer(z.mutableAudioBufferList) {
            if let data = b.mData { memset(data, 0, Int(b.mDataByteSize)) }
        }
        return z
    }

    /// Nothing is written once finished (the file is closed); `finish()` writes its tail itself.
    private func write(_ body: () throws -> Void) {
        guard firstWriteError == nil, !finished else { return }
        do { try body() } catch { failed(error) }
    }

    private func failed(_ error: Error) {
        guard firstWriteError == nil else { return }
        firstWriteError = error
        onWriteFailed(error)
    }

    /// Fills a gap (on the uptime clock) longer than `maxStall` with silence, at most `maxPad`, in 10 s pieces.
    private func padStall(before count: Int, at: TimeInterval, now: Date) {
        let rate = PCMConverter.sampleRate
        let expected = (at - origin) * rate
        var gap = Int(expected) - Int(writer.frames) - count
        guard Double(gap) > Self.maxStall * rate else { return }
        let cap = Int(Self.maxPad * rate)
        if gap > cap {
            FileHandle.standardError.write(Data(String(format: "earshot: the %@ track had no audio for %.0f s; padding %.0f s of silence\n",
                                                       track.id, Double(gap) / rate, Self.maxPad).utf8))
            origin += Double(gap - cap) / rate
            gap = cap
        }
        let piece = Int(PCMConverter.sampleRate) * 10
        while gap > 0 {
            let n = min(gap, piece)
            write { try writer.append([Float](repeating: 0, count: n), now: now) }
            gap -= n
        }
    }

    // MARK: Speech requests

    private func startSession(_ engine: SpeechEngine) {
        generation += 1
        let g = generation
        needsSession = false
        sessionSeconds = 0
        rotation.reset()
        let s = engine.startRequest { [weak self] event in self?.handle(event, generation: g) }
        // A request that failed inside startRequest has already asked for a replacement.
        if generation == g && !needsSession && speech != nil { session = s } else { s.cancel() }
    }

    private func rotate(_ engine: SpeechEngine, now: Date) {
        if let w = waitingFor { closeWaiting(w) }
        session?.end()
        session = nil
        if lastText[generation] != nil {
            waitingFor = generation
            waitDeadline = now.addingTimeInterval(Self.finalWait)
        }
        startSession(engine)
    }

    private func handle(_ event: SpeechEvent, generation g: Int) {
        lock.lock(); defer { lock.unlock() }
        guard !finished, !paused, speech != nil else { return }
        let now = clock()
        if g == waitingFor {
            switch event {
            case .partial(let t):
                apply(.partial(t), generation: g, at: now)
            case .final(let t):
                apply(.final(t), generation: g, at: now)
                waitingFor = nil
                replayHeld()
            case .failed, .noSpeech:
                closeWaiting(g)
            }
            return
        }
        guard g == generation else { return }
        if case .noSpeech = event {
            // Silence, not a failure: what was heard stands as its line, and the next buffer starts a request.
            if let last = lastText[g] { apply(.final(last.text), generation: g, at: last.at) }
            session = nil
            needsSession = true
            return
        }
        if case .failed(let message) = event {
            lastFailure = message
            // The request's words so far stand as its line; the next request starts a new one.
            if waitingFor != nil {
                held = held.map { h in
                    if h.generation == g, case .partial(let t) = h.event { return (.final(t), h.at, g) }
                    return h
                }
            } else if let last = lastText[g] {
                apply(.final(last.text), generation: g, at: last.at)
            }
            session = nil
            needsSession = true
            if sessionSeconds < Self.quickFailureSeconds { quickFailures += 1 } else { quickFailures = 0 }
            if quickFailures >= Self.maxQuickFailures { liveTextOff() }
            return
        }
        quickFailures = 0
        if waitingFor != nil {
            held.removeAll { $0.generation == g }
            held.append((event, now, g))
            return
        }
        apply(event, generation: g, at: now)
        if case .final = event {
            // The recognizer finished this request on its own; the next buffer starts another.
            session = nil
            needsSession = true
        }
    }

    /// Hands a result to the segment builder. A final is stamped with its request's last partial time,
    /// so a late final finishes that line instead of opening a new one.
    private func apply(_ event: SpeechEvent, generation g: Int, at now: Date) {
        switch event {
        case .partial(let t):
            guard let seg = builder.partial(t, at: now) else { return }
            lastText[g] = (t, now)
            onSegment(seg)
        case .final(let t):
            let at = lastText[g]?.at ?? now
            lastText[g] = nil
            if let seg = builder.final(t, at: at) { onSegment(seg) }
        case .failed, .noSpeech:
            break
        }
    }

    /// The rotated-out request never sent its final: its last text becomes the line's final text.
    private func closeWaiting(_ g: Int) {
        if let last = lastText[g] {
            apply(.final(last.text), generation: g, at: last.at)
        }
        waitingFor = nil
        replayHeld()
    }

    private func replayHeld() {
        let all = held
        held = []
        for h in all {
            apply(h.event, generation: h.generation, at: h.at)
            if case .final = h.event, h.generation == generation {
                session = nil
                needsSession = true
            }
        }
    }

    /// Finishes every line still open, with the text it has.
    private func closeOpenLines() {
        if let w = waitingFor { closeWaiting(w) }
        if let last = lastText[generation] {
            apply(.final(last.text), generation: generation, at: last.at)
        }
        lastText.removeAll()
    }

    private var lastFailure: String?

    private func liveTextOff() {
        speech = nil
        session?.cancel()
        session = nil
        lastText.removeAll()
        waitingFor = nil
        held = []
        onLiveTextOff(lastFailure)
    }
}
