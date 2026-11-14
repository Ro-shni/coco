import Foundation

/// Pure state machine for "hold Right ⌘ alone to talk": tracks whether the physical Right Command key
/// (virtual key code 54) is held alone for `holdDelay` before it counts as a push-to-talk press. A quick
/// tap does nothing. Once held, any other key going down or any other modifier changing (e.g. the user
/// typing ⌘C with the right hand) cancels — discarding an already-started listen, or simply doing nothing
/// if listening hadn't started yet. Left Command (55) never triggers.
public struct ModifierHoldDetector: Sendable {
    public static let rightCommandKeyCode: UInt16 = 54
    public static let holdDelay: TimeInterval = 0.3

    public enum Action: Equatable, Sendable {
        /// The hold lasted `holdDelay` with nothing else pressed: start listening.
        case start
        /// Right ⌘ was released after listening had started: stop and send what was heard.
        case stopAndSend
        /// Listening had started but was interrupted: stop and discard — no utterance is sent.
        case cancelDiscard
        /// No user-visible effect.
        case none
    }

    private enum State: Equatable {
        case idle
        /// Right ⌘ alone is held. `since` is the `now` of the first `tick` observed while pending —
        /// nil until then, so the hold is timed from the first tick rather than the press event itself.
        case pending(since: Date?)
        case active
    }

    private var state: State = .idle

    public init() {}

    /// `keyCode` is the key whose modifier state just changed. `rightCmdDown` is whether the Right ⌘ key
    /// is currently held. `otherModifiersDown` is whether any modifier other than a lone Right ⌘ is held
    /// (left ⌘, ⇧, ⌃, ⌥, fn) — including when `keyCode` itself is one of those.
    @discardableResult
    public mutating func flagsChanged(keyCode: UInt16, rightCmdDown: Bool, otherModifiersDown: Bool) -> Action {
        guard keyCode == Self.rightCommandKeyCode else {
            return otherModifierChanged(down: otherModifiersDown)
        }
        if rightCmdDown {
            // Right ⌘ pressed. Only begins a hold when nothing else is already down.
            guard case .idle = state, !otherModifiersDown else {
                state = .idle
                return .none
            }
            state = .pending(since: nil)
            return .none
        }
        // Right ⌘ released.
        defer { state = .idle }
        return state == .active ? .stopAndSend : .none
    }

    /// Any non-modifier key was pressed. Cancels a hold in progress exactly like another modifier changing.
    @discardableResult
    public mutating func keyDown() -> Action {
        switch state {
        case .pending:
            state = .idle
            return .none
        case .active:
            state = .idle
            return .cancelDiscard
        case .idle:
            return .none
        }
    }

    /// Periodic clock tick. Starts listening once a pending hold has lasted `holdDelay`.
    @discardableResult
    public mutating func tick(now: Date) -> Action {
        guard case .pending(let since) = state else { return .none }
        guard let since else {
            state = .pending(since: now)
            return .none
        }
        guard now.timeIntervalSince(since) >= Self.holdDelay else { return .none }
        state = .active
        return .start
    }

    private mutating func otherModifierChanged(down: Bool) -> Action {
        guard down else { return .none }
        switch state {
        case .pending:
            state = .idle
            return .none
        case .active:
            state = .idle
            return .cancelDiscard
        case .idle:
            return .none
        }
    }
}
