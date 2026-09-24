import AVFoundation
import CocoCore
import Foundation

/// Speaks Coco's lines with a macOS voice. New speech interrupts whatever is being said.
final class VoiceOutput: NSObject, AVSpeechSynthesizerDelegate {
    static let voiceIdKey = "coco.voiceId"
    static let enabledKey = "coco.voiceEnabled"

    /// "Voice on/off" from the status menu; on unless the user turned it off.
    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// True while an utterance is being spoken.
    var onSpeakingChanged: ((Bool) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Installed English voices, for the menu and the picker.
    static func englishVoices() -> [VoiceInfo] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .map { VoiceInfo(identifier: $0.identifier, name: $0.name, language: $0.language, quality: quality($0.quality)) }
    }

    /// The voice Coco will use: the saved choice if still installed, else VoicePicker's best English voice.
    static func currentVoiceId() -> String? {
        VoicePicker.choose(englishVoices(), preferredIdentifier: UserDefaults.standard.string(forKey: voiceIdKey))
    }

    func speak(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        let utterance = AVSpeechUtterance(string: trimmed)
        if let id = Self.currentVoiceId() { utterance.voice = AVSpeechSynthesisVoice(identifier: id) }
        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    }

    private static func quality(_ q: AVSpeechSynthesisVoiceQuality) -> Int {
        switch q {
        case .premium: return 2
        case .enhanced: return 1
        default: return 0
        }
    }

    // Delegate callbacks arrive on the main thread when speech was started from it; hop anyway to be safe.
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) { report() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { report() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { report() }

    private func report() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.onSpeakingChanged?(self.synthesizer.isSpeaking)
        }
    }
}
