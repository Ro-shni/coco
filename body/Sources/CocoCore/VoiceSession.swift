import Foundation

/// Push-to-talk session bookkeeping: idle → listening (key held) → finishing (waiting for the final
/// transcript) → idle. Each session has an id so late recogniser callbacks from an older session are ignored.
public struct VoiceSession: Sendable {
    public enum Phase: Equatable, Sendable { case idle, listening, finishing }
    public enum BeginResult: Equatable, Sendable {
        /// Already listening (e.g. a key repeat): nothing to do.
        case ignored
        /// A new session started. `flushed` is the transcript of a previous session that was still finishing —
        /// it must be delivered now so a quick re-press never drops what was said.
        case started(flushed: String?)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var id = 0
    private var transcript = ""

    public init() {}

    public mutating func begin() -> BeginResult {
        switch phase {
        case .listening:
            return .ignored
        case .finishing:
            let flushed = cleaned
            startNew()
            return .started(flushed: flushed)
        case .idle:
            startNew()
            return .started(flushed: nil)
        }
    }

    /// Key released: stop capturing and wait for the final transcript. False if not listening.
    public mutating func end() -> Bool {
        guard phase == .listening else { return false }
        phase = .finishing
        return true
    }

    /// Records recogniser text for `session`. Returns true when it should be shown live (still listening).
    public mutating func heard(_ text: String, session: Int) -> Bool {
        guard session == id, phase != .idle else { return false }
        transcript = text
        return phase == .listening
    }

    /// Ends `session`, returning its trimmed transcript — or nil if that session is no longer current.
    public mutating func finish(session: Int) -> String? {
        guard session == id, phase != .idle else { return nil }
        phase = .idle
        return cleaned
    }

    private var cleaned: String { transcript.trimmingCharacters(in: .whitespacesAndNewlines) }

    private mutating func startNew() {
        id += 1
        transcript = ""
        phase = .listening
    }
}
