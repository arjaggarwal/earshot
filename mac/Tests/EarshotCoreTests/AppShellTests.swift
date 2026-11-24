import Foundation
import Testing
@testable import EarshotCore

@Suite struct PromptCopyTests {
    @Test func desktopCallNamesTheApp() {
        #expect(PromptCopy(.desktopCall(.teams)) == PromptCopy(title: "Capture this call?", detail: "Microsoft Teams"))
        #expect(PromptCopy(.desktopCall(.zoom)) == PromptCopy(title: "Capture this call?", detail: "Zoom"))
    }

    @Test func captionsOffAndStopped() {
        #expect(PromptCopy(.captionsOff(meetingId: "m1", title: "Weekly sync", lost: false))
                == PromptCopy(title: "Captions are off in this meeting. Capture with Mac audio?", detail: "Weekly sync"))
        #expect(PromptCopy(.captionsOff(meetingId: "m1", title: "Weekly sync", lost: true))
                == PromptCopy(title: "Captions stopped in this meeting. Capture with Mac audio?", detail: "Weekly sync"))
        // No title, or only spaces: no second line.
        #expect(PromptCopy(.captionsOff(meetingId: "m1", title: nil, lost: false)).detail == nil)
        #expect(PromptCopy(.captionsOff(meetingId: "m1", title: "  ", lost: true)).detail == nil)
    }

    @Test func buttons() {
        #expect(PromptCopy.capture == "Capture")
        #expect(PromptCopy.notNow == "Not now")
    }
}

@Suite struct PromptChangeTests {
    let off = PromptKind.captionsOff(meetingId: "m1", title: "Weekly", lost: false)

    @Test func showUpdateClose() {
        #expect(PromptChange.between(nil, nil) == .none)
        #expect(PromptChange.between(nil, .desktopCall(.zoom)) == .show(.desktopCall(.zoom)))
        #expect(PromptChange.between(.desktopCall(.zoom), .desktopCall(.zoom)) == .none)
        // A desktop call replacing a captions-off prompt: the one window changes, no second window.
        #expect(PromptChange.between(off, .desktopCall(.teams)) == .update(.desktopCall(.teams)))
        // Captions stopped after being off for the same meeting: an update too.
        #expect(PromptChange.between(off, .captionsOff(meetingId: "m1", title: "Weekly", lost: true))
                == .update(.captionsOff(meetingId: "m1", title: "Weekly", lost: true)))
        #expect(PromptChange.between(off, nil) == .close)
    }
}

@Suite struct MenuStateTests {
    @Test func idle() {
        let m = MenuState(recording: false, paused: false, canOpenMeetings: true, openAtLogin: false)
        #expect(m.startEnabled && !m.stopEnabled && !m.pauseEnabled)
        #expect(m.pauseTitle == "Pause")
        #expect(!m.showsRecordingDot)
    }

    @Test func recordingAndPaused() {
        var m = MenuState(recording: true, paused: false, canOpenMeetings: false, openAtLogin: true)
        #expect(!m.startEnabled && m.stopEnabled && m.pauseEnabled)
        #expect(m.showsRecordingDot)
        m.paused = true
        #expect(m.pauseTitle == "Resume")
        // Still a capture in progress: the dot stays (no stealth while paused either).
        #expect(m.showsRecordingDot)
    }

    @Test func titles() {
        #expect(MenuState.startTitle == "Start recording")
        #expect(MenuState.stopTitle == "Stop")
        #expect(MenuState.openMeetingsTitle == "Open meetings")
        #expect(MenuState.openAtLoginTitle == "Open at login")
        #expect(MenuState.quitTitle == "Quit")
    }
}

@Suite struct MeetingsLinkTests {
    let id = "pencjmbpnojhdemhnpcpcpnggjpdlooa"

    @Test func extensionIds() {
        #expect(MeetingsLink.isExtensionId(id))
        #expect(MeetingsLink.isExtensionId(" \(id)\n") == false) // callers trim first
        #expect(!MeetingsLink.isExtensionId("abc"))
        #expect(!MeetingsLink.isExtensionId("zencjmbpnojhdemhnpcpcpnggjpdlooa")) // only a-p
        #expect(!MeetingsLink.isExtensionId("PENCJMBPNOJHDEMHNPCPCPNGGJPDLOOA"))
    }

    @Test func url() {
        #expect(MeetingsLink.url(extensionId: id, meetingId: "teams-desktop-mac-20261104-101500")?.absoluteString
                == "chrome-extension://\(id)/app/meetings.html#teams-desktop-mac-20261104-101500")
        #expect(MeetingsLink.url(extensionId: id, meetingId: nil)?.absoluteString == "chrome-extension://\(id)/app/meetings.html")
        #expect(MeetingsLink.url(extensionId: id, meetingId: "")?.absoluteString == "chrome-extension://\(id)/app/meetings.html")
        // The fragment is escaped (meetings.js decodes it).
        #expect(MeetingsLink.url(extensionId: id, meetingId: "a b#c")?.absoluteString == "chrome-extension://\(id)/app/meetings.html#a%20b%23c")
        #expect(MeetingsLink.url(extensionId: nil, meetingId: "m1") == nil)
        #expect(MeetingsLink.url(extensionId: "nope", meetingId: "m1") == nil)
    }

    @Test func extensionIdFromInfo() {
        #expect(MeetingsLink.extensionId(from: ["EarshotExtensionID": "\(id)\n"]) == id)
        #expect(MeetingsLink.extensionId(from: ["EarshotExtensionID": ""]) == nil)
        #expect(MeetingsLink.extensionId(from: [:]) == nil)
        #expect(MeetingsLink.extensionId(from: nil) == nil)
    }
}

@Suite struct ScreenshotTargetTests {
    func win(_ id: UInt32, _ bundle: String?, layer: Int = 0, onScreen: Bool = true, _ w: Double = 1200, _ h: Double = 800) -> WindowCandidate {
        WindowCandidate(id: id, bundleId: bundle, layer: layer, onScreen: onScreen, width: w, height: h)
    }

    @Test func picksTheCallAppsFrontmostWindow() {
        let windows = [win(1, "us.zoom.xos"), win(2, "com.google.Chrome"), win(3, "us.zoom.xos")]
        // Front to back: 3 is above 1.
        #expect(ScreenshotTarget.pick(windows, frontToBack: [2, 3, 1], prefix: "us.zoom") == 3)
        #expect(ScreenshotTarget.pick(windows, frontToBack: [1, 2, 3], prefix: "us.zoom") == 1)
        // Teams' bundle ids vary in case and suffix.
        #expect(ScreenshotTarget.pick([win(7, "com.microsoft.teams2")], frontToBack: [7], prefix: "com.microsoft.teams") == 7)
    }

    @Test func skipsWhatIsntTheCallWindow() {
        let windows = [
            win(1, "us.zoom.xos", 40, 40),            // a tiny toolbar
            win(2, "us.zoom.xos", layer: 3),          // a floating overlay
            win(3, "us.zoom.xos", onScreen: false),   // minimised
            win(4, nil),
        ]
        #expect(ScreenshotTarget.pick(windows, frontToBack: [1, 2, 3, 4], prefix: "us.zoom") == nil)
        // A window the ordering doesn't list still counts, after the listed ones.
        #expect(ScreenshotTarget.pick([win(5, "us.zoom.xos")], frontToBack: [], prefix: "us.zoom") == 5)
    }

    @Test func noPrefixMeansTheScreen() {
        #expect(ScreenshotTarget.pick([win(1, "us.zoom.xos")], frontToBack: [1], prefix: nil) == nil)
        #expect(ScreenshotTarget.pick([win(1, "us.zoom.xos")], frontToBack: [1], prefix: "") == nil)
    }
}
