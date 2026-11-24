import Foundation
import Testing
@testable import EarshotCore

let isoMs = #/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/#

@Suite @MainActor struct DesktopSessionTests {
    @Test func captureOnATeamsPromptSavesANewRecordThenRecordsIntoItsFolder() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))

        // The record is saved first; its audio goes where the helper says.
        let ops = rig.helper.ops()
        let save = try #require(ops.firstIndex(of: "save-meeting"))
        let folderAt = try #require(ops.firstIndex(of: "meeting-folder"))
        #expect(save < folderAt)
        let saved = try #require(rig.helper.payloads("save-meeting").first)
        #expect(saved["base"] is NSNull)
        let record = try #require(saved["meeting"] as? [String: Any])
        let id = try #require(record["id"] as? String)
        #expect(id.wholeMatch(of: #/teams-desktop-mac-\d{8}-\d{6}/#) != nil)
        #expect(record["platform"] as? String == "teams-desktop")
        #expect(record["endedAt"] is NSNull)
        #expect((record["startedAt"] as? String)?.wholeMatch(of: isoMs) != nil)
        #expect((record["updatedAt"] as? String)?.wholeMatch(of: isoMs) != nil)
        #expect(ISOTime.date(record["startedAt"] as! String) == rig.now)
        #expect((record["segments"] as? [Any])?.isEmpty == true)
        #expect(JSONSerialization.isValidJSONObject(record))

        // One capture id, chosen at the start and handed to the recorder.
        let request = rig.recorder.request
        #expect(request.captureId == SegmentIds.captureId(for: rig.now))
        #expect(request.startedAt == rig.now)
        #expect(request.folder.path == rig.helper.folders[id]?.path)
        #expect(request.tracks.map(\.0) == [Track(id: "mic", speaker: "Alex"), Track(id: "call", speaker: "Call")])
        #expect(request.tracks.map(\.1) == [.mic, .tap(.processes(bundlePrefix: "com.microsoft.teams"))])
        #expect(rig.recorder.started)

        #expect(rig.shell.recording)
        #expect(rig.shell.screenshotApp == "com.microsoft.teams")
        #expect(rig.panel.started.first?["id"] as? String == id)
        #expect(rig.panel.startStatuses.first??["level"] as? String == "live")

        let active = try #require(rig.activeJSON())
        #expect(active["meetingId"] as? String == id)
        #expect(active["captureId"] as? String == request.captureId)
        #expect(active["kind"] as? String == "desktop")
        #expect(active["folder"] as? String == request.folder.path)
        #expect(active["startedAt"] as? String == record["startedAt"] as? String)
        #expect((active["tracks"] as? [[String: Any]])?.map { $0["speaker"] as? String } == ["Alex", "Call"])

        // Live lines go to the panel as they come.
        rig.recorder.emit("mic", 1, "Hi there", at: 1_800_000_001_000)
        rig.recorder.emit("call", 1, "Hello", at: 1_800_000_002_000)
        try await rig.until("two lines") { rig.panel.segmentCalls.count == 2 }
        #expect(rig.panel.segmentCalls.flatMap { $0 }.map(\.speaker) == ["Alex", "Call"])
    }

    @Test func zoomTapsEveryZoomProcess() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.zoom))
        let record = try #require(rig.helper.payloads("save-meeting").first?["meeting"] as? [String: Any])
        #expect(record["platform"] as? String == "zoom-desktop")
        #expect((record["id"] as? String)?.hasPrefix("zoom-desktop-mac-") == true)
        #expect(rig.recorder.request.tracks.map(\.1) == [.mic, .tap(.processes(bundlePrefix: "us.zoom"))])
        #expect(rig.shell.screenshotApp == "us.zoom")
    }

    @Test func theCallEndingEndsTheCapture() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        await rig.controller.tick(calls: [.teams], browser: [])
        #expect(rig.controller.session?.phase == .running)
        // Another app's call ending changes nothing.
        await rig.controller.tick(calls: [.teams], browser: [])
        #expect(!rig.recorder.isStopped)
        await rig.controller.tick(calls: [], browser: [])
        await rig.controller.settled()
        #expect(rig.recorder.isStopped)
        #expect(rig.panel.endedCount == 1)
        #expect(rig.controller.session == nil)
    }

    @Test func endingStopsThenWritesTheFullTranscriptThenReplacesThenEnds() async throws {
        let rig = try Rig()
        let whisper = [seg("mac-x-mic-1", "mic", "Hi there.", at: 1_800_000_001_000)]
        rig.transcriber.result = .success(whisper)
        await rig.controller.capture(.desktopCall(.teams))
        rig.panel.segmentDelay = 20_000_000 // a slow page: the last lines are still on their way at Stop
        rig.recorder.emit("mic", 1, "Hi there", at: 1_800_000_001_000)
        rig.recorder.emit("call", 1, "Hello", at: 1_800_000_002_000)
        rig.recorder.emit("mic", 2, "Bye", at: 1_800_000_003_000)
        let captureId = rig.recorder.request.captureId
        let folder = rig.recorder.request.folder
        rig.advance(600)
        await rig.controller.stop()

        let log = rig.log.all
        let stop = try #require(log.firstIndex(of: "recorder.stop"))
        #expect(log.filter { $0.hasPrefix("panel.segments") }.count == 3)
        let lastLine = try #require(log.lastIndex { $0.hasPrefix("panel.segments") })
        let writing = try #require(log.firstIndex(of: "panel.status:waiting:Writing the full transcript…"))
        let whisperAt = try #require(log.firstIndex(of: "whisper"))
        let finish = try #require(log.firstIndex { $0.hasPrefix("panel.finish:") })
        #expect(stop < writing && lastLine < writing && writing < whisperAt && whisperAt < finish)
        #expect(log.firstIndex(of: "shell.recording:false")! < whisperAt)
        #expect(rig.panel.statuses.first { $0.text == SessionController.writingStatus }?.meetingId == rig.panel.started.first?["id"] as? String)

        let run = try #require(rig.transcriber.runs.first)
        #expect(run.captureId == captureId)
        #expect(run.startedAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(run.model == "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin")
        #expect(run.tracks.map(\.0) == [Track(id: "mic", speaker: "Alex"), Track(id: "call", speaker: "Call")])
        #expect(run.tracks.map(\.1.path) == [folder.appendingPathComponent("audio/mic.wav").path, folder.appendingPathComponent("audio/call.wav").path])
        // Ended by its id: Whisper's lines and the moment Stop was pressed.
        let finished = try #require(rig.panel.finished.first)
        #expect(finished.meeting["id"] as? String == rig.panel.started.first?["id"] as? String)
        #expect(finished.segments == whisper)
        #expect(finished.endedAt == ISOTime.string(Date(timeIntervalSince1970: 1_800_000_600)))
        #expect(finished.rename == nil)
        #expect(rig.activeJSON() == nil)
        #expect(rig.finishingFiles().isEmpty)
        #expect(!rig.shell.recording)
        #expect(rig.controller.session == nil)
    }

    @Test func aWhisperFailureKeepsTheLiveLinesAndShowsTheError() async throws {
        let rig = try Rig()
        rig.transcriber.result = .failure(Boom(description: "whisper-cli not found"))
        await rig.controller.capture(.desktopCall(.zoom))
        rig.recorder.emit("mic", 1, "Live words", at: 1_800_000_001_000)
        await rig.controller.stop()
        #expect(rig.panel.finished.first.map { $0.segments == nil } == true)
        let problem = try #require(rig.panel.statuses.last)
        #expect(problem.level == "problem")
        #expect(problem.text.contains("whisper-cli not found"))
        #expect(problem.text.contains("live lines are kept"))
        // Shown for a while before the ended panel replaces it.
        #expect(rig.sleeps == [SessionController.errorHold])
        let log = rig.log.all
        #expect(log.firstIndex { $0.hasPrefix("panel.status:problem") }! < log.firstIndex { $0.hasPrefix("panel.finish:") }!)
        #expect(rig.panel.endedCount == 1)
        #expect(rig.shell.errors.contains { $0.contains("whisper-cli not found") })
        #expect(rig.activeJSON() == nil)
    }

    @Test func aFolderRenamedMidCallIsFoundAgainForWhisper() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        let id = rig.controller.session!.meetingId
        // The title changed, so the helper moved the folder (open files move with it).
        let old = rig.helper.folders[id]!
        let moved = rig.home.appendingPathComponent("meetings/2026/November/renamed")
        try FileManager.default.moveItem(at: old, to: moved)
        rig.helper.folders[id] = moved
        await rig.controller.stop()
        #expect(rig.transcriber.runs.first?.tracks.map(\.1.path) == [moved.appendingPathComponent("audio/mic.wav").path, moved.appendingPathComponent("audio/call.wav").path])
    }

    @Test func aRecorderThatCantStartLeavesNoRecordAndSaysWhy() async throws {
        let rig = try Rig()
        rig.failRecorderStart = Boom(description: "Could not start the microphone (mic track): denied")
        await rig.controller.capture(.desktopCall(.teams))
        #expect(rig.controller.session == nil)
        #expect(!rig.shell.recording)
        #expect(rig.helper.ops().contains("delete-meeting"))
        #expect(rig.helper.meetings.isEmpty)
        #expect(rig.shell.errors.first?.contains("denied") == true)
        #expect(rig.activeJSON() == nil)
        #expect(rig.panel.started.isEmpty)
    }

    @Test func aPanelThatFailsStillLeavesTheRedDotOn() async throws {
        let rig = try Rig()
        rig.panel.failStart = Boom(description: "panel didn't load")
        await rig.controller.capture(.desktopCall(.teams))
        #expect(rig.controller.session?.phase == .running)
        #expect(rig.shell.recording)
        #expect(rig.recorder.started && !rig.recorder.isStopped)
        #expect(rig.shell.errors.first?.contains("panel didn't load") == true)
    }

    @Test func aReloadedPanelGetsTheMeetingAgainWithItsLiveLines() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        rig.recorder.emit("mic", 1, "Before the crash", at: 1_800_000_001_000)
        try await rig.until("the line") { rig.panel.segmentCalls.count == 1 }
        // Another meeting's minutes were waiting in the page that died.
        let ended = ISOTime.string(rig.now.addingTimeInterval(-60))
        rig.helper.rows = [["id": "zoom-desktop-mac-1", "platform": "zoom-desktop", "endedAt": ended, "hasMinutes": false]]
        rig.helper.setMeeting(["id": "zoom-desktop-mac-1", "endedAt": ended, "minutes": NSNull()])
        await rig.controller.panelReloaded()
        #expect(rig.panel.started.count == 2)
        try await rig.until("minutes resumed") { rig.panel.finished.count == 1 }
        #expect(rig.panel.finished[0].meeting["id"] as? String == "zoom-desktop-mac-1")
        let again = rig.panel.started[1]
        #expect(again["id"] as? String == rig.controller.session?.meetingId)
        #expect((again["segments"] as? [[String: Any]])?.first?["text"] as? String == "Before the crash")
        #expect(JSONSerialization.isValidJSONObject(again))
    }
}

@Suite @MainActor struct ManualSessionTests {
    @Test func startRecordsTheMicAndTheWholeMacAsAMacMeeting() async throws {
        let rig = try Rig()
        await rig.controller.startManual()
        let record = try #require(rig.helper.payloads("save-meeting").first?["meeting"] as? [String: Any])
        #expect(record["platform"] as? String == "mac")
        #expect((record["id"] as? String)?.wholeMatch(of: #/mac-mac-\d{8}-\d{6}/#) != nil)
        #expect(rig.recorder.request.tracks.map(\.0) == [Track(id: "mic", speaker: "Speaker"), Track(id: "system", speaker: "Call")])
        #expect(rig.recorder.request.tracks.map(\.1) == [.mic, .tap(.systemExcludingSelf)])
        #expect(rig.shell.screenshotApp == nil)
        #expect(rig.activeJSON()?["kind"] as? String == "manual")
        #expect(rig.shell.recording)
    }

    @Test func theMicIsSpeakerUntilTheMacAudioSpeaksThenItIsMyName() async throws {
        let rig = try Rig()
        await rig.controller.startManual()
        rig.recorder.emit("mic", 1, "In the room", at: 1_800_000_001_000)
        try await rig.until("the mic line") { rig.panel.segmentCalls.count == 1 }
        #expect(rig.panel.segmentCalls[0][0].speaker == "Speaker")
        #expect(rig.panel.renames.isEmpty)
        rig.recorder.emit("system", 1, "From the speakers", at: 1_800_000_002_000)
        rig.recorder.emit("system", 2, "More", at: 1_800_000_003_000)
        try await rig.until("the system lines") { rig.panel.segmentCalls.count == 3 }
        #expect(rig.panel.renames.map { "\($0.0)=\($0.1)" } == ["mic=Alex"])
        let log = rig.log.all
        #expect(log.firstIndex(of: "panel.rename:mic=Alex")! < log.firstIndex(of: "panel.segments:From the speakers")!)
        // Whisper labels the mic with the name too.
        await rig.controller.stop()
        #expect(rig.transcriber.runs.first?.tracks.map(\.0.speaker) == ["Alex", "Call"])
    }

    @Test func withNoMacAudioTheMicStaysSpeakerThroughWhisper() async throws {
        let rig = try Rig()
        rig.transcriber.result = .success([seg("mac-x-mic-1", "mic", "Room talk", at: 1_800_000_001_000, speaker: "Speaker")])
        await rig.controller.startManual()
        await rig.controller.stop()
        #expect(rig.panel.renames.isEmpty)
        #expect(rig.transcriber.runs.first?.tracks.map(\.0.speaker) == ["Speaker", "Call"])
    }

    @Test func whisperFindingMacAudioThatLiveTextMissedRenamesTheMic() async throws {
        let rig = try Rig()
        rig.transcriber.result = .success([seg("mac-x-system-1", "system", "A video", at: 1_800_000_001_000, speaker: "Call")])
        await rig.controller.startManual()
        await rig.controller.stop()
        // Named with the ending (by id), not on whatever meeting the panel shows by then.
        #expect(rig.panel.renames.isEmpty)
        #expect(rig.panel.finished.first?.rename == SpeakerRename(speakerId: "mic", name: "Alex"))
    }

    @Test func onlyStopEndsIt() async throws {
        let rig = try Rig()
        await rig.controller.startManual()
        await rig.controller.tick(calls: [.teams], browser: [])
        await rig.controller.tick(calls: [], browser: [])
        rig.advance(3600)
        await rig.controller.tick(calls: [], browser: [])
        #expect(rig.controller.session?.phase == .running)
        await rig.controller.stop()
        #expect(rig.controller.session == nil)
        #expect(rig.panel.endedCount == 1)
    }
}

@Suite @MainActor struct CaptionsOffSessionTests {
    let meetingId = "zoom-8812345-20261104-150000"
    var kind: PromptKind { .captionsOff(meetingId: meetingId, title: "Weekly", lost: false) }

    @Test func recordsTheMicAndChromeIntoTheBrowserMeetingWithNoPanel() async throws {
        let rig = try Rig()
        await rig.controller.capture(kind)
        #expect(!rig.helper.ops().contains("save-meeting"))
        #expect(rig.helper.payloads("meeting-folder").first?["id"] as? String == meetingId)
        #expect(rig.panel.started.isEmpty)
        let request = rig.recorder.request
        #expect(request.tracks.map(\.0) == [Track(id: "mic", speaker: "Alex"), Track(id: "browser", speaker: "Meeting audio")])
        #expect(request.tracks.map(\.1) == [.mic, .tap(.processes(bundlePrefix: "com.google.chrome"))])
        #expect(rig.shell.screenshotApp == "com.google.chrome")
        #expect(rig.shell.recording)
        #expect(rig.activeJSON()?["kind"] as? String == "captions-off")
        #expect(rig.activeJSON()?["meetingId"] as? String == meetingId)
    }

    @Test func linesGoToTheSegmentFileWhileRunningThenWhispersLinesWithDone() async throws {
        let rig = try Rig()
        await rig.controller.capture(kind)
        let captureId = rig.recorder.request.captureId
        rig.recorder.emit("mic", 1, "Can you hear me", at: 1_800_000_001_000)
        rig.recorder.emit("browser", 1, "Yes", at: 1_800_000_002_000)
        try await rig.until("pumped") { rig.controller.session?.liveCount == 2 }
        rig.advance(2)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off)])
        let running = try #require(rig.segmentFile(meetingId, captureId))
        #expect(running["meetingId"] as? String == meetingId)
        #expect(running["captureId"] as? String == captureId)
        #expect(running["done"] as? Bool == false)
        #expect((running["segments"] as? [[String: Any]])?.map { $0["text"] as? String } == ["Can you hear me", "Yes"])
        #expect((running["segments"] as? [[String: Any]])?.map { $0["speaker"] as? String } == ["Alex", "Meeting audio"])
        // No temporary files where the helper looks.
        #expect(try FileManager.default.contentsOfDirectory(atPath: rig.run.path).filter { $0.hasPrefix("mac-segments-") } == ["mac-segments-\(meetingId)-\(captureId).json"])

        let whisper = [seg("mac-\(captureId)-mic-1", "mic", "Can you hear me?", at: 1_800_000_001_000)]
        rig.transcriber.result = .success(whisper)
        await rig.controller.stop()
        let done = try #require(rig.segmentFile(meetingId, captureId))
        #expect(done["done"] as? Bool == true)
        #expect((done["segments"] as? [[String: Any]])?.map { $0["text"] as? String } == ["Can you hear me?"])
        #expect(rig.activeJSON() == nil)
        #expect(rig.panel.finished.isEmpty)
        #expect(!rig.shell.recording)
    }

    @Test func whenWhisperFailsTheLiveLinesAreMarkedDone() async throws {
        let rig = try Rig()
        rig.transcriber.result = .failure(Boom(description: "no model"))
        await rig.controller.capture(kind)
        let captureId = rig.recorder.request.captureId
        rig.recorder.emit("mic", 1, "Live only", at: 1_800_000_001_000)
        try await rig.until("pumped") { rig.controller.session?.liveCount == 1 }
        await rig.controller.stop()
        let done = try #require(rig.segmentFile(meetingId, captureId))
        #expect(done["done"] as? Bool == true)
        #expect((done["segments"] as? [[String: Any]])?.map { $0["text"] as? String } == ["Live only"])
    }

    @Test func theFileIsRewrittenOnlyWhenLinesChanged() async throws {
        let rig = try Rig()
        await rig.controller.capture(kind)
        let captureId = rig.recorder.request.captureId
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off)])
        #expect(rig.segmentFile(meetingId, captureId) == nil)
        rig.recorder.emit("mic", 1, "One", at: 1_800_000_001_000)
        try await rig.until("pumped") { rig.controller.session?.liveCount == 1 }
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off)])
        let url = rig.run.appendingPathComponent("mac-segments-\(meetingId)-\(captureId).json")
        let first = try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: url.path)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off)])
        #expect(try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date == Date(timeIntervalSince1970: 1))
        #expect(first != nil)
    }

    @Test func captionsArrivingWithACaptionAfterTheStartStopIt() async throws {
        let rig = try Rig()
        await rig.controller.capture(kind)
        let startMs = Int64(rig.now.timeIntervalSince1970 * 1000)
        // A caption from before the capture (the state was stale): keep recording.
        rig.helper.setMeeting(["id": meetingId, "segments": [["id": "c1", "startedAt": startMs - 5000, "text": "old"],
                                                             ["id": "mac-zz-mic-1", "startedAt": startMs + 9000, "text": "a Mac line"]]])
        rig.advance(10)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .arriving)])
        #expect(rig.controller.session?.phase == .running)
        // A real caption after the start: the captions take over.
        rig.helper.setMeeting(["id": meetingId, "segments": [["id": "c1", "startedAt": startMs - 5000, "text": "old"],
                                                             ["id": "c2", "startedAt": startMs + 12000, "text": "new"]]])
        rig.advance(2)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .arriving)])
        await rig.controller.settled()
        #expect(rig.recorder.isStopped)
        #expect(rig.controller.session == nil)
    }

    @Test func captionsArrivingWhenTheRecordCantBeReadStillStopIt() async throws {
        let rig = try Rig()
        rig.helper.failGetMeeting = true
        await rig.controller.capture(kind)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .waiting)])
        #expect(rig.controller.session?.phase == .running)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .arriving)])
        await rig.controller.settled()
        #expect(rig.recorder.isStopped)
    }

    @Test func theMeetingMustBeGoneFor60sBeforeItStops() async throws {
        let rig = try Rig()
        await rig.controller.capture(kind)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off)])
        rig.advance(30)
        await rig.controller.tick(calls: [], browser: []) // a refresh: gone for a moment
        rig.advance(29)
        await rig.controller.tick(calls: [], browser: [])
        #expect(rig.controller.session?.phase == .running)
        rig.advance(10)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off)]) // back: the grace starts over
        rig.advance(59)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting("zoom-other-20261104-150000", .off)])
        #expect(rig.controller.session?.phase == .running)
        rig.advance(1)
        await rig.controller.tick(calls: [], browser: [])
        await rig.controller.settled()
        #expect(rig.recorder.isStopped)
        #expect(rig.controller.session == nil)
    }

    @Test func stopEndsIt() async throws {
        let rig = try Rig()
        await rig.controller.capture(kind)
        await rig.controller.stop()
        #expect(rig.recorder.isStopped)
        #expect(rig.controller.session == nil)
    }

    @Test func pausingTheBrowserMeetingPausesTheRecorder() async throws {
        let rig = try Rig()
        await rig.controller.capture(kind)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off, paused: true)])
        #expect(rig.recorder.isPaused)
        #expect(rig.shell.paused)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off, paused: true)])
        #expect(rig.log.all.filter { $0 == "recorder.pause" }.count == 1)
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(meetingId, .off, paused: false)])
        #expect(!rig.recorder.isPaused)
        #expect(!rig.shell.paused)
        // Paused captions still count as off, not as arriving: no stop.
        #expect(rig.controller.session?.phase == .running)
    }
}

@Suite @MainActor struct SessionRulesTests {
    @Test func noSecondCaptureWhileOneRuns() async throws {
        // Review Focus 5.
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        await rig.controller.capture(.desktopCall(.zoom))
        await rig.controller.startManual()
        await rig.controller.capture(.captionsOff(meetingId: "zoom-1-20261104-150000", title: nil, lost: false))
        #expect(rig.recorders.count == 1)
        #expect(rig.helper.payloads("save-meeting").count == 1)
        // Ending it starts nothing by itself.
        await rig.controller.tick(calls: [], browser: [])
        await rig.controller.settled()
        #expect(rig.recorders.count == 1)
    }

    @Test func twoClicksAtOnceStartOneCapture() async throws {
        let rig = try Rig()
        async let a: Void = rig.controller.startManual()
        async let b: Void = rig.controller.capture(.desktopCall(.zoom))
        _ = await (a, b)
        #expect(rig.recorders.count == 1)
    }

    @Test func thePromptFollowsThePolicyAndGoesWhileRecording() async throws {
        let rig = try Rig()
        await rig.controller.tick(calls: [.teams], browser: [])
        #expect(rig.shell.prompts.last == .desktopCall(.teams))
        rig.controller.notNow(.desktopCall(.teams))
        #expect(rig.shell.prompts.last == .some(nil))
        rig.advance(60)
        await rig.controller.tick(calls: [.teams], browser: [])
        #expect(rig.shell.prompts.last == .some(nil))
        // Something recording: no prompt of either kind.
        await rig.controller.startManual()
        await rig.controller.tick(calls: [.zoom], browser: [rig.browserMeeting("zoom-1-20261104-150000", .off)])
        #expect(rig.shell.prompts.last == .some(nil))
        await rig.controller.stop()
        await rig.controller.tick(calls: [.zoom], browser: [])
        #expect(rig.shell.prompts.last == .desktopCall(.zoom))
    }

    @Test func menuPauseFlipsThePanelAndPanelPauseDoesnt() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        try await rig.controller.setPaused(true, from: .menu)
        #expect(rig.recorder.isPaused)
        #expect(rig.shell.paused)
        #expect(rig.panel.pausedCalls == [true])
        try await rig.controller.setPaused(false, from: .panel)
        #expect(!rig.recorder.isPaused)
        #expect(!rig.shell.paused)
        #expect(rig.panel.pausedCalls == [true])
    }

    @Test func pausingWithNothingRecordingFails() async throws {
        let rig = try Rig()
        await #expect(throws: SessionError.self) { try await rig.controller.setPaused(true, from: .panel) }
        await rig.controller.capture(.desktopCall(.teams))
        await rig.controller.stop()
        await #expect(throws: SessionError.self) { try await rig.controller.setPaused(true, from: .menu) }
    }

    @Test func recorderStatusLinesReachThePanel() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        rig.recorder.say(Recorder.liveTextOff)
        rig.recorder.say(Recorder.callAudioMissing)
        try await rig.until("two statuses") { rig.panel.statuses.count == 2 }
        #expect(rig.panel.statuses.map(\.level) == ["live", "problem"])
        #expect(rig.panel.statuses.map(\.text) == [Recorder.liveTextOff, Recorder.callAudioMissing])
    }
}

@Suite @MainActor struct RecoveryTests {
    func leftover(_ rig: Rig, kind: ActiveCapture.Kind, meetingId: String, audio: Bool = true) throws -> ActiveCapture {
        let folder = rig.home.appendingPathComponent("meetings/2026/November/\(meetingId)")
        rig.helper.folders[meetingId] = folder
        if audio {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent("audio"), withIntermediateDirectories: true)
            try Data(count: 8000).write(to: folder.appendingPathComponent("audio/mic.wav"))
            try Data(count: 8000).write(to: folder.appendingPathComponent("audio/call.wav"))
        }
        let active = ActiveCapture(meetingId: meetingId, captureId: "mhk2x1a0", kind: kind, folder: folder.path,
                                   startedAt: "2027-01-15T07:00:00.000Z",
                                   tracks: [.init(id: "mic", speaker: "Alex"), .init(id: "call", speaker: "Call")])
        try active.write(in: rig.run)
        return active
    }

    @Test func aLeftoverCaptureIsFinishedAsAStoppedOne() async throws {
        // Review Focus 2.
        let rig = try Rig()
        let id = "teams-desktop-mac-20270115-070000"
        _ = try leftover(rig, kind: .desktop, meetingId: id)
        rig.helper.setMeeting(["id": id, "platform": "teams-desktop", "endedAt": NSNull(), "segments": []])
        let whisper = [seg("mac-mhk2x1a0-mic-1", "mic", "Recovered", at: 1_799_996_401_000)]
        rig.transcriber.result = .success(whisper)
        await rig.controller.launch()

        let run = try #require(rig.transcriber.runs.first)
        #expect(run.captureId == "mhk2x1a0")
        #expect(run.startedAt == ISOTime.date("2027-01-15T07:00:00.000Z"))
        #expect(run.tracks.map(\.0) == [Track(id: "mic", speaker: "Alex"), Track(id: "call", speaker: "Call")])
        let finished = try #require(rig.panel.finished.first)
        #expect(finished.meeting["id"] as? String == id)
        #expect(finished.segments == whisper)
        #expect((finished.endedAt ?? "").wholeMatch(of: isoMs) != nil)
        #expect(rig.activeJSON() == nil)
        // A recovery shows no panel and starts no recorder.
        #expect(rig.panel.started.isEmpty && rig.recorders.isEmpty)
    }

    @Test func aLeftoverWithNoAudioIsStillEndedWithoutWhisper() async throws {
        let rig = try Rig()
        let id = "mac-mac-20270115-070000"
        _ = try leftover(rig, kind: .manual, meetingId: id, audio: false)
        rig.helper.setMeeting(["id": id, "platform": "mac", "endedAt": NSNull(), "segments": []])
        await rig.controller.launch()
        #expect(rig.transcriber.runs.isEmpty)
        #expect(rig.panel.finished.first?.meeting["id"] as? String == id)
        #expect(rig.panel.finished.first.map { $0.segments == nil } == true)
        #expect(rig.activeJSON() == nil)
    }

    @Test func aLeftoverManualCaptureWithMacAudioNamesTheMic() async throws {
        let rig = try Rig()
        let id = "mac-mac-20270115-070000"
        let folder = rig.home.appendingPathComponent("meetings/2026/November/\(id)")
        rig.helper.folders[id] = folder
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("audio"), withIntermediateDirectories: true)
        try Data(count: 8000).write(to: folder.appendingPathComponent("audio/mic.wav"))
        try Data(count: 8000).write(to: folder.appendingPathComponent("audio/system.wav"))
        try ActiveCapture(meetingId: id, captureId: "abc", kind: .manual, folder: folder.path, startedAt: "2027-01-15T07:00:00.000Z",
                          tracks: [.init(id: "mic", speaker: "Speaker"), .init(id: "system", speaker: "Call")]).write(in: rig.run)
        rig.helper.setMeeting(["id": id, "platform": "mac", "endedAt": NSNull(), "segments": []])
        rig.transcriber.result = .success([seg("mac-abc-system-1", "system", "Video", at: 1_799_996_401_000, speaker: "Call")])
        await rig.controller.launch()
        // Whisper hears the tracks as they were labelled; the panel then names the mic.
        #expect(rig.transcriber.runs.first?.tracks.map(\.0.speaker) == ["Speaker", "Call"])
        #expect(rig.panel.finished.first?.rename == SpeakerRename(speakerId: "mic", name: "Alex"))
    }

    @Test func aLeftoverCaptionsOffCaptureMarksItsLinesDone() async throws {
        let rig = try Rig()
        let id = "zoom-8812345-20270115-070000"
        _ = try leftover(rig, kind: .captionsOff, meetingId: id)
        let live = [seg("mac-mhk2x1a0-mic-1", "mic", "Live", at: 1_799_996_401_000)]
        _ = try MacSegmentsFile.write(run: rig.run, meetingId: id, captureId: "mhk2x1a0", segments: live, done: false)
        let whisper = [seg("mac-mhk2x1a0-mic-1", "mic", "Live, better.", at: 1_799_996_401_000)]
        rig.transcriber.result = .success(whisper)
        await rig.controller.launch()
        let file = try #require(rig.segmentFile(id, "mhk2x1a0"))
        #expect(file["done"] as? Bool == true)
        #expect((file["segments"] as? [[String: Any]])?.map { $0["text"] as? String } == ["Live, better."])
        #expect(rig.panel.finished.isEmpty)
        #expect(rig.activeJSON() == nil)
    }

    @Test func aLeftoverCaptionsOffCaptureWithoutAudioKeepsItsLiveLines() async throws {
        let rig = try Rig()
        let id = "zoom-8812345-20270115-070000"
        _ = try leftover(rig, kind: .captionsOff, meetingId: id, audio: false)
        // The segment file was taken already (only a done file is moved): the lines are in the record.
        rig.helper.setMeeting(["id": id, "segments": [["id": "c1", "speaker": "Pat", "speakerId": "p", "speakerResolved": true, "startedAt": 1, "lastAt": 2, "text": "caption"],
                                                      ["id": "mac-mhk2x1a0-mic-1", "speaker": "Alex", "speakerId": "mic", "speakerResolved": true, "startedAt": 3, "lastAt": 4, "text": "mine"]]])
        await rig.controller.launch()
        let file = try #require(rig.segmentFile(id, "mhk2x1a0"))
        #expect(file["done"] as? Bool == true)
        #expect((file["segments"] as? [[String: Any]])?.map { $0["text"] as? String } == ["mine"])
    }

    @Test func endedMacMeetingsWithoutMinutesGetTheirEndingResumed() async throws {
        let rig = try Rig()
        let hourAgo = ISOTime.string(rig.now.addingTimeInterval(-3600))
        let longAgo = ISOTime.string(rig.now.addingTimeInterval(-30 * 3600))
        rig.helper.rows = [
            ["id": "teams-desktop-mac-1", "platform": "teams-desktop", "endedAt": hourAgo, "hasMinutes": false],
            ["id": "zoom-desktop-mac-2", "platform": "zoom-desktop", "endedAt": hourAgo, "hasMinutes": false],
            ["id": "mac-mac-3", "platform": "mac", "endedAt": hourAgo, "hasMinutes": true],
            ["id": "mac-mac-4", "platform": "mac", "endedAt": longAgo, "hasMinutes": false],
            ["id": "mac-mac-5", "platform": "mac", "endedAt": NSNull(), "hasMinutes": false],
            ["id": "zoom-6", "platform": "zoom", "endedAt": hourAgo, "hasMinutes": false],
        ]
        for id in ["teams-desktop-mac-1", "zoom-desktop-mac-2"] { rig.helper.setMeeting(["id": id, "endedAt": hourAgo, "minutes": NSNull()]) }
        await rig.controller.launch()
        #expect(rig.panel.finished.map { $0.meeting["id"] as? String } == ["teams-desktop-mac-1", "zoom-desktop-mac-2"])
        #expect(rig.panel.finished.allSatisfy { $0.segments == nil && $0.endedAt == nil && $0.rename == nil })
        #expect(rig.panel.started.isEmpty)
    }

    @Test func aRecoveredLeftoverIsntResumedTwice() async throws {
        let rig = try Rig()
        let id = "teams-desktop-mac-20270115-070000"
        _ = try leftover(rig, kind: .desktop, meetingId: id)
        rig.helper.setMeeting(["id": id, "platform": "teams-desktop", "endedAt": NSNull(), "segments": []])
        rig.helper.rows = [["id": id, "platform": "teams-desktop", "endedAt": ISOTime.string(rig.now), "hasMinutes": false]]
        await rig.controller.launch()
        #expect(rig.panel.finished.count == 1)
    }

    @Test func aCaptureStartedDuringRecoveryKeepsItsActiveFile() async throws {
        let rig = try Rig()
        let id = "teams-desktop-mac-20270115-070000"
        _ = try leftover(rig, kind: .desktop, meetingId: id)
        rig.helper.setMeeting(["id": id, "platform": "teams-desktop", "endedAt": NSNull(), "segments": []])
        // Alex presses Start while the leftover's Whisper pass runs.
        rig.transcriber.during = { await rig.controller.startManual() }
        await rig.controller.launch()
        #expect(rig.controller.session?.kind == .manual)
        #expect(rig.activeJSON()?["kind"] as? String == "manual")
    }

    @Test func quittingMidCaptureClosesTheFilesAndLeavesTheCaptureForNextLaunch() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        rig.controller.prepareForQuit()
        #expect(rig.recorder.isStopped)
        #expect(rig.activeJSON()?["kind"] as? String == "desktop")
        #expect(rig.panel.endedCount == 0 && rig.transcriber.runs.isEmpty)
    }

    @Test func retentionSweepsAtLaunchAndEvery24Hours() async throws {
        let rig = try Rig()
        rig.helper.config = ["mac": ["myName": "Alex", "audioKeepDays": 14]]
        await rig.controller.launch()
        try await rig.until("the first sweep") { rig.sweeps.count == 1 }
        #expect(rig.sweeps[0].0 == rig.home)
        #expect(rig.sweeps[0].1 == 14)
        #expect(rig.sweeps[0].2 == rig.now)
        rig.advance(23 * 3600)
        await rig.controller.tick(calls: [], browser: [])
        #expect(rig.sweeps.count == 1)
        rig.advance(3600)
        await rig.controller.tick(calls: [], browser: [])
        try await rig.until("the second sweep") { rig.sweeps.count == 2 }
        rig.advance(60)
        await rig.controller.tick(calls: [], browser: [])
        #expect(rig.sweeps.count == 2)
    }

    @Test func retentionDefaultsTo30Days() async throws {
        let rig = try Rig()
        rig.helper.config = [:]
        await rig.controller.launch()
        try await rig.until("the sweep") { rig.sweeps.count == 1 }
        #expect(rig.sweeps[0].1 == 30)
    }
}

@Suite @MainActor struct BackToBackTests {
    @Test func aNewCaptureStartsWhileTheLastOneIsWrittenUp() async throws {
        // Alex's real case: one call ends, the next starts while the first's Whisper pass runs.
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        let a = rig.recorder
        let aId = try #require(rig.controller.session?.meetingId)
        a.emit("mic", 1, "First call", at: 1_800_000_001_000)
        try await rig.until("A's line") { rig.panel.segmentCalls.count == 1 }
        let whisper = [seg("mac-\(a.request.captureId)-mic-1", "mic", "First call, from Whisper.", at: 1_800_000_001_000)]
        rig.transcriber.result = .success(whisper)
        var bId: String?
        var whileWritingUp: (recording: Bool, prompt: PromptKind??, releaseChecks: Int)?
        rig.transcriber.during = {
            rig.advance(5)
            await rig.controller.startManual()
            bId = rig.controller.session?.meetingId
            rig.recorder.emit("mic", 1, "Second call", at: 1_800_000_605_000)
            try? await rig.until("B's line") { rig.panel.segmentCalls.count == 2 }
            whileWritingUp = (rig.shell.recording, rig.shell.prompts.last, rig.panel.releaseChecks)
        }
        rig.advance(600)
        await rig.controller.stop()

        let b = try #require(rig.recorders.last)
        #expect(rig.recorders.count == 2 && b !== a)
        #expect(b.started && !b.isStopped)
        #expect(rig.controller.session?.kind == .manual)
        #expect(rig.controller.session?.meetingId == bId)
        #expect(whileWritingUp?.recording == true)
        // A's lines and end land on A's record only.
        #expect(rig.panel.finishedIds == [aId])
        #expect(rig.panel.finished.first?.segments == whisper)
        #expect(rig.panel.finished.first?.endedAt == ISOTime.string(Date(timeIntervalSince1970: 1_800_000_600)))
        // The page showed B from its start, and only B's lines went to it after that.
        #expect(rig.panel.started.map { $0["id"] as? String } == [aId, bId])
        let bStart = try #require(rig.log.index(of: "panel.start", after: 1))
        let after = rig.log.all[bStart...].filter { $0.hasPrefix("panel.segments:") }
        #expect(after == ["panel.segments:Second call"])
        #expect(rig.panel.segmentCalls.last?.allSatisfy { $0.id.hasPrefix("mac-\(b.request.captureId)-") } == true)
        // Every live call names its meeting, so the page drops any that arrive for one no longer on show.
        #expect(rig.panel.segmentMeetings == [aId, try #require(bId)])
        // A's status lines are addressed to A, so B's panel ignores them.
        #expect(rig.panel.statuses.filter { $0.text == SessionController.writingStatus }.map(\.meetingId) == [aId])
        // B's recording keeps its own active.json; A's finishing file went once A was finished.
        #expect(rig.activeJSON()?["kind"] as? String == "manual")
        #expect(rig.finishingFiles().isEmpty)
        // B needs the panel: it isn't let go.
        #expect(rig.panel.releaseChecks == 0 && whileWritingUp?.releaseChecks == 0)
        await rig.controller.stop()
        #expect(rig.panel.finishedIds == [aId, try #require(bId)])
        #expect(rig.panel.releaseChecks == 1)
    }

    @Test func aClickWhileStoppingWaitsInsteadOfBeingLost() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        rig.panel.segmentDelay = 20_000_000
        rig.recorder.emit("mic", 1, "One", at: 1_800_000_001_000)
        rig.recorder.emit("mic", 2, "Two", at: 1_800_000_002_000)
        // Start is clicked while the first capture is stopping (its last lines still draining).
        let stopping = Task { await rig.controller.stop() }
        try await rig.until("stopping") { rig.controller.session?.phase == .ending }
        await rig.controller.startManual()
        await stopping.value
        #expect(rig.recorders.count == 2)
        #expect(rig.controller.session?.kind == .manual)
        #expect(rig.shell.recording)
    }

    @Test func promptsCanShowWhileTheLastCaptureIsWrittenUp() async throws {
        let rig = try Rig()
        await rig.controller.startManual()
        var prompt: PromptKind??
        rig.transcriber.during = {
            await rig.controller.tick(calls: [.zoom], browser: [])
            prompt = rig.shell.prompts.last
        }
        await rig.controller.stop()
        #expect(prompt == .some(.desktopCall(.zoom)))
    }

    @Test func stopCountsAsNotNowForThatCall() async throws {
        let rig = try Rig()
        await rig.controller.tick(calls: [.teams], browser: [])
        await rig.controller.capture(.desktopCall(.teams))
        await rig.controller.stop()
        await rig.controller.tick(calls: [.teams], browser: [])
        #expect(rig.shell.prompts.last == .some(nil))
        rig.advance(PromptPolicy.defaultSnooze + 1)
        await rig.controller.tick(calls: [.teams], browser: [])
        #expect(rig.shell.prompts.last == .desktopCall(.teams))
    }

    @Test func stopCountsAsNotNowForThatCaptionsOffMeeting() async throws {
        let rig = try Rig()
        let id = "zoom-8812345-20261104-150000"
        await rig.controller.capture(.captionsOff(meetingId: id, title: "Weekly", lost: false))
        await rig.controller.stop()
        await rig.controller.tick(calls: [], browser: [rig.browserMeeting(id, .off)])
        #expect(rig.shell.prompts.last == .some(nil))
    }

    @Test func aCallThatEndsByItselfIsntDismissed() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        await rig.controller.tick(calls: [], browser: [])
        await rig.controller.settled()
        await rig.controller.tick(calls: [.teams], browser: [])
        #expect(rig.shell.prompts.last == .desktopCall(.teams))
    }

    @Test func activeFileIsOnDiskBeforeTheRecorderStarts() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        #expect(rig.activeFileAtStart == [true])
        await rig.controller.stop()
        // A start that fails takes its file away again.
        rig.failRecorderStart = Boom(description: "no mic")
        await rig.controller.startManual()
        #expect(rig.activeFileAtStart == [true, true])
        #expect(rig.activeJSON() == nil)
    }

    @Test func aReloadedPanelWhilePausedShowsPaused() async throws {
        let rig = try Rig()
        await rig.controller.capture(.desktopCall(.teams))
        try await rig.controller.setPaused(true, from: .panel)
        #expect(rig.panel.pausedCalls.isEmpty)
        await rig.controller.panelReloaded()
        #expect(rig.panel.startStatuses.last??["level"] as? String == "paused")
        #expect(rig.panel.pausedCalls == [true])
        let log = rig.log.all
        let restarted = try #require(log.lastIndex(of: "panel.start"))
        let shown = try #require(log.lastIndex(of: "panel.showPaused:true"))
        #expect(restarted < shown)
        await rig.controller.settled()
    }
}

@Suite @MainActor struct FailedEndingTests {
    @Test func aFinishThatFailsOnceIsTriedAgain() async throws {
        let rig = try Rig()
        rig.panel.failFinish = 1
        await rig.controller.capture(.desktopCall(.teams))
        await rig.controller.stop()
        #expect(rig.panel.finishAttempts == 2)
        #expect(rig.panel.finished.count == 1)
        #expect(rig.finishingFiles().isEmpty && rig.activeJSON() == nil)
        #expect(rig.shell.errors.isEmpty)
    }

    @Test func aFinishThatKeepsFailingIsLeftForTheNextLaunch() async throws {
        let rig = try Rig()
        rig.panel.failFinish = 2
        await rig.controller.capture(.desktopCall(.teams))
        let id = try #require(rig.controller.session?.meetingId)
        let captureId = rig.recorder.request.captureId
        await rig.controller.stop()
        #expect(rig.panel.finished.isEmpty)
        #expect(rig.finishingFiles() == ["finishing-\(captureId).json"])
        #expect(rig.shell.errors.contains { $0.contains("next time") })
        // The next launch finishes it.
        let whisper = [seg("mac-\(captureId)-mic-1", "mic", "Recovered.", at: 1_800_000_001_000)]
        rig.transcriber.result = .success(whisper)
        await rig.controller.launch()
        #expect(rig.panel.finishedIds == [id])
        #expect(rig.panel.finished.first?.segments == whisper)
        #expect(rig.finishingFiles().isEmpty)
    }

    @Test func aRecoveryWhoseFinishFailsStaysForTheNextLaunch() async throws {
        let rig = try Rig()
        let id = "teams-desktop-mac-20270115-070000"
        let folder = rig.home.appendingPathComponent("meetings/2026/November/\(id)")
        rig.helper.folders[id] = folder
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("audio"), withIntermediateDirectories: true)
        try Data(count: 8000).write(to: folder.appendingPathComponent("audio/mic.wav"))
        try ActiveCapture(meetingId: id, captureId: "abc", kind: .desktop, folder: folder.path, startedAt: "2027-01-15T07:00:00.000Z",
                          tracks: [.init(id: "mic", speaker: "Alex")]).write(in: rig.run)
        rig.helper.setMeeting(["id": id, "platform": "teams-desktop", "endedAt": NSNull(), "segments": []])
        rig.panel.failFinish = 2
        await rig.controller.launch()
        #expect(rig.panel.finishAttempts == 2)
        #expect(rig.panel.finished.isEmpty)
        #expect(rig.finishingFiles() == ["finishing-abc.json"])
        #expect(rig.activeJSON() == nil) // moved aside, so a new capture can't overwrite it
        #expect(!rig.shell.errors.isEmpty)
        await rig.controller.launch()
        #expect(rig.panel.finishedIds == [id])
        #expect(rig.finishingFiles().isEmpty)
    }

    @Test func aRecoveryWhileTheHelperIsDownStaysToo() async throws {
        let rig = try Rig()
        let id = "mac-mac-20270115-070000"
        rig.helper.failGetMeeting = true
        try ActiveCapture(meetingId: id, captureId: "abc", kind: .manual, folder: rig.home.appendingPathComponent("gone").path,
                          startedAt: "2027-01-15T07:00:00.000Z", tracks: [.init(id: "mic", speaker: "Speaker")]).write(in: rig.run)
        await rig.controller.launch()
        #expect(rig.finishingFiles() == ["finishing-abc.json"])
        #expect(!rig.shell.errors.isEmpty)
    }

    @Test func aLeftoverWhoseMeetingWasDeletedIsDropped() async throws {
        let rig = try Rig()
        // Deleted on the meetings page (the helper doesn't know the id), or its meeting.json is gone (null).
        try ActiveCapture(meetingId: "mac-mac-20270115-070000", captureId: "abc", kind: .manual, folder: rig.home.appendingPathComponent("gone").path,
                          startedAt: "2027-01-15T07:00:00.000Z", tracks: [.init(id: "mic", speaker: "Speaker")]).write(in: rig.run)
        await rig.controller.launch()
        #expect(rig.finishingFiles().isEmpty)
        #expect(rig.panel.finishAttempts == 0)
        #expect(rig.shell.errors.isEmpty)
        // Set aside, not deleted: "unknown" can also mean an index that couldn't be read.
        #expect(FileManager.default.fileExists(atPath: rig.run.appendingPathComponent("dropped-abc.json").path))
        await rig.controller.launch()
        #expect(rig.panel.finishAttempts == 0)
    }

    @Test func aLeftoverWhoseMeetingFileIsGoneIsDropped() async throws {
        let rig = try Rig()
        rig.helper.nullMeetings = ["mac-mac-20270115-080000"]
        try ActiveCapture(meetingId: "mac-mac-20270115-080000", captureId: "def", kind: .desktop, folder: rig.home.appendingPathComponent("gone").path,
                          startedAt: "2027-01-15T08:00:00.000Z", tracks: [.init(id: "mic", speaker: "Alex")]).write(in: rig.run)
        await rig.controller.launch()
        #expect(rig.finishingFiles().isEmpty)
        #expect(rig.panel.finishAttempts == 0)
        #expect(FileManager.default.fileExists(atPath: rig.run.appendingPathComponent("dropped-def.json").path))
    }

    @Test func aReRunForACaptureWhoseWhisperLinesLandedOnlyEndsTheMeeting() async throws {
        // The first write-up's save landed late (after finish had given up): the meeting lists the capture,
        // and its lines may have been edited since. The re-run doesn't transcribe or replace them again.
        let rig = try Rig()
        let id = "teams-desktop-mac-20270115-070000"
        let folder = rig.home.appendingPathComponent("meetings/2026/November/\(id)")
        rig.helper.folders[id] = folder
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("audio"), withIntermediateDirectories: true)
        try Data(count: 8000).write(to: folder.appendingPathComponent("audio/mic.wav"))
        try ActiveCapture(meetingId: id, captureId: "abc", kind: .desktop, folder: folder.path, startedAt: "2027-01-15T07:00:00.000Z",
                          tracks: [.init(id: "mic", speaker: "Alex")]).write(in: rig.run)
        rig.helper.setMeeting(["id": id, "platform": "teams-desktop", "endedAt": NSNull(), "segments": [], "macWhisperDone": ["abc"]])
        rig.transcriber.result = .success([seg("mac-abc-mic-1", "mic", "Again", at: 1)])
        await rig.controller.launch()
        #expect(rig.transcriber.runs.isEmpty)
        #expect(rig.panel.finishedIds == [id])
        #expect(rig.panel.finished.first.map { $0.segments == nil } == true)
        #expect(rig.panel.finished.first?.endedAt != nil)
        #expect(rig.finishingFiles().isEmpty)
    }

    @Test func launchLetsThePanelGoWhenNothingNeedsIt() async throws {
        let rig = try Rig()
        await rig.controller.launch()
        #expect(rig.panel.releaseChecks == 1)
    }
}
