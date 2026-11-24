import AVFAudio
import EarshotCore
import Foundation

// The real Recorder: the mic through AVAudioEngine, other apps through Core Audio process taps, live text
// from Apple's on-device recognizer. The recording logic itself is EarshotCore's `Recorder` (unit-tested
// with fake sources); this file only plugs the hardware in.

extension Recorder {
    /// Live text is decided now, without prompting: call `requestPermissions()` first so it can be on.
    convenience init(folder: URL, tracks: [(Track, Source)], captureId: String? = nil, startedAt: Date = Date()) {
        self.init(folder: folder, tracks: tracks, captureId: captureId ?? SegmentIds.captureId(for: startedAt),
                  startedAt: startedAt, speech: LiveSpeech.setup(), makeSource: Recorder.liveSource)
    }

    static func liveSource(_ source: Source, _ track: Track, _ onBuffer: @escaping BufferHandler) throws -> AudioSource {
        switch source {
        case .mic:
            return MicCapture(onBuffer: onBuffer)
        case .tap(let target):
            guard #available(macOS 14.2, *) else { throw CaptureError("process taps need macOS 14.2 or later") }
            return TapCapture(target: target, trackId: track.id, onBuffer: onBuffer)
        }
    }

    /// Asks for the microphone and speech recognition if macOS hasn't asked yet. Capturing other apps' audio
    /// is asked by macOS itself the first time a tap starts.
    static func requestPermissions() async -> (mic: Bool, speech: Bool) {
        let mic: Bool
        switch AVAudioApplication.shared.recordPermission {
        case .granted: mic = true
        case .denied: mic = false
        default: mic = await AVAudioApplication.requestRecordPermission()
        }
        return (mic, await LiveSpeech.requestAuthorization())
    }
}
