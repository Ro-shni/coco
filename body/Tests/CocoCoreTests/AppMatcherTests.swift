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
}
