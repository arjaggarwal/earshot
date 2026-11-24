import AVFAudio
import Foundation
@testable import EarshotCore

/// A synthetic sine buffer, like a 48 kHz stereo device or tap would hand us.
func sineBuffer(seconds: Double, rate: Double = 48_000, channels: AVAudioChannelCount = 2, interleaved: Bool = false,
                frequency: Double = 440, amplitude: Float = 0.5, rightAmplitude: Float? = nil,
                format common: AVAudioCommonFormat = .pcmFormatFloat32) -> AVAudioPCMBuffer {
    // More than two channels needs a layout (voice processing hands the mic over like this).
    let format = channels > 2
        ? AVAudioFormat(commonFormat: common, sampleRate: rate, interleaved: interleaved,
                        channelLayout: AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | UInt32(channels))!)
        : AVAudioFormat(commonFormat: common, sampleRate: rate, channels: channels, interleaved: interleaved)!
    let frames = AVAudioFrameCount((seconds * rate).rounded())
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
    buffer.frameLength = frames
    let stride = buffer.stride
    for ch in 0..<Int(channels) {
        let amp = ch == 1 ? (rightAmplitude ?? amplitude) : amplitude
        for i in 0..<Int(frames) {
            let v = amp * Float(sin(2 * Double.pi * frequency * Double(i) / rate))
            let index = interleaved ? i * stride + ch : i
            let plane = interleaved ? 0 : ch
            switch common {
            case .pcmFormatFloat32: buffer.floatChannelData![plane][index] = v
            case .pcmFormatInt16: buffer.int16ChannelData![plane][index] = Int16(v * 32767)
            default: buffer.int32ChannelData![plane][index] = Int32(Double(v) * 2_147_483_647)
            }
        }
    }
    return buffer
}

func silentBuffer(seconds: Double, rate: Double = 48_000, channels: AVAudioChannelCount = 2) -> AVAudioPCMBuffer {
    sineBuffer(seconds: seconds, rate: rate, channels: channels, amplitude: 0)
}

/// Reads a WAV's 44-byte header fields.
struct WavHeader {
    var riff: String, wave: String, fmt: String, data: String
    var riffSize: UInt32, audioFormat: UInt16, channels: UInt16, sampleRate: UInt32, byteRate: UInt32
    var blockAlign: UInt16, bits: UInt16, dataSize: UInt32

    init(_ url: URL) throws {
        let d = try Data(contentsOf: url)
        func s(_ o: Int) -> String { String(decoding: d[o..<o + 4], as: UTF8.self) }
        func u32(_ o: Int) -> UInt32 { d[o..<o + 4].enumerated().reduce(0) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) } }
        func u16(_ o: Int) -> UInt16 { UInt16(d[o]) | UInt16(d[o + 1]) << 8 }
        riff = s(0); riffSize = u32(4); wave = s(8); fmt = s(12)
        audioFormat = u16(20); channels = u16(22); sampleRate = u32(24); byteRate = u32(28)
        blockAlign = u16(32); bits = u16(34); data = s(36); dataSize = u32(40)
    }
}

/// The WAV's samples as Int16 (skipping the 44-byte header).
func wavSamples(_ url: URL) throws -> [Int16] {
    let d = try Data(contentsOf: url).dropFirst(44)
    return stride(from: d.startIndex, to: d.endIndex - 1, by: 2).map { Int16(bitPattern: UInt16(d[$0]) | UInt16(d[$0 + 1]) << 8) }
}

func tempDir() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-tests-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// A clock the tests move by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t: Date
    init(_ t: Date) { self.t = t }
    var now: Date { lock.lock(); defer { lock.unlock() }; return t }
    func advance(_ s: TimeInterval) { lock.lock(); t = t.addingTimeInterval(s); lock.unlock() }
}

/// A speech engine that records what it was fed and lets the test send results.
final class FakeSpeech: SpeechEngine, @unchecked Sendable {
    private let lock = NSLock()
    private var _sessions: [FakeSession] = []
    /// When set, each new request fails at once (synchronously, as a broken recognizer might).
    var failImmediately = false
    var failMessage = "no on-device model"
    /// When set, each new request ends at once with "no speech detected" (silence, not a failure).
    var noSpeechImmediately = false

    var sessions: [FakeSession] { lock.lock(); defer { lock.unlock() }; return _sessions }

    func startRequest(onEvent: @escaping @Sendable (SpeechEvent) -> Void) -> SpeechSession {
        let s = FakeSession(onEvent: onEvent)
        lock.lock(); _sessions.append(s); lock.unlock()
        if failImmediately { onEvent(.failed(failMessage)) }
        if noSpeechImmediately { onEvent(.noSpeech) }
        return s
    }
}

final class FakeSession: SpeechSession, @unchecked Sendable {
    private let lock = NSLock()
    let onEvent: @Sendable (SpeechEvent) -> Void
    private(set) var framesAppended = 0
    private(set) var ended = false
    private(set) var cancelled = false
    private(set) var formats: [AVAudioFormat] = []

    init(onEvent: @escaping @Sendable (SpeechEvent) -> Void) { self.onEvent = onEvent }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); framesAppended += Int(buffer.frameLength); formats.append(buffer.format); lock.unlock()
    }
    func end() { lock.lock(); ended = true; lock.unlock() }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }

    func partial(_ t: String) { onEvent(.partial(t)) }
    func final(_ t: String) { onEvent(.final(t)) }
    func fail(_ m: String = "boom") { onEvent(.failed(m)) }
}

/// Collects a pipeline's callbacks.
final class Sink: @unchecked Sendable {
    private let lock = NSLock()
    private var _segments: [Segment] = []
    private var _levels: [Float] = []
    private var _liveOff = 0
    private var _writeFailures: [String] = []
    var writeFailures: [String] { lock.lock(); defer { lock.unlock() }; return _writeFailures }
    func writeFailed(_ e: Error) { lock.lock(); _writeFailures.append("\(e)"); lock.unlock() }
    var segments: [Segment] { lock.lock(); defer { lock.unlock() }; return _segments }
    var levels: [Float] { lock.lock(); defer { lock.unlock() }; return _levels }
    var liveOff: Int { lock.lock(); defer { lock.unlock() }; return _liveOff }
    func seg(_ s: Segment) { lock.lock(); _segments.append(s); lock.unlock() }
    func level(_ l: Float) { lock.lock(); _levels.append(l); lock.unlock() }
    func off() { lock.lock(); _liveOff += 1; lock.unlock() }
}

/// A track file that fails once `failAfter` appends have gone through, like a full disk.
final class FailingWriter: TrackFile, @unchecked Sendable {
    let inner: TrackWriter
    let failAfter: Int
    private(set) var appends = 0
    init(url: URL, now: Date, failAfter: Int) throws {
        inner = try TrackWriter(url: url, now: now)
        self.failAfter = failAfter
    }
    var url: URL { inner.url }
    var frames: Int64 { inner.frames }
    func append(_ samples: [Float], now: Date) throws {
        appends += 1
        if appends > failAfter { throw CaptureError("No space left on device") }
        try inner.append(samples, now: now)
    }
    func close() throws { try inner.close() }
}

/// A clock that can hold whoever reads it until the test opens it (to keep a track queue busy).
final class GatedClock: @unchecked Sendable {
    let t: Date
    private let gate = DispatchSemaphore(value: 1)
    private let lock = NSLock()
    private var closed = false
    init(_ t: Date) { self.t = t }
    var now: Date {
        lock.lock(); let c = closed; lock.unlock()
        if c { gate.wait(); gate.signal() }
        return t
    }
    func close() { lock.lock(); closed = true; lock.unlock(); gate.wait() }
    func open() { lock.lock(); closed = false; lock.unlock(); gate.signal() }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
    func bump() { lock.lock(); n += 1; lock.unlock() }
}
