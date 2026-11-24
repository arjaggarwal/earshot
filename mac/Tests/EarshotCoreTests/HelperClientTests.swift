import Foundation
import Testing
@testable import EarshotCore

/// The repo's helper/host.js, run with a throwaway EARSHOT_HOME.
enum HelperFixture {
    static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let hostJs = repo.appendingPathComponent("helper/host.js").path
    static let node: String = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        .first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/opt/homebrew/bin/node"

    static func tempHome() throws -> URL {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-helper-\(UUID().uuidString)/Earshot")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return home
    }

    /// A stand-in host: replies {pid} to any op, never replies to "hang", exits on "quit", sends a frame
    /// header claiming 100 MB on "huge". `crashy`: exits 100 ms after its first reply, every time it starts.
    static func fakeHost(crashy: Bool = false) throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-fakehost-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("fake-host.js")
        try """
        const crashy = \(crashy);
        let buf = Buffer.alloc(0);
        function send(m) { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); process.stdout.write(Buffer.concat([h, b])); }
        process.stdin.on("data", (c) => {
          buf = Buffer.concat([buf, c]);
          while (buf.length >= 4) {
            const n = buf.readUInt32LE(0);
            if (buf.length < 4 + n) break;
            const req = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
            buf = buf.subarray(4 + n);
            if (req.op === "quit") process.exit(3);
            if (req.op === "hang") continue;
            if (req.op === "huge") { const h = Buffer.alloc(4); h.writeUInt32LE(100 * 1024 * 1024, 0); process.stdout.write(h); continue; }
            if (req.op === "fail") { send({ id: req.rid, ok: false, error: "nope" }); continue; }
            send({ id: req.rid, ok: true, result: { pid: process.pid, echo: req.echo ?? null } });
            if (crashy) setTimeout(() => process.exit(1), 100);
          }
        });
        process.stdin.on("end", () => process.exit(0));
        """.write(to: file, atomically: true, encoding: .utf8)
        return file.path
    }

    static func writeSegments(home: URL, meetingId: String, captureId: String, text: String) throws {
        let run = home.appendingPathComponent("run")
        try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
        let file = run.appendingPathComponent("mac-segments-\(meetingId)-\(captureId).json")
        let body: [String: Any] = ["meetingId": meetingId, "captureId": captureId, "done": false,
                                   "segments": [["speaker": "Me", "text": text, "startedAt": 1]]]
        let tmp = file.appendingPathExtension("tmp")
        try JSONSerialization.data(withJSONObject: body).write(to: tmp)
        #expect(rename(tmp.path, file.path) == 0)
    }
}

/// The first push matching `match`, or nil after `timeout` seconds.
func firstPush(_ client: HelperClient, timeout: Double = 8, where match: @escaping @Sendable ([String: Any]) -> Bool) async -> [String: Any]? {
    let stream = client.pushes
    let box = await withTaskGroup(of: PushBox?.self) { group in
        group.addTask {
            for await push in stream where match(push) { return PushBox(push) }
            return nil
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return nil
        }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first
    }
    return box?.value
}

final class PushBox: @unchecked Sendable {
    let value: [String: Any]
    init(_ v: [String: Any]) { value = v }
}

@Suite(.serialized) struct HelperClientTests {
    @Test func helloRoundTripsAgainstTheRealHelper() async throws {
        let home = try HelperFixture.tempHome()
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: HelperFixture.hostJs, home: home)
        defer { Task { await client.stop() } }
        let result = try await client.call("hello", [:]) as? [String: Any]
        #expect(result?["root"] as? String == home.path)
        #expect(result?["version"] is String)
    }

    @Test func helperErrorsThrow() async throws {
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: HelperFixture.hostJs, home: try HelperFixture.tempHome())
        defer { Task { await client.stop() } }
        await #expect(throws: HelperError.self) { _ = try await client.call("no-such-op", [:]) }
        do {
            _ = try await client.call("no-such-op", [:])
        } catch let error as HelperError {
            #expect(error == .failed("unknown op no-such-op"))
        }
    }

    @Test func payloadTravelsWithTheRequest() async throws {
        let home = try HelperFixture.tempHome()
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: HelperFixture.hostJs, home: home)
        defer { Task { await client.stop() } }
        let meetings: [[String: Any]] = [["meetingId": "m1", "tabId": 3, "platform": "zoom", "title": "T",
                                          "captions": "off", "startedAt": "2026-11-04T15:00:00.000Z", "paused": false]]
        _ = try await client.call("browser-state", ["meetings": meetings])
        let read = BrowserState.read(from: home.appendingPathComponent("run/browser.json"), now: Date())
        #expect(read.map(\.meetingId) == ["m1"])
    }

    @Test func receivesMacSegmentsPushAfterWatchMac() async throws {
        let home = try HelperFixture.tempHome()
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: HelperFixture.hostJs, home: home)
        defer { Task { await client.stop() } }
        _ = try await client.call("watch-mac", [:])
        try HelperFixture.writeSegments(home: home, meetingId: "m1", captureId: "a", text: "hi")
        let push = await firstPush(client) { $0["push"] as? String == "mac-segments" }
        #expect(push?["meetingId"] as? String == "m1")
        #expect(push?["captureId"] as? String == "a")
        #expect((push?["segments"] as? [Any])?.count == 1)
        #expect(push?["id"] == nil)
    }

    @Test func restartsAfterTheHelperExitsAndWatchesAgain() async throws {
        let home = try HelperFixture.tempHome()
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: HelperFixture.hostJs, home: home, restartDelay: 0.1)
        defer { Task { await client.stop() } }
        _ = try await client.call("watch-mac", [:])
        let first = try #require(await client.processIdentifier)
        kill(first, SIGKILL)
        // The restarted helper is asked to watch again, so pushes keep coming without another call.
        var second: Int32?
        for _ in 0..<100 {
            if let pid = await client.processIdentifier, pid != first { second = pid; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(second != nil)
        try await Task.sleep(nanoseconds: 300_000_000)
        try HelperFixture.writeSegments(home: home, meetingId: "m2", captureId: "b", text: "after restart")
        let push = await firstPush(client) { $0["meetingId"] as? String == "m2" }
        #expect(push?["captureId"] as? String == "b")
    }

    @Test func aCallThatRestartsTheHelperFirstStillGetsItWatching() async throws {
        // The automatic restart is far off; a call starts the new helper first, and pushes must still come.
        let home = try HelperFixture.tempHome()
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: HelperFixture.hostJs, home: home, restartDelay: 30)
        defer { Task { await client.stop() } }
        _ = try await client.call("watch-mac", [:])
        let first = try #require(await client.processIdentifier)
        kill(first, SIGKILL)
        for _ in 0..<100 {
            if await client.processIdentifier == nil { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(await client.processIdentifier == nil, "the client noticed the exit")
        _ = try await client.call("hello", [:])
        let second = try #require(await client.processIdentifier)
        #expect(second != first)
        try await Task.sleep(nanoseconds: 300_000_000)
        try HelperFixture.writeSegments(home: home, meetingId: "m3", captureId: "c", text: "after a call restarted it")
        let push = await firstPush(client) { $0["meetingId"] as? String == "m3" }
        #expect(push?["captureId"] as? String == "c")
    }

    @Test func aHelperThatKeepsDyingIsRestartedLessAndLessOften() async throws {
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: try HelperFixture.fakeHost(crashy: true), home: nil,
                                  restartDelay: 0.1)
        defer { Task { await client.stop() } }
        _ = try await client.call("watch-mac", [:])
        for _ in 0..<200 {
            if await client.launchTimes.count >= 5 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let times = await client.launchTimes
        try #require(times.count >= 5)
        let gaps = zip(times.dropFirst(), times).map { $0.timeIntervalSince($1) }
        for (a, b) in zip(gaps, gaps.dropFirst()) { #expect(b > a, "gaps \(gaps)") }
        #expect(gaps[3] > 0.8, "fourth restart waits 0.8 s plus the helper's life: \(gaps)")
    }

    @Test func anImpossibleFrameLengthDropsTheHelper() async throws {
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: try HelperFixture.fakeHost(), home: nil)
        defer { Task { await client.stop() } }
        let a = try await client.call("ping", [:]) as? [String: Any]
        await #expect(throws: HelperError.exited) { _ = try await client.call("huge", [:]) }
        let b = try await client.call("ping", [:]) as? [String: Any]
        #expect(b?["pid"] as? Int != nil)
        #expect(b?["pid"] as? Int != a?["pid"] as? Int)
    }

    @Test func aCallInFlightWhenTheHelperExitsFailsAndTheNextCallRestartsIt() async throws {
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: try HelperFixture.fakeHost(), home: nil)
        defer { Task { await client.stop() } }
        let a = try await client.call("ping", ["echo": "one"]) as? [String: Any]
        #expect(a?["echo"] as? String == "one")
        await #expect(throws: HelperError.exited) { _ = try await client.call("quit", [:]) }
        let b = try await client.call("ping", [:]) as? [String: Any]
        #expect(b?["pid"] as? Int != nil)
        #expect(b?["pid"] as? Int != a?["pid"] as? Int)
    }

    @Test func callsTimeOut() async throws {
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: try HelperFixture.fakeHost(), home: nil, timeout: 0.3)
        defer { Task { await client.stop() } }
        await #expect(throws: HelperError.timedOut("hang")) { _ = try await client.call("hang", [:]) }
        // the helper itself is still fine
        #expect(try await client.call("ping", [:]) is [String: Any])
    }

    @Test func defaultTimeoutMatchesTheExtension() {
        #expect(HelperClient.defaultTimeout == 6 * 60)
    }

    @Test func missingNodeFailsCleanly() async {
        let client = HelperClient(nodePath: "/nonexistent/node", hostPath: HelperFixture.hostJs, home: nil)
        await #expect(throws: HelperError.self) { _ = try await client.call("hello", [:]) }
    }
}
