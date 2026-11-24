import Foundation
import Testing
@testable import EarshotCore

@Suite struct SilentTapWatchTests {
    /// Feeds `n` buffers of 0.1 s; returns how many times the watch fired.
    func feed(_ w: inout SilentTapWatch, _ n: Int, zero: Bool = true, playing: () -> Bool = { true }) -> Int {
        var fired = 0
        for _ in 0..<n where w.feed(allZero: zero, seconds: 0.1, targetPlaying: playing) { fired += 1 }
        return fired
    }

    @Test func tenSecondsOfExactZerosWhileTheTargetPlaysFiresOnce() {
        var w = SilentTapWatch()
        var probes = 0
        let playing = { () -> Bool in probes += 1; return true }
        #expect(feed(&w, 99, playing: playing) == 0)
        #expect(probes == 0)
        #expect(feed(&w, 1, playing: playing) == 1)                      // 10 s
        #expect(feed(&w, 100, playing: playing) == 0)
    }

    @Test func realAudioThenThirtySecondsOfZerosNeverFires() {
        // A muted remote side later in a call: the tap worked, so it is never reported.
        var w = SilentTapWatch()
        #expect(feed(&w, 50) == 0)
        #expect(feed(&w, 1, zero: false) == 0)
        #expect(feed(&w, 300) == 0)
    }

    @Test func aQuietTargetIsNotReportedAndIsAskedAboutOncePerSecond() {
        var w = SilentTapWatch()
        var probes = 0
        var playing = false
        let probe = { () -> Bool in probes += 1; return playing }
        #expect(feed(&w, 100, playing: probe) == 0)
        #expect(probes == 1)
        #expect(feed(&w, 20, playing: probe) == 0)
        #expect(probes == 3)
        playing = true
        #expect(feed(&w, 10, playing: probe) == 1)
    }

    @Test func firesOnlyOncePerCapture() {
        var w = SilentTapWatch()
        #expect(feed(&w, 100) == 1)
        #expect(feed(&w, 1, zero: false) == 0)
        #expect(feed(&w, 300) == 0)
    }
}
