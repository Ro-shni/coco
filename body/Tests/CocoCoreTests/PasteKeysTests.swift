import Testing
@testable import CocoCore

@Suite struct PasteKeysTests {
    @Test func onlyPostsCommandV() {
        #expect(PasteKeys.pasteVirtualKey == 0x09)
        #expect(PasteKeys.pasteFlags == .maskCommand)
    }

    @Test func neverPostsReturnOrEnter() {
        #expect(PasteKeys.forbiddenVirtualKeys.contains(0x24))  // Return
        #expect(PasteKeys.forbiddenVirtualKeys.contains(0x4C))  // keypad Enter
        #expect(!PasteKeys.forbiddenVirtualKeys.contains(PasteKeys.pasteVirtualKey))
    }
}
