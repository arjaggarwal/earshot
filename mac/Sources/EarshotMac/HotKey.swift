import Carbon.HIToolbox
import Foundation

/// A system-wide shortcut through Carbon's `RegisterEventHotKey`, which needs no permission (unlike an
/// event tap). The action runs on the main thread. Keep the object: releasing it unregisters the key.
final class HotKey {
    /// ⌥⇧R: Start recording, in the style of the extension's ⌥⇧ keys (E, S, N).
    static let startRecording = (keyCode: UInt32(kVK_ANSI_R), modifiers: UInt32(optionKey | shiftKey))

    private static var actions: [UInt32: () -> Void] = [:]
    private static var handlerInstalled = false
    private static var nextId: UInt32 = 1

    private let id: UInt32
    private var ref: EventHotKeyRef?

    /// nil if the key is taken (another app registered it first).
    init?(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) {
        Self.installHandler()
        id = Self.nextId
        Self.nextId += 1
        let hotKeyId = EventHotKeyID(signature: OSType(0x4541_5253), id: id) // 'EARS'
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(keyCode, modifiers, hotKeyId, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            FileHandle.standardError.write(Data("earshot: couldn't register the shortcut (\(status))\n".utf8))
            return nil
        }
        self.ref = ref
        Self.actions[id] = action
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        Self.actions[id] = nil
    }

    private static func installHandler() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hotKeyId = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyId)
            guard status == noErr else { return status }
            let id = hotKeyId.id
            DispatchQueue.main.async { HotKey.actions[id]?() }
            return noErr
        }, 1, &spec, nil, nil)
    }
}
