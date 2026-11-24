import Foundation

/// Parses whisper-cli's `-oj` output into segments.
public enum WhisperResult {
    public static let joinGapMs = 1000
    public static let maxSpanMs = 30_000

    private struct File: Decodable {
        struct Piece: Decodable {
            struct Offsets: Decodable { let from: Int; let to: Int }
            let offsets: Offsets
            let text: String
        }
        let transcription: [Piece]
    }

    /// Neighbouring pieces less than 1 s apart join into one segment, up to 30 s. Times are `offset` + ms. Throws on bad JSON; an empty `transcription` is a valid empty result.
    public static func segments(json: Data, captureId: String, track: Track, offset: Date) throws -> [Segment] {
        let file = try JSONDecoder().decode(File.self, from: json)
        let base = epochMs(offset)
        var out: [Segment] = []
        var cur: (from: Int, to: Int, text: String)?

        func flush() {
            guard let c = cur else { return }
            out.append(Segment(id: SegmentIds.make(captureId: captureId, track: track, n: out.count + 1),
                               speaker: track.speaker, speakerId: track.id, speakerResolved: !track.speaker.isEmpty,
                               startedAt: base + Int64(c.from), lastAt: base + Int64(c.to), text: c.text))
            cur = nil
        }

        for piece in file.transcription {
            let text = piece.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty || (text.hasPrefix("[") && text.hasSuffix("]")) { continue } // [BLANK_AUDIO] and friends
            let o = piece.offsets
            if let c = cur, o.from - c.to < joinGapMs, o.to - c.from <= maxSpanMs {
                cur = (c.from, max(c.to, o.to), c.text + " " + text)
            } else {
                flush()
                cur = (o.from, o.to, text)
            }
        }
        flush()
        return out
    }

    /// Lines whose stretch of audio is quieter than this (RMS, dBFS) are dropped.
    public static let silenceFloorDb = -60.0

    /// Whisper invents short phrases ("Thank you.") on silent audio. Drop segments whose audio, on the track
    /// they came from, is effectively silent. `samples` is the track as mono Float, starting at `offset`.
    public static func droppingSilent(_ segments: [Segment], samples: [Float], sampleRate: Double, offset: Date,
                                      floorDb: Double = silenceFloorDb) -> [Segment] {
        guard !samples.isEmpty, sampleRate > 0 else { return segments }
        let base = epochMs(offset)
        let floor = pow(10, floorDb / 20)
        return segments.filter { seg in
            let a = max(0, min(samples.count, Int(Double(seg.startedAt - base) * sampleRate / 1000)))
            let b = max(a, min(samples.count, Int(Double(seg.lastAt - base) * sampleRate / 1000)))
            guard b > a else { return true } // no audio to judge by: keep it
            var sum = 0.0
            for i in a..<b { sum += Double(samples[i]) * Double(samples[i]) }
            return (sum / Double(b - a)).squareRoot() >= floor
        }
    }
}
