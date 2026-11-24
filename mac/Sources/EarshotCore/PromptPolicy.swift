import Foundation

/// The one prompt the app may show.
public enum PromptKind: Equatable, Sendable {
    /// "Capture this call?" for a Teams or Zoom desktop call.
    case desktopCall(CallApp)
    /// "Captions are off in this meeting. Capture with Mac audio?" (`lost`: captions stopped).
    case captionsOff(meetingId: String, title: String?, lost: Bool)
}

/// Decides which prompt, if any, should be up right now. The app calls `next` on every change
/// (call started or ended, browser.json rewritten, a capture started or stopped) and shows,
/// updates or closes its prompt window to match.
///
/// Rules:
/// - nothing while something is recording;
/// - a desktop call is suppressed while any browser meeting has captions `arriving`;
/// - a browser meeting with captions `off` or `lost` prompts `captionsOff`, unless it is paused;
/// - at most one prompt at a time: desktop calls first (Teams, then Zoom), then browser meetings in file order;
/// - a dismissed prompt doesn't return for 10 minutes (per app, or per meeting id);
/// - when the cause has gone, `next` returns nil so the window closes. That withdrawal is not a dismissal.
///
/// `calls` is `CallWatcher.active`: the apps in a call by the watcher's rules, so a mic gap shorter than
/// 20 s keeps the one prompt up, and the prompt is withdrawn when the watcher ends the call.
public struct PromptPolicy {
    public static let defaultSnooze: TimeInterval = 10 * 60

    public let snooze: TimeInterval
    private var appSnoozedUntil: [CallApp: Date] = [:]
    private var meetingSnoozedUntil: [String: Date] = [:]

    public init(snooze: TimeInterval = PromptPolicy.defaultSnooze) {
        self.snooze = snooze
    }

    public mutating func next(calls: Set<CallApp>, browser: [BrowserMeeting], recording: Bool, now: Date) -> PromptKind? {
        appSnoozedUntil = appSnoozedUntil.filter { $0.value > now }
        meetingSnoozedUntil = meetingSnoozedUntil.filter { $0.value > now }
        if recording { return nil }

        let captionsArriving = browser.contains { $0.captions == .arriving }
        if !captionsArriving {
            for app in CallApp.allCases where calls.contains(app) && appSnoozedUntil[app] == nil {
                return .desktopCall(app)
            }
        }
        for m in browser where !m.paused && (m.captions == .off || m.captions == .lost) && meetingSnoozedUntil[m.meetingId] == nil {
            return .captionsOff(meetingId: m.meetingId, title: m.title, lost: m.captions == .lost)
        }
        return nil
    }

    /// Alex clicked Not now (or closed the prompt).
    public mutating func dismissed(_ kind: PromptKind, at: Date) {
        switch kind {
        case .desktopCall(let app): appSnoozedUntil[app] = at.addingTimeInterval(snooze)
        case .captionsOff(let id, _, _): meetingSnoozedUntil[id] = at.addingTimeInterval(snooze)
        }
    }
}
