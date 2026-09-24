import Foundation

/// One on-screen window as reported by CGWindowList, trimmed to what picking needs.
public struct WindowListEntry: Equatable, Sendable {
    public let id: UInt32
    public let bounds: CGRect
    public let name: String?

    public init(id: UInt32, bounds: CGRect, name: String?) {
        self.id = id
        self.bounds = bounds
        self.name = name
    }
}

/// Picks the real, focused content window for a pid out of its raw on-screen window list —
/// CGWindowList's front-to-back order alone isn't reliable (browser helper/popup strips can
/// sort ahead of the actual page window), so this filters helper-sized windows and prefers
/// the one whose title matches what Accessibility says is focused.
public enum WindowPicker {
    /// Below this size a window is treated as a helper/popup strip, not real content.
    private static let minWidth: CGFloat = 200
    private static let minHeight: CGFloat = 150

    public static func pick(_ entries: [WindowListEntry], focusedTitle: String?) -> WindowListEntry? {
        let candidates = entries.filter { $0.bounds.width >= minWidth && $0.bounds.height >= minHeight }
        guard !candidates.isEmpty else { return nil }
        if let focusedTitle, !focusedTitle.isEmpty {
            let titled = candidates.filter { $0.name == focusedTitle }
            if let match = largest(of: titled) { return match }
        }
        return largest(of: candidates)
    }

    /// True if the cached window's frame has drifted from its current CGWindowList bounds
    /// (e.g. after a Space switch or full-screen toggle) by more than `tolerance` in any component.
    public static func isStale(cachedFrame: CGRect, currentBounds: CGRect, tolerance: CGFloat = 1) -> Bool {
        abs(cachedFrame.origin.x - currentBounds.origin.x) > tolerance
            || abs(cachedFrame.origin.y - currentBounds.origin.y) > tolerance
            || abs(cachedFrame.width - currentBounds.width) > tolerance
            || abs(cachedFrame.height - currentBounds.height) > tolerance
    }

    private static func largest(of entries: [WindowListEntry]) -> WindowListEntry? {
        entries.max { a, b in (a.bounds.width * a.bounds.height) < (b.bounds.width * b.bounds.height) }
    }
}
