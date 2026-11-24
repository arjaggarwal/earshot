import CoreAudio
import Foundation

/// A process Core Audio knows about, and whether it is reading audio input (the mic) right now.
public struct AudioClient: Equatable, Sendable, CustomStringConvertible {
    public var pid: pid_t
    public var bundleId: String
    public var inputRunning: Bool

    public init(pid: pid_t, bundleId: String, inputRunning: Bool) {
        self.pid = pid
        self.bundleId = bundleId
        self.inputRunning = inputRunning
    }

    public var description: String {
        "pid \(pid)  \(bundleId.isEmpty ? "(no bundle id)" : bundleId)  inputRunning: \(inputRunning)"
    }
}

public protocol AudioClientSource {
    func clients() -> [AudioClient]
}

/// Core Audio's process objects (macOS 14.2+). Reading them needs no permission.
public struct CoreAudioClientSource: AudioClientSource {
    public init() {}

    public func clients() -> [AudioClient] {
        Self.processObjectIds().compactMap(Self.client)
    }

    static func processObjectIds() -> [AudioObjectID] {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var address = Self.address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    static func client(_ id: AudioObjectID) -> AudioClient? {
        var address = address(kAudioProcessPropertyPID)
        var pid: pid_t = 0
        var size = UInt32(MemoryLayout<pid_t>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &pid) == noErr else { return nil }

        var bundleId = ""
        address = Self.address(kAudioProcessPropertyBundleID)
        var name: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        if AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr, let name {
            bundleId = name.takeRetainedValue() as String
        }

        address = Self.address(kAudioProcessPropertyIsRunningInput)
        var running: UInt32 = 0
        size = UInt32(MemoryLayout<UInt32>.size)
        if AudioObjectGetPropertyData(id, &address, 0, nil, &size, &running) != noErr { running = 0 }
        return AudioClient(pid: pid, bundleId: bundleId, inputRunning: running != 0)
    }
}

/// The desktop call apps Earshot watches.
public enum CallApp: String, CaseIterable, Hashable, Sendable {
    case teams, zoom

    /// Teams' bundle ids start `com.microsoft.teams` (`com.microsoft.teams2` for new Teams), Zoom's `us.zoom`.
    public init?(bundleId: String) {
        let id = bundleId.lowercased()
        if id.hasPrefix("com.microsoft.teams") { self = .teams }
        else if id.hasPrefix("us.zoom") { self = .zoom }
        else { return nil }
    }
}

public enum CallEvent: Equatable, Sendable {
    /// The app started using the mic; `pid` is the process reading input.
    case started(CallApp, pid_t)
    /// The app's mic has been off for `endAfter` (20 s) straight.
    case ended(CallApp)
}

/// Watches Core Audio's process list for Teams or Zoom using the mic.
///
/// `step(now:)` is the whole logic and is what the tests drive; `events()` just calls it every `poll` seconds.
/// A brief mic gap (mute toggles, device switches) doesn't end a call: only `endAfter` seconds off in a row does.
public final class CallWatcher: @unchecked Sendable {
    public static let defaultEndAfter: TimeInterval = 20

    private let source: AudioClientSource
    public let poll: TimeInterval
    public let endAfter: TimeInterval
    private let lock = NSLock()
    private var running: [CallApp: pid_t] = [:]
    private var offSince: [CallApp: Date] = [:]

    public init(source: AudioClientSource, poll: TimeInterval = 2, endAfter: TimeInterval = CallWatcher.defaultEndAfter) {
        self.source = source
        self.poll = poll
        self.endAfter = endAfter
    }

    /// The apps currently in a call (started and not yet ended).
    public var active: Set<CallApp> {
        lock.lock()
        defer { lock.unlock() }
        return Set(running.keys)
    }

    /// One poll: reads the source and returns what changed.
    public func step(now: Date) -> [CallEvent] {
        let clients = source.clients()
        lock.lock()
        defer { lock.unlock() }
        var events: [CallEvent] = []
        for app in CallApp.allCases {
            let hot = clients.first { $0.inputRunning && CallApp(bundleId: $0.bundleId) == app }
            if let hot {
                offSince[app] = nil
                if running[app] == nil {
                    running[app] = hot.pid
                    events.append(.started(app, hot.pid))
                }
            } else if running[app] != nil {
                let since = offSince[app] ?? now
                offSince[app] = since
                if now.timeIntervalSince(since) >= endAfter {
                    running[app] = nil
                    offSince[app] = nil
                    events.append(.ended(app))
                }
            }
        }
        return events
    }

    /// Polls every `poll` seconds until the consumer stops iterating.
    public func events() -> AsyncStream<CallEvent> {
        AsyncStream { continuation in
            let task = Task { [self] in
                while !Task.isCancelled {
                    for event in step(now: Date()) { continuation.yield(event) }
                    try? await Task.sleep(nanoseconds: UInt64(poll * 1_000_000_000))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
