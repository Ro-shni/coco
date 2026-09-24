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
    public init(identifier: String, name: String, language: String, quality: Int) {
        self.identifier = identifier; self.name = name; self.language = language; self.quality = quality
    }
}

public enum VoicePicker {
    /// The preferred voice if installed; else the best-quality en-US, then en-GB, then any en-* voice
    /// (ties broken by name). Nil when there is no English voice.
    public static func choose(_ voices: [VoiceInfo], preferredIdentifier: String?) -> String? {
        if let preferredIdentifier, voices.contains(where: { $0.identifier == preferredIdentifier }) {
            return preferredIdentifier
        }
        let tiers: [(VoiceInfo) -> Bool] = [
            { $0.language == "en-US" },
            { $0.language == "en-GB" },
            { $0.language.hasPrefix("en-") || $0.language == "en" },
        ]
        for inTier in tiers {
            let best = voices.filter(inTier).min { a, b in
                a.quality != b.quality ? a.quality > b.quality : a.name < b.name
            }
            if let best { return best.identifier }
        }
        return nil
    }
}
