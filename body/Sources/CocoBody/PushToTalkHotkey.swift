import AppKit
import CocoCore

/// Hold Right ⌘ alone to talk. NSEvent global + local monitors watch `.flagsChanged` and `.keyDown` (a
/// modifier-only press never types a character, so nothing leaks to the focused app) and drive
/// `ModifierHoldDetector`'s pure state machine on a periodic tick. The global monitor needs Accessibility;
/// without it Coco can only see the key while one of its own windows is focused, so `install()` reports
/// that via `onPermissionMissing` for the caller to surface.
final class PushToTalkHotkey {
    /// Right ⌘ was held alone for `ModifierHoldDetector.holdDelay`: start listening.
    var onDown: (() -> Void)?
    /// Right ⌘ released after listening had started: stop and send what was heard.
    var onUp: (() -> Void)?
    /// Listening was interrupted (another key or modifier) before release: stop and discard.
    var onCancel: (() -> Void)?
    /// The global monitor couldn't be installed — likely missing Accessibility permission.
    var onPermissionMissing: ((String) -> Void)?

    private static let tickInterval: TimeInterval = 0.05

    /// Device-dependent modifier bits (NX_DEVICE*KEYMASK from IOLLEvent.h), carried through in
    /// `NSEvent.modifierFlags.rawValue`. Undocumented but stable for decades and the standard way to tell
    /// left and right modifier keys apart — `NSEvent.ModifierFlags`/`kVK_*` alone can't.
    private enum DeviceMask {
        static let leftControl: UInt = 0x0001
        static let leftShift: UInt = 0x0002
        static let rightShift: UInt = 0x0004
        static let leftCommand: UInt = 0x0008
        static let rightCommand: UInt = 0x0010
        static let leftOption: UInt = 0x0020
        static let rightOption: UInt = 0x0040
        static let rightControl: UInt = 0x2000
        /// Everything that counts as "another modifier" while a lone Right ⌘ hold is in progress.
        static let others: UInt = leftControl | leftShift | rightShift | leftCommand | leftOption | rightOption | rightControl
    }

    private var detector = ModifierHoldDetector()
    private var globalFlagsMonitor: Any?
    private var localFlagsMonitor: Any?
    private var globalKeyMonitor: Any?
    private var localKeyMonitor: Any?
    private var tickTimer: Timer?

    /// Installs the monitors and starts the tick timer. Safe to call more than once.
    func install() {
        guard tickTimer == nil else { return }

        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { [weak self] in self?.handleFlagsChanged($0) }) {
            globalFlagsMonitor = monitor
        } else {
            FileLog.body.warn("push-to-talk: couldn't install global flagsChanged monitor (Accessibility not granted?)")
            onPermissionMissing?("Coco needs Accessibility to hear Right ⌘ while another app is focused. Grant it in Permissions….")
        }
        globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] _ in self?.handleKeyDown() })
        localFlagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
            return event
        }
        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleKeyDown()
            return event
        }
        tickTimer = Timer.scheduledTimer(withTimeInterval: Self.tickInterval, repeats: true) { [weak self] _ in self?.tick() }
    }

    /// Removes the monitors and stops the tick timer. Safe to call more than once.
    func stop() {
        for monitor in [globalFlagsMonitor, globalKeyMonitor, localFlagsMonitor, localKeyMonitor] {
            if let monitor { NSEvent.removeMonitor(monitor) }
        }
        globalFlagsMonitor = nil
        globalKeyMonitor = nil
        localFlagsMonitor = nil
        localKeyMonitor = nil
        tickTimer?.invalidate()
        tickTimer = nil
    }

    deinit { stop() }

    private func handleFlagsChanged(_ event: NSEvent) {
        let raw = UInt(event.modifierFlags.rawValue)
        let rightCmdDown = raw & DeviceMask.rightCommand != 0
        let otherModifiersDown = raw & DeviceMask.others != 0
        dispatch(detector.flagsChanged(keyCode: event.keyCode, rightCmdDown: rightCmdDown, otherModifiersDown: otherModifiersDown))
    }

    private func handleKeyDown() {
        dispatch(detector.keyDown())
    }

    private func tick() {
        dispatch(detector.tick(now: Date()))
    }

    private func dispatch(_ action: ModifierHoldDetector.Action) {
        switch action {
        case .start: onDown?()
        case .stopAndSend: onUp?()
        case .cancelDiscard: onCancel?()
        case .none: break
        }
    }
}
