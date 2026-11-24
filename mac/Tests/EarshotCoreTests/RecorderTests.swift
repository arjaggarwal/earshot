import AVFAudio
import Foundation
import Testing
@testable import EarshotCore

/// Stands in for the mic or a process tap: the test pushes buffers through `emit`.
final class FakeSource: AudioSource, @unchecked Sendable {
    let kind: Recorder.Source
    let onBuffer: BufferHandler
    var failure: String?
    var probe: (@Sendable () -> Bool)?
    var outputProbe: (@Sendable () -> Bool)? { probe }
    private(set) var started = false
    private(set) var stopped = false
    init(kind: Recorder.Source, onBuffer: @escaping BufferHandler) { self.kind = kind; self.onBuffer = onBuffer }
    func start() throws {
        if let failure { throw CaptureError(failure) }
        started = true
    }
    func stop() { stopped = true }
    func emit(_ b: AVAudioPCMBuffer) { onBuffer(b) }
}

final class FakeSources: @unchecked Sendable {
    var made: [String: FakeSource] = [:]
    var failing: [String: String] = [:]
    var speech: [String: FakeSpeech] = [:]
    var probes: [String: @Sendable () -> Bool] = [:]
    func make(_ kind: Recorder.Source, _ track: Track, _ h: @escaping BufferHandler) throws -> AudioSource {
        let s = FakeSource(kind: kind, onBuffer: h)
        s.failure = failing[track.id]
        s.probe = probes[track.id]
        made[track.id] = s
        return s
    }
    func engine(_ track: Track) -> SpeechEngine {
        let e = FakeSpeech()
        speech[track.id] = e
        return e
    }
}

func collect<T>(_ stream: AsyncStream<T>) async -> [T] {
    var out: [T] = []
    for await x in stream { out.append(x) }
    return out
}

@Suite struct RecorderTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let mic = Track(id: "mic", speaker: "Alex")
    let call = Track(id: "call", speaker: "Call")

    func recorder(_ fakes: FakeSources, folder: URL, speechOn: Bool = true, clock: (@Sendable () -> Date)? = nil,
                  makeWriter: Recorder.WriterFactory? = nil) -> Recorder {
        // A fixed clock: the tests hand over audio faster than real time, so wall-clock padding never applies.
        let t0 = self.t0
        return Recorder(folder: folder, tracks: [(mic, .mic), (call, .tap(.processes(bundlePrefix: "us.zoom")))],
                        captureId: "cap", startedAt: t0,
                        speech: speechOn ? .on(fakes.engine) : .off(reason: "speech recognition isn't allowed"),
                        makeSource: fakes.make, makeWriter: makeWriter ?? Recorder.defaultWriter, clock: clock ?? { t0 },
                        uptime: { 0 })
    }

    @Test func recordsEachTrackToAudioFolderAndStreamsSegmentsAndLevels() async throws {
        let fakes = FakeSources(), folder = tempDir()
        let r = recorder(fakes, folder: folder)
        try r.start()
        #expect(fakes.made["mic"]?.started == true && fakes.made["call"]?.started == true)
        #expect(fakes.made["mic"]?.kind == .mic)
        for _ in 0..<10 {
            fakes.made["mic"]!.emit(sineBuffer(seconds: 0.1, channels: 1))
            fakes.made["call"]!.emit(sineBuffer(seconds: 0.1))
        }
        r.drain()
        fakes.speech["call"]!.sessions[0].partial("hi from zoom")
        let files = r.stop()
        #expect(fakes.made["mic"]?.stopped == true && fakes.made["call"]?.stopped == true)
        #expect(files.map(\.0.id) == ["mic", "call"])
        #expect(files.map(\.1) == [folder.appendingPathComponent("audio/mic.wav"), folder.appendingPathComponent("audio/call.wav")])
        for (_, url) in files { #expect(abs(Double(try AVAudioFile(forReading: url).length) / 16_000 - 1) < 0.01) }

        let segments = await collect(r.segments)
        #expect(segments.map(\.text).first == "hi from zoom")
        #expect(segments.first?.id == "mac-cap-call-1" && segments.first?.speaker == "Call")
        let levels = await collect(r.level)
        #expect(Set(levels.map(\.trackId)) == ["mic", "call"])
        #expect(await collect(r.status).isEmpty)
        #expect(r.stop().count == 2)                 // stopping twice is harmless
    }

    @Test func speechOffKeepsRecordingAndSaysSo() async throws {
        let fakes = FakeSources(), folder = tempDir()
        let r = recorder(fakes, folder: folder, speechOn: false)
        try r.start()
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))
        let files = r.stop()
        #expect(abs(Double(try AVAudioFile(forReading: files[0].1).length) / 16_000 - 0.5) < 0.01)
        #expect(await collect(r.status) == ["Live text off: the full transcript comes after the call"])
        #expect(Recorder.liveTextOff == "Live text off: the full transcript comes after the call")
        #expect(await collect(r.segments).isEmpty)
    }

    @Test func liveTextOffIsReportedOnceEveryTrackHasGivenUp() async throws {
        let fakes = FakeSources(), folder = tempDir()
        let r = Recorder(folder: folder, tracks: [(mic, .mic), (call, .tap(.systemExcludingSelf))], captureId: "cap", startedAt: t0,
                         speech: .on { _ in let e = FakeSpeech(); e.failImmediately = true; return e }, makeSource: fakes.make,
                         clock: { [t0] in t0 }, uptime: { 0 })
        try r.start()
        for _ in 0..<10 { fakes.made["mic"]!.emit(sineBuffer(seconds: 0.1, channels: 1)) }
        r.drain()
        for _ in 0..<10 { fakes.made["call"]!.emit(sineBuffer(seconds: 0.1)) }
        _ = r.stop()
        #expect(await collect(r.status) == [Recorder.liveTextOff])
    }

    /// With Siri and Dictation off, every request fails with "Siri and Dictation are disabled";
    /// the panel must say how to fix it, not just that live text is off.
    @Test func dictationOffIsNamedWithTheFix() async throws {
        let fakes = FakeSources(), folder = tempDir()
        let r = Recorder(folder: folder, tracks: [(mic, .mic)], captureId: "cap", startedAt: t0,
                         speech: .on { _ in let e = FakeSpeech(); e.failImmediately = true; e.failMessage = "Siri and Dictation are disabled"; return e },
                         makeSource: fakes.make, clock: { [t0] in t0 }, uptime: { 0 })
        try r.start()
        for _ in 0..<10 { fakes.made["mic"]!.emit(sineBuffer(seconds: 0.1, channels: 1)) }
        _ = r.stop()
        #expect(await collect(r.status) == [Recorder.dictationOff])
        #expect(Recorder.dictationOff.contains("Dictation"))
    }

    @Test func aSourceThatFailsToStartIsNamedAndTheOthersAreStopped() throws {
        let fakes = FakeSources(), folder = tempDir()
        fakes.failing["call"] = "AudioHardwareCreateProcessTap failed (OSStatus 560947818)"
        let r = recorder(fakes, folder: folder)
        do {
            try r.start()
            Issue.record("start should throw")
        } catch let e as RecorderError {
            #expect(e.trackId == "call")
            #expect(e.description == "Could not start the audio tap on us.zoom (call track): AudioHardwareCreateProcessTap failed (OSStatus 560947818)")
        }
        #expect(fakes.made["mic"]?.stopped == true)
        #expect(r.stop().isEmpty)
    }

    @Test func micFailureNamesTheMicrophone() {
        let fakes = FakeSources()
        fakes.failing["mic"] = "microphone access is off"
        let r = recorder(fakes, folder: tempDir())
        #expect(throws: RecorderError.self) { try r.start() }
        do { try r.start() } catch { #expect("\(error)".hasPrefix("Could not start the microphone (mic track)")) }
        #expect(Recorder.Source.tap(.systemExcludingSelf).label == "the audio tap on the whole Mac")
    }

    @Test func pauseDropsAudioAndSegmentsUntilResume() async throws {
        let fakes = FakeSources(), folder = tempDir()
        let r = recorder(fakes, folder: folder)
        try r.start()
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))
        r.drain()
        r.pause()
        #expect(r.isPaused)
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))
        r.drain()
        fakes.speech["mic"]!.sessions[0].partial("while paused")
        r.resume()
        #expect(!r.isPaused)
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))
        r.drain()
        fakes.speech["mic"]!.sessions[1].partial("back")
        let files = r.stop()
        #expect(await collect(r.segments).map(\.text) == ["back", "back"])
        let samples = try wavSamples(files[0].1)
        #expect(abs(samples.count - 24_000) <= 48)
        #expect(samples[8_500..<15_500].allSatisfy { $0 == 0 })
    }

    @Test func aRecorderDroppedWhileRunningStopsItsSources() throws {
        let fakes = FakeSources()
        do {
            let r = recorder(fakes, folder: tempDir())
            try r.start()
            fakes.made["call"]!.emit(sineBuffer(seconds: 0.2))
        }
        #expect(fakes.made["mic"]?.stopped == true && fakes.made["call"]?.stopped == true)
    }

    @Test func aWriteFailureIsReportedAndStopStillReturnsThePartialFile() async throws {
        let fakes = FakeSources(), folder = tempDir()
        let r = recorder(fakes, folder: folder, makeWriter: { url, now in
            url.lastPathComponent == "call.wav" ? try FailingWriter(url: url, now: now, failAfter: 2) as TrackFile : try TrackWriter(url: url, now: now)
        })
        try r.start()
        for _ in 0..<10 {
            fakes.made["mic"]!.emit(sineBuffer(seconds: 0.1, channels: 1))
            fakes.made["call"]!.emit(sineBuffer(seconds: 0.1))
        }
        let files = r.stop()
        #expect(files.map(\.0.id) == ["mic", "call"])
        #expect(r.writeErrors.keys.sorted() == ["call"])
        #expect("\(r.writeErrors["call"]!)" == "No space left on device")
        #expect(try AVAudioFile(forReading: files[1].1).length > 0)
        #expect(await collect(r.status) == ["The call track stopped recording: No space left on device"])
    }

    @Test func buffersQueuedDuringAPauseStayZeroedAfterResume() throws {
        let fakes = FakeSources(), folder = tempDir()
        let gate = GatedClock(t0)
        let r = recorder(fakes, folder: folder, speechOn: false, clock: { gate.now })
        try r.start()
        r.pause()
        gate.close()
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))   // the queue holds this one in clock()
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))   // captured during the pause, still queued
        // Opened from elsewhere: before the fix resume() itself waited on the busy track.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { gate.open() }
        r.resume()
        r.drain()
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))   // after the resume: kept
        let files = r.stop()
        let samples = try wavSamples(files[0].1)
        #expect(samples[0..<15_000].allSatisfy { $0 == 0 })
        #expect(samples[17_000..<23_000].contains { $0 != 0 })
    }

    @Test func pauseAndResumeTwiceQuicklyKeepsTheLaterPause() throws {
        let fakes = FakeSources(), folder = tempDir()
        let r = recorder(fakes, folder: folder, speechOn: false)
        try r.start()
        r.pause(); r.resume(); r.pause()
        fakes.made["mic"]!.emit(sineBuffer(seconds: 0.5, channels: 1))
        r.drain()
        #expect(r.isPaused)
        let samples = try wavSamples(r.stop()[0].1)
        #expect(samples.allSatisfy { $0 == 0 })
    }

    @Test func aFailedStartRemovesTheFilesItCreated() throws {
        let fakes = FakeSources(), folder = tempDir()
        fakes.failing["call"] = "tap failed"
        let r = recorder(fakes, folder: folder)
        #expect(throws: RecorderError.self) { try r.start() }
        let left = (try? FileManager.default.contentsOfDirectory(atPath: r.audioFolder.path)) ?? []
        #expect(left.filter { $0.hasSuffix(".wav") }.isEmpty)
    }

    @Test func aSilentTapWhileTheAppPlaysSaysCallAudioIsMissing() async throws {
        let fakes = FakeSources(), folder = tempDir()
        fakes.probes["call"] = { true }
        let r = recorder(fakes, folder: folder)
        try r.start()
        for _ in 0..<21 {
            fakes.made["call"]!.emit(silentBuffer(seconds: 0.5))
            fakes.made["mic"]!.emit(silentBuffer(seconds: 0.5, channels: 1))   // the mic has no probe: never reported
        }
        _ = r.stop()
        #expect(await collect(r.status) == ["Call audio isn't reaching Earshot: check Screen & System Audio Recording in System Settings"])
        #expect(Recorder.callAudioMissing == "Call audio isn't reaching Earshot: check Screen & System Audio Recording in System Settings")
    }

    @Test func stoppingFromATrackQueueDoesNotDeadlock() throws {
        // Stands in for deinit running on a track queue (a callback held the last reference): the clock is
        // read on the mic queue, and here it stops the recorder from there.
        let fakes = FakeSources()
        let box = RecorderBox()
        let t0 = self.t0
        let r = recorder(fakes, folder: tempDir(), speechOn: false, clock: {
            if Thread.isMainThread == false, box.armed { box.armed = false; box.recorder?.stop() }
            return t0
        })
        box.recorder = r
        try r.start()
        box.armed = true
        fakes.made["mic"]!.emit(silentBuffer(seconds: 0.1, channels: 1))
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { r.drain(); done.signal() }
        #expect(done.wait(timeout: .now() + 5) == .success)
        #expect(fakes.made["mic"]?.stopped == true)
        // The rest of that process() call saw the pipeline finished and wrote nothing to the closed file.
        #expect(r.writeErrors.isEmpty)
        box.recorder = nil
    }

    @Test func droppingTheLastReferenceInsideAPipelineCallbackNeverWaits() throws {
        // The recognizer reports its third quick failure on its own thread, inside the mic pipeline's lock.
        // There the last reference goes away while the mic queue is blocked on that lock: deinit must not wait.
        let fakes = FakeSources(), folder = tempDir()
        let box = RecorderBox()
        let engine = FakeSpeech()
        let t0 = self.t0
        box.recorder = Recorder(
            folder: folder, tracks: [(mic, .mic)], captureId: "cap", startedAt: t0, speech: .on { _ in engine },
            makeSource: fakes.make,
            clock: {
                if box.armed {
                    box.armed = false
                    fakes.made["mic"]!.emit(sineBuffer(seconds: 0.1, channels: 1))   // queues behind the lock
                    Thread.sleep(forTimeInterval: 0.1)
                    box.recorder = nil                                                // the last reference
                }
                return t0
            },
            uptime: { 0 })
        try box.recorder!.start()
        for i in 0..<TrackPipeline.maxQuickFailures {
            fakes.made["mic"]!.emit(sineBuffer(seconds: 0.1, channels: 1))
            box.recorder!.drain()
            try #require(engine.sessions.count == i + 1)
            if i == TrackPipeline.maxQuickFailures - 1 { box.armed = true }
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async { engine.sessions[i].fail(); done.signal() }
            try #require(done.wait(timeout: .now() + 3) == .success)
        }
        #expect(box.recorder == nil)
        #expect(fakes.made["mic"]?.stopped == true)
        // The files are finished on the track queue once it is free.
        let url = folder.appendingPathComponent("audio/mic.wav")
        var finalized = false
        for _ in 0..<60 where !finalized {
            if let h = try? WavHeader(url), h.dataSize > 0, Int(h.dataSize) == (try wavSamples(url).count) * 2 { finalized = true }
            else { Thread.sleep(forTimeInterval: 0.05) }
        }
        #expect(finalized)
    }
}

final class RecorderBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _recorder: Recorder?
    private var _armed = false
    var recorder: Recorder? {
        get { lock.lock(); defer { lock.unlock() }; return _recorder }
        set { lock.lock(); let old = _recorder; _recorder = newValue; lock.unlock(); _ = old }   // released outside the lock
    }
    var armed: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _armed }
        set { lock.lock(); _armed = newValue; lock.unlock() }
    }
}
