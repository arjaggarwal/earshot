import Foundation
import Testing
@testable import EarshotCore

@Suite struct RequestRotationTests {
    @Test func rmsOfASineIsAmplitudeOverRootTwo() {
        let samples = (0..<16_000).map { Float(0.5 * sin(2 * Double.pi * 440 * Double($0) / 16_000)) }
        #expect(abs(AudioLevel.rms(samples) - 0.5 / Float(2).squareRoot()) < 0.002)
        #expect(AudioLevel.rms([]) == 0)
        #expect(AudioLevel.rms([Float](repeating: 0, count: 100)) == 0)
    }

    @Test func pauseOfOnePointTwoSecondsAfterSpeechRotates() {
        var r = RequestRotation()
        #expect(r.feed(rms: 0.2, seconds: 1.0) == .speech)
        var decisions: [RequestRotation.Decision] = []
        for _ in 0..<11 { decisions.append(r.feed(rms: 0.001, seconds: 0.1)) }   // 1.1 s quiet
        #expect(decisions.allSatisfy { $0 == .silence })
        #expect(r.feed(rms: 0.001, seconds: 0.1) == .rotate(.pause))            // 1.2 s
    }

    @Test func speechInsideThePauseResetsTheQuietRun() {
        var r = RequestRotation()
        _ = r.feed(rms: 0.2, seconds: 0.5)
        _ = r.feed(rms: 0.001, seconds: 1.0)
        #expect(r.feed(rms: 0.2, seconds: 0.1) == .speech)
        #expect(r.feed(rms: 0.001, seconds: 1.1) == .silence)
        #expect(r.feed(rms: 0.001, seconds: 0.1) == .rotate(.pause))
    }

    @Test func quietWithNoSpeechNeverRotatesOnPause() {
        var r = RequestRotation()
        for _ in 0..<100 { #expect(r.feed(rms: 0.0, seconds: 0.5) == .silence) }   // 50 s
    }

    @Test func fiftyFiveSecondsRotatesEvenMidSpeech() {
        var r = RequestRotation()
        for _ in 0..<54 { #expect(r.feed(rms: 0.3, seconds: 1.0) == .speech) }
        #expect(r.feed(rms: 0.3, seconds: 1.0) == .rotate(.maxLength))
        // After a rotation the counts start again.
        r.reset()
        #expect(r.feed(rms: 0.3, seconds: 1.0) == .speech)
    }

    @Test func aSilentRequestStillRotatesAtFiftyFiveSeconds() {
        var r = RequestRotation()
        for _ in 0..<109 { _ = r.feed(rms: 0, seconds: 0.5) }
        #expect(r.feed(rms: 0, seconds: 0.5) == .rotate(.maxLength))
    }

    @Test func thresholdSplitsSpeechFromQuiet() {
        var r = RequestRotation()
        #expect(r.feed(rms: RequestRotation.speechThreshold * 0.9, seconds: 0.1) == .silence)
        #expect(r.feed(rms: RequestRotation.speechThreshold * 1.1, seconds: 0.1) == .speech)
        #expect(RequestRotation.pauseSeconds == 1.2)
        #expect(RequestRotation.maxSeconds == 55)
    }
}
