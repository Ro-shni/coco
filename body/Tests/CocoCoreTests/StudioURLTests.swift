import Foundation
import Testing
@testable import CocoCore

@Suite struct StudioURLTests {
    @Test func launchURLPointsAtLoopbackWithNonce() {
        let url = StudioURL.launch(port: 5123, nonce: "abc")
        #expect(url.absoluteString == "http://127.0.0.1:5123/studio/launch?n=abc")
    }

    @Test func allowsOnlyOurOwnOrigin() {
        #expect(StudioURL.decide(URL(string: "http://127.0.0.1:5123/studio/#connectors")!, port: 5123) == .allow)
        #expect(StudioURL.decide(URL(string: "http://127.0.0.1:9999/studio/")!, port: 5123) == .block)
        #expect(StudioURL.decide(URL(string: "http://localhost:5123/studio/")!, port: 5123) == .block)
    }

    /// The launch page itself (with its single-use nonce in the query string) is on our own origin, so it
    /// must be allowed to load inside the window like any other same-origin path.
    @Test func allowsOurOwnLaunchPage() {
        let nonce = String(repeating: "a", count: 64)
        let url = URL(string: "http://127.0.0.1:5123/studio/launch?n=\(nonce)")!
        #expect(StudioURL.decide(url, port: 5123) == .allow)
    }

    @Test func sendsWebLinksToTheDefaultBrowser() {
        let signIn = URL(string: "https://auth.atlassian.com/authorize?x=1")!
        #expect(StudioURL.decide(signIn, port: 5123) == .openExternally(signIn))
    }

    @Test func blocksOtherSchemes() {
        for raw in ["file:///etc/passwd", "javascript:alert(1)", "x-apple.systempreferences:foo", "ssh://host"] {
            #expect(StudioURL.decide(URL(string: raw)!, port: 5123) == .block)
        }
    }

    @Test func parseNonceAcceptsExactly64LowercaseHex() {
        let hex = String(repeating: "a1", count: 32)  // 64 chars
        let data = Data("{\"nonce\":\"\(hex)\"}".utf8)
        #expect(StudioURL.parseNonce(data) == hex)
    }

    @Test func parseNonceRejectsAnythingElse() {
        let tooShort = Data(#"{"nonce":"abc"}"#.utf8)
        let uppercase = Data("{\"nonce\":\"\(String(repeating: "A", count: 64))\"}".utf8)
        let wrongField = Data(#"{"token":"abc"}"#.utf8)
        let notJson = Data("not json".utf8)
        let extraChars = Data("{\"nonce\":\"\(String(repeating: "a", count: 64))!\"}".utf8)
        for bad in [tooShort, uppercase, wrongField, notJson, extraChars] {
            #expect(StudioURL.parseNonce(bad) == nil)
        }
    }

    /// A `$`-anchored regex (this implementation's earlier approach) matches immediately before a trailing
    /// line terminator as well as at the true end of string, so 64 valid hex chars plus a trailing "\n" must
    /// still be rejected — the check has to be exact, not merely "starts with 64 hex chars".
    @Test func parseNonceRejectsTrailingNewline() {
        let hex = String(repeating: "a", count: 64)
        let withTrailingNewline = Data("{\"nonce\":\"\(hex)\\n\"}".utf8)
        #expect(StudioURL.parseNonce(withTrailingNewline) == nil)
    }
}
