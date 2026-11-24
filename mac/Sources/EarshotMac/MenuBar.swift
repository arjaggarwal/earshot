import AppKit
import EarshotCore
import ServiceManagement

/// The menu-bar icon and its menu: Start recording (⌥⇧R), Stop, Pause/Resume, Open meetings, Open at login,
/// Quit. While a capture is going the icon carries a red dot (no stealth mode: recording is always visible
/// to Alex). The items only call back; the session code does the work and reports back with
/// `setRecording` / `setPaused`.
@MainActor
final class MenuBar: NSObject, NSMenuDelegate {
    var onStart: (() -> Void)?
    var onStop: (() -> Void)?
    var onSetPaused: ((Bool) -> Void)?
    var onOpenMeetings: (() -> Void)?

    private(set) var state: MenuState
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let startItem: NSMenuItem
    private let stopItem: NSMenuItem
    private let pauseItem: NSMenuItem
    private let meetingsItem: NSMenuItem
    private let loginItem: NSMenuItem
    /// The last thing that went wrong, at the top of the menu (hidden when there's nothing).
    private let noticeItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let noticeSeparator = NSMenuItem.separator()
    private var notice: String?

    init(canOpenMeetings: Bool) {
        state = MenuState(canOpenMeetings: canOpenMeetings)
        startItem = NSMenuItem(title: MenuState.startTitle, action: #selector(start), keyEquivalent: "r")
        startItem.keyEquivalentModifierMask = [.option, .shift] // shown only; the global key is HotKey
        stopItem = NSMenuItem(title: MenuState.stopTitle, action: #selector(stop), keyEquivalent: "")
        pauseItem = NSMenuItem(title: "Pause", action: #selector(togglePause), keyEquivalent: "")
        meetingsItem = NSMenuItem(title: MenuState.openMeetingsTitle, action: #selector(openMeetings), keyEquivalent: "")
        loginItem = NSMenuItem(title: MenuState.openAtLoginTitle, action: #selector(toggleLogin), keyEquivalent: "")
        super.init()

        for i in [startItem, stopItem, pauseItem, meetingsItem, loginItem] { i.target = self }
        let quit = NSMenuItem(title: MenuState.quitTitle, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        noticeItem.isEnabled = false
        menu.items = [noticeItem, noticeSeparator, startItem, stopItem, pauseItem, .separator(), meetingsItem, loginItem, .separator(), quit]
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        if let button = item.button {
            let image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Earshot")
            image?.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeft
            button.toolTip = "Earshot"
        }
        refresh()
    }

    func setRecording(_ on: Bool) {
        state.recording = on
        if !on { state.paused = false }
        refresh()
    }

    func setPaused(_ on: Bool) {
        state.paused = on
        refresh()
    }

    /// ⌥⇧R next to Start recording, only while the shortcut is really registered.
    func showShortcut(_ on: Bool) {
        startItem.keyEquivalent = on ? "r" : ""
        startItem.keyEquivalentModifierMask = on ? [.option, .shift] : []
        startItem.toolTip = on ? nil : "⌥⇧R is taken by another app"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        refresh()
    }

    /// Shows a message without taking focus: "!" by the icon, the text at the top of the menu. It clears
    /// once the menu has been opened and closed (it's been read).
    func setNotice(_ message: String?) {
        notice = message
        refresh()
    }

    func menuDidClose(_ menu: NSMenu) {
        guard notice != nil else { return }
        notice = nil
        refresh()
    }

    private func refresh() {
        state.openAtLogin = SMAppService.mainApp.status == .enabled
        startItem.isEnabled = state.startEnabled
        stopItem.isEnabled = state.stopEnabled
        pauseItem.isEnabled = state.pauseEnabled
        pauseItem.title = state.pauseTitle
        meetingsItem.isEnabled = state.canOpenMeetings
        meetingsItem.toolTip = state.canOpenMeetings ? nil : "Rebuild with bundle.sh (it needs node) to open the meetings page"
        loginItem.state = state.openAtLogin ? .on : .off
        if let notice {
            noticeItem.attributedTitle = NSAttributedString(string: Self.wrap(notice), attributes: [
                .font: NSFont.menuFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor,
            ])
        }
        noticeItem.isHidden = notice == nil
        noticeSeparator.isHidden = notice == nil
        guard let button = item.button else { return }
        button.toolTip = notice.map { "Earshot: \($0)" } ?? "Earshot"
        // An "E" beside the template icon so it's easy to spot; labelColor follows the menu bar's light
        // or dark look, as the icon does. The recording dot is red on any of them; a notice adds an orange "!".
        let title = NSMutableAttributedString(string: " E", attributes: [
            .foregroundColor: NSColor.labelColor, .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
        ])
        let mark = notice == nil ? "" : " !"
        if state.showsRecordingDot {
            title.append(NSAttributedString(string: " ●" + mark, attributes: [
                .foregroundColor: NSColor.systemRed, .font: NSFont.systemFont(ofSize: 11, weight: .bold),
                .baselineOffset: 1,
            ]))
            button.attributedTitle = title
            button.setAccessibilityLabel(state.paused ? "Earshot, recording paused" : "Earshot, recording")
        } else {
            title.append(NSAttributedString(string: mark, attributes: [
                .foregroundColor: NSColor.systemOrange, .font: NSFont.systemFont(ofSize: 11, weight: .bold), .baselineOffset: 1,
            ]))
            button.attributedTitle = title
            button.setAccessibilityLabel(notice == nil ? "Earshot" : "Earshot, something needs your attention")
        }
    }

    /// Menu items don't wrap: break the text into lines of about 46 characters.
    static func wrap(_ text: String, width: Int = 46) -> String {
        var lines: [String] = []
        var line = ""
        for word in text.split(separator: " ") {
            if !line.isEmpty, line.count + 1 + word.count > width {
                lines.append(line)
                line = ""
            }
            line += line.isEmpty ? String(word) : " " + word
        }
        if !line.isEmpty { lines.append(line) }
        return lines.joined(separator: "\n")
    }

    @objc private func start() { onStart?() }
    @objc private func stop() { onStop?() }
    @objc private func togglePause() { onSetPaused?(!state.paused) }
    @objc private func openMeetings() { onOpenMeetings?() }

    /// The login item is Alex's to turn on: nothing registers it at launch.
    @objc private func toggleLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Open at login"
            alert.informativeText = "\(error.localizedDescription)\n\nThis works only for Earshot.app (from mac/scripts/bundle.sh), not the command-line build."
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
        refresh()
    }
}
