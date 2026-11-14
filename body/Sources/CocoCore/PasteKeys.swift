import CoreGraphics

/// The exact keystroke Paster is allowed to post (⌘V) and the codes it must never post, pulled out as a
/// pure, testable list. Coco pastes a draft; it never presses Return or Enter to send it — the human does.
public enum PasteKeys {
    /// Virtual key code for 'V' on a US layout.
    public static let pasteVirtualKey: CGKeyCode = 0x09
    public static let pasteFlags: CGEventFlags = .maskCommand

    /// Return (0x24) and keypad Enter (0x4C) — Paster must never post either of these.
    public static let forbiddenVirtualKeys: Set<CGKeyCode> = [0x24, 0x4C]
}
