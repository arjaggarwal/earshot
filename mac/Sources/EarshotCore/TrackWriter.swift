import Foundation

/// Where a track's 16 kHz mono samples go. `TrackWriter` is the real one; tests inject failing ones.
public protocol TrackFile: AnyObject {
    var url: URL { get }
    /// Samples written so far.
    var frames: Int64 { get }
    func append(_ samples: [Float], now: Date) throws
    func close() throws
}

/// Writes one track as a 16 kHz mono 16-bit PCM WAV. The header's sizes are rewritten and the file synced
/// every `flushInterval` (5 s), so a crash loses at most that much and another reader (or Whisper after a
/// relaunch) can open the file while the capture is still running.
public final class TrackWriter: TrackFile {
    public static let sampleRate = 16_000
    public static let flushInterval: TimeInterval = 5
    static let headerSize = 44

    public let url: URL
    /// Samples written so far (flushed or not).
    public private(set) var frames: Int64 = 0
    private var handle: FileHandle?
    private var lastFlush: Date

    /// Creates the file (and its folder) with an empty WAV header.
    public init(url: URL, now: Date = Date()) throws {
        self.url = url
        lastFlush = now
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard FileManager.default.createFile(atPath: url.path, contents: Self.header(dataBytes: 0)) else {
            throw CaptureError("could not create \(url.path)")
        }
        handle = try FileHandle(forWritingTo: url)
        try handle?.seekToEnd()
    }

    deinit { try? close() }

    /// Appends 16 kHz mono samples (clipped to -1...1), flushing when 5 s have passed since the last flush.
    public func append(_ samples: [Float], now: Date) throws {
        var data = Data(count: samples.count * 2)
        data.withUnsafeMutableBytes { raw in
            let out = raw.bindMemory(to: Int16.self)
            for (i, s) in samples.enumerated() {
                let v = (max(-1, min(1, s)) * 32_767).rounded()
                out[i] = Int16(v).littleEndian
            }
        }
        try write(data, frames: samples.count, now: now)
    }

    /// Rewrites the header's sizes and syncs the file to disk.
    public func flush() throws {
        guard let handle else { return }
        let dataBytes = UInt32(clamping: frames * 2)
        try handle.seek(toOffset: 4)
        try handle.write(contentsOf: Self.le32(dataBytes &+ 36))
        try handle.seek(toOffset: 40)
        try handle.write(contentsOf: Self.le32(dataBytes))
        try handle.seekToEnd()
        try handle.synchronize()
    }

    /// Flushes and closes. Safe to call twice.
    public func close() throws {
        guard handle != nil else { return }
        defer { try? handle?.close(); handle = nil }
        try flush()
    }

    private func write(_ data: Data, frames n: Int, now: Date) throws {
        guard let handle else { throw CaptureError("\(url.lastPathComponent) is already closed") }
        if !data.isEmpty { try handle.write(contentsOf: data) }
        frames += Int64(n)
        if now.timeIntervalSince(lastFlush) >= Self.flushInterval {
            try flush()
            lastFlush = now
        }
    }

    static func header(dataBytes: UInt32) -> Data {
        var d = Data()
        d += Data("RIFF".utf8); d += le32(dataBytes &+ 36); d += Data("WAVE".utf8)
        d += Data("fmt ".utf8); d += le32(16)
        d += le16(1)                                   // PCM
        d += le16(1)                                   // mono
        d += le32(UInt32(sampleRate))
        d += le32(UInt32(sampleRate * 2))              // byte rate
        d += le16(2)                                   // block align
        d += le16(16)                                  // bits per sample
        d += Data("data".utf8); d += le32(dataBytes)
        return d
    }

    static func le32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    static func le16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
}

/// A capture failure with a plain message.
public struct CaptureError: Error, CustomStringConvertible, Sendable {
    public let description: String
    public init(_ description: String) { self.description = description }
}
