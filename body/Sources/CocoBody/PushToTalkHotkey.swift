import AppKit
import CocoCore

/// Hold ⌥Space to talk. Active from the ⌥Space key-down until Space or Option is released; key repeats are
/// ignored. The global monitor needs Accessibility; the local one covers Coco's own windows (and swallows the
/// keystrokes there so they don't type into the chat box).
final class PushToTalkHotkey {
    var onDown: (() -> Void)?
    var onUp: (() -> Void)?

    private(set) var isActive = false
    private var monitors: [Any] = []

    func install() {
        let mask: NSEvent.EventTypeMask = [.keyDown, .keyUp, .flagsChanged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] e in _ = self?.process(e) }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] e in
            (self?.process(e) ?? false) ? nil : e
        }) {
            monitors.append(local)
        }
    }

    /// Returns true when the event belongs to push-to-talk (so a local monitor can swallow it).
    private func process(_ event: NSEvent) -> Bool {
        switch event.type {
        case .keyDown:
            if isActive { return event.keyCode == HotkeyMatcher.spaceKeyCode }  // repeats while held
            guard !event.isARepeat, HotkeyMatcher.isPushToTalk(keyCode: event.keyCode, flags: Self.flags(event)) else { return false }
            isActive = true
            onDown?()
            return true
        case .keyUp:
            guard isActive, event.keyCode == HotkeyMatcher.spaceKeyCode else { return false }
            end()
            return true
        case .flagsChanged:
            if isActive && !event.modifierFlags.contains(.option) { end() }
            return false
        default:
            return false
        }
    }

    private func end() {
        isActive = false
        onUp?()
    }

    private static func flags(_ event: NSEvent) -> ModifierFlagsLike {
        let f = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var out: ModifierFlagsLike = []
        if f.contains(.shift) { out.insert(.shift) }
        if f.contains(.control) { out.insert(.control) }
        if f.contains(.option) { out.insert(.option) }
        if f.contains(.command) { out.insert(.command) }
        return out
    }
}
