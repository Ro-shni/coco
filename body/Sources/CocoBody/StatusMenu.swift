import AppKit

final class StatusMenu: NSObject {
    var onOpenChat: (() -> Void)?
    var onTogglePause: (() -> Void)?
    var onPermissions: (() -> Void)?

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let pauseItem = NSMenuItem(title: "Pause watching  ⌃⌥P", action: #selector(togglePause), keyEquivalent: "")

    override init() {
        super.init()
        item.button?.title = "●"
        let menu = NSMenu()
        menu.addItem(withTitle: "Open chat", action: #selector(openChat), keyEquivalent: "").target = self
        pauseItem.target = self
        menu.addItem(pauseItem)
        menu.addItem(withTitle: "Permissions…", action: #selector(permissions), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Coco", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
    }

    func setPaused(_ paused: Bool) {
        pauseItem.title = paused ? "Resume watching  ⌃⌥P" : "Pause watching  ⌃⌥P"
        item.button?.title = paused ? "◌" : "●"
    }

    @objc private func openChat() { onOpenChat?() }
    @objc private func togglePause() { onTogglePause?() }
    @objc private func permissions() { onPermissions?() }
}
