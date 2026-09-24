import Testing
@testable import CocoCore

@Suite struct SpeakPolicyTests {
    func say(kind: SayKind = .reply, speak: Bool = true) -> SayPayload {
        SayPayload(nudgeId: "n1", text: "hi", kind: kind, chips: [], speak: speak)
    }

    @Test func speaksWhenAllowed() {
        #expect(SpeakPolicy.shouldSpeak(say: say(), voiceEnabled: true, activity: .reading, recording: false))
    }
    @Test func respectsBrainSpeakFlag() {
        #expect(!SpeakPolicy.shouldSpeak(say: say(speak: false), voiceEnabled: true, activity: .reading, recording: false))
    }
    @Test func respectsVoiceToggle() {
        #expect(!SpeakPolicy.shouldSpeak(say: say(), voiceEnabled: false, activity: .reading, recording: false))
    }
    @Test func neverSpeaksWhileUserIsTalking() {
        #expect(!SpeakPolicy.shouldSpeak(say: say(), voiceEnabled: true, activity: .reading, recording: true))
    }
    @Test func neverSpeaksInCallOrSharing() {
        #expect(!SpeakPolicy.shouldSpeak(say: say(), voiceEnabled: true, activity: .inCall, recording: false))
        #expect(!SpeakPolicy.shouldSpeak(say: say(), voiceEnabled: true, activity: .sharing, recording: false))
    }
    @Test func typingAllowsSolicitedOnly() {
        #expect(SpeakPolicy.shouldSpeak(say: say(kind: .reply), voiceEnabled: true, activity: .typing, recording: false))
        #expect(SpeakPolicy.shouldSpeak(say: say(kind: .status), voiceEnabled: true, activity: .typing, recording: false))
        #expect(!SpeakPolicy.shouldSpeak(say: say(kind: .quip), voiceEnabled: true, activity: .typing, recording: false))
        #expect(!SpeakPolicy.shouldSpeak(say: say(kind: .suggestion), voiceEnabled: true, activity: .typing, recording: false))
        #expect(!SpeakPolicy.shouldSpeak(say: say(kind: .question), voiceEnabled: true, activity: .typing, recording: false))
    }
    @Test func unsolicitedSpeaksWhenNotBusy() {
        #expect(SpeakPolicy.shouldSpeak(say: say(kind: .quip), voiceEnabled: true, activity: .idle, recording: false))
    }
}

@Suite struct VoicePickerTests {
    func v(_ id: String, _ name: String, _ lang: String, _ q: Int = 0) -> VoiceInfo {
        VoiceInfo(identifier: id, name: name, language: lang, quality: q)
    }

    @Test func preferredIdentifierWins() {
        let voices = [v("a", "Alex", "en-US", 2), v("b", "Bea", "en-GB", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: "b") == "b")
    }
    @Test func missingPreferredFallsBack() {
        let voices = [v("a", "Alex", "en-US", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: "gone") == "a")
    }
    @Test func bestQualityUSFirst() {
        let voices = [v("gb", "Daniel", "en-GB", 2), v("us0", "Fred", "en-US", 0), v("us1", "Samantha", "en-US", 1)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "us1")
    }
    @Test func thenGB() {
        let voices = [v("au", "Karen", "en-AU", 2), v("gb", "Daniel", "en-GB", 0), v("fr", "Thomas", "fr-FR", 2)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "gb")
    }
    @Test func thenAnyEnglish() {
        let voices = [v("fr", "Thomas", "fr-FR", 2), v("in", "Rishi", "en-IN", 0), v("au", "Karen", "en-AU", 1)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "au")
    }
    @Test func tiesBreakByName() {
        let voices = [v("z", "Zoe", "en-US", 1), v("a", "Ava", "en-US", 1)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "a")
    }
    @Test func noEnglishMeansNil() {
        #expect(VoicePicker.choose([v("fr", "Thomas", "fr-FR", 2)], preferredIdentifier: nil) == nil)
        #expect(VoicePicker.choose([], preferredIdentifier: nil) == nil)
    }
}
