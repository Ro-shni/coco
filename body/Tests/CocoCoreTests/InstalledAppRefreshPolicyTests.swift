import Foundation
import Testing
@testable import CocoCore

@Suite struct InstalledAppRefreshPolicyTests {
    let arc = InstalledAppCandidate(name: "Arc", bundleId: "company.thebrowser.Browser", url: URL(fileURLWithPath: "/Applications/Arc.app"))
    let slack = InstalledAppCandidate(name: "Slack", bundleId: "com.tinyspeck.slackmacgap", url: URL(fileURLWithPath: "/Applications/Slack.app"))
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func refreshesForANewlyLaunchedAppNotInTheCache() {
        let newApp = URL(fileURLWithPath: "/Applications/Notion.app")
        #expect(InstalledAppRefreshPolicy.shouldRefresh(launchedOrTerminatedURL: newApp, cachedApps: [arc, slack], now: t0, lastRefreshAt: .distantPast, debounce: 30) == true)
    }

    @Test func skipsWhenTheLaunchedAppIsAlreadyInTheCache() {
        #expect(InstalledAppRefreshPolicy.shouldRefresh(launchedOrTerminatedURL: arc.url, cachedApps: [arc, slack], now: t0, lastRefreshAt: .distantPast, debounce: 30) == false)
    }

    @Test func skipsWhenTheTerminatedAppIsAlreadyInTheCache() {
        #expect(InstalledAppRefreshPolicy.shouldRefresh(launchedOrTerminatedURL: slack.url, cachedApps: [arc, slack], now: t0, lastRefreshAt: .distantPast, debounce: 30) == false)
    }

    @Test func refreshesWhenTheBundleURLIsUnknown() {
        // A launch notification with no resolvable bundle URL (e.g. a helper process) still gets the
        // benefit of the doubt, subject to the debounce.
        #expect(InstalledAppRefreshPolicy.shouldRefresh(launchedOrTerminatedURL: nil, cachedApps: [arc], now: t0, lastRefreshAt: .distantPast, debounce: 30) == true)
    }

    @Test func debouncesRepeatedRefreshesWithinTheWindow() {
        let newApp = URL(fileURLWithPath: "/Applications/Notion.app")
        let lastRefresh = t0.addingTimeInterval(-10) // 10s ago, inside a 30s debounce
        #expect(InstalledAppRefreshPolicy.shouldRefresh(launchedOrTerminatedURL: newApp, cachedApps: [arc], now: t0, lastRefreshAt: lastRefresh, debounce: 30) == false)
    }

    @Test func allowsARefreshOnceTheDebounceWindowHasElapsed() {
        let newApp = URL(fileURLWithPath: "/Applications/Notion.app")
        let lastRefresh = t0.addingTimeInterval(-31) // just past a 30s debounce
        #expect(InstalledAppRefreshPolicy.shouldRefresh(launchedOrTerminatedURL: newApp, cachedApps: [arc], now: t0, lastRefreshAt: lastRefresh, debounce: 30) == true)
    }
}
