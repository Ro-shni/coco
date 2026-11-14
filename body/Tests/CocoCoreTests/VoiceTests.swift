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
    func v(_ id: String, _ name: String, _ lang: String, _ q: Int = 0, novelty: Bool = false) -> VoiceInfo {
        VoiceInfo(identifier: id, name: name, language: lang, quality: q, isNovelty: novelty)
    }

    @Test func preferredIdentifierWins() {
        let voices = [v("a", "Alex", "en-US", 2), v("b", "Bea", "en-GB", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: "b") == "b")
    }
    @Test func missingPreferredFallsBack() {
        let voices = [v("a", "Alex", "en-US", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: "gone") == "a")
    }
    @Test func noEnglishMeansNil() {
        #expect(VoicePicker.choose([v("fr", "Thomas", "fr-FR", 2)], preferredIdentifier: nil) == nil)
        #expect(VoicePicker.choose([], preferredIdentifier: nil) == nil)
    }

    // Never novelty voices.
    @Test func noveltyOnlyListIsNil() {
        let voices = [v("a", "Zarvox", "en-US", 2, novelty: true), v("b", "Bells", "en-US", 1)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == nil)
    }
    @Test func albertLosesToSamanthaEvenAtEqualQuality() {
        // "Albert" is excluded by the name fallback list even though `isNovelty` isn't set here.
        let voices = [v("a", "Albert", "en-US", 0), v("s", "Samantha", "en-US", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "s")
    }
    @Test func preferredIdentifierNeverANoveltyVoice() {
        let voices = [v("a", "Albert", "en-US", 0, novelty: true), v("s", "Samantha", "en-US", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: "a") == "s")
    }

    // Preference order: quality > preferred names > locale tier > alphabetical.
    @Test func qualityBeatsPreferredName() {
        let voices = [v("z", "Zoe", "en-US", 2), v("s", "Samantha", "en-US", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "z")
    }
    @Test func preferredNameBeatsLocaleTier() {
        // Tara (en-IN, preferred) beats a same-quality, non-preferred en-US voice.
        let voices = [v("t", "Tara", "en-IN", 0), v("n", "Nora", "en-US", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "t")
    }
    @Test func localeTierBreaksTiesAmongNonPreferredNames() {
        let voices = [v("au", "Nora", "en-AU", 0), v("gb", "Daniel", "en-GB", 0), v("fr", "Thomas", "fr-FR", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "gb")
    }
    @Test func alphabeticalBreaksFinalTie() {
        let voices = [v("z", "Zed", "en-US", 0), v("a", "Amy", "en-US", 0)]
        #expect(VoicePicker.choose(voices, preferredIdentifier: nil) == "a")
    }
}
