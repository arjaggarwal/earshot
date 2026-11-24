import AppKit
import CoreText
import EarshotCore

/// The plugin's typeface, from the panel's own font files (Resources/Web/fonts), for the native windows.
enum Fonts {
    static func registerInter(in folder: URL) {
        for name in ["inter-latin.woff2", "inter-latin-ext.woff2"] {
            let url = folder.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                let why = error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
                FileHandle.standardError.write(Data("earshot: couldn't load \(name): \(why)\n".utf8))
            }
        }
    }

    /// Inter at that weight, or the system font if Inter isn't loaded.
    static func inter(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        let descriptor = NSFontDescriptor(fontAttributes: [.family: "Inter", .traits: [NSFontDescriptor.TraitKey.weight: weight]])
        if let font = NSFont(descriptor: descriptor, size: size), font.familyName == "Inter" { return font }
        return .systemFont(ofSize: size, weight: weight)
    }
}

/// The plugin's colours (extension/content/sidebar.js `.panel`).
enum PluginColor {
    static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
    static let panel = rgb(0x232427)
    static let raised = rgb(0x2c2d31)
    static let line = rgb(0x36383c)
    static let text = rgb(0xe6e4df)
    static let muted = rgb(0xa3a19b)
    static let accent = rgb(0x8fb0cc)
    static let accentInk = rgb(0x13212c)
}

/// A flat button in the plugin's style (6 px corners, no pill, no bezel) that works on the first click in
/// a window that isn't key (the prompt never takes focus).
final class FirstClickButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    convenience init(title: String, primary: Bool, target: AnyObject, action: Selector) {
        self.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.backgroundColor = (primary ? PluginColor.accent : PluginColor.raised).cgColor
        attributedTitle = NSAttributedString(string: title, attributes: [
            .font: Fonts.inter(13, primary ? .semibold : .regular),
            .foregroundColor: primary ? PluginColor.accentInk : PluginColor.text,
        ])
    }

    override var intrinsicContentSize: NSSize {
        let size = attributedTitle.size()
        return NSSize(width: ceil(size.width) + 20, height: 26)
    }
}

/// The one capture prompt: a small non-activating panel at the top right, like a notification. It never
/// records by itself: Capture and Not now only call back (the session code decides what they do).
///
/// Call `show(_:)` with `PromptPolicy.next`'s answer on every change. A different prompt while one is up
/// changes this window's words (no second window); nil closes it.
@MainActor
final class PromptWindow: NSObject {
    var onCapture: ((PromptKind) -> Void)?
    var onNotNow: ((PromptKind) -> Void)?

    /// The prompt on screen, if any.
    private(set) var showing: PromptKind?

    static let width: CGFloat = 320

    private let panel: NSPanel
    private let titleLabel = NSTextField(wrappingLabelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let content: NSView

    override init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 100),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1) // above the launcher
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .utilityWindow
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.title = "Earshot"

        // The plugin's panel: its dark surface, 8 px corners, a hairline edge, Inter.
        let effect = NSView()
        effect.wantsLayer = true
        effect.layer?.backgroundColor = PluginColor.panel.cgColor
        effect.layer?.cornerRadius = 8
        effect.layer?.borderWidth = 1
        effect.layer?.borderColor = PluginColor.line.cgColor
        effect.layer?.masksToBounds = true
        effect.appearance = NSAppearance(named: .darkAqua)
        content = effect
        super.init()

        let icon = NSImageView(image: NSImage(systemSymbolName: "waveform", accessibilityDescription: "Earshot") ?? NSImage())
        icon.contentTintColor = PluginColor.accent
        icon.setContentHuggingPriority(.required, for: .horizontal)

        titleLabel.font = Fonts.inter(14, .semibold)
        titleLabel.textColor = PluginColor.text
        titleLabel.preferredMaxLayoutWidth = Self.width - 32 - 28
        detailLabel.font = Fonts.inter(12)
        detailLabel.textColor = PluginColor.muted
        detailLabel.lineBreakMode = .byTruncatingTail

        let notNow = FirstClickButton(title: PromptCopy.notNow, primary: false, target: self, action: #selector(notNowClicked))
        let capture = FirstClickButton(title: PromptCopy.capture, primary: true, target: self, action: #selector(captureClicked))
        let buttons = NSStackView(views: [NSView(), notNow, capture])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let words = NSStackView(views: [titleLabel, detailLabel])
        words.orientation = .vertical
        words.alignment = .leading
        words.spacing = 2
        let top = NSStackView(views: [icon, words])
        top.orientation = .horizontal
        top.alignment = .top
        top.spacing = 10

        let stack = NSStackView(views: [top, buttons])
        stack.orientation = .vertical
        stack.alignment = .width
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 12, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            stack.topAnchor.constraint(equalTo: effect.topAnchor),
            stack.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            effect.widthAnchor.constraint(equalToConstant: Self.width),
        ])
        panel.contentView = effect
    }

    func show(_ next: PromptKind?) {
        switch PromptChange.between(showing, next) {
        case .none:
            return
        case .show(let kind), .update(let kind):
            showing = kind
            fill(PromptCopy(kind))
            place()
            panel.orderFrontRegardless()
        case .close:
            showing = nil
            panel.orderOut(nil)
        }
    }

    private func fill(_ copy: PromptCopy) {
        titleLabel.stringValue = copy.title
        detailLabel.stringValue = copy.detail ?? ""
        detailLabel.isHidden = copy.detail == nil
    }

    /// Sized to the words, at the top right of the screen in use.
    private func place() {
        content.layoutSubtreeIfNeeded()
        let size = NSSize(width: Self.width, height: ceil(content.fittingSize.height))
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        panel.setFrame(WindowGeometry.promptFrame(size: size, screen: screen.visibleFrame), display: true)
    }

    @objc private func captureClicked() {
        guard let kind = showing else { return }
        show(nil)
        onCapture?(kind)
    }

    @objc private func notNowClicked() {
        guard let kind = showing else { return }
        show(nil)
        onNotNow?(kind)
    }
}
