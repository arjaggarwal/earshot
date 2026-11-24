import Foundation
import Testing
@testable import EarshotCore

final class FakeAudioSource: AudioClientSource {
    var current: [AudioClient] = []
    func clients() -> [AudioClient] { current }
}

@Suite struct CallWatcherTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    let zoomOn = AudioClient(pid: 501, bundleId: "us.zoom.xos", inputRunning: true)
    let zoomOff = AudioClient(pid: 501, bundleId: "us.zoom.xos", inputRunning: false)

    @Test func callAppFromBundleId() {
        #expect(CallApp(bundleId: "us.zoom.xos") == .zoom)
        #expect(CallApp(bundleId: "us.zoom.ZoomAutoUpdater") == .zoom)
        #expect(CallApp(bundleId: "com.microsoft.teams2") == .teams)
        #expect(CallApp(bundleId: "com.microsoft.teams") == .teams)
        #expect(CallApp(bundleId: "com.microsoft.teams2.helper") == .teams)
        #expect(CallApp(bundleId: "com.google.Chrome") == nil)
        #expect(CallApp(bundleId: "com.microsoft.Outlook") == nil)
        #expect(CallApp(bundleId: "") == nil)
    }

    @Test func zoomInputStartsOnce() {
        let source = FakeAudioSource()
        let watcher = CallWatcher(source: source)
        source.current = [zoomOn]
        #expect(watcher.step(now: at(0)) == [.started(.zoom, 501)])
        #expect(watcher.step(now: at(2)) == [])
        #expect(watcher.step(now: at(4)) == [])
        #expect(watcher.active == [.zoom])
    }

    @Test func offFor19SecondsThenOnIsNoEnd() {
        let source = FakeAudioSource()
        let watcher = CallWatcher(source: source)
        source.current = [zoomOn]
        _ = watcher.step(now: at(0))
        source.current = [zoomOff]
        #expect(watcher.step(now: at(2)) == [])
        #expect(watcher.step(now: at(12)) == [])
        #expect(watcher.step(now: at(21)) == [], "19 s off")
        source.current = [zoomOn]
        #expect(watcher.step(now: at(22)) == [], "same call, no second start")
        // The off clock starts again from zero.
        source.current = [zoomOff]
        #expect(watcher.step(now: at(24)) == [])
        #expect(watcher.step(now: at(43)) == [])
        #expect(watcher.active == [.zoom])
    }

    @Test func offFor20SecondsEnds() {
        let source = FakeAudioSource()
        let watcher = CallWatcher(source: source)
        source.current = [zoomOn]
        _ = watcher.step(now: at(0))
        source.current = [zoomOff]
        #expect(watcher.step(now: at(2)) == [])
        #expect(watcher.step(now: at(22)) == [.ended(.zoom)])
        #expect(watcher.step(now: at(24)) == [], "ends once")
        #expect(watcher.active == [])
        source.current = [zoomOn]
        #expect(watcher.step(now: at(26)) == [.started(.zoom, 501)], "a new run starts again")
    }

    @Test func processGoneCountsAsOff() {
        let source = FakeAudioSource()
        let watcher = CallWatcher(source: source)
        source.current = [zoomOn]
        _ = watcher.step(now: at(0))
        source.current = []
        #expect(watcher.step(now: at(2)) == [])
        #expect(watcher.step(now: at(22)) == [.ended(.zoom)])
    }

    @Test func chromeInputGivesNothing() {
        let source = FakeAudioSource()
        let watcher = CallWatcher(source: source)
        source.current = [AudioClient(pid: 77, bundleId: "com.google.Chrome", inputRunning: true),
                          AudioClient(pid: 88, bundleId: "com.google.Chrome.helper", inputRunning: true)]
        #expect(watcher.step(now: at(0)) == [])
        #expect(watcher.step(now: at(30)) == [])
        #expect(watcher.active == [])
    }

    @Test func teamsAndZoomAreTrackedApart() {
        let source = FakeAudioSource()
        let watcher = CallWatcher(source: source)
        source.current = [AudioClient(pid: 10, bundleId: "com.microsoft.teams2", inputRunning: false),
                          AudioClient(pid: 11, bundleId: "com.microsoft.teams2.helper", inputRunning: true),
                          zoomOff]
        #expect(watcher.step(now: at(0)) == [.started(.teams, 11)])
        source.current.append(zoomOn)
        #expect(watcher.step(now: at(2)) == [.started(.zoom, 501)])
        source.current = [zoomOn]
        #expect(watcher.step(now: at(4)) == [])
        #expect(watcher.step(now: at(24)) == [.ended(.teams)])
        #expect(watcher.active == [.zoom])
    }

    @Test func pollingStreamUsesTheSource() async {
        let source = FakeAudioSource()
        source.current = [zoomOn]
        let watcher = CallWatcher(source: source, poll: 0.05)
        var got: [CallEvent] = []
        for await event in watcher.events() {
            got.append(event)
            break
        }
        #expect(got == [.started(.zoom, 501)])
    }
}
