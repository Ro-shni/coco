import Testing
@testable import CocoCore

@Suite struct PresenceMachineTests {
    @Test func speaksThenReturnsHomeAfterTimeout() {
        var p = PresenceMachine(speakTimeout: 8)
        let shown = p.onSay(kind: .suggestion, now: 0)
        #expect(shown)
        #expect(p.state == .speaking)
        p.tick(now: 7.9)
        #expect(p.state == .speaking)
        p.tick(now: 8)
        #expect(p.state == .home)
    }

    @Test func interactionExtendsSpeaking() {
        var p = PresenceMachine(speakTimeout: 8)
        let _ = p.onSay(kind: .question, now: 0)
        p.onInteraction(now: 6)
        p.tick(now: 10)
        #expect(p.state == .speaking)
        p.tick(now: 14)
        #expect(p.state == .home)
    }

    @Test func busyBlocksUnsolicitedButNotReplies() {
        var p = PresenceMachine()
        p.onActivity(.typing, now: 0)
        #expect(p.state == .busy)
        let unsolicitedShown = p.onSay(kind: .quip, now: 1)
        #expect(!unsolicitedShown)
        #expect(p.state == .busy)
        let replyShown = p.onSay(kind: .reply, now: 1)
        #expect(replyShown)
        #expect(p.state == .speaking)
    }

    @Test func returnsToBusyNotHomeWhenStillBusy() {
        var p = PresenceMachine(speakTimeout: 8)
        let _ = p.onSay(kind: .suggestion, now: 0)
        p.onActivity(.inCall, now: 1)
        #expect(p.state == .speaking)
        p.tick(now: 9)
        #expect(p.state == .busy)
        p.onActivity(.reading, now: 10)
        #expect(p.state == .home)
    }

    @Test func dismissGoesHome() {
        var p = PresenceMachine()
        let _ = p.onSay(kind: .suggestion, now: 0)
        p.dismiss()
        #expect(p.state == .home)
    }
}

@Suite struct RestartLimiterTests {
    @Test func allowsThreeRestartsPerMinute() {
        var l = RestartLimiter(max: 3, window: 60)
        let r1 = l.shouldRestart(now: 0)
        #expect(r1)
        let r2 = l.shouldRestart(now: 10)
        #expect(r2)
        let r3 = l.shouldRestart(now: 20)
        #expect(r3)
        let r4 = l.shouldRestart(now: 30)
        #expect(!r4)
        let r5 = l.shouldRestart(now: 61)
        #expect(r5)
    }
}
