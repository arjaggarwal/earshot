import AVFAudio
import Foundation

/// How a multi-channel buffer becomes mono.
public enum ChannelPolicy: Sendable {
    /// Channel 0 only. The mic: with voice processing on, the input can carry extra channels and only the
    /// first is the echo-cancelled voice.
    case first
    /// The average of all channels. A tap's stereo mixdown.
    case mixdown
}

/// Turns whatever a device or tap hands over (any rate, channel count, Float32/Int16/Int32, interleaved or
/// not) into 16 kHz mono Float32 samples. Keeps the resampler between calls so chunk edges don't click, and
/// starts a new one when the input rate changes (a device switch mid-capture).
public final class PCMConverter {
    public static let sampleRate: Double = 16_000
    // Never mutated after creation.
    nonisolated(unsafe) public static let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

    private let channels: ChannelPolicy
    private var resampler: AVAudioConverter?
    private var resamplerRate: Double = 0
    private var widener: AVAudioConverter?
    private let warnConversion = LogOnce()

    public init(channels: ChannelPolicy) {
        self.channels = channels
    }

    /// The 16 kHz mono samples for this buffer (may be a few fewer or more than an exact rate ratio: the
    /// resampler holds back a little until `finish()`).
    public func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard buffer.frameLength > 0, let mono = monoBuffer(buffer) else { return [] }
        let rate = mono.format.sampleRate
        if rate == Self.sampleRate {
            return finish() + UnsafeBufferPointer(start: mono.floatChannelData![0], count: Int(mono.frameLength))
        }
        var out: [Float] = []
        if resampler == nil || resamplerRate != rate {
            out += finish()
            guard let c = AVAudioConverter(from: mono.format, to: Self.outputFormat) else { return out }
            c.sampleRateConverterQuality = AVAudioQuality.high.rawValue
            resampler = c
            resamplerRate = rate
        }
        out += run(resampler!, input: mono)
        return out
    }

    /// Drains the resampler's tail. The next `convert` starts a fresh one.
    public func finish() -> [Float] {
        guard let r = resampler else { return [] }
        resampler = nil
        resamplerRate = 0
        return run(r, input: nil)
    }

    /// A 16 kHz mono Float32 buffer holding `samples` (what the speech recognizer is fed).
    public static func buffer(_ samples: [Float]) -> AVAudioPCMBuffer {
        let b = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(max(samples.count, 1)))!
        b.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            if let base = src.baseAddress { b.floatChannelData![0].update(from: base, count: samples.count) }
        }
        return b
    }

    /// Feeds `input` once (nil: end of stream) and collects everything the converter gives back.
    private func run(_ converter: AVAudioConverter, input: AVAudioPCMBuffer?) -> [Float] {
        let frames = Double(input?.frameLength ?? 0) * Self.sampleRate / max(resamplerRate, converter.inputFormat.sampleRate)
        let capacity = AVAudioFrameCount(frames.rounded(.up)) + 1024
        let feeder = Feeder(input)
        var out: [Float] = []
        while true {
            guard let ob = AVAudioPCMBuffer(pcmFormat: Self.outputFormat, frameCapacity: capacity) else { break }
            var error: NSError?
            let status = converter.convert(to: ob, error: &error, withInputFrom: feeder.next)
            if status == .error {
                warnConversion("audio conversion failed (\(converter.inputFormat) → 16 kHz mono): \(error.map { "\($0)" } ?? "no detail")")
            }
            if ob.frameLength > 0 {
                out += UnsafeBufferPointer(start: ob.floatChannelData![0], count: Int(ob.frameLength))
            }
            if status != .haveData { break }
        }
        return out
    }

    /// Hands the converter its one buffer, then "no data now" (or end of stream when there is no buffer).
    private final class Feeder: @unchecked Sendable {
        private var buffer: AVAudioPCMBuffer?
        private let endOfStream: Bool
        init(_ buffer: AVAudioPCMBuffer?) { self.buffer = buffer; endOfStream = buffer == nil }
        func next(_: AVAudioPacketCount, _ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
            if let b = buffer {
                buffer = nil
                status.pointee = .haveData
                return b
            }
            status.pointee = endOfStream ? .endOfStream : .noDataNow
            return nil
        }
    }

    /// One channel of Float32 at the input's rate.
    private func monoBuffer(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        var buffer = input
        let common = input.format.commonFormat
        if common != .pcmFormatFloat32 && common != .pcmFormatInt16 && common != .pcmFormatInt32 {
            // Float64 and other rare layouts: widen to Float32 first.
            let src = input.format
            let wide = src.channelLayout.map {
                AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: src.sampleRate, interleaved: false, channelLayout: $0)
            } ?? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: src.sampleRate, channels: src.channelCount, interleaved: false)
            guard let f = wide else { return nil }
            if widener?.inputFormat != input.format { widener = AVAudioConverter(from: input.format, to: f) }
            guard let w = widener, let out = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: input.frameLength),
                  (try? w.convert(to: out, from: input)) != nil else { return nil }
            buffer = out
        }
        let frames = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        let used = channels == .first ? 1 : channelCount
        let interleaved = buffer.format.isInterleaved
        let stride = buffer.stride
        guard let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false),
              let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: buffer.frameLength) else { return nil }
        mono.frameLength = buffer.frameLength
        let dst = mono.floatChannelData![0]
        func sample(_ ch: Int, _ i: Int) -> Float {
            let plane = interleaved ? 0 : ch
            let index = interleaved ? i * stride + ch : i
            switch buffer.format.commonFormat {
            case .pcmFormatFloat32: return buffer.floatChannelData![plane][index]
            case .pcmFormatInt16: return Float(buffer.int16ChannelData![plane][index]) / 32_768
            default: return Float(buffer.int32ChannelData![plane][index]) / 2_147_483_648
            }
        }
        for i in 0..<frames {
            var sum: Float = 0
            for ch in 0..<used { sum += sample(ch, i) }
            dst[i] = sum / Float(used)
        }
        return mono
    }
}
