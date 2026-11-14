import Foundation

/// Push-to-talk's own hold-and-cancel timing lives in `ModifierHoldDetector`; see ModifierHoldDetector.swift.

public enum SpeakPolicy {
    /// Whether Coco should say `say` out loud. Never while the user is talking, in a call or sharing;
    /// while typing only solicited replies (reply/status) are spoken.
    public static func shouldSpeak(say: SayPayload, voiceEnabled: Bool, activity: ActivityState, recording: Bool) -> Bool {
        guard say.speak, voiceEnabled, !recording else { return false }
        switch activity {
        case .inCall, .sharing: return false
        case .typing: return say.kind.isSolicited
        case .reading, .idle: return true
        }
    }
}

public struct VoiceInfo: Equatable, Sendable {
    public var identifier: String
    public var name: String
    public var language: String
    /// 0 default, 1 enhanced, 2 premium.
    public var quality: Int
    /// From AVSpeechSynthesisVoice.voiceTraits.contains(.isNoveltyVoice); not every novelty voice sets it
    /// (see VoicePicker.noveltyNames), so callers should prefer `VoicePicker.isNovelty(_:)` over this alone.
    public var isNovelty: Bool
    public init(identifier: String, name: String, language: String, quality: Int, isNovelty: Bool = false) {
        self.identifier = identifier; self.name = name; self.language = language
        self.quality = quality; self.isNovelty = isNovelty
    }
}

public enum VoicePicker {
    /// Novelty voices Apple ships that don't reliably report `.isNoveltyVoice` in `voiceTraits`;
    /// matched by name as a fallback so they're never offered or auto-picked.
    public static let noveltyNames: Set<String> = [
        "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Wobble", "Deranged",
        "Good News", "Hysterical", "Jester", "Organ", "Pipe Organ", "Superstar", "Trinoids",
        "Whisper", "Zarvox", "Fred", "Junior", "Ralph", "Kathy", "Grandma", "Grandpa", "Rocko",
        "Eddy", "Flo", "Reed", "Sandy", "Shelley",
    ]

    /// Names of natural-sounding voices we'd rather use when quality ties, in preference order.
    private static let preferredNames = ["Zoe", "Ava", "Samantha", "Allison", "Susan", "Karen", "Tara", "Moira", "Tessa"]

    /// True if a voice should never be shown or auto-picked: novelty per the OS trait, or by name fallback.
    public static func isNovelty(_ voice: VoiceInfo) -> Bool {
        voice.isNovelty || noveltyNames.contains(voice.name)
    }

    /// The preferred voice if installed and not novelty; else the best remaining voice, preferring
    /// (in order) higher quality, a name from `preferredNames`, en-US over en-GB over any other en-*,
    /// then alphabetical. Nil when there is no non-novelty English voice.
    public static func choose(_ voices: [VoiceInfo], preferredIdentifier: String?) -> String? {
        let candidates = voices.filter { !isNovelty($0) && ($0.language.hasPrefix("en-") || $0.language == "en") }
        if let preferredIdentifier, candidates.contains(where: { $0.identifier == preferredIdentifier }) {
            return preferredIdentifier
        }
        func localeTier(_ v: VoiceInfo) -> Int {
            v.language == "en-US" ? 0 : (v.language == "en-GB" ? 1 : 2)
        }
        func nameRank(_ v: VoiceInfo) -> Int {
            preferredNames.firstIndex(of: v.name) ?? Int.max
        }
        return candidates.min { a, b in
            if a.quality != b.quality { return a.quality > b.quality }
            let ar = nameRank(a), br = nameRank(b)
            if ar != br { return ar < br }
            let at = localeTier(a), bt = localeTier(b)
            if at != bt { return at < bt }
            return a.name < b.name
        }?.identifier
    }
}
