import Foundation

// The menu-bar app's words and small decisions, kept out of AppKit so they can be tested.

extension CallApp {
    public var displayName: String {
        switch self {
        case .teams: return "Microsoft Teams"
        case .zoom: return "Zoom"
        }
    }

    /// The bundle id prefix of the app's processes and windows.
    public var bundlePrefix: String {
        switch self {
        case .teams: return "com.microsoft.teams"
        case .zoom: return "us.zoom"
        }
    }
}

/// The prompt's words. It never records by itself: Capture and Not now are the only ways out.
public struct PromptCopy: Equatable, Sendable {
    public static let capture = "Capture"
    public static let notNow = "Not now"

    public var title: String
    /// The second line: the app's name, or the meeting's title.
    public var detail: String?

    public init(title: String, detail: String?) {
        self.title = title
        self.detail = detail
    }

    public init(_ kind: PromptKind) {
        switch kind {
        case .desktopCall(let app):
            self.init(title: "Capture this call?", detail: app.displayName)
        case .captionsOff(_, let title, let lost):
            let name = title?.trimmingCharacters(in: .whitespacesAndNewlines)
            self.init(title: lost ? "Captions stopped in this meeting. Capture with Mac audio?"
                                  : "Captions are off in this meeting. Capture with Mac audio?",
                      detail: name?.isEmpty == false ? name : nil)
        }
    }
}

/// What the one prompt window does when `PromptPolicy.next` gives a new answer.
public enum PromptChange: Equatable, Sendable {
    case none
    case show(PromptKind)
    /// A different prompt while one is up (a desktop call replacing a captions-off one): the same window
    /// changes its words, so prompts never stack.
    case update(PromptKind)
    case close

    public static func between(_ showing: PromptKind?, _ next: PromptKind?) -> PromptChange {
        switch (showing, next) {
        case (nil, nil): return .none
        case (nil, let next?): return .show(next)
        case (_?, nil): return .close
        case (let now?, let next?): return now == next ? .none : .update(next)
        }
    }
}

/// The menu bar's items and the recording dot.
public struct MenuState: Equatable, Sendable {
    public static let startTitle = "Start recording"
    public static let stopTitle = "Stop"
    public static let openMeetingsTitle = "Open meetings"
    public static let openAtLoginTitle = "Open at login"
    public static let quitTitle = "Quit"

    public var recording: Bool
    public var paused: Bool
    public var canOpenMeetings: Bool
    public var openAtLogin: Bool

    public init(recording: Bool = false, paused: Bool = false, canOpenMeetings: Bool = false, openAtLogin: Bool = false) {
        self.recording = recording
        self.paused = paused
        self.canOpenMeetings = canOpenMeetings
        self.openAtLogin = openAtLogin
    }

    public var startEnabled: Bool { !recording }
    public var stopEnabled: Bool { recording }
    public var pauseEnabled: Bool { recording }
    public var pauseTitle: String { paused ? "Resume" : "Pause" }
    /// The red dot shows for the whole capture, paused or not: recording is never hidden from Alex.
    public var showsRecordingDot: Bool { recording }
}

/// The meetings page lives in the Chrome extension: chrome-extension://<id>/app/meetings.html#<meetingId>.
public enum MeetingsLink {
    public static let infoKey = "EarshotExtensionID"

    /// Chrome extension ids are 32 letters a to p.
    public static func isExtensionId(_ s: String) -> Bool {
        s.count == 32 && s.unicodeScalars.allSatisfy { ("a"..."p").contains($0) }
    }

    /// The id bundle.sh wrote into Info.plist from the manifest's key, if it's a real one.
    public static func extensionId(from info: [String: Any]?) -> String? {
        guard let raw = info?[infoKey] as? String else { return nil }
        let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return isExtensionId(id) ? id : nil
    }

    public static func url(extensionId: String?, meetingId: String?) -> URL? {
        guard let extensionId, isExtensionId(extensionId) else { return nil }
        var s = "chrome-extension://\(extensionId)/app/meetings.html"
        if let meetingId, !meetingId.isEmpty {
            var allowed = CharacterSet.urlFragmentAllowed
            allowed.remove(charactersIn: "#")
            s += "#" + (meetingId.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
        }
        return URL(string: s)
    }
}

/// A window ScreenCaptureKit lists, with what the choice needs.
public struct WindowCandidate: Equatable, Sendable {
    public var id: UInt32
    public var bundleId: String?
    public var layer: Int
    public var onScreen: Bool
    public var width: Double
    public var height: Double

    public init(id: UInt32, bundleId: String?, layer: Int, onScreen: Bool, width: Double, height: Double) {
        self.id = id
        self.bundleId = bundleId
        self.layer = layer
        self.onScreen = onScreen
        self.width = width
        self.height = height
    }
}

public enum ScreenshotTarget {
    /// Smaller than this is a toolbar or a mini window, not the call.
    public static let minWidth: Double = 200
    public static let minHeight: Double = 150

    /// The call app's frontmost normal window (`frontToBack`: window ids in the window server's order),
    /// or nil for "capture the screen".
    public static func pick(_ windows: [WindowCandidate], frontToBack: [UInt32], prefix: String?) -> UInt32? {
        guard let prefix = prefix?.lowercased(), !prefix.isEmpty else { return nil }
        let rank = Dictionary(frontToBack.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        return windows
            .filter { ($0.bundleId?.lowercased().hasPrefix(prefix) ?? false) && $0.layer == 0 && $0.onScreen
                && $0.width >= minWidth && $0.height >= minHeight }
            .enumerated()
            .min { (rank[$0.element.id] ?? Int.max, $0.offset) < (rank[$1.element.id] ?? Int.max, $1.offset) }?
            .element.id
    }

    /// The bridge's answer to `screenshot`: what the panel's `add-screenshot` takes.
    public static func reply(png: Data, width: Int, height: Int) -> [String: Any] {
        ["dataUrl": "data:image/png;base64," + png.base64EncodedString(), "width": width, "height": height]
    }
}
