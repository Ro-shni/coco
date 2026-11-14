import Testing
@testable import CocoCore

@Suite struct VoiceSessionTests {
    @Test func beginFromIdleStartsListening() {
        var s = VoiceSession()
        let r1 = s.begin()
        #expect(r1 == .started(flushed: nil))
        #expect(s.phase == .listening)
    }
    @Test func beginWhileListeningIsIgnored() {
        var s = VoiceSession()
        _ = s.begin()
        let r2 = s.begin()
        #expect(r2 == .ignored)
        #expect(s.phase == .listening)
    }
    @Test func partialsSurfaceOnlyWhileListening() {
        var s = VoiceSession()
        _ = s.begin()
        let r3 = s.heard("hel", session: s.id)
        #expect(r3)
        _ = s.end()
        let r4 = s.heard("hello", session: s.id)
        #expect(!r4)
        let r5 = s.finish(session: s.id)
        #expect(r5 == "hello")
    }
    @Test func endOnlyFromListening() {
        var s = VoiceSession()
        let r6 = s.end()
        #expect(!r6)
        _ = s.begin()
        let r7 = s.end()
        #expect(r7)
        #expect(s.phase == .finishing)
        let r8 = s.end()
        #expect(!r8)
    }
    @Test func finishDeliversOnceAndIgnoresStaleSessions() {
        var s = VoiceSession()
        _ = s.begin()
        let first = s.id
        _ = s.heard("  hi there ", session: first)
        _ = s.end()
        let r9 = s.finish(session: first)
        #expect(r9 == "hi there")
        #expect(s.phase == .idle)
        let r10 = s.finish(session: first)
        #expect(r10 == nil)
        let r11 = s.heard("late", session: first)
        #expect(!r11)
    }
    @Test func rePressWhileFinishingFlushesPreviousAndStartsNew() {
        var s = VoiceSession()
        _ = s.begin()
        let first = s.id
        _ = s.heard("first words", session: first)
        _ = s.end()
        let r12 = s.begin()
        #expect(r12 == .started(flushed: "first words"))
        #expect(s.phase == .listening)
        #expect(s.id != first)
        let r13 = s.heard("stale", session: first)
        #expect(!r13)
        let r14 = s.finish(session: first)
        #expect(r14 == nil)
    }
    @Test func rePressAfterSilentSessionFlushesEmptyText() {
        var s = VoiceSession()
        _ = s.begin()
        _ = s.end()
        let r15 = s.begin()
        #expect(r15 == .started(flushed: ""))
    }
    @Test func newSessionStartsWithEmptyTranscript() {
        var s = VoiceSession()
        _ = s.begin()
        _ = s.heard("old", session: s.id)
        _ = s.end()
        _ = s.begin()
        _ = s.end()
        let r16 = s.finish(session: s.id)
        #expect(r16 == "")
    }
}
