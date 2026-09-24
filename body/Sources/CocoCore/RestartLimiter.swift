import Foundation

public struct RestartLimiter: Sendable {
    private let max: Int
    private let window: TimeInterval
    private var restarts: [TimeInterval] = []

    public init(max: Int = 3, window: TimeInterval = 60) { self.max = max; self.window = window }

    public mutating func shouldRestart(now: TimeInterval) -> Bool {
        restarts = restarts.filter { now - $0 < window }
        guard restarts.count < max else { return false }
        restarts.append(now)
        return true
    }
}
