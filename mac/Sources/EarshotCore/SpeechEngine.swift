import AVFAudio
import Foundation

/// What one live speech request reports.
public enum SpeechEvent: Equatable, Sendable {
    case partial(String)
    case final(String)
    /// The request stopped with an error.
    case failed(String)
    /// The request heard only silence (Apple's "No speech detected"): not a failure; the next buffer starts another.
    case noSpeech
}

/// One recognizer request, fed 16 kHz mono Float32 buffers.
public protocol SpeechSession: AnyObject {
    func append(_ buffer: AVAudioPCMBuffer)
    /// No more audio: the recognizer sends its final result.
    func end()
    /// Drop the request without a final result.
    func cancel()
}

/// Starts recognizer requests. The app's is Apple's on-device recognizer; the tests use a fake.
public protocol SpeechEngine: AnyObject {
    /// `onEvent` may be called on any thread, and even before this returns.
    func startRequest(onEvent: @escaping @Sendable (SpeechEvent) -> Void) -> SpeechSession
}
