import Foundation
import Testing
@testable import EarshotCore

@Suite struct SegmentBuilderTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let mic = Track(id: "mic", speaker: "Alex")

    @Test func partialsKeepOneId() {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        let a = b.partial("hello", at: t0.addingTimeInterval(0.5))!
        let c = b.partial("hello there", at: t0.addingTimeInterval(1.0))!
        #expect(a.id == "mac-abc-mic-1")
        #expect(c.id == a.id)
        #expect(c.text == "hello there")
        #expect(c.startedAt == a.startedAt)
        #expect(c.lastAt > a.lastAt)
        #expect(c.speakerId == "mic" && c.speaker == "Alex" && c.speakerResolved)
    }

    @Test func finalClosesAndNextStartsNewId() {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        _ = b.partial("hi", at: t0.addingTimeInterval(0.2))!
        let f = b.final("hi.", at: t0.addingTimeInterval(0.4))!
        let n = b.partial("next", at: t0.addingTimeInterval(0.5))!
        #expect(f.id == "mac-abc-mic-1")
        #expect(n.id == "mac-abc-mic-2")
    }

    @Test func silenceOfOnePointTwoSecondsStartsNewSegment() {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        let a = b.partial("one", at: t0.addingTimeInterval(1))!
        let still = b.partial("one more", at: t0.addingTimeInterval(2.0))!
        b.silence(at: t0.addingTimeInterval(3.3))
        let n = b.partial("two", at: t0.addingTimeInterval(3.4))!
        #expect(still.id == a.id)
        #expect(n.id == "mac-abc-mic-2")
        // Without an explicit silence() call a long gap also splits.
        let m = b.partial("three", at: t0.addingTimeInterval(9))!
        #expect(m.id == "mac-abc-mic-3")
    }

    /// Apple's recognizer sends the whole request's text with every partial. After a pause opens a new line,
    /// that line must carry only the words since the last one, not repeat them (e.g. "To see if",
    /// "To see if pick up", "To see if pick up the dictation" each became its own line).
    @Test func aLineAfterAPauseHoldsOnlyTheNewWords() {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        let first = b.partial("To see if", at: t0.addingTimeInterval(0.5))!
        let second = b.partial("To see if it picks up", at: t0.addingTimeInterval(2.5))!
        #expect(second.id != first.id)
        #expect(second.text == "it picks up")
        let more = b.partial("To see if it picks up the dictation", at: t0.addingTimeInterval(3.0))!
        #expect(more.id == second.id && more.text == "it picks up the dictation")
        let fin = b.final("To see if it picks up the dictation.", at: t0.addingTimeInterval(3.2))!
        #expect(fin.id == second.id && fin.text == "it picks up the dictation.")
        // The next request starts from nothing.
        let next = b.partial("Amazing", at: t0.addingTimeInterval(3.4))!
        #expect(next.text == "Amazing" && next.id != fin.id)
    }

    /// The recognizer may revise earlier words; then the line can't be split cleanly and keeps the whole text.
    @Test func aRevisedEarlierPartKeepsTheWholeText() {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        _ = b.partial("To see if", at: t0.addingTimeInterval(0.5))!
        let second = b.partial("To sea it picks up", at: t0.addingTimeInterval(2.5))!
        #expect(second.text == "To sea it picks up")
    }

    @Test func idsNeverRepeat() {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        var ids: [String] = []
        for i in 0..<6 {
            let at = t0.addingTimeInterval(Double(i) * 2)
            _ = b.partial("p", at: at)
            ids.append(b.final("f", at: at.addingTimeInterval(0.1))!.id)
        }
        #expect(Set(ids).count == 6)
    }

    @Test func unnamedTrackIsNotResolved() {
        let b = SegmentBuilder(captureId: "x", track: Track(id: "call", speaker: ""), startedAt: t0)
        #expect(b.partial("a", at: t0)!.speakerResolved == false)
    }

    @Test func jsonShapeUsesMillisecondNumbers() throws {
        let b = SegmentBuilder(captureId: "x", track: mic, startedAt: t0)
        let data = try JSONEncoder().encode(try #require(b.partial("a", at: t0)))
        let obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(obj["startedAt"] as? Int64 == 1_800_000_000_000)
        #expect(Set(obj.keys) == ["id", "speaker", "speakerId", "speakerResolved", "startedAt", "lastAt", "text"])
    }

    @Test func captureIdIsBase36OfStartMs() {
        #expect(SegmentIds.captureId(for: t0) == String(1_800_000_000_000, radix: 36))
    }

    @Test func fractionalStartRoundTripsToSameCaptureId() throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000.9996)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let again = try #require(CLIArgs.parseISO(f.string(from: start)))
        #expect(SegmentIds.captureId(for: again) == SegmentIds.captureId(for: start))
        // The builder's first segment time agrees with the id's clock.
        let b = SegmentBuilder(captureId: SegmentIds.captureId(for: start), track: mic, startedAt: start)
        #expect(try #require(b.partial("x", at: start)).startedAt == epochMs(start))
    }

    @Test func finalAfterSilenceFinishesTheClosedSegment() throws {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        let p = try #require(b.partial("hello wor", at: t0.addingTimeInterval(1)))
        b.silence(at: t0.addingTimeInterval(2.5))
        let f = try #require(b.final("hello world.", at: t0.addingTimeInterval(2.6)))
        #expect(f.id == p.id)
        #expect(f.text == "hello world.")
        #expect(try #require(b.partial("next", at: t0.addingTimeInterval(2.7))).id == "mac-abc-mic-2")
    }

    @Test func emptyTextReturnsNilAndAllocatesNoId() throws {
        let b = SegmentBuilder(captureId: "abc", track: mic, startedAt: t0)
        #expect(b.partial("", at: t0) == nil)
        #expect(b.final("  ", at: t0) == nil)
        #expect(try #require(b.partial("a", at: t0)).id == "mac-abc-mic-1")
    }

    @Test func parsesTrackArgs() throws {
        let (t, url) = try #require(CLIArgs.parseTrack("mic=Alex:/tmp/m.wav"))
        #expect(t == Track(id: "mic", speaker: "Alex") && url.path == "/tmp/m.wav")
        #expect(CLIArgs.parseTrack("mic=/tmp/m.wav") == nil)
        #expect(CLIArgs.parseTrack("mic=:/tmp/m.wav") == nil)
        #expect(CLIArgs.parseTrack("nonsense") == nil)
        #expect(CLIArgs.parseISO("2026-11-04T10:00:00Z") != nil)
        #expect(CLIArgs.parseISO("2026-11-04T10:00:00.250Z") != nil)
        #expect(CLIArgs.parseISO("yesterday") == nil)
    }
}
