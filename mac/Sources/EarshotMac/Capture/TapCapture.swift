import AVFAudio
import CoreAudio
import EarshotCore
import Foundation

/// Another app's audio (or the whole Mac's) through a Core Audio process tap (macOS 14.2+): a
/// `CATapDescription` on the target's process objects, wrapped in a private aggregate device, read with an
/// IOProc. Every process whose bundle id has the target's prefix is tapped, and the tap is updated when
/// such a process appears later (Teams starts helpers mid-call). `stop()` destroys the IOProc, the
/// aggregate device and the tap.
///
/// Untested on hardware by the build (it would raise the audio-capture prompt): see STATUS.md, Mac app checks.
@available(macOS 14.2, *)
final class TapCapture: AudioSource, @unchecked Sendable {
    private let target: TapTarget
    private let name: String
    private let onBuffer: BufferHandler
    private let ioQueue: DispatchQueue
    private let controlQueue: DispatchQueue
    private let lock = NSLock()

    private var description: CATapDescription?
    private var selection: TapSelection?
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var listener: AudioObjectPropertyListenerBlock?
    private let warnLayout = LogOnce()
    private let warnBuffers = LogOnce()

    init(target: TapTarget, trackId: String, onBuffer: @escaping BufferHandler) {
        self.target = target
        self.name = "Earshot \(trackId)"
        self.onBuffer = onBuffer
        ioQueue = DispatchQueue(label: "earshot.tap.\(trackId).io", qos: .userInteractive)
        controlQueue = DispatchQueue(label: "earshot.tap.\(trackId).control")
    }

    /// A tap dropped without `stop()` must not keep its IOProc running.
    deinit { stop() }

    /// Whether any tapped process is playing audio (for the whole Mac: any process but ours).
    var outputProbe: (@Sendable () -> Bool)? {
        { [weak self] in self?.targetIsPlaying() ?? false }
    }

    func targetIsPlaying() -> Bool {
        lock.lock()
        let sel = selection
        lock.unlock()
        guard let sel else { return false }
        let ids = sel.exclusive
            ? CoreAudioClientSource.allProcessObjectIds().filter { !sel.objectIds.contains($0) }
            : sel.objectIds
        return ids.contains(where: CoreAudioClientSource.isRunningOutput)
    }

    func start() throws {
        lock.lock(); defer { lock.unlock() }
        guard tapID == kAudioObjectUnknown else { return }
        do {
            try build()
        } catch {
            teardown()
            throw error
        }
    }

    func stop() {
        // Remove the process-list listener outside the lock: removal may wait for a running
        // refreshProcesses(), which takes the lock.
        lock.lock()
        let watching = listener
        listener = nil
        lock.unlock()
        if let watching {
            var address = Self.address(kAudioHardwarePropertyProcessObjectList)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, watching)
        }
        lock.lock(); defer { lock.unlock() }
        teardown()
    }

    // MARK: Setup

    /// Call with `lock` held. On a throw, `teardown()` removes whatever was made.
    private func build() throws {
        let sel = target.selection(from: CoreAudioClientSource().processes(), ownPid: getpid())
        if !sel.exclusive && sel.objectIds.isEmpty {
            throw CaptureError("no \(target.label) process is using audio right now")
        }
        let desc = sel.exclusive
            ? CATapDescription(stereoGlobalTapButExcludeProcesses: sel.objectIds)
            : CATapDescription(stereoMixdownOfProcesses: sel.objectIds)
        desc.name = name
        desc.isPrivate = true
        desc.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(desc, &tap), "AudioHardwareCreateProcessTap")
        tapID = tap
        description = desc
        selection = sel

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = Self.address(kAudioTapPropertyFormat)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd), "reading the tap's format")
        guard let format = AVAudioFormat(streamDescription: &asbd), format.sampleRate > 0 else {
            throw CaptureError("the tap's format isn't usable (\(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) channels)")
        }

        var device: [String: Any] = [
            kAudioAggregateDeviceNameKey: name,
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: desc.uuid.uuidString,
            ]],
        ]
        // The default output device clocks the aggregate (as in Apple's tap sample).
        if let output = Self.defaultOutputUID() {
            device[kAudioAggregateDeviceMainSubDeviceKey] = output
            device[kAudioAggregateDeviceSubDeviceListKey] = [[kAudioSubDeviceUIDKey: output]]
        }
        var aggregate = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(device as CFDictionary, &aggregate), "AudioHardwareCreateAggregateDevice")
        aggregateID = aggregate

        // Find the tap's stream among the aggregate's inputs (the clock device may bring its own, e.g. a
        // headset mic) and label its buffers with that stream's format.
        var bufferRange: Range<Int>?
        var streamFormat = format
        let streams = Self.inputStreamFormats(aggregate)
        if let pick = TapStreams.pick(streams.map(StreamFormat.init), tap: StreamFormat(asbd)) {
            var d = streams[pick.index]
            if let f = AVAudioFormat(streamDescription: &d) { streamFormat = f }
            bufferRange = pick.bufferRange
            if !pick.exact || streams.count != 1 {
                warnLayout("the \(target.label) tap's aggregate device has \(streams.count) input streams; using #\(pick.index) "
                           + "(\(pick.exact ? "matches" : "does not match") the tap's \(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) ch)")
            }
        } else {
            warnLayout("could not read the \(target.label) tap's aggregate input streams; assuming the tap's buffers come last")
        }

        let handler = onBuffer
        let layout = LayoutBox(format: streamFormat, range: bufferRange, warn: warnBuffers)
        var proc: AudioDeviceIOProcID?
        try check(AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, ioQueue) { _, input, _, _, _ in
            if let buffer = Self.copy(input, layout: layout) { handler(buffer) }
        }, "AudioDeviceCreateIOProcIDWithBlock")
        procID = proc
        try check(AudioDeviceStart(aggregate, proc), "AudioDeviceStart")
        try watchProcesses()
    }

    /// Re-selects the target's processes whenever Core Audio's process list changes.
    private func watchProcesses() throws {
        var address = Self.address(kAudioHardwarePropertyProcessObjectList)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.refreshProcesses() }
        try check(AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, block),
                  "watching the process list")
        listener = block
    }

    private func refreshProcesses() {
        lock.lock(); defer { lock.unlock() }
        guard listener != nil, tapID != kAudioObjectUnknown, let desc = description else { return }
        let sel = target.selection(from: CoreAudioClientSource().processes(), ownPid: getpid())
        // If every matching process went away, keep the tap as it is: it simply goes quiet.
        guard sel != selection, sel.exclusive || !sel.objectIds.isEmpty else { return }
        desc.processes = sel.objectIds
        var address = Self.address(kAudioTapPropertyDescription)
        // The property's data is the description object's pointer.
        var ref = Unmanaged.passUnretained(desc)
        let status = AudioObjectSetPropertyData(tapID, &address, 0, nil, UInt32(MemoryLayout<Unmanaged<CATapDescription>>.size), &ref)
        if status == noErr {
            selection = sel
        } else {
            FileHandle.standardError.write(Data("earshot: updating the \(target.label) tap failed (\(Self.statusText(status)))\n".utf8))
        }
    }

    /// Call with `lock` held and the listener already removed (it is added last, so a failed start has none).
    /// Destroys, in reverse order, whatever exists.
    private func teardown() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        tapID = AudioObjectID(kAudioObjectUnknown)
        description = nil
        selection = nil
    }

    // MARK: Helpers

    /// Copies the tap's buffers out of the IOProc's buffer list (valid only during the call), at the range
    /// found from the aggregate's streams (or, if those couldn't be read, the last ones).
    static func copy(_ list: UnsafePointer<AudioBufferList>, layout: LayoutBox) -> AVAudioPCMBuffer? {
        let format = layout.format
        let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        let needed = format.isInterleaved ? 1 : Int(format.channelCount)
        let range = layout.range ?? max(0, src.count - needed)..<src.count
        guard needed > 0, range.count == needed, range.upperBound <= src.count else {
            layout.warn("the tap's IOProc got \(src.count) buffers; expected the tap's at \(range)")
            return nil
        }
        let tapBuffers = Array(src[range])
        let channelsPerBuffer = format.isInterleaved ? format.channelCount : 1
        if tapBuffers[0].mNumberChannels != channelsPerBuffer {
            layout.warn("the tap's buffer has \(tapBuffers[0].mNumberChannels) channels; its stream format says \(channelsPerBuffer)")
        }
        let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
        guard bytesPerFrame > 0, tapBuffers[0].mDataByteSize > 0 else { return nil }
        let frames = tapBuffers[0].mDataByteSize / bytesPerFrame
        guard frames > 0, let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        out.frameLength = frames
        let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
        for (i, s) in tapBuffers.enumerated() where i < dst.count {
            guard let from = s.mData, let to = dst[i].mData else { continue }
            memcpy(to, from, Int(min(s.mDataByteSize, dst[i].mDataByteSize)))
        }
        return out
    }

    /// The virtual formats of a device's input streams, in order (empty if any can't be read).
    static func inputStreamFormats(_ device: AudioObjectID) -> [AudioStreamBasicDescription] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioStreamID](repeating: 0, count: Int(size) / MemoryLayout<AudioStreamID>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &ids) == noErr else { return [] }
        var formats: [AudioStreamBasicDescription] = []
        for id in ids.prefix(Int(size) / MemoryLayout<AudioStreamID>.size) {
            var a = Self.address(kAudioStreamPropertyVirtualFormat)
            var d = AudioStreamBasicDescription()
            var sz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            guard AudioObjectGetPropertyData(id, &a, 0, nil, &sz, &d) == noErr else { return [] }
            formats.append(d)
        }
        return formats
    }

    static func defaultOutputUID() -> String? {
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != kAudioObjectUnknown else { return nil }
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        address = Self.address(kAudioDevicePropertyDeviceUID)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid) == noErr, let uid else { return nil }
        return uid.takeRetainedValue() as String
    }

    static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private func check(_ status: OSStatus, _ what: String) throws {
        guard status != noErr else { return }
        throw CaptureError("\(what) failed (\(Self.statusText(status)))")
    }

    /// "OSStatus 560947818 'what'" when the code is a four-character code, else the number.
    static func statusText(_ status: OSStatus) -> String {
        let n = UInt32(bitPattern: status)
        let bytes = [24, 16, 8, 0].map { UInt8((n >> $0) & 0xFF) }
        if bytes.allSatisfy({ $0 >= 32 && $0 < 127 }) {
            return "OSStatus \(status) '\(String(decoding: bytes, as: UTF8.self))'"
        }
        return "OSStatus \(status)"
    }
}

/// What the IOProc block needs to pick out the tap's buffers: their format, where they are, a log-once.
struct LayoutBox: @unchecked Sendable {
    let format: AVAudioFormat
    let range: Range<Int>?
    let warn: LogOnce
}
