import AVFoundation
import CocoCore
import Foundation

/// Speaks Coco's lines with a macOS voice. New speech interrupts whatever is being said.
final class VoiceOutput: NSObject, AVSpeechSynthesizerDelegate {
    static let voiceIdKey = "coco.voiceId"
    static let enabledKey = "coco.voiceEnabled"
    /// Special `coco.voiceId` value (and the default when unset) meaning "speak with the macOS System Voice".
    static let systemVoiceId = "system"

    /// "Voice on/off" from the status menu; on unless the user turned it off.
    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// True while an utterance is being spoken.
    var onSpeakingChanged: ((Bool) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private let systemVoice = SystemVoiceSpeaker()

    override init() {
        super.init()
        synthesizer.delegate = self
        systemVoice.onSpeakingChanged = { [weak self] speaking in self?.onSpeakingChanged?(speaking) }
    }

    /// Installed English voices, for the menu and the picker. Includes novelty voices — callers that
    /// display or auto-pick a voice must filter with `VoicePicker.isNovelty(_:)` / `VoicePicker.choose`.
    static func englishVoices() -> [VoiceInfo] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .map {
                VoiceInfo(identifier: $0.identifier, name: $0.name, language: $0.language,
                          quality: quality($0.quality), isNovelty: $0.voiceTraits.contains(.isNoveltyVoice))
            }
    }

    /// True when Coco should speak with the macOS System Voice: unset (the default) or explicitly "system".
    static func isSystemVoiceActive() -> Bool {
        let saved = UserDefaults.standard.string(forKey: voiceIdKey)
        return saved == nil || saved == systemVoiceId
    }

    /// The AV voice Coco will use when not in system-voice mode: the saved choice if still installed and
    /// not novelty, else VoicePicker's best remaining English voice.
    static func currentVoiceId() -> String? {
        let saved = UserDefaults.standard.string(forKey: voiceIdKey)
        let preferred = (saved == nil || saved == systemVoiceId) ? nil : saved
        return VoicePicker.choose(englishVoices(), preferredIdentifier: preferred)
    }

    /// Speaks `SpeechText.clean(text)` — drafts are never passed here, and raw markdown/URLs/emoji never
    /// reach either voice path. New speech interrupts whatever is being said, in either mode.
    func speak(_ text: String) {
        let cleaned = SpeechText.clean(text)
        guard !cleaned.isEmpty else { return }
        let saved = UserDefaults.standard.string(forKey: Self.voiceIdKey)
        if saved == nil || saved == Self.systemVoiceId {
            if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
            systemVoice.speak(cleaned)
            return
        }
        systemVoice.stop()
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        let utterance = AVSpeechUtterance(string: cleaned)
        if let id = VoicePicker.choose(Self.englishVoices(), preferredIdentifier: saved) {
            utterance.voice = AVSpeechSynthesisVoice(identifier: id)
        }
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
        utterance.pitchMultiplier = 1.1
        utterance.preUtteranceDelay = 0.05
        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        systemVoice.stop()
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
