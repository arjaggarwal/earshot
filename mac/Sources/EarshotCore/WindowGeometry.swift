import CoreGraphics
import Foundation

/// Window placement for the launcher/panel and the prompt, in AppKit screen coordinates (origin bottom left,
/// y up). `screens` are the screens' visible frames (without the menu bar and the Dock).
public enum WindowGeometry {
    /// A pointer move in the page's screen coordinates (`screenX`/`screenY`, y down) applied to a frame.
    public static func moved(_ frame: CGRect, dx: Double, dy: Double) -> CGRect {
        frame.offsetBy(dx: dx, dy: -dy)
    }

    /// The screen the frame belongs on: the one it overlaps most, else the nearest to its centre.
    public static func screen(for frame: CGRect, in screens: [CGRect]) -> CGRect? {
        func overlap(_ s: CGRect) -> CGFloat {
            let i = s.intersection(frame)
            return i.isNull ? 0 : i.width * i.height
        }
        if let best = screens.max(by: { overlap($0) < overlap($1) }), overlap(best) > 0 { return best }
        let c = CGPoint(x: frame.midX, y: frame.midY)
        func distance(_ s: CGRect) -> CGFloat {
            let dx = max(s.minX - c.x, 0, c.x - s.maxX)
            let dy = max(s.minY - c.y, 0, c.y - s.maxY)
            return dx * dx + dy * dy
        }
        return screens.min(by: { distance($0) < distance($1) })
    }

    /// The frame moved (not resized) to lie on `screen`. Wider or taller than the screen: its left edge or
    /// top edge is kept on screen, so the header (and the launcher's E) stay reachable.
    public static func clamp(_ frame: CGRect, to screen: CGRect) -> CGRect {
        var f = frame
        f.origin.x = f.width > screen.width ? screen.minX : min(max(f.minX, screen.minX), screen.maxX - f.width)
        f.origin.y = f.height > screen.height ? screen.maxY - f.height : min(max(f.minY, screen.minY), screen.maxY - f.height)
        return f
    }

    public static func clamp(_ frame: CGRect, screens: [CGRect]) -> CGRect {
        guard let screen = screen(for: frame, in: screens) else { return frame }
        return clamp(frame, to: screen)
    }

    /// The new size with the top-left corner where it was (the launcher sits at the window's top left and
    /// the panel at the same inset, so E stays put), then kept on screen.
    public static func resized(_ frame: CGRect, to size: CGSize, screens: [CGRect]) -> CGRect {
        let f = CGRect(x: frame.minX, y: frame.maxY - size.height, width: size.width, height: size.height)
        return clamp(f, screens: screens)
    }

    /// Where the launcher first appears: at the right edge, below where the prompt shows.
    public static func launcherFrame(size: CGSize, screen: CGRect) -> CGRect {
        CGRect(x: screen.maxX - size.width - 16, y: screen.maxY - size.height - 140, width: size.width, height: size.height)
    }

    /// The prompt: the top right corner, like a notification.
    public static func promptFrame(size: CGSize, screen: CGRect) -> CGRect {
        CGRect(x: screen.maxX - size.width - 12, y: screen.maxY - size.height - 12, width: size.width, height: size.height)
    }
}

/// Turns the page's drag deltas into window frames. The window follows where the pointer has taken it
/// (`unclamped`), kept on screen; so a window pinned at an edge waits for the pointer to come back rather
/// than drifting from it, and moves to the next screen once it would be mostly there.
public struct DragTracker {
    /// Deltas further apart than this start a new drag.
    public let gap: TimeInterval
    private var unclamped: CGRect?
    private var last: CGRect?
    private var lastAt = Date.distantPast

    public init(gap: TimeInterval = 0.5) {
        self.gap = gap
    }

    public mutating func drag(_ frame: CGRect, dx: Double, dy: Double, screens: [CGRect], now: Date) -> CGRect {
        // A new drag, or the window moved or resized since: start from where it is.
        if unclamped == nil || now.timeIntervalSince(lastAt) > gap || !Self.same(last, frame) {
            unclamped = frame
        }
        let target = WindowGeometry.moved(unclamped!, dx: dx, dy: dy)
        unclamped = target
        let result = WindowGeometry.clamp(target, screens: screens)
        last = result
        lastAt = now
        return result
    }

    /// AppKit may round a frame it was given to the pixel grid.
    static func same(_ a: CGRect?, _ b: CGRect) -> Bool {
        guard let a else { return false }
        return abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }
}
