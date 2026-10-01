import Testing
@testable import CocoCore

@Suite struct VoiceVocabularyTests {
    @Test func includesNamesTheRecogniserMishears() {
        #expect(VoiceVocabulary.terms.contains("Claude"))
        #expect(VoiceVocabulary.terms.contains("Confluence"))
        #expect(Set(VoiceVocabulary.terms).count == VoiceVocabulary.terms.count)
    }
}
