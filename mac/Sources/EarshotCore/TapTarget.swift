import CoreAudio
import Foundation

/// A process Core Audio knows about, by its process object id (what a tap description takes, not the pid).
public struct AudioProcess: Equatable, Sendable {
    public var objectId: AudioObjectID
    public var pid: pid_t
    public var bundleId: String
    public init(objectId: AudioObjectID, pid: pid_t, bundleId: String) {
        self.objectId = objectId
        self.pid = pid
        self.bundleId = bundleId
    }
}

/// What a process tap listens to.
public enum TapTarget: Equatable, Sendable {
    /// Every process whose bundle id starts with the prefix: a call app (Teams runs as several
    /// `com.microsoft.teams2.*` processes and any of them may play the call) or Chrome and its helpers.
    case processes(bundlePrefix: String)
    /// Everything the Mac plays except Earshot itself.
    case systemExcludingSelf

    public var label: String {
        switch self {
        case .processes(let prefix): return prefix
        case .systemExcludingSelf: return "the whole Mac"
        }
    }

    /// The process objects to put in the tap description: included ones, or (`exclusive`) the ones to leave out.
    public func selection(from processes: [AudioProcess], ownPid: pid_t) -> TapSelection {
        switch self {
        case .processes(let prefix):
            let p = prefix.lowercased()
            guard !p.isEmpty else { return TapSelection(objectIds: [], exclusive: false) }
            let ids = processes.filter { $0.pid != ownPid && $0.bundleId.lowercased().hasPrefix(p) }.map(\.objectId)
            return TapSelection(objectIds: Array(Set(ids)).sorted(), exclusive: false)
        case .systemExcludingSelf:
            let ids = processes.filter { $0.pid == ownPid }.map(\.objectId)
            return TapSelection(objectIds: Array(Set(ids)).sorted(), exclusive: true)
        }
    }
}

public struct TapSelection: Equatable, Sendable {
    /// Sorted, without duplicates, so two selections compare equal when the tap needn't change.
    public var objectIds: [AudioObjectID]
    /// true: a global tap that leaves these out; false: a tap of only these.
    public var exclusive: Bool
    public init(objectIds: [AudioObjectID], exclusive: Bool) {
        self.objectIds = objectIds
        self.exclusive = exclusive
    }
}

/// The parts of a stream format that tell the tap's stream apart from a clock device's own input.
public struct StreamFormat: Equatable, Sendable {
    public var sampleRate: Double
    public var channels: UInt32
    public var formatID: UInt32
    public var isFloat: Bool
    public var bitsPerChannel: UInt32
    public var isInterleaved: Bool

    public init(sampleRate: Double, channels: UInt32, formatID: UInt32, isFloat: Bool, bitsPerChannel: UInt32, isInterleaved: Bool) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.formatID = formatID
        self.isFloat = isFloat
        self.bitsPerChannel = bitsPerChannel
        self.isInterleaved = isInterleaved
    }

    public init(_ d: AudioStreamBasicDescription) {
        self.init(sampleRate: d.mSampleRate, channels: d.mChannelsPerFrame, formatID: d.mFormatID,
                  isFloat: d.mFormatFlags & kAudioFormatFlagIsFloat != 0, bitsPerChannel: d.mBitsPerChannel,
                  isInterleaved: d.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0)
    }

    /// IOProc buffers this stream takes: one when interleaved, one per channel otherwise.
    var bufferCount: Int { isInterleaved ? 1 : Int(channels) }
}

public struct TapStreamPick: Equatable, Sendable {
    /// Which of the aggregate device's input streams is the tap's.
    public var index: Int
    /// Its buffers in the IOProc's input buffer list.
    public var bufferRange: Range<Int>
    /// false: no stream has exactly the tap's format, so this is a best guess (worth a log line).
    public var exact: Bool
}

public enum TapStreams {
    /// Finds the tap's stream among an aggregate device's input streams. The clock (output) device can bring
    /// input streams of its own (a USB or Bluetooth headset's mic), so "the last buffer" isn't safe.
    public static func pick(_ streams: [StreamFormat], tap: StreamFormat) -> TapStreamPick? {
        guard !streams.isEmpty else { return nil }
        let exact = streams.indices.last { streams[$0] == tap }
        let index = exact ?? streams.indices.last { streams[$0].channels == tap.channels } ?? streams.count - 1
        let start = streams[..<index].reduce(0) { $0 + $1.bufferCount }
        return TapStreamPick(index: index, bufferRange: start..<(start + streams[index].bufferCount), exact: exact != nil)
    }
}

extension CoreAudioClientSource {
    /// Whether the process object is playing audio right now.
    public static func isRunningOutput(_ id: AudioObjectID) -> Bool {
        var address = address(kAudioProcessPropertyIsRunningOutput)
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &running) == noErr && running != 0
    }

    /// All of Core Audio's process object ids (macOS 14.2+; empty before).
    public static func allProcessObjectIds() -> [AudioObjectID] { processObjectIds() }

    /// Core Audio's process objects with their pids and bundle ids (macOS 14.2+; empty before). No permission needed.
    public func processes() -> [AudioProcess] {
        Self.processObjectIds().compactMap { id in
            guard let c = Self.client(id) else { return nil }
            return AudioProcess(objectId: id, pid: c.pid, bundleId: c.bundleId)
        }
    }
}
