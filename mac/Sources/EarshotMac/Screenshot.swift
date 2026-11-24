import CoreGraphics
import EarshotCore
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The panel's 📷: the call app's frontmost window, else the main display (without Earshot's own windows).
/// The first use raises macOS's Screen Recording prompt; denied, it returns nil and the panel says
/// "Couldn't capture the screen".
enum Screenshot {
    static func capture(appBundlePrefix: String?) async -> (png: Data, width: Int, height: Int)? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let filter: SCContentFilter
            if let window = callWindow(in: content, prefix: appBundlePrefix) {
                filter = SCContentFilter(desktopIndependentWindow: window)
            } else {
                guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first
                else { return nil }
                let me = ProcessInfo.processInfo.processIdentifier
                filter = SCContentFilter(display: display, excludingApplications: content.applications.filter { $0.processID == me },
                                         exceptingWindows: [])
            }
            let config = SCStreamConfiguration()
            let scale = CGFloat(filter.pointPixelScale)
            config.width = max(1, Int((filter.contentRect.width * scale).rounded()))
            config.height = max(1, Int((filter.contentRect.height * scale).rounded()))
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard let png = pngData(image) else { return nil }
            return (png, image.width, image.height)
        } catch {
            FileHandle.standardError.write(Data("earshot: screenshot failed: \(error)\n".utf8))
            return nil
        }
    }

    private static func callWindow(in content: SCShareableContent, prefix: String?) -> SCWindow? {
        let candidates = content.windows.map {
            WindowCandidate(id: $0.windowID, bundleId: $0.owningApplication?.bundleIdentifier, layer: $0.windowLayer,
                            onScreen: $0.isOnScreen, width: Double($0.frame.width), height: Double($0.frame.height))
        }
        guard let id = ScreenshotTarget.pick(candidates, frontToBack: frontToBackWindowIds(), prefix: prefix) else { return nil }
        return content.windows.first { $0.windowID == id }
    }

    /// The window server's on-screen order, front first. Window numbers and owners need no permission.
    private static func frontToBackWindowIds() -> [UInt32] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
    }

    private static func pngData(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }
}
