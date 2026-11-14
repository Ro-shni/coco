import Foundation
import Testing
@testable import CocoCore

@Suite struct AppMatcherTests {
    let apps = [
        AppCandidate(name: "Slack", bundleId: "com.tinyspeck.slackmacgap", pid: 1),
        AppCandidate(name: "Google Chrome", bundleId: "com.google.Chrome", pid: 2),
        AppCandidate(name: "Terminal", bundleId: "com.apple.Terminal", pid: 3),
        AppCandidate(name: "Code", bundleId: "com.microsoft.VSCode", pid: 4),
    ]

    @Test func exactNameMatch() {
        #expect(AppMatcher.bestApp(for: "slack", in: apps)?.name == "Slack")
    }

    @Test func vscodeAliasesMatchAppNamedCode() {
        #expect(AppMatcher.bestApp(for: "vs code", in: apps)?.name == "Code")
        #expect(AppMatcher.bestApp(for: "vscode", in: apps)?.name == "Code")
        #expect(AppMatcher.bestApp(for: "code", in: apps)?.name == "Code")
    }

    @Test func vscodeAliasMatchesAppNamedVisualStudioCode() {
        let withFullName = [AppCandidate(name: "Visual Studio Code", bundleId: "com.microsoft.VSCode", pid: 5)]
        #expect(AppMatcher.bestApp(for: "vscode", in: withFullName)?.name == "Visual Studio Code")
    }

    @Test func chromeAliasMatchesGoogleChrome() {
        #expect(AppMatcher.bestApp(for: "chrome", in: apps)?.name == "Google Chrome")
    }

    @Test func prefixMatchesTerminal() {
        #expect(AppMatcher.bestApp(for: "term", in: apps)?.name == "Terminal")
    }

    @Test func noMatchReturnsNil() {
        #expect(AppMatcher.bestApp(for: "figma", in: apps) == nil)
    }

    // Compound-commands-trace brief: "open gmail on google" was parsed (before the brain-side parser fix)
    // as a bare focus target "gmailongoogle", which the old containment rule (any length ratio, >= 3 chars)
    // then matched against "Mail" — 0.8 containment score, above appThreshold. The rule now requires the
    // shorter (normalised) string to be at least 60% of the longer's length, so a garbled, much-longer query
    // no longer rides in on a short app name.
    @Test func garbledCompoundQueryDoesNotMatchUnrelatedShortAppName() {
        let candidates = [AppCandidate(name: "Mail", bundleId: "com.apple.mail", pid: 20)]
        #expect(AppMatcher.bestApp(for: "gmailongoogle", in: candidates) == nil)
    }

    @Test func bundleIdFallbackMatchesSlack() {
        #expect(AppMatcher.bestApp(for: "tinyspeck", in: apps)?.name == "Slack")
    }

    @Test func tiesPreferShorterName() {
        let candidates = [
            AppCandidate(name: "Chatty", bundleId: "com.example.chatty", pid: 10),
            AppCandidate(name: "Chat", bundleId: "com.example.chat", pid: 11),
        ]
        #expect(AppMatcher.bestApp(for: "chat", in: candidates)?.name == "Chat")
    }

    let windows = [
        WindowCandidate(appName: "Google Chrome", pid: 2, title: "supply-prd latency - Grafana", index: 0),
        WindowCandidate(appName: "Mail", pid: 6, title: "Inbox", index: 0),
        WindowCandidate(appName: "iTerm2", pid: 7, title: "devops-rca — zsh", index: 0),
        WindowCandidate(appName: "Coco", pid: 8, title: "", index: 0),
    ]

    @Test func bestWindowPrefersGrafanaOverInbox() {
        #expect(AppMatcher.bestWindow(for: "grafana", in: windows)?.title == "supply-prd latency - Grafana")
    }

    @Test func bestWindowMatchesHyphenatedToken() {
        #expect(AppMatcher.bestWindow(for: "devops-rca", in: windows)?.title == "devops-rca — zsh")
    }

    @Test func bestWindowIgnoresEmptyTitles() {
        #expect(AppMatcher.bestWindow(for: "coco", in: windows) == nil)
    }

    @Test func bestWindowBelowThresholdReturnsNil() {
        #expect(AppMatcher.bestWindow(for: "spreadsheet budget forecast", in: windows) == nil)
    }

    @Test func bestWindowTiesPreferShorterTitle() {
        let candidates = [
            WindowCandidate(appName: "A", pid: 1, title: "release notes", index: 0),
            WindowCandidate(appName: "A", pid: 1, title: "release", index: 1),
        ]
        #expect(AppMatcher.bestWindow(for: "release", in: candidates)?.title == "release")
    }

    let installedApps = [
        InstalledAppCandidate(name: "Arc", bundleId: "company.thebrowser.Browser", url: URL(fileURLWithPath: "/Applications/Arc.app")),
        InstalledAppCandidate(name: "Slack", bundleId: "com.tinyspeck.slackmacgap", url: URL(fileURLWithPath: "/Applications/Slack.app")),
        InstalledAppCandidate(name: "Visual Studio Code", bundleId: "com.microsoft.VSCode", url: URL(fileURLWithPath: "/Applications/Visual Studio Code.app")),
    ]

    @Test func bestInstalledAppExactNameMatch() {
        #expect(AppMatcher.bestInstalledApp(for: "arc", in: installedApps)?.name == "Arc")
    }

    @Test func bestInstalledAppMatchesAlias() {
        #expect(AppMatcher.bestInstalledApp(for: "vscode", in: installedApps)?.name == "Visual Studio Code")
    }

    @Test func bestInstalledAppReturnsUrlForLaunching() {
        #expect(AppMatcher.bestInstalledApp(for: "slack", in: installedApps)?.url == URL(fileURLWithPath: "/Applications/Slack.app"))
    }

    @Test func bestInstalledAppNoMatchReturnsNil() {
        #expect(AppMatcher.bestInstalledApp(for: "figma", in: installedApps) == nil)
    }

    // MARK: - N3: bestInstalledAppWithScore

    @Test func bestInstalledAppWithScoreExactMatchIsStrong() {
        let match = AppMatcher.bestInstalledAppWithScore(for: "arc", in: installedApps)
        #expect(match?.candidate.name == "Arc")
        #expect(match!.score >= AppFocusOrdering.strongInstalledThreshold)
    }

    @Test func bestInstalledAppWithScoreSubstringMatchIsWeak() {
        // Compound-commands-trace brief (N4/21): the containment rule now only scores when the shorter
        // (normalised) string is >= 60% of the longer's length. "release notes" vs "notes" (5/12 ≈ 0.42)
        // falls below that floor, so it no longer matches at all (see garbledCompoundQueryDoesNotMatch...
        // above for that exact scenario) — "notes app" (5/8 = 0.625) still clears it and still exercises a
        // genuine, merely-fuzzy containment match, below strongInstalledThreshold.
        let notes = [InstalledAppCandidate(name: "Notes", bundleId: "com.apple.Notes", url: URL(fileURLWithPath: "/System/Applications/Notes.app"))]
        let match = AppMatcher.bestInstalledAppWithScore(for: "notes app", in: notes)
        #expect(match?.candidate.name == "Notes")
        #expect(match!.score < AppFocusOrdering.strongInstalledThreshold)
    }
}
