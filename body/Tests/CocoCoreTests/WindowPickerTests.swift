import Foundation
import Testing
@testable import CocoCore

@Suite struct WindowPickerTests {
    // Chrome-like list: a helper/popup strip sorted first, then the real page window.
    let strip = WindowListEntry(id: 1, bounds: CGRect(x: 0, y: 0, width: 1728, height: 123), name: nil)
    let page = WindowListEntry(id: 2, bounds: CGRect(x: 0, y: 33, width: 1728, height: 1084), name: "Coco mock")

    @Test func focusedTitleMatchPicksPageOverStrip() {
        #expect(WindowPicker.pick([strip, page], focusedTitle: "Coco mock")?.id == page.id)
    }

    @Test func nilFocusedTitleFallsBackToLargest() {
        #expect(WindowPicker.pick([strip, page], focusedTitle: nil)?.id == page.id)
    }

    @Test func emptyFocusedTitleFallsBackToLargest() {
        #expect(WindowPicker.pick([strip, page], focusedTitle: "")?.id == page.id)
    }

    @Test func helperOnlyListReturnsNil() {
        #expect(WindowPicker.pick([strip], focusedTitle: "Coco mock") == nil)
    }

    @Test func emptyListReturnsNil() {
        #expect(WindowPicker.pick([], focusedTitle: "anything") == nil)
    }

    @Test func twoWindowsSameTitlePicksLarger() {
        let small = WindowListEntry(id: 3, bounds: CGRect(x: 0, y: 0, width: 400, height: 300), name: "Docs")
        let large = WindowListEntry(id: 4, bounds: CGRect(x: 0, y: 0, width: 1200, height: 800), name: "Docs")
        #expect(WindowPicker.pick([small, large], focusedTitle: "Docs")?.id == large.id)
        #expect(WindowPicker.pick([large, small], focusedTitle: "Docs")?.id == large.id)
    }

    @Test func focusedTitleWithNoMatchFallsBackToLargestCandidate() {
        let other = WindowListEntry(id: 5, bounds: CGRect(x: 0, y: 0, width: 500, height: 400), name: "Something else")
        #expect(WindowPicker.pick([strip, other], focusedTitle: "no such window")?.id == other.id)
    }

    // Logged failure cases from body.log: cgBounds=-3553,33,1728x1084 vs scFrame=0,33,1728x1084,
    // and cgBounds=2134,33 vs scFrame=0,33 -- both after a Space/full-screen switch.
    @Test func isStaleDetectsLoggedOriginDrift() {
        let scFrame = CGRect(x: 0, y: 33, width: 1728, height: 1084)
        let cgBoundsA = CGRect(x: -3553, y: 33, width: 1728, height: 1084)
        let cgBoundsB = CGRect(x: 2134, y: 33, width: 1728, height: 1084)
        #expect(WindowPicker.isStale(cachedFrame: scFrame, currentBounds: cgBoundsA))
        #expect(WindowPicker.isStale(cachedFrame: scFrame, currentBounds: cgBoundsB))
    }

    @Test func isStaleFalseForIdenticalFrames() {
        let frame = CGRect(x: 0, y: 33, width: 1728, height: 1084)
        #expect(!WindowPicker.isStale(cachedFrame: frame, currentBounds: frame))
    }

    @Test func isStaleFalseForSubToleranceJitter() {
        let cached = CGRect(x: 0, y: 33, width: 1728, height: 1084)
        let jittered = CGRect(x: 0.5, y: 33, width: 1728, height: 1084)
        #expect(!WindowPicker.isStale(cachedFrame: cached, currentBounds: jittered))
    }
}
