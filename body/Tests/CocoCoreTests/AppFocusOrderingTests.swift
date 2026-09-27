import Foundation
import Testing
@testable import CocoCore

@Suite struct AppFocusOrderingTests {
    let notes = InstalledAppCandidate(name: "Notes", bundleId: "com.apple.Notes", url: URL(fileURLWithPath: "/System/Applications/Notes.app"))
    let calendar = InstalledAppCandidate(name: "Calendar", bundleId: "com.apple.iCal", url: URL(fileURLWithPath: "/System/Applications/Calendar.app"))
    let home = InstalledAppCandidate(name: "Home", bundleId: "com.apple.Home", url: URL(fileURLWithPath: "/System/Applications/Home.app"))
    let notion = InstalledAppCandidate(name: "Notion", bundleId: "notion.id", url: URL(fileURLWithPath: "/Applications/Notion.app"))
    let code = InstalledAppCandidate(name: "Code", bundleId: "com.microsoft.VSCode", url: URL(fileURLWithPath: "/Applications/Visual Studio Code.app"))

    // N3 (reviewer's probes): a fuzzy (score < 0.9) installed-app match must not steal a real window match.

    @Test func releaseNotesFocusesTheConfluenceWindowNotNotes() {
        let windows = [WindowCandidate(appName: "Google Chrome", pid: 1, title: "Release notes – Confluence", index: 0)]
        let decision = AppFocusOrdering.decide(target: "release notes", installedApps: [notes], windows: windows)
        guard case .focusWindow(let window) = decision else {
            Issue.record("expected .focusWindow, got \(decision)")
            return
        }
        #expect(window.title == "Release notes – Confluence")
    }

    @Test func deployCalendarFocusesTheWindowNotCalendarApp() {
        let windows = [WindowCandidate(appName: "Google Chrome", pid: 1, title: "Deploy calendar – Confluence", index: 0)]
        let decision = AppFocusOrdering.decide(target: "deploy calendar", installedApps: [calendar], windows: windows)
        guard case .focusWindow(let window) = decision else {
            Issue.record("expected .focusWindow, got \(decision)")
            return
        }
        #expect(window.title == "Deploy calendar – Confluence")
    }

    @Test func homePageFocusesTheWindowNotHomeApp() {
        let windows = [WindowCandidate(appName: "Google Chrome", pid: 1, title: "Home page - Confluence", index: 0)]
        let decision = AppFocusOrdering.decide(target: "home page", installedApps: [home], windows: windows)
        guard case .focusWindow(let window) = decision else {
            Issue.record("expected .focusWindow, got \(decision)")
            return
        }
        #expect(window.title == "Home page - Confluence")
    }

    // A STRONG installed match (exact/alias/prefix, score >= 0.9) still wins over any window.

    @Test func notionLaunchesEvenWithNoCompetingWindow() {
        let decision = AppFocusOrdering.decide(target: "notion", installedApps: [notion], windows: [])
        guard case .launchInstalled(let candidate) = decision else {
            Issue.record("expected .launchInstalled, got \(decision)")
            return
        }
        #expect(candidate.name == "Notion")
    }

    @Test func codeLaunchesVSCodeEvenWithALeetCodeWindowOpen() {
        let windows = [WindowCandidate(appName: "Google Chrome", pid: 1, title: "LeetCode – Dynamic Programming", index: 0)]
        let decision = AppFocusOrdering.decide(target: "code", installedApps: [code], windows: windows)
        guard case .launchInstalled(let candidate) = decision else {
            Issue.record("expected .launchInstalled, got \(decision)")
            return
        }
        #expect(candidate.name == "Code")
    }

    // A weak installed match still wins as a last resort when NO window matches either.

    @Test func weakInstalledMatchLaunchesWhenNoWindowMatches() {
        // Compound-commands-trace brief (N4/21): the containment rule now only scores when the shorter
        // (normalised) string is >= 60% of the longer's length. "release notes" vs "notes" (5/12 ≈ 0.42)
        // falls below that floor and no longer matches at all — "notes app" (5/8 = 0.625) still clears it
        // and still exercises a genuine, merely-fuzzy containment match as the last-resort case this test
        // is about.
        let decision = AppFocusOrdering.decide(target: "notes app", installedApps: [notes], windows: [])
        guard case .launchInstalled(let candidate) = decision else {
            Issue.record("expected .launchInstalled, got \(decision)")
            return
        }
        #expect(candidate.name == "Notes")
    }

    @Test func returnsNoneWhenNothingMatchesAtAll() {
        let decision = AppFocusOrdering.decide(target: "figma", installedApps: [notion], windows: [])
        #expect(decision == .none)
    }
}
