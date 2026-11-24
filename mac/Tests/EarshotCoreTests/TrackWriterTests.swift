import AVFAudio
import Foundation
import Testing
@testable import EarshotCore

@Suite struct PCMConverterTests {
    @Test(arguments: [false, true])
    func stereo48kBecomes16kMono(interleaved: Bool) {
        let c = PCMConverter(channels: .mixdown)
        var out = c.convert(sineBuffer(seconds: 3, interleaved: interleaved))
        out += c.finish()
        #expect(abs(out.count - 48_000) <= 48)                               // 3 s at 16 kHz, within 1 ms
        // Both channels carry the same 0.5 sine, so the mix keeps its level.
        #expect(abs(AudioLevel.rms(Array(out[1000..<47_000])) - 0.5 / Float(2).squareRoot()) < 0.01)
    }

    @Test func mixdownAveragesAndFirstTakesChannelZero() {
        let left = sineBuffer(seconds: 1, amplitude: 0.6, rightAmplitude: 0)
        let mix = PCMConverter(channels: .mixdown).convert(left)
        let first = PCMConverter(channels: .first).convert(sineBuffer(seconds: 1, amplitude: 0.6, rightAmplitude: 0))
        #expect(abs(AudioLevel.rms(Array(mix[500..<15_000])) - 0.3 / Float(2).squareRoot()) < 0.01)
        #expect(abs(AudioLevel.rms(Array(first[500..<15_000])) - 0.6 / Float(2).squareRoot()) < 0.01)
    }

    @Test func manyChannelsWithFirstPolicyUseOnlyTheFirst() {
        // Voice processing can hand over several channels; only the first is the processed mic.
        let b = sineBuffer(seconds: 1, channels: 5, amplitude: 0.4, rightAmplitude: 0.9)
        let out = PCMConverter(channels: .first).convert(b)
        #expect(abs(AudioLevel.rms(Array(out[500..<15_000])) - 0.4 / Float(2).squareRoot()) < 0.01)
    }

    @Test func int16AndInt32InputsConvert() {
        for f in [AVAudioCommonFormat.pcmFormatInt16, .pcmFormatInt32] {
            let out = PCMConverter(channels: .mixdown).convert(sineBuffer(seconds: 1, interleaved: true, format: f))
            #expect(abs(out.count - 16_000) <= 48)
            #expect(abs(AudioLevel.rms(Array(out[500..<15_000])) - 0.5 / Float(2).squareRoot()) < 0.01)
        }
    }

    @Test func sixteenKMonoPassesThroughAndRateChangesAreHandled() {
        let c = PCMConverter(channels: .first)
        let a = c.convert(sineBuffer(seconds: 1, rate: 16_000, channels: 1))
        #expect(a.count == 16_000)
        // The device switches to 44.1 kHz mid-capture (headphones plugged in).
        var b = c.convert(sineBuffer(seconds: 1, rate: 44_100, channels: 1))
        b += c.finish()
        #expect(abs(b.count - 16_000) <= 48)
    }

    @Test func outputBufferIs16kMonoFloat() {
        let b = PCMConverter.buffer([0.1, 0.2, 0.3])
        #expect(b.format.sampleRate == 16_000 && b.format.channelCount == 1)
        #expect(b.format.commonFormat == .pcmFormatFloat32 && b.frameLength == 3)
        #expect(b.floatChannelData![0][2] == 0.3)
    }
}

@Suite struct TrackWriterTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func writesA16kMono16BitWav() throws {
        let url = tempDir().appendingPathComponent("audio/mic.wav")
        let w = try TrackWriter(url: url, now: t0)
        let c = PCMConverter(channels: .mixdown)
        try w.append(c.convert(sineBuffer(seconds: 3)), now: t0)
        try w.append(c.finish(), now: t0)
        try w.close()

        let h = try WavHeader(url)
        #expect(h.riff == "RIFF" && h.wave == "WAVE" && h.fmt == "fmt " && h.data == "data")
        #expect(h.audioFormat == 1 && h.channels == 1 && h.sampleRate == 16_000)
        #expect(h.byteRate == 32_000 && h.blockAlign == 2 && h.bits == 16)
        #expect(h.dataSize == UInt32(w.frames * 2))
        #expect(h.riffSize == h.dataSize + 36)

        let file = try AVAudioFile(forReading: url)
        #expect(file.fileFormat.sampleRate == 16_000 && file.fileFormat.channelCount == 1)
        #expect(abs(Double(file.length) / 16_000 - 3.0) < 0.01)
    }

    @Test func flushesEveryFiveSecondsSoTheFileIsReadableMidCapture() throws {
        let url = tempDir().appendingPathComponent("call.wav")
        let w = try TrackWriter(url: url, now: t0)
        try w.append([Float](repeating: 0.25, count: 32_000), now: t0.addingTimeInterval(2))   // 2 s of audio
        #expect(try WavHeader(url).dataSize == 0)                                               // not flushed yet
        try w.append([Float](repeating: 0.25, count: 48_000), now: t0.addingTimeInterval(5))   // 5 s since open
        let h = try WavHeader(url)
        #expect(h.dataSize == 80_000 * 2 && h.riffSize == h.dataSize + 36)
        // Still open for writing, and another reader sees the first 5 s.
        let mid = try AVAudioFile(forReading: url)
        #expect(mid.length == 80_000)
        try w.append([Float](repeating: 0.25, count: 16_000), now: t0.addingTimeInterval(7))
        #expect(try WavHeader(url).dataSize == 80_000 * 2)                                      // next flush at 10 s
        try w.close()
        #expect(try AVAudioFile(forReading: url).length == 96_000)
    }

    @Test func clipsAndScalesToInt16() throws {
        let url = tempDir().appendingPathComponent("x.wav")
        let w = try TrackWriter(url: url, now: t0)
        try w.append([0, 0.5, -0.5, 1.5, -1.5], now: t0)
        try w.close()
        #expect(try wavSamples(url) == [0, 16_384, -16_384, 32_767, -32_767])
    }

    @Test func closeIsIdempotentAndWritingAfterCloseFails() throws {
        let url = tempDir().appendingPathComponent("y.wav")
        let w = try TrackWriter(url: url, now: t0)
        try w.close()
        try w.close()
        #expect(throws: (any Error).self) { try w.append([0.1], now: t0) }
    }
}
