import Foundation
import Testing
@testable import EarshotCore

@Suite struct PromptPolicyTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    func meeting(_ id: String, _ captions: CaptionState, title: String? = "Weekly", paused: Bool = false) -> BrowserMeeting {
        BrowserMeeting(meetingId: id, tabId: 1, platform: "zoom", title: title, captions: captions,
                       startedAt: "2026-11-04T15:00:00.000Z", paused: paused)
    }

    @Test func desktopCallPrompts() {
        var policy = PromptPolicy()
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(0)) == .desktopCall(.teams))
        #expect(policy.next(calls: [], browser: [], recording: false, now: at(1)) == nil)
    }

    @Test func nothingWhileRecording() {
        // Review Focus 5: something is already recording, so neither kind prompts.
        var policy = PromptPolicy()
        #expect(policy.next(calls: [.zoom], browser: [], recording: true, now: at(0)) == nil)
        #expect(policy.next(calls: [], browser: [meeting("m1", .off)], recording: true, now: at(0)) == nil)
        #expect(policy.next(calls: [.teams, .zoom], browser: [meeting("m1", .lost)], recording: true, now: at(0)) == nil)
        // and once recording stops, the cause prompts again
        #expect(policy.next(calls: [.zoom], browser: [], recording: false, now: at(1)) == .desktopCall(.zoom))
    }

    @Test func desktopCallSuppressedWhileBrowserCaptionsArrive() {
        var policy = PromptPolicy()
        #expect(policy.next(calls: [.teams], browser: [meeting("m1", .arriving)], recording: false, now: at(0)) == nil)
        #expect(policy.next(calls: [.teams], browser: [meeting("m1", .waiting)], recording: false, now: at(1)) == .desktopCall(.teams))
    }

    @Test func captionsOffAndLostPrompt() {
        var policy = PromptPolicy()
        #expect(policy.next(calls: [], browser: [meeting("m1", .off)], recording: false, now: at(0))
                == .captionsOff(meetingId: "m1", title: "Weekly", lost: false))
        #expect(policy.next(calls: [], browser: [meeting("m1", .lost, title: nil)], recording: false, now: at(1))
                == .captionsOff(meetingId: "m1", title: nil, lost: true))
        #expect(policy.next(calls: [], browser: [meeting("m1", .arriving)], recording: false, now: at(2)) == nil)
        #expect(policy.next(calls: [], browser: [meeting("m1", .waiting)], recording: false, now: at(3)) == nil)
    }

    @Test func pausedMeetingNeverPromptsCaptionsOff() {
        var policy = PromptPolicy()
        #expect(policy.next(calls: [], browser: [meeting("m1", .off, paused: true)], recording: false, now: at(0)) == nil)
        #expect(policy.next(calls: [], browser: [meeting("m1", .lost, paused: true)], recording: false, now: at(1)) == nil)
        #expect(policy.next(calls: [], browser: [meeting("m1", .off, paused: true), meeting("m2", .off)], recording: false, now: at(2))
                == .captionsOff(meetingId: "m2", title: "Weekly", lost: false))
    }

    @Test func oneAtATimeDesktopFirst() {
        var policy = PromptPolicy()
        let off = [meeting("m1", .off)]
        #expect(policy.next(calls: [.zoom, .teams], browser: off, recording: false, now: at(0)) == .desktopCall(.teams))
        #expect(policy.next(calls: [.zoom], browser: off, recording: false, now: at(1)) == .desktopCall(.zoom))
        #expect(policy.next(calls: [], browser: off, recording: false, now: at(2)) == .captionsOff(meetingId: "m1", title: "Weekly", lost: false))
        #expect(policy.next(calls: [], browser: [meeting("m1", .off), meeting("m2", .lost)], recording: false, now: at(3))
                == .captionsOff(meetingId: "m1", title: "Weekly", lost: false))
    }

    @Test func dismissedDesktopCallStaysAwayTenMinutesPerApp() {
        var policy = PromptPolicy()
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(0)) == .desktopCall(.teams))
        policy.dismissed(.desktopCall(.teams), at: at(1))
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(2)) == nil)
        // a different app is not snoozed
        #expect(policy.next(calls: [.teams, .zoom], browser: [], recording: false, now: at(3)) == .desktopCall(.zoom))
        // nor are captions-off prompts
        #expect(policy.next(calls: [.teams], browser: [meeting("m1", .off)], recording: false, now: at(4))
                == .captionsOff(meetingId: "m1", title: "Weekly", lost: false))
        // a new mic run of the same app inside the 10 minutes stays quiet
        #expect(policy.next(calls: [], browser: [], recording: false, now: at(100)) == nil)
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(200)) == nil)
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(600)) == nil)
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(601)) == .desktopCall(.teams))
    }

    @Test func dismissedCaptionsOffStaysAwayTenMinutesPerMeeting() {
        var policy = PromptPolicy()
        let both = [meeting("m1", .off), meeting("m2", .off, title: "Other")]
        #expect(policy.next(calls: [], browser: both, recording: false, now: at(0)) == .captionsOff(meetingId: "m1", title: "Weekly", lost: false))
        policy.dismissed(.captionsOff(meetingId: "m1", title: "Weekly", lost: false), at: at(1))
        #expect(policy.next(calls: [], browser: both, recording: false, now: at(2)) == .captionsOff(meetingId: "m2", title: "Other", lost: false))
        // off turning into lost is the same meeting: still snoozed
        #expect(policy.next(calls: [], browser: [meeting("m1", .lost)], recording: false, now: at(300)) == nil)
        #expect(policy.next(calls: [], browser: [meeting("m1", .lost)], recording: false, now: at(601))
                == .captionsOff(meetingId: "m1", title: "Weekly", lost: true))
    }

    @Test func micOnOffOnGivesOnePromptPerRunWithdrawnInBetween() {
        // Review Focus 1: Teams opens the mic for a device test, closes it within 5 s, opens it again.
        var policy = PromptPolicy()
        let first = policy.next(calls: [.teams], browser: [], recording: false, now: at(0))
        #expect(first == .desktopCall(.teams))
        // polling during the same run keeps the one prompt, it doesn't raise another
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(2)) == first)
        // mic off within 5 s: the prompt is withdrawn (the window closes)
        #expect(policy.next(calls: [], browser: [], recording: false, now: at(4)) == nil)
        // on again: a withdrawn prompt is not a dismissal, so the new run gets its one prompt
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(6)) == .desktopCall(.teams))
        // Not now, then the same dance again inside 10 minutes: nothing
        policy.dismissed(.desktopCall(.teams), at: at(7))
        #expect(policy.next(calls: [], browser: [], recording: false, now: at(9)) == nil)
        #expect(policy.next(calls: [.teams], browser: [], recording: false, now: at(11)) == nil)
    }

    @Test func causeGoneReturnsNil() {
        var policy = PromptPolicy()
        #expect(policy.next(calls: [], browser: [meeting("m1", .off)], recording: false, now: at(0)) != nil)
        #expect(policy.next(calls: [], browser: [], recording: false, now: at(1)) == nil, "meeting left the browser state")
        #expect(policy.next(calls: [.zoom], browser: [], recording: false, now: at(2)) != nil)
        #expect(policy.next(calls: [.zoom], browser: [meeting("m2", .arriving)], recording: false, now: at(3)) == nil, "captions arrived elsewhere")
    }
}

/// CallWatcher's active set feeding PromptPolicy, as the app wires them (Review Focus 1 end to end).
@Suite struct CallWatcherFeedsPromptPolicyTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func deviceTestOnOffOnGivesOnePromptWithdrawnWhenTheCallEnds() {
        let source = FakeAudioSource()
        let watcher = CallWatcher(source: source)
        var policy = PromptPolicy()
        let teams = { (on: Bool) in [AudioClient(pid: 42, bundleId: "com.microsoft.teams2", inputRunning: on)] }
        var shown: [PromptKind?] = []
        // One poll every 2 s: on at 0, off within 5 s (at 4), on again at 8, then off for good from 12.
        for s in stride(from: 0.0, through: 40, by: 2) {
            let on = s < 4 || (s >= 8 && s < 12)
            source.current = teams(on)
            _ = watcher.step(now: t0.addingTimeInterval(s))
            shown.append(policy.next(calls: watcher.active, browser: [], recording: false, now: t0.addingTimeInterval(s)))
        }
        let prompt = PromptKind.desktopCall(.teams)
        // The quick off/on doesn't end the call, so the one prompt stays up through it...
        #expect(shown[0...15].allSatisfy { $0 == prompt }, "\(shown)")
        // ...and it's withdrawn once the watcher reports the call ended (20 s off from the poll at 12).
        #expect(watcher.active == [])
        #expect(shown[16...].allSatisfy { $0 == nil }, "\(shown)")
    }
}
