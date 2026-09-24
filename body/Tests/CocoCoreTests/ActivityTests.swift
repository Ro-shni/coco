import Testing
@testable import CocoCore

@Suite struct ActivityClassifierTests {
    func signals(keys: Int = 0, idle: Double = 1, mic: Bool = false, cam: Bool = false, share: Bool = false,
                 selfRec: Bool = false) -> ActivitySignals {
        ActivitySignals(keystrokesLast10s: keys, secondsSinceInput: idle, micInUse: mic, cameraInUse: cam, screenSharing: share,
                        selfRecording: selfRec)
    }

    @Test func readingByDefault() { #expect(ActivityClassifier.classify(signals()) == .reading) }
    @Test func typingAtFifteenKeysPerTenSeconds() {
        #expect(ActivityClassifier.classify(signals(keys: 14)) == .reading)
        #expect(ActivityClassifier.classify(signals(keys: 15)) == .typing)
    }
    @Test func idleAfterTwoMinutes() {
        #expect(ActivityClassifier.classify(signals(idle: 119)) == .reading)
        #expect(ActivityClassifier.classify(signals(idle: 120)) == .idle)
    }
    @Test func callBeatsTypingAndIdle() {
        #expect(ActivityClassifier.classify(signals(keys: 50, mic: true)) == .inCall)
        #expect(ActivityClassifier.classify(signals(idle: 500, cam: true)) == .inCall)
    }
    @Test func cocosOwnRecordingIsNotACall() {
        #expect(ActivityClassifier.classify(signals(mic: true, selfRec: true)) == .reading)
        #expect(ActivityClassifier.classify(signals(keys: 50, mic: true, selfRec: true)) == .typing)
    }
    @Test func selfRecordingDoesNotHideCameraOrSharing() {
        #expect(ActivityClassifier.classify(signals(mic: true, cam: true, selfRec: true)) == .inCall)
        #expect(ActivityClassifier.classify(signals(mic: true, share: true, selfRec: true)) == .sharing)
    }
    @Test func sharingBeatsEverything() {
        #expect(ActivityClassifier.classify(signals(keys: 50, mic: true, share: true)) == .sharing)
    }
    @Test func busyStates() {
        #expect(ActivityState.typing.isBusy && ActivityState.inCall.isBusy && ActivityState.sharing.isBusy)
        #expect(!ActivityState.reading.isBusy && !ActivityState.idle.isBusy)
    }
}

@Suite struct KeystrokeWindowTests {
    @Test func countsOnlyWithinWindow() {
        var w = KeystrokeWindow()
        for t in [0.0, 1, 2, 9.5, 10.5] { w.record(at: t) }
        #expect(w.count(now: 11, window: 10) == 3)
    }
    @Test func boundsMemory() {
        var w = KeystrokeWindow()
        for i in 0..<2000 { w.record(at: Double(i)) }
        #expect(w.count(now: 2000, window: 10_000) == 500)
    }
}
