import Foundation
import Testing
@testable import EarshotCore

/// What WebKit hands the native handler: the page's `{name, payload}` as Foundation objects
/// (NSDictionary, NSNumber, NSNull for null). JSON text through JSONSerialization gives the same shapes.
func pageMessage(_ json: String) throws -> Any {
    try JSONSerialization.jsonObject(with: Data(json.utf8))
}

/// Records what the bridge asked for and answers like the app would.
@MainActor final class FakeBridgeHost: NativeBridgeHost {
    var helperCalls: [(op: String, payload: [String: Any])] = []
    var helperResult: Any = NSNull()
    var helperError: Error?
    var shot: (png: Data, width: Int, height: Int)?
    var paused: [Bool] = []
    var stops = 0
    var opened: [String?] = []
    var layouts: [PanelLayout] = []
    var drags: [(Double, Double)] = []
    var focus: [Bool] = []
    var idles = 0

    func helper(op: String, payload: [String: Any]) async throws -> Any {
        helperCalls.append((op, payload))
        if let helperError { throw helperError }
        return helperResult
    }
    func screenshot() async -> (png: Data, width: Int, height: Int)? { shot }
    func setPaused(_ value: Bool) async throws { paused.append(value) }
    func stop() async { stops += 1 }
    func openMeetings(id: String?) { opened.append(id) }
    func layout(_ layout: PanelLayout) { layouts.append(layout) }
    func drag(dx: Double, dy: Double) { drags.append((dx, dy)) }
    func focus(editing: Bool) { focus.append(editing) }
    func pageIdle() { idles += 1 }
}

@Suite struct BridgeDecodeTests {
    @Test func helperPayloadPassesThroughWithNull() throws {
        let body = try pageMessage("""
        {"name":"helper","payload":{"op":"save-meeting","payload":{"meeting":{"id":"m1","segments":[],"endedAt":null},"base":null}}}
        """)
        guard case .helper(let op, let payload) = try BridgeCommand.decode(body) else { Issue.record("not helper"); return }
        #expect(op == "save-meeting")
        // base: null stays a key holding null, not a missing key.
        #expect(payload.keys.sorted() == ["base", "meeting"])
        #expect(payload["base"] is NSNull)
        let meeting = try #require(payload["meeting"] as? [String: Any])
        #expect(meeting["endedAt"] is NSNull)
        let wire = String(decoding: try JSONSerialization.data(withJSONObject: payload, options: .sortedKeys), as: UTF8.self)
        #expect(wire == #"{"base":null,"meeting":{"endedAt":null,"id":"m1","segments":[]}}"#)
    }

    @Test func helperWithoutInnerPayloadIsEmpty() throws {
        for json in [#"{"name":"helper","payload":{"op":"get-config"}}"#, #"{"name":"helper","payload":{"op":"get-config","payload":null}}"#] {
            guard case .helper(let op, let payload) = try BridgeCommand.decode(try pageMessage(json)) else { Issue.record("not helper"); return }
            #expect(op == "get-config")
            #expect(payload.isEmpty)
        }
    }

    @Test func helperNeedsAnOp() throws {
        #expect(throws: BridgeError.badPayload("helper")) { try BridgeCommand.decode(try pageMessage(#"{"name":"helper","payload":{}}"#)) }
        #expect(throws: BridgeError.badPayload("helper")) { try BridgeCommand.decode(try pageMessage(#"{"name":"helper","payload":{"op":""}}"#)) }
        #expect(throws: BridgeError.badPayload("helper")) {
            try BridgeCommand.decode(try pageMessage(#"{"name":"helper","payload":{"op":"x","payload":[1]}}"#))
        }
    }

    @Test func eachNameIsATypedCommand() throws {
        func decode(_ json: String) throws -> BridgeCommand { try BridgeCommand.decode(try pageMessage(json)) }
        guard case .screenshot = try decode(#"{"name":"screenshot","payload":{}}"#) else { Issue.record("screenshot"); return }
        guard case .setPaused(true) = try decode(#"{"name":"set-paused","payload":{"value":true}}"#) else { Issue.record("set-paused"); return }
        guard case .setPaused(false) = try decode(#"{"name":"set-paused","payload":{"value":false}}"#) else { Issue.record("set-paused false"); return }
        guard case .stop = try decode(#"{"name":"stop","payload":{}}"#) else { Issue.record("stop"); return }
        guard case .openMeetings(let id) = try decode(#"{"name":"open-meetings","payload":{"id":"m1"}}"#), id == "m1" else { Issue.record("open-meetings"); return }
        guard case .openMeetings(nil) = try decode(#"{"name":"open-meetings","payload":{"id":null}}"#) else { Issue.record("open-meetings null"); return }
        guard case .layout(let layout) = try decode(#"{"name":"layout","payload":{"collapsed":true,"width":96,"height":160}}"#) else { Issue.record("layout"); return }
        #expect(layout == .shown(collapsed: true, width: 96, height: 160))
        guard case .layout(.hidden) = try decode(#"{"name":"layout","payload":{"hidden":true}}"#) else { Issue.record("layout hidden"); return }
        guard case .drag(let dx, let dy) = try decode(#"{"name":"drag","payload":{"dx":3,"dy":-2.5}}"#) else { Issue.record("drag"); return }
        #expect(dx == 3 && dy == -2.5)
        guard case .focus(true) = try decode(#"{"name":"focus","payload":{"editing":true}}"#) else { Issue.record("focus"); return }
        // A missing payload is an empty one.
        guard case .screenshot = try decode(#"{"name":"screenshot"}"#) else { Issue.record("no payload"); return }
    }

    @Test func badMessagesAreRefused() throws {
        #expect(throws: BridgeError.notAMessage) { try BridgeCommand.decode("hello") }
        #expect(throws: BridgeError.notAMessage) { try BridgeCommand.decode(try pageMessage(#"{"payload":{}}"#)) }
        #expect(throws: BridgeError.unknownName("explode")) { try BridgeCommand.decode(try pageMessage(#"{"name":"explode"}"#)) }
        #expect(throws: BridgeError.badPayload("set-paused")) { try BridgeCommand.decode(try pageMessage(#"{"name":"set-paused","payload":{}}"#)) }
        #expect(throws: BridgeError.badPayload("layout")) {
            try BridgeCommand.decode(try pageMessage(#"{"name":"layout","payload":{"collapsed":true,"width":0,"height":10}}"#))
        }
        #expect(throws: BridgeError.badPayload("drag")) { try BridgeCommand.decode(try pageMessage(#"{"name":"drag","payload":{"dx":"3"}}"#)) }
    }
}

@Suite @MainActor struct BridgeRoutingTests {
    @Test func helperGoesToTheHelperAndAnswersItsResult() async throws {
        let host = FakeBridgeHost()
        host.helperResult = ["stale": true, "meeting": NSNull()] as [String: Any]
        let (value, error) = await NativeBridge.handle(try pageMessage("""
        {"name":"helper","payload":{"op":"save-meeting","payload":{"meeting":{"id":"m1"},"base":null}}}
        """), host: host)
        #expect(error == nil)
        #expect(host.helperCalls.count == 1)
        #expect(host.helperCalls[0].op == "save-meeting")
        #expect(host.helperCalls[0].payload["base"] is NSNull)
        let reply = try #require(value as? [String: Any])
        #expect(reply["stale"] as? Bool == true)
        #expect(reply["meeting"] is NSNull)
    }

    @Test func helperFailureRejectsWithItsMessage() async throws {
        let host = FakeBridgeHost()
        host.helperError = HelperError.failed("no such meeting")
        let (value, error) = await NativeBridge.handle(try pageMessage(#"{"name":"helper","payload":{"op":"get-meeting","payload":{"id":"x"}}}"#), host: host)
        #expect(value == nil)
        #expect(error == "no such meeting")
    }

    @Test func screenshotAnswersADataURL() async throws {
        let host = FakeBridgeHost()
        host.shot = (Data([0x89, 0x50, 0x4E, 0x47]), 1440, 900)
        let (value, error) = await NativeBridge.handle(try pageMessage(#"{"name":"screenshot","payload":{}}"#), host: host)
        #expect(error == nil)
        let reply = try #require(value as? [String: Any])
        #expect(reply["dataUrl"] as? String == "data:image/png;base64,iVBORw==")
        #expect(reply["width"] as? Int == 1440)
        #expect(reply["height"] as? Int == 900)

        host.shot = nil
        let (none, noError) = await NativeBridge.handle(try pageMessage(#"{"name":"screenshot","payload":{}}"#), host: host)
        #expect(none is NSNull)
        #expect(noError == nil)
    }

    @Test func theRestReachTheHost() async throws {
        let host = FakeBridgeHost()
        let (paused, _) = await NativeBridge.handle(try pageMessage(#"{"name":"set-paused","payload":{"value":true}}"#), host: host)
        #expect((paused as? [String: Any])?["paused"] as? Bool == true)
        _ = await NativeBridge.handle(try pageMessage(#"{"name":"stop","payload":{}}"#), host: host)
        _ = await NativeBridge.handle(try pageMessage(#"{"name":"open-meetings","payload":{"id":"m1"}}"#), host: host)
        _ = await NativeBridge.handle(try pageMessage(#"{"name":"layout","payload":{"collapsed":false,"width":376,"height":736}}"#), host: host)
        _ = await NativeBridge.handle(try pageMessage(#"{"name":"drag","payload":{"dx":4,"dy":5}}"#), host: host)
        _ = await NativeBridge.handle(try pageMessage(#"{"name":"focus","payload":{"editing":true}}"#), host: host)
        _ = await NativeBridge.handle(try pageMessage(#"{"name":"idle","payload":{}}"#), host: host)
        #expect(host.idles == 1)
        #expect(host.paused == [true])
        #expect(host.stops == 1)
        #expect(host.opened == ["m1"])
        #expect(host.layouts == [.shown(collapsed: false, width: 376, height: 736)])
        #expect(host.drags.count == 1 && host.drags[0] == (4, 5))
        #expect(host.focus == [true])
    }

    @Test func unknownNamesReject() async throws {
        let host = FakeBridgeHost()
        let (value, error) = await NativeBridge.handle(try pageMessage(#"{"name":"explode"}"#), host: host)
        #expect(value == nil)
        #expect(error == "Earshot for Mac doesn't know \"explode\".")
    }

    /// The whole way: page message → bridge → HelperClient → the helper's stdin. `base: null` arrives as null.
    @Test func baseNullReachesTheHelperProcess() async throws {
        let client = HelperClient(nodePath: HelperFixture.node, hostPath: try echoHost(), home: try HelperFixture.tempHome())
        defer { Task { await client.stop() } }
        let host = HelperBackedHost(client: client)
        let (value, error) = await NativeBridge.handle(try pageMessage("""
        {"name":"helper","payload":{"op":"save-meeting","payload":{"meeting":{"id":"m1","title":null},"base":null}}}
        """), host: host)
        #expect(error == nil)
        let request = try #require(value as? [String: Any])
        #expect(request["op"] as? String == "save-meeting")
        #expect(request["hasBase"] as? Bool == true)
        #expect(request["base"] is NSNull)
        #expect((request["meeting"] as? [String: Any])?["title"] is NSNull)
    }

    /// A host that answers every request with the request it read (plus whether `base` was a key).
    func echoHost() throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("earshot-echohost-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("echo-host.js")
        try """
        let buf = Buffer.alloc(0);
        function send(m) { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); process.stdout.write(Buffer.concat([h, b])); }
        process.stdin.on("data", (c) => {
          buf = Buffer.concat([buf, c]);
          while (buf.length >= 4) {
            const n = buf.readUInt32LE(0);
            if (buf.length < 4 + n) break;
            const req = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
            buf = buf.subarray(4 + n);
            send({ id: req.rid, ok: true, result: { ...req, hasBase: Object.prototype.hasOwnProperty.call(req, "base") } });
          }
        });
        process.stdin.on("end", () => process.exit(0));
        """.write(to: file, atomically: true, encoding: .utf8)
        return file.path
    }
}

@MainActor final class HelperBackedHost: NativeBridgeHost {
    let client: HelperClient
    init(client: HelperClient) { self.client = client }
    func helper(op: String, payload: [String: Any]) async throws -> Any { try await client.call(op, payload) }
    func screenshot() async -> (png: Data, width: Int, height: Int)? { nil }
    func setPaused(_ value: Bool) async throws {}
    func stop() async {}
    func openMeetings(id: String?) {}
    func layout(_ layout: PanelLayout) {}
    func drag(dx: Double, dy: Double) {}
    func focus(editing: Bool) {}
    func pageIdle() {}
}

@Suite struct PageValueTests {
    @Test func segmentsBecomePlainObjects() throws {
        let seg = Segment(id: "mac-abc-mic-1", speaker: "Alex", speakerId: "mic", speakerResolved: true,
                          startedAt: 1_800_000_000_000, lastAt: 1_800_000_002_000, text: "Hello")
        let list = try #require(try PageValue.from([seg]) as? [[String: Any]])
        #expect(list.count == 1)
        #expect(list[0]["id"] as? String == "mac-abc-mic-1")
        #expect((list[0]["startedAt"] as? NSNumber)?.int64Value == 1_800_000_000_000)
        #expect(list[0]["speakerResolved"] as? Bool == true)
    }
}

@Suite struct HelperLocationTests {
    @Test func readsTheInstalledLauncher() {
        let text = """
        #!/bin/sh
        exec "/opt/homebrew/bin/node" "/Users/me/Earshot/helper/host.js" "$@"
        """
        let found = HelperLocation.parseLauncher(text)
        #expect(found?.node == "/opt/homebrew/bin/node")
        #expect(found?.host == "/Users/me/Earshot/helper/host.js")
        #expect(HelperLocation.parseLauncher("#!/bin/sh\necho hi\n") == nil)
    }

    @Test func fallsBackToKnownNodeAndTheDefaultHost() {
        let home = URL(fileURLWithPath: "/Users/me/Earshot")
        let found = HelperLocation.resolve(home: home, launcher: nil, isExecutable: { $0 == "/usr/local/bin/node" })
        #expect(found.node == "/usr/local/bin/node")
        #expect(found.host == "/Users/me/Earshot/helper/host.js")
        let fromLauncher = HelperLocation.resolve(home: home, launcher: "exec \"/x/node\" \"/y/host.js\" \"$@\"", isExecutable: { _ in false })
        #expect(fromLauncher.node == "/x/node" && fromLauncher.host == "/y/host.js")
    }
}
