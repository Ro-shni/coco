import AppKit
import CocoCore

final class StatusMenu: NSObject {
    var onOpenChat: (() -> Void)?
    var onTogglePause: (() -> Void)?
    var onPermissions: (() -> Void)?
    var onSetHome: ((HomeSpec) -> Void)?

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let pauseItem = NSMenuItem(title: "Pause watching  ⌃⌥P", action: #selector(togglePause), keyEquivalent: "")
    private static let corners: [(title: String, corner: ScreenGeometry.Corner)] = [
        ("Bottom right", .bottomRight), ("Bottom left", .bottomLeft),
        ("Top right", .topRight), ("Top left", .topLeft),
    ]

    override init() {
        super.init()
        item.button?.title = "●"
        let menu = NSMenu()
        menu.addItem(withTitle: "Open chat", action: #selector(openChat), keyEquivalent: "").target = self
        pauseItem.target = self
        menu.addItem(pauseItem)
        menu.addItem(withTitle: "Permissions…", action: #selector(permissions), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(homePositionItem())
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Coco", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
    }

    func setPaused(_ paused: Bool) {
        pauseItem.title = paused ? "Resume watching  ⌃⌥P" : "Pause watching  ⌃⌥P"
        item.button?.title = paused ? "◌" : "●"
    }

    private func homePositionItem() -> NSMenuItem {
        let submenu = NSMenu()
        for (title, corner) in Self.corners {
            let entry = NSMenuItem(title: title, action: #selector(selectCorner(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = corner.rawValue
            submenu.addItem(entry)
        }
        submenu.addItem(.separator())
        let reset = NSMenuItem(title: "Reset", action: #selector(selectReset), keyEquivalent: "")
        reset.target = self
        submenu.addItem(reset)
        let item = NSMenuItem(title: "Home position", action: nil, keyEquivalent: "")
        item.submenu = submenu
        return item
    }

    @objc private func openChat() { onOpenChat?() }
    @objc private func togglePause() { onTogglePause?() }
    @objc private func permissions() { onPermissions?() }

    @objc private func selectCorner(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let corner = ScreenGeometry.Corner(rawValue: raw) else { return }
        onSetHome?(.corner(corner))
    }

    @objc private func selectReset() { onSetHome?(HomePlacement.defaultSpec) }
}
