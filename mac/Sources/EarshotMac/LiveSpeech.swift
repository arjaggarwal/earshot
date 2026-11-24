import AVFAudio
import EarshotCore
import Foundation
import Speech

/// Live transcript lines from Apple's on-device recognizer (en-US), one request at a time per track. When
/// a request ends and the next starts is decided in EarshotCore (`TrackPipeline`, `RequestRotation`).
///
/// Untested on hardware by the build (it would raise the speech-recognition prompt): see STATUS.md.
enum LiveSpeech {
    static let locale = Locale(identifier: "en-US")

    /// Asks for speech recognition if it hasn't been decided yet. Returns whether it is allowed.
    static func requestAuthorization() async -> Bool {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current != .notDetermined { return current == .authorized }
        return await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
        }
    }

    /// Whether live text can run now, without prompting. When it can't, recording goes on without it.
    static func setup() -> SpeechSetup {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .notDetermined: return .off(reason: "speech recognition hasn't been allowed yet")
        default: return .off(reason: "speech recognition isn't allowed (System Settings → Privacy & Security → Speech Recognition)")
        }
        guard let probe = SFSpeechRecognizer(locale: locale) else { return .off(reason: "no speech recognizer for en-US") }
        guard probe.supportsOnDeviceRecognition else { return .off(reason: "on-device speech isn't available for en-US") }
        guard probe.isAvailable else { return .off(reason: "the speech recognizer isn't available right now") }
        return .on { _ in AppleSpeechEngine(locale: locale) }
    }
}

/// One `SFSpeechRecognizer` per track; each request is on-device only, with partial results.
final class AppleSpeechEngine: SpeechEngine, @unchecked Sendable {
    private let recognizer: SFSpeechRecognizer?

    init(locale: Locale) {
        recognizer = SFSpeechRecognizer(locale: locale)
        // Results would otherwise come on the main queue, which the command-line check doesn't run.
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "earshot.speech"
        recognizer?.queue = queue
    }

    func startRequest(onEvent: @escaping @Sendable (SpeechEvent) -> Void) -> SpeechSession {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        guard let recognizer, recognizer.isAvailable else {
            onEvent(.failed("the speech recognizer isn't available"))
            return AppleSpeechSession(request: request, task: nil)
        }
        var logged = false
        let task = recognizer.recognitionTask(with: request) { result, error in
            if let result, !logged {
                logged = true
                FileHandle.standardError.write(Data("earshot: live text: first result on a request\n".utf8))
            }
            if let error {
                let e = error as NSError
                FileHandle.standardError.write(Data("earshot: live text failed: \(e.domain) \(e.code) \(e.localizedDescription)\n".utf8))
            }
            if let result {
                let text = result.bestTranscription.formattedString
                onEvent(result.isFinal ? .final(text) : .partial(text))
                if result.isFinal { return }
            }
            if let error {
                let e = error as NSError
                // 1110 "No speech detected": the request heard only silence.
                if e.domain == "kAFAssistantErrorDomain", e.code == 1110 { onEvent(.noSpeech) } else { onEvent(.failed(error.localizedDescription)) }
            }
        }
        return AppleSpeechSession(request: request, task: task)
    }
}

final class AppleSpeechSession: SpeechSession, @unchecked Sendable {
    private let request: SFSpeechAudioBufferRecognitionRequest
    private let task: SFSpeechRecognitionTask?

    init(request: SFSpeechAudioBufferRecognitionRequest, task: SFSpeechRecognitionTask?) {
        self.request = request
        self.task = task
    }

    func append(_ buffer: AVAudioPCMBuffer) { request.append(buffer) }
    func end() { request.endAudio() }
    func cancel() {
        request.endAudio()
        task?.cancel()
    }
}
