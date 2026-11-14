import Testing
@testable import CocoCore

@Suite struct SpeechTextTests {
    @Test func stripsBackticks() {
        #expect(SpeechText.clean("`code`") == "code")
    }
    @Test func stripsBoldAndItalic() {
        #expect(SpeechText.clean("**bold** and _italic_") == "bold and italic")
    }
    @Test func stripsHeaders() {
        #expect(SpeechText.clean("# Title") == "Title")
        #expect(SpeechText.clean("## Subtitle") == "Subtitle")
    }
    @Test func stripsListBullets() {
        #expect(SpeechText.clean("- one\n- two") == "one two")
        #expect(SpeechText.clean("* one\n* two") == "one two")
    }
    @Test func stripsCodeFences() {
        #expect(SpeechText.clean("```swift\nlet x = 1\n```") == "let x = 1")
    }
    @Test func replacesURLsWithALink() {
        #expect(SpeechText.clean("See https://example.com/path for more") == "See a link for more")
    }
    @Test func stripsEmoji() {
        #expect(SpeechText.clean("Great job! 🎉👍") == "Great job!")
    }
    @Test func collapsesWhitespace() {
        #expect(SpeechText.clean("a   b\n\nc") == "a b c")
    }
    @Test func arrowsBecomeTo() {
        #expect(SpeechText.clean("A -> B and A \u{2192} B") == "A to B and A to B")
    }
    @Test func keepsNumbersAsIs() {
        #expect(SpeechText.clean("p99 latency is 42.5ms") == "p99 latency is 42.5ms")
    }
    @Test func trimsSurroundingWhitespace() {
        #expect(SpeechText.clean("  hello  ") == "hello")
    }
}
