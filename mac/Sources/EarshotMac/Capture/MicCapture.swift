import AVFAudio
import CoreAudio
import EarshotCore
import Foundation

/// The microphone through AVAudioEngine, with voice processing on so the other side of the call coming out
/// of the speakers is cancelled from the mic instead of becoming Alex's lines.
///
/// Untested on hardware by the build (it would raise the microphone prompt): see STATUS.md, Mac app checks.
final class MicCapture: AudioSource, @unchecked Sendable {
    private var engine = AVAudioEngine()
    private var voiceProcessing = false
    private let onBuffer: BufferHandler
    private let lock = NSLock()
    private var running = false
    private var observer: NSObjectProtocol?

    init(onBuffer: @escaping BufferHandler) {
        self.onBuffer = onBuffer
    }

    deinit { stop() }

    func start() throws {
        lock.lock(); defer { lock.unlock() }
        guard !running else { return }
        if AVAudioApplication.shared.recordPermission == .denied {
            throw CaptureError("microphone access is off (System Settings → Privacy & Security → Microphone)")
        }
        try startOnCurrentDevice()
        running = true
        observeDeviceChanges()
    }

    /// Echo cancellation unless the output is headphones, else (or if it won't start) the plain mic.
    /// Call with `lock` held, on a fresh engine.
    private func startOnCurrentDevice() throws {
        let mode = MicMode.choose(outputTransport: Self.outputProperty(kAudioDevicePropertyTransportType),
                                  outputSource: Self.outputProperty(kAudioDevicePropertyDataSource))
        if mode == .voiceProcessing {
            do {
                try startWithVoiceProcessing()
            } catch {
                // Better a mic with some echo than no recording: start it plain on a fresh engine.
                FileHandle.standardError.write(Data("earshot: echo cancellation didn't start (\(error)); recording the mic without it\n".utf8))
                engine = AVAudioEngine()
                try startPlain()
            }
        } else {
            try startPlain()
        }
    }

    /// A device change (AirPods connected, a USB mic unplugged) stops the engine; start again on the new
    /// device. The format may change too, which the track's converter handles. Call with `lock` held.
    private func observeDeviceChanges() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restart()
        }
    }

    /// Call with `lock` held.
    private func startWithVoiceProcessing() throws {
        let input = engine.inputNode
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            throw CaptureError("could not turn on echo cancellation: \(error.localizedDescription)")
        }
        voiceProcessing = true
        // Voice processing ducks other apps' audio by default; keep the call at its normal volume.
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        // Don't touch engine.mainMixerNode here. On a MacBook Pro, doing so made every start
        // fail with -10875 (kAUInitialize on the output node); without it the engine starts every time, and
        // the voice-processed mic arrives on channel 0 of a 9-channel input (PCMConverter keeps channel 0).
        do {
            try installTapAndStart()
        } catch {
            try? input.setVoiceProcessingEnabled(false)
            voiceProcessing = false
            throw error
        }
    }

    /// Call with `lock` held.
    private func startPlain() throws {
        voiceProcessing = false
        try installTapAndStart()
    }

    /// A property of the default output device (transport type, data source), or nil if it can't be read.
    static func outputProperty(_ selector: AudioObjectPropertySelector) -> UInt32? {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0 else { return nil }
        var value: UInt32 = 0
        size = UInt32(MemoryLayout<UInt32>.size)
        address = AudioObjectPropertyAddress(mSelector: selector,
                                             mScope: selector == kAudioDevicePropertyDataSource ? kAudioObjectPropertyScopeOutput : kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(device, &address),
              AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        guard running else { return }
        running = false
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if voiceProcessing { try? engine.inputNode.setVoiceProcessingEnabled(false) }
        voiceProcessing = false
    }

    /// Call with `lock` held.
    private func installTapAndStart() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError("no microphone input (format \(format))")
        }
        let handler = onBuffer
        // About 0.1 s per buffer at 48 kHz. The engine owns the buffer only for the call, so pass a copy.
        // format nil: the tap takes the bus's own format. A format that no longer matches the hardware
        // makes installTap raise an Objective-C exception, which Swift can't catch.
        input.installTap(onBus: 0, bufferSize: 4_800, format: nil) { buffer, _ in
            if let copy = buffer.copy() as? AVAudioPCMBuffer { handler(copy) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw CaptureError("the audio engine did not start: \(error.localizedDescription)")
        }
    }

    private func restart() {
        lock.lock(); defer { lock.unlock() }
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if voiceProcessing { try? engine.inputNode.setVoiceProcessingEnabled(false) }
        voiceProcessing = false
        // A fresh engine on the new device. Reusing the old one and its stale input format crashed the app
        // mid-call (installTap raised an exception after a device change).
        engine = AVAudioEngine()
        do {
            try startOnCurrentDevice()
        } catch {
            // Leave the track silent rather than crash the capture; the next configuration change retries.
            FileHandle.standardError.write(Data("earshot: mic restart failed: \(error)\n".utf8))
        }
        observeDeviceChanges()
    }
}
