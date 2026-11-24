import Foundation

/// What the panel's web view asks the app for, through `window.earshotNative.call(name, payload)`
/// (mac/Web/mac-shim.js: `webkit.messageHandlers.native.postMessage({name, payload})`, a handler with reply).
///
/// WebKit hands the message over as Foundation objects: dictionaries, arrays, strings, NSNumber, and NSNull
/// for null. Helper payloads are passed on exactly as they came, so a `base: null` stays a key holding null:
/// the panel's save guard (helper `save-meeting`) tells "built on no disk copy" from "sent no base" by it.
public enum BridgeCommand {
    /// `helper {op, payload}`: a helper op, answered with the helper's `result`.
    case helper(op: String, payload: [String: Any])
    /// `screenshot {}`: the call's window or the screen, answered `{dataUrl, width, height}` or null.
    case screenshot
    /// `set-paused {value}`, answered `{paused}`.
    case setPaused(Bool)
    /// `stop {}`.
    case stop
    /// `open-meetings {id}`: the meetings page in Chrome, at that meeting if there is one.
    case openMeetings(id: String?)
    /// `layout {collapsed, width, height}` (what shows: the panel or the launcher), or `{hidden: true}` once
    /// the panel has gone (after a meeting ends).
    case layout(PanelLayout)
    /// `drag {dx, dy}`: the pointer's move in screen points (y down).
    case drag(dx: Double, dy: Double)
    /// `focus {editing}`: a text field in the panel gained (true) or lost (false) focus.
    case focus(editing: Bool)
    /// `idle {}`: nothing is on show and nothing is pending in the page (no save, no minutes to come).
    case idle
}

public enum PanelLayout: Equatable, Sendable {
    case hidden
    case shown(collapsed: Bool, width: Double, height: Double)
}

public enum BridgeError: Error, Equatable, LocalizedError {
    /// Not `{name: String, ...}`.
    case notAMessage
    case unknownName(String)
    /// The payload for this name is missing what it needs.
    case badPayload(String)

    public var errorDescription: String? {
        switch self {
        case .notAMessage: return "Earshot for Mac got a message it can't read."
        case .unknownName(let name): return "Earshot for Mac doesn't know \"\(name)\"."
        case .badPayload(let name): return "Earshot for Mac got a bad \"\(name)\" message."
        }
    }
}

extension BridgeCommand {
    public static func decode(_ body: Any) throws -> BridgeCommand {
        guard let message = body as? [String: Any], let name = message["name"] as? String else { throw BridgeError.notAMessage }
        let payload: [String: Any]
        switch message["payload"] {
        case nil, is NSNull: payload = [:]
        case let p as [String: Any]: payload = p
        default: throw BridgeError.badPayload(name)
        }
        switch name {
        case "helper":
            guard let op = payload["op"] as? String, !op.isEmpty else { throw BridgeError.badPayload(name) }
            switch payload["payload"] {
            case nil, is NSNull: return .helper(op: op, payload: [:])
            case let inner as [String: Any]: return .helper(op: op, payload: inner)
            default: throw BridgeError.badPayload(name)
            }
        case "screenshot":
            return .screenshot
        case "set-paused":
            guard let value = payload["value"] as? Bool else { throw BridgeError.badPayload(name) }
            return .setPaused(value)
        case "stop":
            return .stop
        case "open-meetings":
            let id = (payload["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return .openMeetings(id: id)
        case "layout":
            if payload["hidden"] as? Bool == true { return .layout(.hidden) }
            guard let collapsed = payload["collapsed"] as? Bool,
                  let width = number(payload["width"]), let height = number(payload["height"]),
                  width > 0, height > 0 else { throw BridgeError.badPayload(name) }
            return .layout(.shown(collapsed: collapsed, width: width, height: height))
        case "drag":
            guard let dx = number(payload["dx"]), let dy = number(payload["dy"]) else { throw BridgeError.badPayload(name) }
            return .drag(dx: dx, dy: dy)
        case "focus":
            guard let editing = payload["editing"] as? Bool else { throw BridgeError.badPayload(name) }
            return .focus(editing: editing)
        case "idle":
            return .idle
        default:
            throw BridgeError.unknownName(name)
        }
    }

    /// A finite JS number (not a boolean, not a numeric string).
    static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }
}

/// The app side of the bridge: what each command does. The app's panel window implements it; tests fake it.
@MainActor
public protocol NativeBridgeHost: AnyObject {
    func helper(op: String, payload: [String: Any]) async throws -> Any
    func screenshot() async -> (png: Data, width: Int, height: Int)?
    func setPaused(_ value: Bool) async throws
    func stop() async
    func openMeetings(id: String?)
    func layout(_ layout: PanelLayout)
    func drag(dx: Double, dy: Double)
    func focus(editing: Bool)
    /// The page has nothing on show or pending: the app may let the web view go.
    func pageIdle()
}

public enum NativeBridge {
    /// Handles one message from the page and returns what `WKScriptMessageHandlerWithReply` replies with:
    /// a value the page's promise resolves with (nil: undefined), or an error message it rejects with.
    @MainActor
    public static func handle(_ body: Any, host: NativeBridgeHost) async -> (Any?, String?) {
        do {
            switch try BridgeCommand.decode(body) {
            case .helper(let op, let payload):
                return (try await host.helper(op: op, payload: payload), nil)
            case .screenshot:
                guard let shot = await host.screenshot() else { return (NSNull(), nil) }
                return (ScreenshotTarget.reply(png: shot.png, width: shot.width, height: shot.height), nil)
            case .setPaused(let value):
                try await host.setPaused(value)
                return (["paused": value], nil)
            case .stop:
                await host.stop()
            case .openMeetings(let id):
                host.openMeetings(id: id)
            case .layout(let layout):
                host.layout(layout)
            case .drag(let dx, let dy):
                host.drag(dx: dx, dy: dy)
            case .focus(let editing):
                host.focus(editing: editing)
            case .idle:
                host.pageIdle()
            }
            return (nil, nil)
        } catch {
            return (nil, message(for: error))
        }
    }

    public static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
}

/// Values for `callAsyncJavaScript` arguments: plain Foundation objects (what JSON parses to).
public enum PageValue {
    public static func from<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: .fragmentsAllowed)
    }
}

/// Where the installed helper is: `~/Earshot/helper/earshot-host` (written by helper/install.sh) names the
/// node and host.js Chrome runs; without it, a known node and `~/Earshot/helper/host.js`.
public enum HelperLocation {
    public static let nodeCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]

    /// `exec "<node>" "<host.js>" "$@"` → (node, host).
    public static func parseLauncher(_ text: String) -> (node: String, host: String)? {
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("exec ") else { continue }
            let quoted = trimmed.split(separator: "\"", omittingEmptySubsequences: false)
            // exec ␣ "node" ␣ "host" ␣ "$@"  →  ["exec ", node, " ", host, " ", "$@", ""]
            guard quoted.count >= 4 else { continue }
            let node = String(quoted[1]), host = String(quoted[3])
            if !node.isEmpty, !host.isEmpty { return (node, host) }
        }
        return nil
    }

    public static func resolve(home: URL, launcher: String?, isExecutable: (String) -> Bool) -> (node: String, host: String) {
        if let launcher, let found = parseLauncher(launcher) { return found }
        let node = nodeCandidates.first(where: isExecutable) ?? nodeCandidates[0]
        return (node, home.appendingPathComponent("helper/host.js").path)
    }

    /// The real one, for the app.
    public static func installed(home: URL) -> (node: String, host: String) {
        let launcher = try? String(contentsOf: home.appendingPathComponent("helper/earshot-host"), encoding: .utf8)
        return resolve(home: home, launcher: launcher) { FileManager.default.isExecutableFile(atPath: $0) }
    }
}
