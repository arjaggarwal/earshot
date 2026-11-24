import Foundation

public enum AudioLevel {
    /// Root mean square of the samples (0 for none).
    public static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for s in samples { sum += s * s }
        return (sum / Float(samples.count)).squareRoot()
    }
}

/// Decides when a live speech request should end and the next one start: after a 1.2 s pause that follows
/// speech, or once a request has run 55 s (Apple's recognizer stops at about a minute). Fed with each
/// buffer's level and length, so it runs on audio time and the tests can drive it.
public struct RequestRotation: Sendable {
    public static let pauseSeconds: Double = 1.2
    public static let maxSeconds: Double = 55
    /// RMS above this counts as speech (about -40 dBFS). Voice processing keeps the mic's room noise well below it.
    public static let speechThreshold: Float = 0.01

    public enum Reason: Equatable, Sendable { case pause, maxLength }
    public enum Decision: Equatable, Sendable {
        case speech, silence
        case rotate(Reason)
    }

    private var requestSeconds: Double = 0
    private var quietSeconds: Double = 0
    private var heardSpeech = false

    public init() {}

    public mutating func feed(rms: Float, seconds: Double) -> Decision {
        requestSeconds += seconds
        let loud = rms > Self.speechThreshold
        if loud {
            heardSpeech = true
            quietSeconds = 0
        } else {
            quietSeconds += seconds
        }
        // A small tolerance so ten 0.12 s buffers count as 1.2 s despite floating-point sums.
        if requestSeconds >= Self.maxSeconds - 1e-6 { return .rotate(.maxLength) }
        if heardSpeech && quietSeconds >= Self.pauseSeconds - 1e-6 { return .rotate(.pause) }
        return loud ? .speech : .silence
    }

    /// Starts counting again for a new request.
    public mutating func reset() { self = RequestRotation() }
}
