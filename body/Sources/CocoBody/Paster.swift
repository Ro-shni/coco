import AppKit
import ApplicationServices
import CocoCore

/// Pastes a brain-provided draft into another app's focused text field with ⌘V, then restores whatever was
/// on the clipboard before. Never presses Return/Enter and never clicks a Send button — the user reviews the
/// pasted text and sends it themselves.
enum Paster {
    /// Time to let the target app finish activating before we post ⌘V.
    private static let activationDelay: TimeInterval = 0.25
    /// Time to leave the draft on the clipboard (covers ⌘V actually landing) before restoring it.
    private static let restoreDelay: TimeInterval = 1.5

    /// Call on the main thread; completion is delivered on main.
    static func paste(text: String, intoApp: String, completion: @escaping (Bool, String?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard AXIsProcessTrusted() else {
            completion(false, "Accessibility permission is off")
            return
        }
        guard let app = resolveApp(intoApp) else {
            completion(false, "\(intoApp) isn't running")
            return
        }

        let pasteboard = NSPasteboard.general
        let saved = pasteboard.string(forType: .string)
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        app.activate()
        DispatchQueue.main.asyncAfter(deadline: .now() + activationDelay) {
            postPasteKeystroke()
            DispatchQueue.main.asyncAfter(deadline: .now() + restoreDelay) {
                restorePasteboard(pasteboard, expecting: text, saved: saved)
            }
            completion(true, nil)
        }
    }

    private static func resolveApp(_ target: String) -> NSRunningApplication? {
        let apps = WindowFocus.candidateApps()
        let candidates = apps.map { AppCandidate(name: $0.localizedName ?? "", bundleId: $0.bundleIdentifier ?? "", pid: $0.processIdentifier) }
        guard let best = AppMatcher.bestApp(for: target, in: candidates) else { return nil }
        return apps.first(where: { $0.processIdentifier == best.pid })
    }

    /// Posts ⌘V only — never Return/Enter or any other key. See CocoCore.PasteKeys.
    private static func postPasteKeystroke() {
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: PasteKeys.pasteVirtualKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: PasteKeys.pasteVirtualKey, keyDown: false) else { return }
        down.flags = PasteKeys.pasteFlags
        up.flags = PasteKeys.pasteFlags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    /// Only restores if the pasteboard still holds our draft — if the user copied something else in the
    /// meantime, leave it alone rather than clobbering it.
    private static func restorePasteboard(_ pasteboard: NSPasteboard, expecting text: String, saved: String?) {
        guard pasteboard.string(forType: .string) == text else { return }
        pasteboard.clearContents()
        if let saved { pasteboard.setString(saved, forType: .string) }
    }
}
