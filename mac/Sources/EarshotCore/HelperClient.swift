import Foundation

public enum HelperError: Error, Equatable, LocalizedError {
    /// node or host.js couldn't be started.
    case launchFailed(String)
    /// The helper exited before replying.
    case exited
    /// No reply within the timeout (6 minutes, as the extension allows for minutes).
    case timedOut(String)
    /// The helper replied `{ok: false, error}`.
    case failed(String)
    /// The payload can't be sent as JSON.
    case badPayload(String)
    /// `stop()` was called.
    case stopped

    public var errorDescription: String? {
        switch self {
        case .launchFailed(let why): return "Couldn't start the Earshot helper: \(why)"
        case .exited: return "The Earshot helper stopped before replying."
        case .timedOut(let op): return "The Earshot helper didn't answer \(op) in time."
        case .failed(let message): return message
        case .badPayload(let op): return "Couldn't send \(op) to the Earshot helper (not JSON)."
        case .stopped: return "The Earshot helper connection was closed."
        }
    }
}

/// Talks to the Earshot helper (`node host.js`, normally the installed `~/Earshot/helper/host.js`) the way
/// Chrome does: 4-byte little-endian length + JSON on stdin/stdout. Requests are `{op, rid, ...payload}`;
/// replies are `{id: rid, ok, result | error}`; frames with `push` and no `id` go to `pushes`.
///
/// The helper is started on the first call and again after it exits. Once `watch-mac` has succeeded, every
/// helper started afterwards is asked to watch too, and one that exits is restarted on its own, so pushes keep
/// coming. Restarts back off (`restartDelay`, doubling up to `maxRestartDelay`) while the helper keeps dying
/// young; a helper that lived `stableAfter` seconds resets the backoff.
public actor HelperClient {
    public static let defaultTimeout: TimeInterval = 6 * 60

    /// Unsolicited frames (`{push: "mac-segments", ...}`), in the order the helper sent them.
    /// Single consumer: read it from one loop that lives as long as the client. Cancelling that
    /// iteration ends the stream for good, and later pushes are lost.
    public nonisolated let pushes: AsyncStream<[String: Any]>
    private nonisolated let pushSink: AsyncStream<[String: Any]>.Continuation

    private let nodePath: String
    private let hostPath: String
    private let home: URL?
    private let timeout: TimeInterval
    private let restartDelay: TimeInterval
    private let maxRestartDelay: TimeInterval
    private let stableAfter: TimeInterval

    private var process: Process?
    private var input: FileHandle?
    private var generation = 0
    private var nextRid = 1
    private var pending: [Int: Pending] = [:]
    private var watching = false
    private var stopped = false
    private var restartScheduled = false
    private var backoff: TimeInterval
    private var launchedAt = Date.distantPast
    /// When each helper was started (the last 20), for tests.
    private(set) var launchTimes: [Date] = []

    private struct Pending {
        let op: String
        let continuation: CheckedContinuation<Any, Error>
        let timer: Task<Void, Never>
    }

    /// `home` sets `EARSHOT_HOME` for the helper (nil: the helper's default, `~/Earshot`).
    public init(nodePath: String, hostPath: String, home: URL?, timeout: TimeInterval = HelperClient.defaultTimeout,
                restartDelay: TimeInterval = 1, maxRestartDelay: TimeInterval = 30, stableAfter: TimeInterval = 10) {
        self.nodePath = nodePath
        self.hostPath = hostPath
        self.home = home
        self.timeout = timeout
        self.restartDelay = restartDelay
        self.maxRestartDelay = maxRestartDelay
        self.stableAfter = stableAfter
        backoff = restartDelay
        (pushes, pushSink) = AsyncStream<[String: Any]>.makeStream()
        // A write to a helper that just died must fail with EPIPE, not kill the app.
        signal(SIGPIPE, SIG_IGN)
    }

    deinit {
        process?.terminate()
        pushSink.finish()
    }

    /// The running helper's pid, if one is running.
    public var processIdentifier: Int32? { process?.processIdentifier }

    /// Sends `op` with `payload` merged into the request and returns the reply's `result` (`NSNull` for null).
    public func call(_ op: String, _ payload: [String: Any] = [:]) async throws -> Any {
        if stopped { throw HelperError.stopped }
        try launchIfNeeded()
        let rid = nextRid
        nextRid += 1
        var request = payload
        request["op"] = op
        request["rid"] = rid
        guard JSONSerialization.isValidJSONObject(request),
              let body = try? JSONSerialization.data(withJSONObject: request) else { throw HelperError.badPayload(op) }
        var length = UInt32(body.count).littleEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(body)

        let result = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any, Error>) in
            let timer = Task { [timeout, weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                if !Task.isCancelled { await self?.finish(rid, with: .failure(HelperError.timedOut(op))) }
            }
            pending[rid] = Pending(op: op, continuation: continuation, timer: timer)
            do {
                guard let input else { throw HelperError.exited }
                try input.write(contentsOf: frame)
            } catch {
                finish(rid, with: .failure(HelperError.exited))
            }
        }
        if op == "watch-mac" { watching = true }
        return result
    }

    /// Closes the helper for good; calls in flight fail with `.stopped` and `pushes` finishes.
    public func stop() {
        stopped = true
        let p = process
        process = nil
        try? input?.close()
        input = nil
        p?.terminate()
        for rid in Array(pending.keys) { finish(rid, with: .failure(HelperError.stopped)) }
        pushSink.finish()
    }

    // MARK: - process

    private func launchIfNeeded() throws {
        guard process == nil else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [hostPath]
        var env = ProcessInfo.processInfo.environment
        if let home { env["EARSHOT_HOME"] = home.path }
        p.environment = env
        let stdin = Pipe()
        let stdout = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = FileHandle.standardError

        generation += 1
        let gen = generation
        let framer = Framer()
        let sink = pushSink
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let (messages, overflow) = framer.feed(data)
            for message in messages {
                if message.value["push"] != nil, message.value["id"] == nil {
                    sink.yield(message.value)
                } else if let id = message.value["id"] as? Int {
                    Task { await self?.reply(gen, id, message) }
                }
            }
            if overflow {
                // A length no real frame has: the stream is out of step. Drop this helper and start clean.
                handle.readabilityHandler = nil
                Task { await self?.drop(gen) }
            }
        }
        p.terminationHandler = { [weak self] _ in
            Task { await self?.exited(gen) }
        }
        do {
            try p.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            throw HelperError.launchFailed(error.localizedDescription)
        }
        process = p
        input = stdin.fileHandleForWriting
        launchedAt = Date()
        launchTimes = Array((launchTimes + [launchedAt]).suffix(20))
        // Watching belongs to the process, so every new helper is asked again, however it was started.
        if watching { Task { _ = try? await self.call("watch-mac", [:]) } }
    }

    private func reply(_ gen: Int, _ id: Int, _ message: Message) {
        guard gen == generation else { return }
        if message.value["ok"] as? Bool == true {
            finish(id, with: .success(message.value["result"] ?? NSNull()))
        } else {
            finish(id, with: .failure(HelperError.failed(message.value["error"] as? String ?? "helper error")))
        }
    }

    private func finish(_ rid: Int, with result: Result<Any, Error>) {
        guard let entry = pending.removeValue(forKey: rid) else { return }
        entry.timer.cancel()
        entry.continuation.resume(with: result)
    }

    private func drop(_ gen: Int) {
        guard gen == generation, let p = process else { return }
        exited(gen)
        p.terminate()
    }

    private func exited(_ gen: Int) {
        guard gen == generation, process != nil else { return }
        process = nil
        try? input?.close()
        input = nil
        for rid in Array(pending.keys) { finish(rid, with: .failure(HelperError.exited)) }
        if Date().timeIntervalSince(launchedAt) >= stableAfter { backoff = restartDelay }
        if watching { scheduleRestart() }
    }

    /// Brings a watching helper back so pushes keep flowing, waiting longer each time it dies young.
    private func scheduleRestart() {
        guard !stopped, !restartScheduled else { return }
        restartScheduled = true
        let delay = backoff
        backoff = min(backoff * 2, maxRestartDelay)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            await self?.restart()
        }
    }

    private func restart() {
        restartScheduled = false
        guard !stopped, process == nil else { return } // a call already started one (and it was asked to watch)
        do {
            try launchIfNeeded()
        } catch {
            scheduleRestart()
        }
    }
}

/// A parsed frame, boxed to cross from the pipe's reader thread into the actor.
struct Message: @unchecked Sendable {
    let value: [String: Any]
}

/// Splits the helper's stdout into frames. Called only from the pipe's reader (one at a time).
final class Framer: @unchecked Sendable {
    /// No real frame comes near this; a bigger length means the stream is corrupt.
    static let maxFrame = 64 * 1024 * 1024

    private var buffer = Data()

    /// The complete frames so far, and whether a frame claimed more than `maxFrame` (the buffer is then dropped).
    func feed(_ data: Data) -> (messages: [Message], overflow: Bool) {
        buffer.append(data)
        var out: [Message] = []
        while buffer.count >= 4 {
            let b = [UInt8](buffer.prefix(4))
            let length = Int(UInt32(b[0]) | UInt32(b[1]) << 8 | UInt32(b[2]) << 16 | UInt32(b[3]) << 24)
            if length > Self.maxFrame {
                buffer = Data()
                return (out, true)
            }
            guard buffer.count >= 4 + length else { break }
            let body = buffer.subdata(in: buffer.startIndex + 4 ..< buffer.startIndex + 4 + length)
            buffer = Data(buffer.dropFirst(4 + length))
            if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                out.append(Message(value: json))
            }
        }
        return (out, false)
    }
}
