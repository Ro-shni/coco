import Foundation

/// I4/N3: for `FocusKind.app` with no running-app match, what WindowFocus should do next. A window-title
/// match must not lose to a merely fuzzy (score < `strongInstalledThreshold`) installed-app match — "go to
/// the release notes" must focus a Confluence window titled "Release notes", not launch Notes.app just
/// because "release notes" contains "notes". A STRONG installed match (exact/alias/prefix) still wins over
/// any window, since that really is the named app — "code" launches VS Code even with a "LeetCode" browser
/// tab open. If neither a strong installed match nor any window matches, a weak installed match is still
/// launched as a last resort, rather than reporting no match at all.
public enum AppFocusOrdering {
    /// Exact name/alias match scores 1.0, a prefix match 0.9 — both count as strong. A looser substring
    /// match (0.8) or a bundle-id-only match (0.7) does not.
    public static let strongInstalledThreshold = 0.9

    public enum Decision: Equatable, Sendable {
        case launchInstalled(InstalledAppCandidate)
        case focusWindow(WindowCandidate)
        case none
    }

    public static func decide(target: String, installedApps: [InstalledAppCandidate], windows: [WindowCandidate]) -> Decision {
        let installedMatch = AppMatcher.bestInstalledAppWithScore(for: target, in: installedApps)
        if let installedMatch, installedMatch.score >= strongInstalledThreshold {
            return .launchInstalled(installedMatch.candidate)
        }
        if let window = AppMatcher.bestWindow(for: target, in: windows) {
            return .focusWindow(window)
        }
        if let installedMatch {
            return .launchInstalled(installedMatch.candidate)
        }
        return .none
    }
}
