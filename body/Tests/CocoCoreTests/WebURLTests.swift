import Testing
@testable import CocoCore

@Suite struct WebURLTests {
    @Test func acceptsHttp() {
        #expect(WebURL.parse("http://example.com")?.absoluteString == "http://example.com")
    }

    @Test func acceptsHttpsWithPathAndQuery() {
        #expect(WebURL.parse("https://example.com/path?q=1") != nil)
    }

    @Test func acceptsAnUppercaseScheme() {
        #expect(WebURL.parse("HTTPS://example.com") != nil)
    }

    @Test func rejectsFileScheme() {
        #expect(WebURL.parse("file:///etc/passwd") == nil)
    }

    @Test func rejectsJavascriptScheme() {
        #expect(WebURL.parse("javascript:alert(1)") == nil)
    }

    @Test func rejectsCustomAppSchemes() {
        #expect(WebURL.parse("x-apple-reminderkit://") == nil)
        #expect(WebURL.parse("slack://open") == nil)
    }

    @Test func rejectsUnparseableOrEmptyStrings() {
        #expect(WebURL.parse("") == nil)
        #expect(WebURL.parse("not a url") == nil)
    }

    @Test func rejectsASchemelessString() {
        #expect(WebURL.parse("example.com") == nil)
    }
}
