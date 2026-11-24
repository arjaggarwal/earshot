import AVFAudio
import Foundation

public struct TranscriberError: Error, CustomStringConvertible {
    public let description: String
}

/// Runs whisper-cli over recorded audio files, one process per track.
public struct Transcriber: Sendable {
    public var binary: String
    public var model: URL

    public init(binary: String = "whisper-cli", model: URL) {
        self.binary = binary
        self.model = model
    }

    /// For config paths like "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin".
    public init(binary: String = "whisper-cli", modelPath: String) {
        self.init(binary: binary, model: URL(fileURLWithPath: (modelPath as NSString).expandingTildeInPath))
    }

    /// A bare name is looked up in Homebrew's folders and PATH (an app's PATH lacks Homebrew).
    func resolvedBinary() throws -> URL {
        if binary.contains("/") { return URL(fileURLWithPath: (binary as NSString).expandingTildeInPath) }
        let envPath = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for dir in ["/opt/homebrew/bin", "/usr/local/bin"] + envPath {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(binary)
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        throw TranscriberError(description: "\(binary) not found (looked in /opt/homebrew/bin, /usr/local/bin and PATH)")
    }

    /// At most this many whisper-cli processes at once (each loads about 1 GB).
    public static let maxConcurrent = 2

    public func run(captureId: String, tracks: [(Track, URL)], startedAt: Date) async throws -> [Segment] {
        let exe = try resolvedBinary()
        let model = self.model
        let all = try await withThrowingTaskGroup(of: [Segment].self) { group in
            var next = 0
            func addNext() {
                guard next < tracks.count else { return }
                let (track, audio) = tracks[next]
                next += 1
                group.addTask {
                    let json = try await Self.runOne(exe: exe, model: model, audio: audio)
                    do {
                        let segs = try WhisperResult.segments(json: json, captureId: captureId, track: track, offset: startedAt)
                        guard let (samples, rate) = Self.monoSamples(audio) else { return segs }
                        return WhisperResult.droppingSilent(segs, samples: samples, sampleRate: rate, offset: startedAt)
                    } catch {
                        throw TranscriberError(description: "track \(track.id): could not read whisper-cli output: \(error)")
                    }
                }
            }
            for _ in 0..<min(Self.maxConcurrent, tracks.count) { addNext() }
            var merged: [Segment] = []
            do {
                while let segs = try await group.next() {
                    merged += segs
                    addNext()
                }
            } catch {
                group.cancelAll()
                throw error
            }
            return merged
        }
        return all.sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }
    }

    /// The track's first channel as Float, for the silence check; nil if it can't be read (then nothing is dropped).
    static func monoSamples(_ url: URL) -> ([Float], Double)? {
        guard let file = try? AVAudioFile(forReading: url),
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buffer)) != nil,
              let data = buffer.floatChannelData else { return nil }
        return (Array(UnsafeBufferPointer(start: data[0], count: Int(buffer.frameLength))), file.processingFormat.sampleRate)
    }

    /// Holds the child process so cancellation can terminate it.
    private final class ProcessBox: @unchecked Sendable {
        private let lock = NSLock()
        private var process: Process?
        private var cancelled = false
        var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
        /// Returns false if already cancelled (the process is not started).
        func start(_ p: Process) throws -> Bool {
            lock.lock(); defer { lock.unlock() }
            if cancelled { return false }
            try p.run()
            process = p
            return true
        }
        func cancel() {
            lock.lock(); defer { lock.unlock() }
            cancelled = true
            if let p = process, p.isRunning { p.terminate() }
        }
    }

    private static func runOne(exe: URL, model: URL, audio: URL) async throws -> Data {
        let box = ProcessBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { cont in
                DispatchQueue.global().async {
                    cont.resume(with: Result { try runBlocking(exe: exe, model: model, audio: audio, box: box) })
                }
            }
        } onCancel: {
            box.cancel()
        }
    }

    private static func runBlocking(exe: URL, model: URL, audio: URL, box: ProcessBox) throws -> Data {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("earshot-whisper-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }
        let prefix = work.appendingPathComponent("out")
        let errFile = work.appendingPathComponent("stderr.txt")
        fm.createFile(atPath: errFile.path, contents: nil)
        let errHandle = try FileHandle(forWritingTo: errFile)
        defer { try? errHandle.close() }

        let p = Process()
        p.executableURL = exe
        p.arguments = ["-m", model.path, "-f", audio.path, "-l", "en", "-oj", "-of", prefix.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = errHandle
        let started: Bool
        do { started = try box.start(p) } catch { throw TranscriberError(description: "could not start \(exe.path): \(error)") }
        if !started { throw CancellationError() }
        p.waitUntilExit()
        if box.isCancelled { throw CancellationError() }

        guard p.terminationStatus == 0 else {
            let tail = ((try? String(contentsOf: errFile, encoding: .utf8)) ?? "")
                .split(separator: "\n").suffix(8).joined(separator: "\n")
            throw TranscriberError(description: "whisper-cli failed (exit \(p.terminationStatus)) on \(audio.lastPathComponent):\n\(tail)")
        }
        return try Data(contentsOf: prefix.appendingPathExtension("json"))
    }
}
