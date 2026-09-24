import AppKit
import CocoCore

final class StatusMenu: NSObject, NSMenuDelegate {
    var onOpenChat: (() -> Void)?
    var onTogglePause: (() -> Void)?
    var onPermissions: (() -> Void)?
    var onSetHome: ((HomeSpec) -> Void)?
    /// Voice was turned on/off (the setting itself is already saved).
    var onVoiceEnabledChanged: ((Bool) -> Void)?

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let pauseItem = NSMenuItem(title: "Pause watching  ⌃⌥P", action: #selector(togglePause), keyEquivalent: "")
    private let voiceToggleItem = NSMenuItem(title: "Voice on", action: #selector(toggleVoice), keyEquivalent: "")
    private let voicesMenu = NSMenu()
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
        voiceToggleItem.target = self
        voiceToggleItem.state = VoiceOutput.isEnabled ? .on : .off
        menu.addItem(voiceToggleItem)
        voicesMenu.delegate = self
        let voicesItem = NSMenuItem(title: "Voice", action: nil, keyEquivalent: "")
        voicesItem.submenu = voicesMenu
        menu.addItem(voicesItem)
        menu.addItem(withTitle: "Hold Right ⌘ to talk", action: nil, keyEquivalent: "").isEnabled = false
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

    /// Rebuilds the voice list each time it opens (voices can be installed while Coco runs).
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === voicesMenu else { return }
        menu.removeAllItems()
        let systemActive = VoiceOutput.isSystemVoiceActive()
        let systemEntry = NSMenuItem(title: "System voice (Siri)", action: #selector(selectSystemVoice), keyEquivalent: "")
        systemEntry.target = self
        systemEntry.state = systemActive ? .on : .off
        menu.addItem(systemEntry)
        menu.addItem(.separator())
        let voices = VoiceOutput.englishVoices()
            .filter { !VoicePicker.isNovelty($0) }
            .sorted { ($0.name, $0.language) < ($1.name, $1.language) }
        guard !voices.isEmpty else {
            menu.addItem(withTitle: "No English voices installed", action: nil, keyEquivalent: "").isEnabled = false
            return
        }
        let current = systemActive ? nil : VoiceOutput.currentVoiceId()
        for voice in voices {
            let label = voice.quality > 0 ? "\(voice.name) (\(voice.language), \(voice.quality == 2 ? "premium" : "enhanced"))"
                                          : "\(voice.name) (\(voice.language))"
            let entry = NSMenuItem(title: label, action: #selector(selectVoice(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = voice.identifier
            entry.state = voice.identifier == current ? .on : .off
            menu.addItem(entry)
        }
    }

    @objc private func toggleVoice() {
        let enabled = !VoiceOutput.isEnabled
        VoiceOutput.isEnabled = enabled
        voiceToggleItem.state = enabled ? .on : .off
        onVoiceEnabledChanged?(enabled)
    }

    @objc private func selectSystemVoice() {
        UserDefaults.standard.set(VoiceOutput.systemVoiceId, forKey: VoiceOutput.voiceIdKey)
    }

    @objc private func selectVoice(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        UserDefaults.standard.set(id, forKey: VoiceOutput.voiceIdKey)
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
