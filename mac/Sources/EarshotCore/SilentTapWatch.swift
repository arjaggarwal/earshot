import Foundation

/// Spots a tap that hears nothing while its app is playing: macOS delivers exact digital silence (not an
/// error) when Earshot isn't allowed to record other apps' audio, and it does so from the very first buffer.
/// So it only reports while the tap has never delivered a non-zero sample in this capture: once real audio
/// has arrived, later silence (a muted remote side) is never reported. Runs on audio time; asks whether the
/// target is playing only once the silence has lasted 10 s, then at most once a second. Fires once.
public struct SilentTapWatch: Sendable {
    public static let seconds: Double = 10
    static let probeEvery: Double = 1

    private var zeroRun: Double = 0
    private var nextProbe: Double = SilentTapWatch.seconds
    /// Real audio arrived (the tap works) or the problem was already reported: nothing more to say.
    private var settled = false

    public init() {}

    /// true once, when the tap has only ever delivered zeros for 10 s and the target reports it is playing.
    public mutating func feed(allZero: Bool, seconds: Double, targetPlaying: () -> Bool) -> Bool {
        guard !settled else { return false }
        guard allZero else {
            settled = true
            return false
        }
        zeroRun += seconds
        guard zeroRun >= nextProbe - 1e-6 else { return false }
        nextProbe = zeroRun + Self.probeEvery
        if targetPlaying() {
            settled = true
            return true
        }
        return false
    }
}
