import Foundation

/// The parts of Coco's face that change with mood (see docs/design/coco-look-mock.html).
public enum Expression {
    public enum EyeStyle: Sendable { case open, wink, halfLid, wide, closed }
    public enum MouthStyle: Sendable { case smile, bigSmile, soft, wavy, flat, o }
    public enum StarStyle: Sendable { case bright, dim, amber }
    public enum AntennaStyle: Sendable { case up, droop }
    public enum Extra: Sendable { case sweat, zzz }
}

public typealias EyeStyle = Expression.EyeStyle
public typealias MouthStyle = Expression.MouthStyle
public typealias StarStyle = Expression.StarStyle
public typealias AntennaStyle = Expression.AntennaStyle
public typealias Extra = Expression.Extra

public struct CharacterLook: Equatable, Sendable {
    public var leftEye: EyeStyle
    public var rightEye: EyeStyle
    public var mouth: MouthStyle
    public var star: StarStyle
    public var antenna: AntennaStyle
    public var extras: Set<Extra>
    public var blush: Double

    public init(leftEye: EyeStyle, rightEye: EyeStyle, mouth: MouthStyle, star: StarStyle, antenna: AntennaStyle,
                extras: Set<Extra>, blush: Double) {
        self.leftEye = leftEye
        self.rightEye = rightEye
        self.mouth = mouth
        self.star = star
        self.antenna = antenna
        self.extras = extras
        self.blush = blush
    }

    /// Speaking shows the wink + big smile, except when worried or sleepy. A blink closes open, wide and
    /// half-lidded eyes for that frame; a wink stays a wink.
    public static func look(mood: Mood, speaking: Bool, blinking: Bool) -> CharacterLook {
        let base = showsSpeakingFace(mood: mood, speaking: speaking) ? speakingLook : restingLook(mood)
        guard blinking else { return base }
        return CharacterLook(leftEye: blinked(base.leftEye), rightEye: blinked(base.rightEye), mouth: base.mouth,
                             star: base.star, antenna: base.antenna, extras: base.extras, blush: base.blush)
    }

    /// Whether `look(mood:speaking:)` would show the speaking face for this mood.
    public static func showsSpeakingFace(mood: Mood, speaking: Bool) -> Bool {
        speaking && mood != .worried && mood != .sleepy
    }

    private static let speakingLook = CharacterLook(leftEye: .open, rightEye: .wink, mouth: .bigSmile, star: .bright,
                                                    antenna: .up, extras: [], blush: 0.6)

    private static func restingLook(_ mood: Mood) -> CharacterLook {
        switch mood {
        case .curious:
            return CharacterLook(leftEye: .open, rightEye: .open, mouth: .smile, star: .bright, antenna: .up, extras: [], blush: 0.6)
        case .focused:
            return CharacterLook(leftEye: .halfLid, rightEye: .halfLid, mouth: .soft, star: .dim, antenna: .up, extras: [], blush: 0.6)
        case .worried:
            return CharacterLook(leftEye: .wide, rightEye: .wide, mouth: .wavy, star: .amber, antenna: .up, extras: [.sweat], blush: 0.25)
        case .bored:
            return CharacterLook(leftEye: .halfLid, rightEye: .halfLid, mouth: .flat, star: .dim, antenna: .droop, extras: [], blush: 0.6)
        case .sleepy:
            return CharacterLook(leftEye: .closed, rightEye: .closed, mouth: .o, star: .dim, antenna: .up, extras: [.zzz], blush: 0.6)
        }
    }

    private static func blinked(_ eye: EyeStyle) -> EyeStyle {
        switch eye {
        case .open, .wide, .halfLid: return .closed
        case .wink, .closed: return eye
        }
    }
}

/// Deterministic blink timing (SplitMix64): every 3–6 s normally, slow 1.8–3 s blinks when bored, never when sleepy.
public struct BlinkSchedule: Sendable {
    public static let blinkDuration: TimeInterval = 0.12
    private var state: UInt64

    public init(seed: UInt64) { state = seed }

    public mutating func nextInterval(mood: Mood) -> TimeInterval {
        switch mood {
        case .sleepy: return .infinity
        case .bored: return 1.8 + nextUnit() * 1.2
        case .curious, .focused, .worried: return 3 + nextUnit() * 3
        }
    }

    /// Uniform in [0, 1).
    private mutating func nextUnit() -> Double {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / Double(UInt64(1) << 53)
    }
}
