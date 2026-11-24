import AVFAudio
import Foundation
import Testing
@testable import EarshotCore

@Suite struct TrackPipelineTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let mic = Track(id: "mic", speaker: "Alex")

    func make(speech: SpeechEngine?, clock: TestClock, sink: Sink, policy: ChannelPolicy = .first,
              writer: ((URL) throws -> TrackFile)? = nil, uptime: TestClock? = nil) throws -> (TrackPipeline, URL) {
        // Uptime (the monotonic clock behind stall padding) follows the wall clock unless a test splits them.
        let up = uptime ?? clock
        let url = tempDir().appendingPathComponent("audio/mic.wav")
        let file = try writer?(url) ?? TrackWriter(url: url, now: clock.now)
        let p = TrackPipeline(track: mic, captureId: "cap", startedAt: t0, writer: file,
                              channels: policy, speech: speech, clock: { clock.now },
                              uptime: { up.now.timeIntervalSince1970 },
                              onSegment: { sink.seg($0) }, onLevel: { sink.level($0) }, onLiveTextOff: { _ in sink.off() },
                              onWriteFailed: { sink.writeFailed($0) })
        return (p, url)
    }

    /// Feeds `seconds` of audio in 0.1 s chunks, moving the clock with it.
    func feed(_ p: TrackPipeline, _ clock: TestClock, seconds: Double, loud: Bool) {
        for _ in 0..<Int((seconds * 10).rounded()) {
            p.process(loud ? sineBuffer(seconds: 0.1, amplitude: 0.4) : silentBuffer(seconds: 0.1))
            clock.advance(0.1)
        }
    }

    @Test func writesTheTrackAndReportsLevelsWithoutSpeech() throws {
        let clock = TestClock(t0), sink = Sink()
        let (p, url) = try make(speech: nil, clock: clock, sink: sink)
        feed(p, clock, seconds: 2, loud: true)
        #expect(p.finish() == url)
        #expect(abs(Double(try AVAudioFile(forReading: url).length) / 16_000 - 2) < 0.01)
        // The resampler hands back output in blocks (it works on 4096-frame packets), so not every 0.1 s
        // chunk yields a level, and output trails input by up to one block (~85 ms) until finish().
        #expect(sink.levels.count >= 10)
        #expect(abs(sink.levels[5] - 0.4 / Float(2).squareRoot()) < 0.01)
        #expect(sink.segments.isEmpty)
    }

    @Test func feedsSpeechSixteenKMonoAndMapsResultsToSegments() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 1, loud: true)
        #expect(speech.sessions.count == 1)
        let s = speech.sessions[0]
        #expect(abs(s.framesAppended - 16_000) <= 1_400)
        #expect(s.formats.allSatisfy { $0.sampleRate == 16_000 && $0.channelCount == 1 && $0.commonFormat == .pcmFormatFloat32 })
        s.partial("hello")
        s.partial("hello there")
        #expect(sink.segments.map(\.id) == ["mac-cap-mic-1", "mac-cap-mic-1"])
        #expect(sink.segments.last?.text == "hello there" && sink.segments.last?.speaker == "Alex")
        _ = p.finish()
    }

    @Test func aPauseInSpeechEndsTheRequestStartsTheNextAndTheOldFinalCompletesItsLine() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 1, loud: true)
        speech.sessions[0].partial("first line")
        feed(p, clock, seconds: 1.0, loud: false)
        #expect(speech.sessions.count == 1 && !speech.sessions[0].ended)
        feed(p, clock, seconds: 0.4, loud: false)                       // past 1.2 s of quiet, allowing a block
        try #require(speech.sessions.count == 2)
        #expect(speech.sessions[0].ended)
        speech.sessions[0].final("First line.")
        feed(p, clock, seconds: 0.5, loud: true)
        speech.sessions[1].partial("second")
        #expect(sink.segments.map(\.id) == ["mac-cap-mic-1", "mac-cap-mic-1", "mac-cap-mic-2"])
        #expect(sink.segments[1].text == "First line.")
        _ = p.finish()
    }

    @Test func fiftyFiveSecondsRotatesAndHoldsTheNewRequestUntilTheOldOneFinishes() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 54.5, loud: true)
        speech.sessions[0].partial("a long monologue")
        feed(p, clock, seconds: 0.7, loud: true)
        try #require(speech.sessions.count == 2)
        #expect(speech.sessions[0].ended)
        speech.sessions[1].partial("next words")                        // arrives before the old final
        #expect(sink.segments.count == 1)
        speech.sessions[0].final("A long monologue, finished.")
        #expect(sink.segments.map(\.text) == ["a long monologue", "A long monologue, finished.", "next words"])
        #expect(sink.segments.map(\.id) == ["mac-cap-mic-1", "mac-cap-mic-1", "mac-cap-mic-2"])
        _ = p.finish()
    }

    @Test func anOldRequestThatNeverFinishesIsClosedWithItsLastTextAfterTwoSeconds() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 54, loud: true)
        speech.sessions[0].partial("words before the cut")
        feed(p, clock, seconds: 1.2, loud: true)
        try #require(speech.sessions.count == 2)
        speech.sessions[1].partial("after")
        feed(p, clock, seconds: 1.5, loud: true)
        #expect(sink.segments.count == 1)
        feed(p, clock, seconds: 1, loud: true)
        #expect(sink.segments.map(\.text) == ["words before the cut", "words before the cut", "after"])
        #expect(sink.segments.map(\.id) == ["mac-cap-mic-1", "mac-cap-mic-1", "mac-cap-mic-2"])
        _ = p.finish()
    }

    @Test func pauseDropsAudioAndLinesAndResumeStartsAFreshRequest() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, url) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 1, loud: true)
        speech.sessions[0].partial("before")
        p.pause()
        #expect(speech.sessions[0].cancelled)
        #expect(sink.segments.map(\.text) == ["before", "before"])      // the open line is closed at the pause
        let fedBefore = speech.sessions[0].framesAppended
        feed(p, clock, seconds: 2, loud: true)                          // said while paused
        speech.sessions[0].partial("secret")
        speech.sessions[0].final("Secret.")
        #expect(speech.sessions.count == 1 && speech.sessions[0].framesAppended == fedBefore)
        #expect(sink.segments.count == 2)
        p.resume()
        feed(p, clock, seconds: 1, loud: true)
        try #require(speech.sessions.count == 2)
        speech.sessions[1].partial("after")
        #expect(sink.segments.map(\.id) == ["mac-cap-mic-1", "mac-cap-mic-1", "mac-cap-mic-2"])
        _ = p.finish()

        // The paused stretch is in the file as silence, so file time still matches wall time for Whisper.
        let samples = try wavSamples(url)
        #expect(abs(samples.count - 64_000) <= 48)
        #expect(samples[17_000..<47_000].allSatisfy { $0 == 0 })
        #expect(samples[1000..<15_000].contains { $0 != 0 } && samples[50_000..<63_000].contains { $0 != 0 })
    }

    @Test func aRequestThatFinishesOnItsOwnIsReplacedOnTheNextBuffer() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 3, loud: true)
        speech.sessions[0].final("Done.")
        feed(p, clock, seconds: 0.2, loud: true)
        try #require(speech.sessions.count == 2)
        // A failure after enough audio (a recognizer hiccup) just starts the next request.
        feed(p, clock, seconds: 3, loud: true)
        speech.sessions[1].fail()
        feed(p, clock, seconds: 0.2, loud: true)
        #expect(speech.sessions.count == 3 && sink.liveOff == 0)
        _ = p.finish()
    }

    @Test func requestsThatFailRightAwayTurnLiveTextOffButRecordingGoesOn() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        speech.failImmediately = true
        let (p, url) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 3, loud: true)
        #expect(speech.sessions.count == TrackPipeline.maxQuickFailures)
        #expect(sink.liveOff == 1)
        #expect(sink.segments.isEmpty)
        _ = p.finish()
        #expect(abs(Double(try AVAudioFile(forReading: url).length) / 16_000 - 3) < 0.01)
    }

    /// "No speech detected" (silence, e.g. while AirPods switch to their mic) counted as a failure,
    /// and three in a row switched the mic's live text off for the whole recording.
    @Test func noSpeechIsNotAFailureAndLiveTextStaysOn() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        speech.noSpeechImmediately = true
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 3, loud: true)
        #expect(sink.liveOff == 0)
        #expect(speech.sessions.count > TrackPipeline.maxQuickFailures)
        // Speech that comes later still becomes a line.
        speech.noSpeechImmediately = false
        feed(p, clock, seconds: 0.2, loud: true)
        speech.sessions.last!.partial("finally talking")
        #expect(sink.segments.last?.text == "finally talking")
        _ = p.finish()
    }

    /// A silent call track started a request every 0.1 s, each answered "No speech detected"
    /// at once, and the flood starved the mic's recognizer. Silence starts no request.
    @Test func silenceStartsNoRequestUntilThereIsSound() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        speech.noSpeechImmediately = true
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 3, loud: false)
        #expect(speech.sessions.isEmpty)
        speech.noSpeechImmediately = false
        feed(p, clock, seconds: 0.2, loud: true)
        #expect(speech.sessions.count == 1)
        _ = p.finish()
    }

    @Test func finishClosesTheOpenLineAndCancelsTheRequest() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 1, loud: true)
        speech.sessions[0].partial("last words")
        _ = p.finish()
        #expect(speech.sessions[0].cancelled)
        #expect(sink.segments.map(\.text) == ["last words", "last words"])
        speech.sessions[0].final("Last words.")                        // too late: ignored
        #expect(sink.segments.count == 2)
    }

    @Test func aRequestThatFailsKeepsItsWordsOnTheirOwnLine() throws {
        let clock = TestClock(t0), sink = Sink(), speech = FakeSpeech()
        let (p, _) = try make(speech: speech, clock: clock, sink: sink)
        feed(p, clock, seconds: 3, loud: true)
        speech.sessions[0].partial("words so far")
        speech.sessions[0].fail()
        feed(p, clock, seconds: 0.2, loud: true)
        try #require(speech.sessions.count == 2)
        speech.sessions[1].partial("new words")
        #expect(sink.segments.map(\.text) == ["words so far", "words so far", "new words"])
        #expect(sink.segments.map(\.id) == ["mac-cap-mic-1", "mac-cap-mic-1", "mac-cap-mic-2"])
        p.finish()
    }

    @Test func aWriteFailureIsReportedOnceAndTheFileKeepsWhatWasWritten() throws {
        let clock = TestClock(t0), sink = Sink()
        let (p, url) = try make(speech: nil, clock: clock, sink: sink,
                                writer: { try FailingWriter(url: $0, now: self.t0, failAfter: 5) })
        feed(p, clock, seconds: 2, loud: true)
        #expect(sink.writeFailures == ["No space left on device"])
        #expect(p.finish() == url)
        #expect(p.writeError != nil)
        // The header was still written on close, so the partial file is readable.
        let h = try WavHeader(url)
        let written = try wavSamples(url).count
        #expect(h.dataSize > 0 && h.dataSize == UInt32(written * 2))
    }

    @Test func aStallLongerThanHalfASecondIsPaddedWithSilence() throws {
        let clock = TestClock(t0), sink = Sink()
        let (p, url) = try make(speech: nil, clock: clock, sink: sink)
        feed(p, clock, seconds: 1, loud: true)
        clock.advance(3)                                               // the mic engine restarts: no audio
        feed(p, clock, seconds: 1, loud: true)
        p.finish()
        let samples = try wavSamples(url)
        #expect(abs(Double(samples.count) / 16_000 - 4.9) < 0.15)       // file time follows wall time again
        #expect(samples[20_000..<60_000].allSatisfy { $0 == 0 })
        #expect(samples[70_000..<76_000].contains { $0 != 0 })
        // Short jitter (under 0.5 s) is not padded.
        let clock2 = TestClock(t0)
        let (q, url2) = try make(speech: nil, clock: clock2, sink: Sink())
        feed(q, clock2, seconds: 1, loud: true)
        clock2.advance(0.4)
        feed(q, clock2, seconds: 1, loud: true)
        q.finish()
        #expect(abs(Double(try wavSamples(url2).count) / 16_000 - 2) < 0.01)
    }

    @Test func aSilentTapWithAPlayingTargetIsReportedAfterTenSeconds() throws {
        let clock = TestClock(t0), sink = Sink()
        let (p, _) = try make(speech: nil, clock: clock, sink: sink, policy: .mixdown)
        let probes = Counter()
        p.watchForSilentTap(probe: { probes.bump(); return true }, onSilent: { sink.off() })
        feed(p, clock, seconds: 9.5, loud: false)
        #expect(sink.liveOff == 0 && probes.value == 0)
        feed(p, clock, seconds: 1, loud: false)
        #expect(sink.liveOff == 1)
        feed(p, clock, seconds: 5, loud: false)
        #expect(sink.liveOff == 1)
        p.finish()
    }

    /// Feeds 0.1 s chunks, moving the wall clock and uptime together.
    func feed(_ p: TrackPipeline, wall: TestClock, up: TestClock, seconds: Double) {
        for _ in 0..<Int((seconds * 10).rounded()) {
            p.process(sineBuffer(seconds: 0.1, amplitude: 0.4))
            wall.advance(0.1)
            up.advance(0.1)
        }
    }

    @Test func aWallClockJumpIsNotAStall() throws {
        // Sleep/wake or an NTP step moves Date() but not uptime: nothing is padded.
        let wall = TestClock(t0), up = TestClock(t0)
        let (p, url) = try make(speech: nil, clock: wall, sink: Sink(), uptime: up)
        feed(p, wall: wall, up: up, seconds: 1)
        wall.advance(3 * 3600)
        feed(p, wall: wall, up: up, seconds: 1)
        p.finish()
        #expect(abs(Double(try wavSamples(url).count) / 16_000 - 2) < 0.01)
    }

    @Test func oneLongStallIsPaddedAtMostThirtySeconds() throws {
        let wall = TestClock(t0), up = TestClock(t0)
        let (p, url) = try make(speech: nil, clock: wall, sink: Sink(), uptime: up)
        feed(p, wall: wall, up: up, seconds: 1)
        up.advance(120)
        wall.advance(120)
        feed(p, wall: wall, up: up, seconds: 1)
        feed(p, wall: wall, up: up, seconds: 1)                             // and not again afterwards
        p.finish()
        #expect(abs(Double(try wavSamples(url).count) / 16_000 - 33) < 0.15)
    }

    @Test func aProcessingBacklogIsNotAStall() throws {
        // Buffers stamped when the source handed them over, processed 5 s late: still no padding.
        let wall = TestClock(t0), up = TestClock(t0)
        let (p, url) = try make(speech: nil, clock: wall, sink: Sink(), uptime: up)
        up.advance(5)
        wall.advance(5)
        for i in 0..<20 {
            p.process(sineBuffer(seconds: 0.1, amplitude: 0.4), capturedAt: t0.timeIntervalSince1970 + Double(i + 1) * 0.1)
        }
        p.finish()
        #expect(abs(Double(try wavSamples(url).count) / 16_000 - 2) < 0.01)
    }
}
