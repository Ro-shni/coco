import Foundation
import Testing
@testable import CocoCore

@Suite struct PrivacyGateTests {
    let gate = try! PrivacyGate(config: .defaults)

    @Test func deniesPasswordManagersByBundleId() {
        #expect(gate.isPrivate(bundleId: "com.1password.1password", url: nil, title: "Vault"))
        #expect(gate.isPrivate(bundleId: "com.apple.Passwords", url: nil, title: ""))
    }

    @Test func deniesBankingAndSignInUrls() {
        #expect(gate.isPrivate(bundleId: "com.google.Chrome", url: "https://netbanking.hdfcbank.com/netbanking/", title: "HDFC"))
        #expect(gate.isPrivate(bundleId: "com.google.Chrome", url: "https://accounts.google.com/v3/signin/identifier", title: "Sign in"))
    }

    @Test func deniesPrivateWindowsByTitle() {
        #expect(gate.isPrivate(bundleId: "com.google.Chrome", url: nil, title: "New Incognito Tab"))
        #expect(gate.isPrivate(bundleId: "com.apple.Safari", url: nil, title: "Private Browsing"))
    }

    @Test func allowsOrdinaryWork() {
        #expect(!gate.isPrivate(bundleId: "com.google.Chrome", url: "https://grafana.example.com/d/abc", title: "supply-prd - Grafana"))
    }

    @Test func deniesByTitleWhenTheUrlLookupFailed() {
        // A browser tab whose AX URL lookup came back nil must not fail open just because url is nil.
        #expect(gate.isPrivate(bundleId: "com.google.Chrome", url: nil, title: "HDFC Bank NetBanking - hdfcbank.com"))
    }

    @Test func invalidRegexThrows() {
        #expect(throws: (any Error).self) {
            try PrivacyGate(config: PrivacyConfig(denyBundleIds: [], denyUrlPatterns: ["("], denyTitlePatterns: []))
        }
    }

    @Test func loadConfigFallsBackToDefaults() throws {
        let missing = URL(fileURLWithPath: "/nonexistent/privacy.json")
        #expect(PrivacyGate.loadConfig(from: missing) == .defaults)
        let bad = FileManager.default.temporaryDirectory.appendingPathComponent("coco-bad-privacy.json")
        try Data("not json".utf8).write(to: bad)
        #expect(PrivacyGate.loadConfig(from: bad) == .defaults)
    }

    @Test func loadConfigReadsFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("coco-privacy.json")
        let custom = PrivacyConfig(denyBundleIds: ["com.example.secret"], denyUrlPatterns: [], denyTitlePatterns: [])
        try JSONEncoder().encode(custom).write(to: url)
        #expect(PrivacyGate.loadConfig(from: url) == custom)
    }
}

@Suite struct RedactorTests {
    @Test(arguments: [
        "key sk-proj-abcdefghijklmnop1234 here",
        "slack xoxb-1234567890-abcdefghij token",
        "slack xoxe-1234567890-abcdefghij config",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end",
        "aws AKIAIOSFODNN7EXAMPLE end",
        "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789 end",
    ])
    func redactsSecrets(input: String) {
        let out = Redactor.redact(input)
        #expect(out.contains("[REDACTED]"))
        #expect(!out.contains("sk-proj-abc") && !out.contains("xoxb-123") && !out.contains("xoxe-123") && !out.contains("eyJhbGci") && !out.contains("AKIAIOSF") && !out.contains("ghp_abc"))
    }

    @Test func redactsPemBlocks() {
        let pem = "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nb"
        #expect(Redactor.redact(pem) == "a\n[REDACTED]\nb")
    }

    @Test func redactsATruncatedPemWithNoEndLine() {
        let pem = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\nmore key data that got cut off"
        let out = Redactor.redact(pem)
        #expect(out == "before\n[REDACTED]")
        #expect(!out.contains("MIIEow"))
    }

    @Test func leavesNormalTextAlone() {
        let text = "p99 latency 900ms at 10:40 on supply-prd"
        #expect(Redactor.redact(text) == text)
    }
}
