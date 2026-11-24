import CoreGraphics
import Foundation
import Testing
@testable import EarshotCore

// AppKit coordinates: origin at the bottom left of the main screen, y up. Visible frames leave out the
// menu bar and the Dock.
@Suite struct WindowGeometryTests {
    let main = CGRect(x: 0, y: 0, width: 1440, height: 875)
    let right = CGRect(x: 1440, y: 0, width: 1920, height: 1055)

    @Test func screenMoveFlipsY() {
        // The page's screenY grows downward; AppKit's y grows upward.
        let frame = CGRect(x: 100, y: 500, width: 96, height: 160)
        #expect(WindowGeometry.moved(frame, dx: 10, dy: 20) == CGRect(x: 110, y: 480, width: 96, height: 160))
        #expect(WindowGeometry.moved(frame, dx: -5, dy: -7) == CGRect(x: 95, y: 507, width: 96, height: 160))
    }

    @Test func clampKeepsTheWindowOnItsScreen() {
        let w = CGSize(width: 96, height: 160)
        func at(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(origin: CGPoint(x: x, y: y), size: w) }
        #expect(WindowGeometry.clamp(at(-40, 300), screens: [main]) == at(0, 300))
        #expect(WindowGeometry.clamp(at(1400, 300), screens: [main]) == at(1344, 300))
        #expect(WindowGeometry.clamp(at(200, 800), screens: [main]) == at(200, 715))
        #expect(WindowGeometry.clamp(at(200, -50), screens: [main]) == at(200, 0))
        #expect(WindowGeometry.clamp(at(200, 300), screens: [main]) == at(200, 300))
    }

    @Test func aWindowTallerThanTheScreenKeepsItsTopOnScreen() {
        let short = CGRect(x: 0, y: 0, width: 1440, height: 600)
        let frame = CGRect(x: 100, y: -300, width: 376, height: 736)
        #expect(WindowGeometry.clamp(frame, screens: [short]) == CGRect(x: 100, y: -136, width: 376, height: 736))
    }

    @Test func clampPicksTheScreenItOverlapsMostOrTheNearest() {
        let w = CGSize(width: 100, height: 100)
        // Mostly on the right screen.
        #expect(WindowGeometry.clamp(CGRect(origin: CGPoint(x: 1420, y: 950), size: w), screens: [main, right])
                == CGRect(origin: CGPoint(x: 1440, y: 950), size: w))
        // Off every screen (above the main one, where nothing is): onto the nearest.
        #expect(WindowGeometry.clamp(CGRect(origin: CGPoint(x: 300, y: 2000), size: w), screens: [main, right])
                == CGRect(origin: CGPoint(x: 300, y: 775), size: w))
        // No screens at all: unchanged.
        let lost = CGRect(origin: CGPoint(x: 9, y: 9), size: w)
        #expect(WindowGeometry.clamp(lost, screens: []) == lost)
    }

    @Test func resizeKeepsTheTopLeftCorner() {
        // The launcher opening into the panel: same top-left, so E stays under the pointer.
        let launcher = CGRect(x: 1300, y: 600, width: 96, height: 160)
        let panel = WindowGeometry.resized(launcher, to: CGSize(width: 376, height: 736), screens: [main])
        // Top stays at 760; the right edge would pass 1440, so it moves left.
        #expect(panel == CGRect(x: 1064, y: 24, width: 376, height: 736))
        let back = WindowGeometry.resized(panel, to: CGSize(width: 96, height: 160), screens: [main])
        #expect(back == CGRect(x: 1064, y: 600, width: 96, height: 160))
    }

    @Test func firstPlacesAreTopRight() {
        #expect(WindowGeometry.launcherFrame(size: CGSize(width: 96, height: 160), screen: main)
                == CGRect(x: 1440 - 96 - 16, y: 875 - 160 - 140, width: 96, height: 160))
        #expect(WindowGeometry.promptFrame(size: CGSize(width: 320, height: 110), screen: main)
                == CGRect(x: 1440 - 320 - 12, y: 875 - 110 - 12, width: 320, height: 110))
        // On a screen whose origin isn't zero.
        #expect(WindowGeometry.promptFrame(size: CGSize(width: 320, height: 110), screen: right)
                == CGRect(x: 1440 + 1920 - 320 - 12, y: 1055 - 110 - 12, width: 320, height: 110))
    }
}

@Suite struct DragTrackerTests {
    let main = CGRect(x: 0, y: 0, width: 1000, height: 800)
    let right = CGRect(x: 1000, y: 0, width: 1000, height: 800)
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func followsThePointer() {
        var drag = DragTracker()
        var frame = CGRect(x: 100, y: 100, width: 100, height: 100)
        frame = drag.drag(frame, dx: 10, dy: 10, screens: [main], now: t0)
        #expect(frame == CGRect(x: 110, y: 90, width: 100, height: 100))
        frame = drag.drag(frame, dx: 5, dy: -20, screens: [main], now: t0.addingTimeInterval(0.02))
        #expect(frame == CGRect(x: 115, y: 110, width: 100, height: 100))
    }

    @Test func pinsAtTheEdgeAndComesBackWithThePointer() {
        var drag = DragTracker()
        var frame = CGRect(x: 880, y: 100, width: 100, height: 100)
        var t = t0
        func step(_ dx: Double) { t = t.addingTimeInterval(0.02); frame = drag.drag(frame, dx: dx, dy: 0, screens: [main], now: t) }
        step(10)
        step(10)
        #expect(frame.minX == 900) // at the edge
        step(10)
        step(10) // the pointer is now 20 past the edge
        #expect(frame.minX == 900)
        step(-10)
        #expect(frame.minX == 900) // still 10 past it, so the window waits
        step(-15)
        #expect(frame.minX == 895) // back with the pointer
    }

    @Test func crossesToTheNextScreenOnceMostlyThere() {
        var drag = DragTracker()
        var frame = CGRect(x: 900, y: 100, width: 100, height: 100)
        var t = t0
        func step(_ dx: Double) { t = t.addingTimeInterval(0.02); frame = drag.drag(frame, dx: dx, dy: 0, screens: [main, right], now: t) }
        step(30)
        #expect(frame.minX == 900) // 70 on main, 30 on the right: stays on main
        step(30)
        #expect(frame.minX == 1000) // 40 on main, 60 on the right: onto the right screen
        step(30)
        #expect(frame.minX == 1000) // the pointer is 10 short of the window's own place
        step(30)
        #expect(frame.minX == 1020)
    }

    @Test func aNewDragStartsFromWhereTheWindowIs() {
        var drag = DragTracker()
        var frame = CGRect(x: 880, y: 100, width: 100, height: 100)
        frame = drag.drag(frame, dx: 50, dy: 0, screens: [main], now: t0) // pinned at 900, pointer 30 past
        #expect(frame.minX == 900)
        // A second later: a new drag, so no leftover from the first.
        frame = drag.drag(frame, dx: -10, dy: 0, screens: [main], now: t0.addingTimeInterval(1))
        #expect(frame.minX == 890)
        // And the window moved by something else (a resize) also starts afresh.
        frame = CGRect(x: 500, y: 100, width: 100, height: 100)
        frame = drag.drag(frame, dx: 1, dy: 0, screens: [main], now: t0.addingTimeInterval(1.01))
        #expect(frame.minX == 501)
    }
}
