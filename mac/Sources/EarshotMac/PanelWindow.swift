import AppKit
import EarshotCore
import WebKit

/// Clicks reach the page even while the panel isn't key, so the call app keeps focus.
final class PanelWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Borderless, so it can't become key unless `allowKey` says so (a text field in the page has focus).
final class FloatingPanel: NSPanel {
    var allowKey = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }
}

/// The launcher and the panel: one non-activating, always-on-top, transparent panel holding a web view on
/// `Earshot.app/Contents/Resources/Web/panel.html` (the extension's sidebar.js, mac/Web). The page tells it
/// what shows (`layout`), moves it (`drag`), and asks for helper ops, screenshots and the rest through the
/// `native` bridge (EarshotCore `NativeBridge`).
///
/// It stays hidden until the page shows something: the panel appears once `start` has given it a meeting,
/// and hides again when the panel goes, after the meeting ends.
///
/// Calls into the page (`start`, `segments`, `replaceSegments`, `status`, `ended`, …) wait for it to load and
/// run one at a time in the page (mac-background.js). If the page can't load (no Web folder, a failed
/// navigation) they throw instead of waiting for ever.
///
/// The web view is made on the first call, not at launch: idle, the app holds no web process.
@MainActor
final class PanelWindow: NSObject, NativeBridgeHost, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate
{
    let window: FloatingPanel
    private(set) var webView: PanelWebView?
    private let helperClient: HelperClient
    private let webFolder: URL?

    /// The bundle id prefix of the app whose window 📷 captures (nil: the main display).
    var screenshotPrefix: () -> String? = { nil }
    /// The panel's pause button. It throws when the session couldn't pause, so the page doesn't show Paused.
    var onSetPaused: ((Bool) async throws -> Void)?
    var onStop: (() -> Void)?
    var onOpenMeetings: ((String?) -> Void)?
    /// The page was reloaded after its web process died: its meeting is gone and needs `start` again.
    var onPageReloaded: (() -> Void)?

    /// The meeting last given to `start`.
    private(set) var meetingId: String?

    private enum Load { case idle, loading, loaded, failed(Error) }
    private var load: Load = .idle
    private var crashed = false
    private var waiting: [CheckedContinuation<Void, Error>] = []
    private var dragTracker = DragTracker()
    private var placed = false
    /// The app that was in front when a text field took the keyboard: it gets it back afterwards.
    private var keyFrom: NSRunningApplication?
    /// The page said it has nothing on show or pending (cleared by every call into it).
    private var pageIsIdle = false
    private var inFlight = 0
    private var loadGeneration = 0
    static let loadTimeout: TimeInterval = 20
    /// Whether the sessions still need the page (a capture, or one being written up).
    var inUse: () -> Bool = { false }
    private static let originKey = "EarshotLauncherTopLeft"

    struct PanelError: Error, LocalizedError {
        let errorDescription: String?
    }

    init(helper: HelperClient, webFolder: URL?) {
        helperClient = helper
        self.webFolder = webFolder

        window = FloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 96, height: 160),
                               styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isFloatingPanel = true
        window.level = .floating
        window.becomesKeyOnlyIfNeeded = true
        window.hidesOnDeactivate = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false // the page draws the panel's shadow inside its 8 px margin
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.title = "Earshot"
        super.init()
    }

    /// The web view, made on first use. The script handler goes through a weak proxy: the content
    /// controller keeps its handlers, and the web view keeps the controller.
    private func makeWebView() -> PanelWebView {
        if let webView { return webView }
        let contentController = WKUserContentController()
        contentController.addScriptMessageHandler(WeakScriptHandler(self), contentWorld: .page, name: "native")
        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        // The page keeps working while the panel is hidden: saves, the minutes timer, vault filing and the
        // daily-note line. By default a web view that isn't on screen is suspended and its timers never fire,
        // so a meeting that ended with the panel hidden (or one recovered after a crash) never got minutes
        // or its daily-note line.
        config.preferences.inactiveSchedulingPolicy = .none
        let view = PanelWebView(frame: NSRect(x: 0, y: 0, width: 96, height: 160), configuration: config)
        view.setValue(false, forKey: "drawsBackground") // transparent: only the panel or the launcher shows
        #if DEBUG
        view.isInspectable = true // Safari → Develop, for debugging the panel
        #endif
        view.navigationDelegate = self
        view.uiDelegate = self
        window.contentView = view
        webView = view
        return view
    }

    private func loadPage() {
        let view = makeWebView()
        guard let webFolder else {
            fail(PanelError(errorDescription: "The panel's files are missing (run Earshot.app built by mac/scripts/bundle.sh)."))
            return
        }
        load = .loading
        loadGeneration += 1
        let generation = loadGeneration
        view.loadFileURL(webFolder.appendingPathComponent("panel.html"), allowingReadAccessTo: webFolder)
        // A page that never finishes loading mustn't hold up a stop or a waiting click for ever.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.loadTimeout * 1_000_000_000))
            guard let self, self.loadGeneration == generation, case .loading = self.load else { return }
            self.webView?.stopLoading()
            self.fail(PanelError(errorDescription: "The panel didn't load within \(Int(Self.loadTimeout)) s."))
        }
    }

    private func fail(_ error: Error) {
        FileHandle.standardError.write(Data("earshot: panel failed to load: \(error)\n".utf8))
        load = .failed(error)
        let failed = waiting
        waiting = []
        for w in failed { w.resume(throwing: error) }
    }

    // MARK: - Calls into the page (mac-background.js `earshotMac`)

    /// A meeting to show: new, or the same id again. `meeting` is the record (helper `save-meeting` shape).
    func start(meeting: [String: Any], settings: [String: Any] = [:], status: [String: Any]? = nil) async throws {
        meetingId = meeting["id"] as? String
        var arg: [String: Any] = ["meeting": meeting, "settings": settings]
        if let status { arg["status"] = status }
        try await callPage("start", arg)
    }

    /// The menu paused or resumed: the page's pause button and status follow.
    func showPaused(_ value: Bool) async throws {
        try await callPage("setPaused", value)
    }

    func renameSpeaker(speakerId: String, name: String) async throws {
        try await callPage("renameSpeaker", ["speakerId": speakerId, "name": name])
    }

    /// Ends a meeting that isn't on show (see mac-background.js `finish`).
    func finish(meeting: [String: Any], segments: [Segment]?, endedAt: String?, rename: SpeakerRename?) async throws {
        let arg: [String: Any] = [
            "meeting": meeting,
            "segments": try segments.map { try PageValue.from($0) } ?? NSNull(),
            "endedAt": endedAt ?? NSNull(),
            "rename": rename.map { ["speakerId": $0.speakerId, "name": $0.name] as [String: Any] } ?? NSNull(),
        ]
        try await callPage("finish", arg)
    }

    /// Live lines, new or revised (by id), for that meeting (dropped by the page if it shows another).
    func segments(_ list: [Segment], meetingId: String) async throws {
        try await callPage("segments", ["meetingId": meetingId, "segments": try PageValue.from(list)])
    }

    /// A status line for that meeting's panel (ignored once another meeting is on show).
    func status(level: String, text: String, meetingId: String) async throws {
        try await callPage("status", ["level": level, "text": text, "meetingId": meetingId])
    }

    private func callPage(_ method: String, _ arg: Any?) async throws {
        pageIsIdle = false
        inFlight += 1
        defer { inFlight -= 1 }
        try await whenLoaded()
        guard let webView else { throw PanelError(errorDescription: "The panel isn't there.") }
        let body = arg == nil ? "await window.earshotMac.\(method)(); return true;" : "await window.earshotMac.\(method)(arg); return true;"
        let arguments: [String: Any] = arg.map { ["arg": $0] } ?? [:]
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .success: done.resume()
                case .failure(let error): done.resume(throwing: error)
                }
            }
        }
    }

    /// Loads the page on first use; after a failed load, the next call tries again.
    private func whenLoaded() async throws {
        switch load {
        case .loaded: return
        case .idle, .failed: loadPage()
        case .loading: break
        }
        if case .failed(let error) = load { throw error }
        try await withCheckedThrowingContinuation { waiting.append($0) }
    }

    // MARK: - NativeBridgeHost (the page's calls)

    func helper(op: String, payload: [String: Any]) async throws -> Any {
        try await helperClient.call(op, payload)
    }

    func screenshot() async -> (png: Data, width: Int, height: Int)? {
        await Screenshot.capture(appBundlePrefix: screenshotPrefix())
    }

    func setPaused(_ value: Bool) async throws {
        guard let onSetPaused else { throw SessionError.notRecording }
        try await onSetPaused(value)
    }

    func stop() async {
        onStop?()
    }

    func openMeetings(id: String?) {
        onOpenMeetings?(id ?? meetingId)
    }

    func layout(_ layout: PanelLayout) {
        switch layout {
        case .hidden:
            window.allowKey = false
            window.orderOut(nil)
            releaseIfIdle()
        case .shown(_, let width, let height):
            let size = CGSize(width: width, height: height)
            let screens = NSScreen.screens.map(\.visibleFrame)
            let frame: CGRect
            if placed {
                frame = WindowGeometry.resized(window.frame, to: size, screens: screens)
            } else {
                placed = true
                frame = firstFrame(size: size, screens: screens)
            }
            window.setFrame(frame, display: true)
            if !window.isVisible { window.orderFrontRegardless() }
        }
    }

    func drag(dx: Double, dy: Double) {
        let frame = dragTracker.drag(window.frame, dx: dx, dy: dy, screens: NSScreen.screens.map(\.visibleFrame), now: Date())
        window.setFrameOrigin(frame.origin)
        UserDefaults.standard.set([frame.minX, frame.maxY], forKey: Self.originKey)
    }

    /// Key only while a text field has focus (mac/Web/mac-focus.js), so typing notes works and clicks
    /// elsewhere leave the call app in front.
    func pageIdle() {
        pageIsIdle = true
        releaseIfIdle()
    }

    /// Lets the web view (and its web process) go when nothing shows, nothing is pending in the page and no
    /// session needs it: idle, the app holds no web process. The next call makes a new one. The page's
    /// `idle` may be stale by the time it's handled (minutes scheduled since), so the page is asked again
    /// right before.
    func releaseIfIdle() {
        guard canRelease, let view = webView else { return }
        view.evaluateJavaScript("window.earshotMac ? window.earshotMac.isIdle() : false") { [weak self] result, _ in
            MainActor.assumeIsolated {
                guard let self, result as? Bool == true, self.canRelease, self.webView === view else { return }
                self.tearDown(view)
            }
        }
    }

    private var canRelease: Bool {
        guard pageIsIdle, inFlight == 0, waiting.isEmpty, !window.isVisible, !inUse(), webView != nil else { return false }
        if case .loaded = load { return true }
        return false
    }

    private func tearDown(_ view: PanelWebView) {
        view.stopLoading()
        view.configuration.userContentController.removeAllScriptMessageHandlers()
        view.navigationDelegate = nil
        view.uiDelegate = nil
        window.contentView = nil
        webView = nil
        load = .idle
        crashed = false
        pageIsIdle = false
    }

    func focus(editing: Bool) {
        window.allowKey = editing
        if editing {
            guard window.isVisible else { return }
            if !window.isKeyWindow, let front = NSWorkspace.shared.frontmostApplication,
               front.processIdentifier != ProcessInfo.processInfo.processIdentifier {
                keyFrom = front
            }
            window.makeKey()
            window.makeFirstResponder(webView)
        } else {
            giveKeyBack()
        }
    }

    /// Done typing: the call app (or whatever was in front) gets the keyboard again, so its shortcuts work.
    private func giveKeyBack() {
        let previous = keyFrom
        keyFrom = nil
        guard window.isKeyWindow else { return }
        // The panel never activates Earshot, so the app in front is still the call app.
        let me = ProcessInfo.processInfo.processIdentifier
        if let target = previous ?? NSWorkspace.shared.frontmostApplication, target.processIdentifier != me, !target.isTerminated {
            target.activate()
        }
        DispatchQueue.main.async { [weak self] in
            // Still key (that app was already active, so activating it changed nothing): ordering the panel
            // out and back hands the keyboard to the app's own window. It can't become key again now.
            guard let self, self.window.isKeyWindow, !self.window.allowKey, self.window.isVisible else { return }
            self.window.orderOut(nil)
            self.window.orderFrontRegardless()
        }
    }

    /// Where the launcher was last left (its top-left corner), else the right edge of the main screen.
    private func firstFrame(size: CGSize, screens: [CGRect]) -> CGRect {
        if let saved = UserDefaults.standard.array(forKey: Self.originKey) as? [Double], saved.count == 2 {
            return WindowGeometry.clamp(CGRect(x: saved[0], y: saved[1] - size.height, width: size.width, height: size.height), screens: screens)
        }
        let screen = NSScreen.screens.first?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return WindowGeometry.launcherFrame(size: size, screen: screen)
    }

    // MARK: - WKScriptMessageHandlerWithReply

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Only panel.html itself talks to the app, never a frame inside it.
        guard message.frameInfo.isMainFrame else { return replyHandler(nil, "Earshot for Mac answers the panel only.") }
        let body = message.body
        Task { @MainActor in
            let (value, error) = await NativeBridge.handle(body, host: self)
            replyHandler(value, error)
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        load = .loaded
        let resumed = waiting
        waiting = []
        for w in resumed { w.resume() }
        if crashed {
            crashed = false
            onPageReloaded?()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard case .loading = load else { return }
        fail(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard case .loading = load else { return }
        fail(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page's records are gone with it; the session code restarts the meeting on onPageReloaded.
        FileHandle.standardError.write(Data("earshot: the panel's web process stopped; reloading\n".utf8))
        crashed = true
        window.orderOut(nil)
        loadPage()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        switch url.scheme?.lowercased() {
        case "file":
            // Only the panel's own folder.
            let path = url.standardizedFileURL.path
            let inside = webFolder.map { path == $0.standardizedFileURL.path || path.hasPrefix($0.standardizedFileURL.path + "/") } ?? false
            decisionHandler(inside ? .allow : .cancel)
        case "about", "blob", "data":
            decisionHandler(navigationAction.targetFrame?.isMainFrame == false ? .allow : .cancel)
        default:
            // A clicked link (an Ask AI answer, the meeting's URL) opens in its own app, never in the panel.
            Self.openExternally(navigationAction)
            decisionHandler(.cancel)
        }
    }

    /// Only a link Alex clicked, and only to the web or mail: nothing a page script starts by itself.
    static func openExternally(_ action: WKNavigationAction) {
        guard action.navigationType == .linkActivated, let url = action.request.url,
              ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        Self.openExternally(navigationAction)
        return nil
    }

    // MARK: - WKDownloadDelegate (Export, Debug info)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        completionHandler(Self.downloadDestination(suggestedFilename))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        FileHandle.standardError.write(Data("earshot: download failed: \(error)\n".utf8))
    }

    /// ~/Downloads/<name>, with " 2", " 3"… before the extension if it's taken.
    static func downloadDestination(_ suggested: String) -> URL {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        let name = (suggested as NSString).lastPathComponent.isEmpty ? "earshot-download" : (suggested as NSString).lastPathComponent
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var url = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return url
    }
}

/// Holds the panel weakly for WebKit, which keeps its script handlers for as long as the web view lives.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: (NSObject & WKScriptMessageHandlerWithReply)?
    init(_ target: NSObject & WKScriptMessageHandlerWithReply) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, "Earshot for Mac's panel is gone.") }
        target.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}

extension PanelWindow: SessionPanel {
    func start(meeting: [String: Any], status: [String: Any]?) async throws {
        try await start(meeting: meeting, settings: [:], status: status)
    }
}
