import AppKit
import EarshotCore

/// Wires EarshotCore's `SessionController` to the app: the real recorder (mic, process taps, live speech),
/// the panel's page, the helper, the menu bar and prompt, and a 2 s tick that reads Core Audio's process list
/// (`CallWatcher`) and `run/browser.json` (`BrowserState`). All the decisions are in the controller, which
/// is unit-tested with fakes; this file only plugs things in.
@MainActor
final class Sessions {
    static let tickEvery: TimeInterval = 2

    let controller: SessionController
    private let home: URL
    private let watcher = CallWatcher(source: CoreAudioClientSource())
    private var loop: Task<Void, Never>?

    init(app: EarshotApp) {
        home = app.home
        controller = SessionController(
            home: app.home, helper: app.helper, panel: app.panel, shell: app,
            makeRecorder: { request in
                // Asks for the mic and speech recognition the first time (Alex has just clicked); live text
                // is then on or off for the whole capture.
                _ = await Recorder.requestPermissions()
                return Recorder(folder: request.folder, tracks: request.tracks, captureId: request.captureId,
                                startedAt: request.startedAt)
            })

        let controller = self.controller
        app.panel.inUse = { controller.needsPanel }
        app.onStartRecording = { Task { await controller.startManual() } }
        app.onCapture = { kind in Task { await controller.capture(kind) } }
        app.onNotNow = { kind in controller.notNow(kind) }
        app.onStop = { Task { await controller.stop() } }
        app.onSetPaused = { value, source in try await controller.setPaused(value, from: source) }
        app.onPanelReloaded = { Task { await controller.panelReloaded() } }
    }

    /// Recovery and the first sweep, then the tick. Nothing here records: only a click starts a capture.
    func start() {
        let controller = self.controller
        Task { await controller.launch() }
        let browserFile = home.appendingPathComponent("run/browser.json")
        let watcher = self.watcher
        loop = Task {
            while !Task.isCancelled {
                let now = Date()
                _ = watcher.step(now: now)
                await controller.tick(calls: watcher.active, browser: BrowserState.read(from: browserFile, now: now))
                try? await Task.sleep(nanoseconds: UInt64(Self.tickEvery * 1_000_000_000))
            }
        }
    }

    func prepareForQuit() {
        loop?.cancel()
        controller.prepareForQuit()
    }
}
