import Foundation

public enum PresenceState: Equatable, Sendable { case home, speaking, busy }

public struct PresenceMachine: Sendable {
    public private(set) var state: PresenceState = .home
    public let speakTimeout: TimeInterval
    private var speakingSince: TimeInterval = 0
    private var activity: ActivityState = .reading

    public init(speakTimeout: TimeInterval = 8) { self.speakTimeout = speakTimeout }

    /// Returns true when the bubble should be shown.
    public mutating func onSay(kind: SayKind, now: TimeInterval) -> Bool {
        if activity.isBusy && !kind.isSolicited { return false }
        state = .speaking
        speakingSince = now
        return true
    }

    public mutating func onActivity(_ a: ActivityState, now: TimeInterval) {
        activity = a
        if state != .speaking { state = restingState }
    }

    public mutating func onInteraction(now: TimeInterval) {
        if state == .speaking { speakingSince = now }
    }

    public mutating func dismiss() { state = restingState }

    public mutating func tick(now: TimeInterval) {
        if state == .speaking && now - speakingSince >= speakTimeout { dismiss() }
    }

    private var restingState: PresenceState { activity.isBusy ? .busy : .home }
}
