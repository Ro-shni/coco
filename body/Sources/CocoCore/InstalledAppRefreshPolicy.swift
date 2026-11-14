import Foundation

/// N6: decides whether an NSWorkspace launch/terminate notification should trigger a background rescan of
/// installed apps. Pure so it's testable without AppKit. Two independent reasons to skip a rescan: the
/// app that just launched/quit is already a known cache entry (its launching/quitting doesn't change what
/// is installed on disk), or a rescan happened too recently (several apps can launch/quit within seconds
/// of each other, e.g. at login — a debounce keeps that from becoming a rescan storm).
public enum InstalledAppRefreshPolicy {
    public static func shouldRefresh(
        launchedOrTerminatedURL: URL?,
        cachedApps: [InstalledAppCandidate],
        now: Date,
        lastRefreshAt: Date,
        debounce: TimeInterval
    ) -> Bool {
        if let launchedOrTerminatedURL, cachedApps.contains(where: { $0.url == launchedOrTerminatedURL }) {
            return false
        }
        return now.timeIntervalSince(lastRefreshAt) >= debounce
    }
}
