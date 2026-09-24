import Testing
import Foundation
@testable import CocoCore

@Suite struct ModifierHoldDetectorTests {
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    let delay = ModifierHoldDetector.holdDelay

    @Test func tapUnder0_3sNeverStarts() {
        var d = ModifierHoldDetector()
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: false) == .none)
        #expect(d.tick(now: t0) == .none)  // establishes the pending start time
        #expect(d.tick(now: t0.addingTimeInterval(delay - 0.05)) == .none)
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: false, otherModifiersDown: false) == .none)
        #expect(d.tick(now: t0.addingTimeInterval(10)) == .none)  // stays idle, no late start
    }

    @Test func holdFor0_3sStartsThenReleaseSends() {
        var d = ModifierHoldDetector()
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: false) == .none)
        #expect(d.tick(now: t0) == .none)
        #expect(d.tick(now: t0.addingTimeInterval(delay + 0.01)) == .start)
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: false, otherModifiersDown: false) == .stopAndSend)
    }

    @Test func keyDownBeforeHoldElapsedMeansNothingEverStarts() {
        var d = ModifierHoldDetector()
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: false) == .none)
        #expect(d.tick(now: t0) == .none)
        #expect(d.keyDown() == .none)
        // Even once the original hold would have elapsed, nothing starts: the hold was cancelled.
        #expect(d.tick(now: t0.addingTimeInterval(delay + 0.01)) == .none)
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: false, otherModifiersDown: false) == .none)
    }

    @Test func keyDownAfterStartCancelsAndDiscards() {
        var d = ModifierHoldDetector()
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: false) == .none)
        #expect(d.tick(now: t0) == .none)
        #expect(d.tick(now: t0.addingTimeInterval(delay + 0.01)) == .start)
        #expect(d.keyDown() == .cancelDiscard)
        // A second, repeat-driven keyDown is a no-op — already idle.
        #expect(d.keyDown() == .none)
    }

    @Test func leftCommandAloneIsIgnored() {
        var d = ModifierHoldDetector()
        #expect(d.flagsChanged(keyCode: 55, rightCmdDown: false, otherModifiersDown: true) == .none)
        #expect(d.tick(now: t0.addingTimeInterval(delay + 0.01)) == .none)
        #expect(d.flagsChanged(keyCode: 55, rightCmdDown: false, otherModifiersDown: false) == .none)
    }

    @Test func rightCommandPlusShiftCancels() {
        // Cancel while still pending (hold not yet elapsed) — nothing had started, so no discard.
        var pending = ModifierHoldDetector()
        #expect(pending.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: false) == .none)
        #expect(pending.tick(now: t0) == .none)
        #expect(pending.flagsChanged(keyCode: 56, rightCmdDown: true, otherModifiersDown: true) == .none)
        #expect(pending.tick(now: t0.addingTimeInterval(delay + 0.01)) == .none)

        // Cancel after listening had started — must discard.
        var active = ModifierHoldDetector()
        #expect(active.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: false) == .none)
        #expect(active.tick(now: t0) == .none)
        #expect(active.tick(now: t0.addingTimeInterval(delay + 0.01)) == .start)
        #expect(active.flagsChanged(keyCode: 56, rightCmdDown: true, otherModifiersDown: true) == .cancelDiscard)
    }

    @Test func rightCommandPressedWhileAnotherModifierAlreadyDownNeverStarts() {
        var d = ModifierHoldDetector()
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: true) == .none)
        #expect(d.tick(now: t0.addingTimeInterval(delay + 0.01)) == .none)
    }

    @Test func autoRepeatIsIrrelevant() {
        var d = ModifierHoldDetector()
        #expect(d.flagsChanged(keyCode: 54, rightCmdDown: true, otherModifiersDown: false) == .none)
        #expect(d.tick(now: t0) == .none)
        #expect(d.tick(now: t0.addingTimeInterval(delay + 0.01)) == .start)
        // Simulate OS auto-repeat delivering several keyDown calls for one interrupting keypress.
        #expect(d.keyDown() == .cancelDiscard)
        #expect(d.keyDown() == .none)
        #expect(d.keyDown() == .none)
    }
}
