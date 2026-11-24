import AVFAudio
import EarshotCore
import Foundation

/// `live-test <wav> [--speed 1]`: plays a recorded track through the real live-text pipeline (Apple's
/// recognizer, request rotation, line building) in real time and prints every line and live-text event.
/// For checking live text on a recording without another meeting. Run it as the app
/// (`open -a Earshot --args live-test …`) so it has the app's speech-recognition permission.
func liveTestCommand(_ args: [String]) -> Never {
    guard let path = args.first else { fail("usage: live-test <wav file> [--speed <x>]") }
    nonisolated(unsafe) var speed = 1.0
    if let i = args.firstIndex(of: "--speed"), i + 1 < args.count, let v = Double(args[i + 1]), v > 0 { speed = v }
    let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    guard let file = try? AVAudioFile(forReading: url) else { fail("can't read \(url.path)") }
    guard case .on(let make) = LiveSpeech.setup() else {
        if case .off(let reason) = LiveSpeech.setup() { fail("live text is off: \(reason)") }
        fail("live text is off")
    }
    let track = Track(id: "mic", speaker: "Speaker")
    let out = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-live-test-\(UUID().uuidString).wav")
    let started = Date()
    let t0 = Date()
    @Sendable func stamp() -> String { String(format: "%6.1fs", Date().timeIntervalSince(t0) * speed) }
    let writer: TrackFile
    do { writer = try TrackWriter(url: out, now: started) } catch { fail("can't write \(out.path): \(error)") }
    // --with <wav>: a second track fed alongside (a live recording runs the mic and the call together).
    var other: (AVAudioFile, TrackPipeline)?
    if let i = args.firstIndex(of: "--with"), i + 1 < args.count {
        let u = URL(fileURLWithPath: (args[i + 1] as NSString).expandingTildeInPath)
        guard let f = try? AVAudioFile(forReading: u) else { fail("can't read \(u.path)") }
        let t = Track(id: "system", speaker: "Call")
        let o = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-live-test-\(UUID().uuidString).wav")
        guard let w = try? TrackWriter(url: o, now: started) else { fail("can't write \(o.path)") }
        other = (f, TrackPipeline(track: t, captureId: "test", startedAt: started, writer: w, channels: .first, speech: make(t),
                                  onSegment: { seg in print("\(stamp()) CALL line: \(seg.text)") },
                                  onLiveTextOff: { reason in print("\(stamp()) CALL LIVE TEXT OFF: \(reason ?? "no reason")") }))
    }
    let pipeline = TrackPipeline(track: track, captureId: "test", startedAt: started, writer: writer, channels: .first,
                                 speech: make(track),
                                 onSegment: { seg in print("\(stamp()) line \(seg.id.split(separator: "-").last ?? ""): \(seg.text)") },
                                 onLiveTextOff: { reason in print("\(stamp()) LIVE TEXT OFF: \(reason ?? "no reason")") })
    print("live-test: \(url.lastPathComponent), \(String(format: "%.1f", Double(file.length) / file.processingFormat.sampleRate)) s at \(speed)x")
    let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
    while file.framePosition < file.length {
        guard let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk),
              (try? file.read(into: buf, frameCount: chunk)) != nil, buf.frameLength > 0 else { break }
        pipeline.process(buf)
        if let (f, p) = other, f.framePosition < f.length,
           let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.processingFormat.sampleRate / 10)),
           (try? f.read(into: b, frameCount: b.frameCapacity)) != nil, b.frameLength > 0 {
            p.process(b)
        }
        Thread.sleep(forTimeInterval: 0.1 / speed)
    }
    // A couple of seconds of quiet for the last results to come in.
    let format = file.processingFormat
    for _ in 0..<20 {
        if let quiet = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) {
            quiet.frameLength = chunk
            pipeline.process(quiet)
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
    _ = pipeline.finish()
    if let (_, p) = other { _ = p.finish() }
    try? FileManager.default.removeItem(at: out)
    print("\(stamp()) done")
    exit(0)
}
