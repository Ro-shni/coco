import Foundation

public let protocolVersion = 1

public func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

public enum ActivityState: String, Codable, Sendable {
    case typing, reading, idle, inCall = "in_call", sharing

    public var isBusy: Bool { self == .typing || self == .inCall || self == .sharing }
}

public enum Mood: String, Codable, Sendable { case bored, curious, focused, worried, sleepy }

public enum SayKind: String, Codable, Sendable {
    case quip, suggestion, question, status, reply
    public var isSolicited: Bool { self == .status || self == .reply }
}

public enum UtteranceSource: String, Codable, Sendable { case voice, chat }

public struct ContextPayload: Codable, Equatable, Sendable {
    public var app: String
    public var bundleId: String
    public var windowTitle: String
    public var url: String?
    public var selection: String?
    public var ocrText: String?
    public var isPrivate: Bool
    public var ts: Int64

    enum CodingKeys: String, CodingKey { case app, bundleId, windowTitle, url, selection, ocrText, isPrivate = "private", ts }

    public init(app: String, bundleId: String, windowTitle: String, url: String? = nil, selection: String? = nil,
                ocrText: String? = nil, isPrivate: Bool, ts: Int64) {
        self.app = app; self.bundleId = bundleId; self.windowTitle = windowTitle; self.url = url
        self.selection = selection; self.ocrText = ocrText; self.isPrivate = isPrivate; self.ts = ts
    }
}

public struct ActivityPayload: Codable, Equatable, Sendable {
    public var state: ActivityState
    public var ts: Int64
    public init(state: ActivityState, ts: Int64) { self.state = state; self.ts = ts }
}

public struct KeyframePayload: Codable, Equatable, Sendable {
    public var jpegBase64: String
    public var width: Int
    public var height: Int
    public var ts: Int64
    public init(jpegBase64: String, width: Int, height: Int, ts: Int64) {
        self.jpegBase64 = jpegBase64; self.width = width; self.height = height; self.ts = ts
    }
}

public struct UtterancePayload: Codable, Equatable, Sendable {
    public var text: String
    public var source: UtteranceSource
    public init(text: String, source: UtteranceSource) { self.text = text; self.source = source }
}

public struct ChipPayload: Codable, Equatable, Sendable {
    public var nudgeId: String
    public var choice: String
    public init(nudgeId: String, choice: String) { self.nudgeId = nudgeId; self.choice = choice }
}

public struct SayPayload: Codable, Equatable, Sendable {
    public var nudgeId: String
    public var text: String
    public var kind: SayKind
    public var chips: [String]
    public var speak: Bool
    public var pointAt: String?
    public init(nudgeId: String, text: String, kind: SayKind, chips: [String], speak: Bool, pointAt: String? = nil) {
        self.nudgeId = nudgeId; self.text = text; self.kind = kind; self.chips = chips; self.speak = speak; self.pointAt = pointAt
    }
}

public struct RequestKeyframePayload: Codable, Equatable, Sendable {
    public var reason: String
    public init(reason: String) { self.reason = reason }
}

public struct MoodPayload: Codable, Equatable, Sendable {
    public var mood: Mood
    public init(mood: Mood) { self.mood = mood }
}

public enum FocusKind: String, Codable, Sendable { case app, window }

public struct FocusPayload: Codable, Equatable, Sendable {
    public var requestId: String
    public var target: String
    public var kind: FocusKind
    public init(requestId: String, target: String, kind: FocusKind) {
        self.requestId = requestId; self.target = target; self.kind = kind
    }
}

public struct FocusResultPayload: Codable, Equatable, Sendable {
    public var requestId: String
    public var ok: Bool
    public var matched: String?
    public init(requestId: String, ok: Bool, matched: String? = nil) {
        self.requestId = requestId; self.ok = ok; self.matched = matched
    }
}

private enum EnvelopeKeys: String, CodingKey { case v, type }

private func decodeEnvelope(_ decoder: Decoder) throws -> (KeyedDecodingContainer<EnvelopeKeys>, String) {
    let c = try decoder.container(keyedBy: EnvelopeKeys.self)
    let v = try c.decode(Int.self, forKey: .v)
    guard v == protocolVersion else {
        throw DecodingError.dataCorruptedError(forKey: .v, in: c, debugDescription: "unsupported protocol version \(v)")
    }
    return (c, try c.decode(String.self, forKey: .type))
}

private func encodeEnvelope(_ encoder: Encoder, type: String) throws {
    var c = encoder.container(keyedBy: EnvelopeKeys.self)
    try c.encode(protocolVersion, forKey: .v)
    try c.encode(type, forKey: .type)
}

public enum BodyToBrain: Codable, Equatable, Sendable {
    case context(ContextPayload)
    case activity(ActivityPayload)
    case keyframe(KeyframePayload)
    case utterance(UtterancePayload)
    case chip(ChipPayload)
    case focusResult(FocusResultPayload)

    public init(from decoder: Decoder) throws {
        let (c, type) = try decodeEnvelope(decoder)
        switch type {
        case "context": self = .context(try ContextPayload(from: decoder))
        case "activity": self = .activity(try ActivityPayload(from: decoder))
        case "keyframe": self = .keyframe(try KeyframePayload(from: decoder))
        case "utterance": self = .utterance(try UtterancePayload(from: decoder))
        case "chip": self = .chip(try ChipPayload(from: decoder))
        case "focus_result": self = .focusResult(try FocusResultPayload(from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown type \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .context(let p): try encodeEnvelope(encoder, type: "context"); try p.encode(to: encoder)
        case .activity(let p): try encodeEnvelope(encoder, type: "activity"); try p.encode(to: encoder)
        case .keyframe(let p): try encodeEnvelope(encoder, type: "keyframe"); try p.encode(to: encoder)
        case .utterance(let p): try encodeEnvelope(encoder, type: "utterance"); try p.encode(to: encoder)
        case .chip(let p): try encodeEnvelope(encoder, type: "chip"); try p.encode(to: encoder)
        case .focusResult(let p): try encodeEnvelope(encoder, type: "focus_result"); try p.encode(to: encoder)
        }
    }
}

public enum BrainToBody: Codable, Equatable, Sendable {
    case say(SayPayload)
    case requestKeyframe(RequestKeyframePayload)
    case mood(MoodPayload)
    case focus(FocusPayload)

    public init(from decoder: Decoder) throws {
        let (c, type) = try decodeEnvelope(decoder)
        switch type {
        case "say": self = .say(try SayPayload(from: decoder))
        case "request_keyframe": self = .requestKeyframe(try RequestKeyframePayload(from: decoder))
        case "mood": self = .mood(try MoodPayload(from: decoder))
        case "focus": self = .focus(try FocusPayload(from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown type \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .say(let p): try encodeEnvelope(encoder, type: "say"); try p.encode(to: encoder)
        case .requestKeyframe(let p): try encodeEnvelope(encoder, type: "request_keyframe"); try p.encode(to: encoder)
        case .mood(let p): try encodeEnvelope(encoder, type: "mood"); try p.encode(to: encoder)
        case .focus(let p): try encodeEnvelope(encoder, type: "focus"); try p.encode(to: encoder)
        }
    }
}
