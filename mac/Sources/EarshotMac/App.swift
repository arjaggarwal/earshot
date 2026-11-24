import AppKit
import EarshotCore

/// The menu-bar app: no Dock icon (LSUIElement, and the accessory policy for an unbundled run), the menu,
/// ⌥⇧R, the launcher/panel window and the capture prompt.
///
/// This shell never records by itself. Every way in (Start recording and ⌥⇧R, the prompt's Capture, Stop,
/// Pause) only calls one of the `on…` hooks below; the session code (Session.swift, EarshotCore
/// `SessionController`) sets them, runs the capture, and reports back through `SessionShell` and the panel.
@MainActor
final class EarshotApp: NSObject, NSApplicationDelegate, SessionShell {
    static func run() -> Never {
        let app = NSApplication.shared
        let delegate = EarshotApp()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        exit(0)
    }

    /// ~/Earshot (or EARSHOT_HOME): where the helper keeps meetings, browser.json and run files.
    let home: URL
    /// The helper the panel and the sessions share. Its `pushes` stream is the session code's to read.
    let helper: HelperClient
    /// From Info.plist `EarshotExtensionID` (bundle.sh, from the manifest's key). nil: Open meetings is off.
    let extensionId: String?
    // The windows and the status item exist from applicationDidFinishLaunching on.
    private(set) var panel: PanelWindow!
    private(set) var prompt: PromptWindow!
    private(set) var menuBar: MenuBar!
    private var hotKey: HotKey?
    private var sessions: Sessions?
    /// Runs once the windows exist, at the end of applicationDidFinishLaunching: where the session code
    /// sets the hooks below and starts watching for calls.
    static var onLaunched: ((EarshotApp) -> Void)?

    // MARK: - Hooks for the session code (each way in calls one; none of them records here)

    /// Start recording in the menu, and ⌥⇧R.
    var onStartRecording: (() -> Void)?
    /// Stop in the menu or the panel.
    var onStop: (() -> Void)?
    /// Pause/Resume in the menu, or the panel's pause button. Throws when nothing was paused.
    var onSetPaused: ((Bool, SessionController.PauseSource) async throws -> Void)?
    /// The prompt's Capture (the prompt has already closed).
    var onCapture: ((PromptKind) -> Void)?
    /// The prompt's Not now (the prompt has already closed): `PromptPolicy.dismissed`.
    var onNotNow: ((PromptKind) -> Void)?
    /// The panel's page was reloaded after a crash; `panel.start` the current meeting again.
    var onPanelReloaded: (() -> Void)?
    /// Which app 📷 captures: the call app's bundle id prefix (`CallApp.bundlePrefix`, or Chrome's for a
    /// captions-off capture); nil captures the main display.
    var screenshotAppPrefix: String?

    // MARK: - What the session code reports

    /// The red dot in the menu bar (the launcher's colour comes from the panel's status).
    func setRecording(_ on: Bool) { menuBar.setRecording(on) }
    func setPaused(_ on: Bool) { menuBar.setPaused(on) }
    /// `PromptPolicy.next`'s answer: shows, updates in place, or closes the one prompt.
    func showPrompt(_ kind: PromptKind?) { prompt.show(kind) }
    func setScreenshotApp(_ prefix: String?) { screenshotAppPrefix = prefix }

    /// Something Alex must know (a capture that couldn't start, a write-up that failed). It never takes
    /// focus from the call: a "!" by the icon and the message at the top of the menu, until he opens it.
    func showError(_ message: String) {
        FileHandle.standardError.write(Data("earshot: \(message)\n".utf8))
        menuBar.setNotice(message)
    }

    /// The meetings page in Chrome, at `id` if given.
    func openMeetings(id: String?) {
        guard let url = MeetingsLink.url(extensionId: extensionId, meetingId: id) else { return }
        guard let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            FileHandle.standardError.write(Data("earshot: Google Chrome isn't installed\n".utf8))
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: config) { _, error in
            if let error { FileHandle.standardError.write(Data("earshot: couldn't open the meetings page: \(error)\n".utf8)) }
        }
    }

    override init() {
        let env = ProcessInfo.processInfo.environment["EARSHOT_HOME"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
        home = env ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Earshot")
        let location = HelperLocation.installed(home: home)
        helper = HelperClient(nodePath: location.node, hostPath: location.host, home: env)
        extensionId = MeetingsLink.extensionId(from: Bundle.main.infoDictionary)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let web = Bundle.main.resourceURL?.appendingPathComponent("Web")
        let webFolder = web.flatMap { FileManager.default.fileExists(atPath: $0.appendingPathComponent("panel.html").path) ? $0 : nil }
        if let webFolder { Fonts.registerInter(in: webFolder.appendingPathComponent("fonts")) }
        panel = PanelWindow(helper: helper, webFolder: webFolder)
        prompt = PromptWindow()
        menuBar = MenuBar(canOpenMeetings: extensionId != nil)

        menuBar.onStart = { [weak self] in self?.onStartRecording?() }
        menuBar.onStop = { [weak self] in self?.onStop?() }
        menuBar.onSetPaused = { [weak self] value in
            Task { @MainActor in try? await self?.onSetPaused?(value, .menu) }
        }
        menuBar.onOpenMeetings = { [weak self] in self?.openMeetings(id: self?.panel.meetingId) }
        panel.onSetPaused = { [weak self] value in
            guard let hook = self?.onSetPaused else { throw SessionError.notRecording }
            try await hook(value, .panel)
        }
        panel.onStop = { [weak self] in self?.onStop?() }
        panel.onOpenMeetings = { [weak self] id in self?.openMeetings(id: id) }
        panel.screenshotPrefix = { [weak self] in self?.screenshotAppPrefix }
        prompt.onCapture = { [weak self] kind in self?.onCapture?(kind) }
        prompt.onNotNow = { [weak self] kind in self?.onNotNow?(kind) }
        panel.onPageReloaded = { [weak self] in self?.onPanelReloaded?() }

        let key = HotKey.startRecording
        hotKey = HotKey(keyCode: key.keyCode, modifiers: key.modifiers) { [weak self] in
            MainActor.assumeIsolated { self?.onStartRecording?() }
        }
        // Another app holds ⌥⇧R: the menu doesn't offer a shortcut that does nothing.
        menuBar.showShortcut(hotKey != nil)

        let sessions = Sessions(app: self)
        self.sessions = sessions
        sessions.start()
        Self.onLaunched?(self)
    }

    func applicationWillTerminate(_ notification: Notification) {
        sessions?.prepareForQuit()
        hotKey = nil
    }
}
