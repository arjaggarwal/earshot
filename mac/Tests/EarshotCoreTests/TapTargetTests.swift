import Foundation
import Testing
@testable import EarshotCore

@Suite struct TapTargetTests {
    let own: pid_t = 500
    let processes = [
        AudioProcess(objectId: 71, pid: 900, bundleId: "com.microsoft.teams2"),
        AudioProcess(objectId: 72, pid: 901, bundleId: "com.microsoft.teams2.helper"),
        AudioProcess(objectId: 73, pid: 902, bundleId: "com.microsoft.teams2.modulehost"),
        AudioProcess(objectId: 80, pid: 950, bundleId: "us.zoom.xos"),
        AudioProcess(objectId: 90, pid: 960, bundleId: "com.google.Chrome.helper"),
        AudioProcess(objectId: 91, pid: 961, bundleId: "com.google.Chrome"),
        AudioProcess(objectId: 95, pid: 500, bundleId: "local.earshot.cli"),
        AudioProcess(objectId: 99, pid: 970, bundleId: ""),
    ]

    @Test func appTargetIncludesEveryProcessWithThePrefix() {
        let s = TapTarget.processes(bundlePrefix: "com.microsoft.teams").selection(from: processes, ownPid: own)
        #expect(s == TapSelection(objectIds: [71, 72, 73], exclusive: false))
    }

    @Test func prefixMatchIgnoresCase() {
        let s = TapTarget.processes(bundlePrefix: "com.google.chrome").selection(from: processes, ownPid: own)
        #expect(s.objectIds == [90, 91] && !s.exclusive)
        #expect(TapTarget.processes(bundlePrefix: "us.zoom").selection(from: processes, ownPid: own).objectIds == [80])
    }

    @Test func appTargetWithNoMatchIsEmptyAndNeverTapsUsOrNamelessProcesses() {
        #expect(TapTarget.processes(bundlePrefix: "com.apple.FaceTime").selection(from: processes, ownPid: own).objectIds.isEmpty)
        #expect(TapTarget.processes(bundlePrefix: "").selection(from: processes, ownPid: own).objectIds.isEmpty)
        #expect(TapTarget.processes(bundlePrefix: "local.earshot").selection(from: processes, ownPid: own).objectIds.isEmpty)
    }

    @Test func systemTargetExcludesOnlyOurOwnProcess() {
        let s = TapTarget.systemExcludingSelf.selection(from: processes, ownPid: own)
        #expect(s == TapSelection(objectIds: [95], exclusive: true))
        #expect(TapTarget.systemExcludingSelf.selection(from: [], ownPid: own) == TapSelection(objectIds: [], exclusive: true))
    }

    @Test func newHelperProcessesChangeTheSelection() {
        let before = TapTarget.processes(bundlePrefix: "com.microsoft.teams").selection(from: processes, ownPid: own)
        let more = processes + [AudioProcess(objectId: 74, pid: 903, bundleId: "com.microsoft.teams2.helper")]
        let after = TapTarget.processes(bundlePrefix: "com.microsoft.teams").selection(from: more, ownPid: own)
        #expect(after.objectIds == [71, 72, 73, 74])
        #expect(after != before)
        // Order and duplicates in the source list don't matter.
        let shuffled = more.reversed() + [processes[0]]
        #expect(TapTarget.processes(bundlePrefix: "com.microsoft.teams").selection(from: Array(shuffled), ownPid: own) == after)
    }

    @Test func labelsNameTheSource() {
        #expect(TapTarget.processes(bundlePrefix: "us.zoom").label == "us.zoom")
        #expect(TapTarget.systemExcludingSelf.label == "the whole Mac")
    }
}

@Suite struct TapStreamsTests {
    let tap = StreamFormat(sampleRate: 48_000, channels: 2, formatID: 0x6C70636D, isFloat: true, bitsPerChannel: 32, isInterleaved: true)
    let headsetMic = StreamFormat(sampleRate: 16_000, channels: 1, formatID: 0x6C70636D, isFloat: true, bitsPerChannel: 32, isInterleaved: true)

    @Test func theOnlyStreamMatchingTheTapIsChosen() {
        #expect(TapStreams.pick([tap], tap: tap) == TapStreamPick(index: 0, bufferRange: 0..<1, exact: true))
    }

    @Test func aClockDeviceInputBeforeTheTapIsSkipped() {
        // A USB or Bluetooth headset as output brings its mic stream into the aggregate.
        #expect(TapStreams.pick([headsetMic, tap], tap: tap) == TapStreamPick(index: 1, bufferRange: 1..<2, exact: true))
        #expect(TapStreams.pick([tap, headsetMic], tap: tap) == TapStreamPick(index: 0, bufferRange: 0..<1, exact: true))
    }

    @Test func withoutAnExactMatchTheLastStreamWithTheTapsChannelCountIsUsed() {
        var resampled = tap
        resampled.sampleRate = 44_100
        let pick = TapStreams.pick([headsetMic, resampled], tap: tap)
        #expect(pick == TapStreamPick(index: 1, bufferRange: 1..<2, exact: false))
        #expect(TapStreams.pick([headsetMic], tap: tap) == TapStreamPick(index: 0, bufferRange: 0..<1, exact: false))
        #expect(TapStreams.pick([], tap: tap) == nil)
    }

    @Test func nonInterleavedStreamsTakeOneBufferPerChannel() {
        var planar = tap
        planar.isInterleaved = false
        var stereoMic = headsetMic
        stereoMic.channels = 2
        stereoMic.isInterleaved = false
        #expect(TapStreams.pick([stereoMic, planar], tap: planar) == TapStreamPick(index: 1, bufferRange: 2..<4, exact: true))
    }
}
