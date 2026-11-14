import Foundation

public struct ActivitySignals: Equatable, Sendable {
    public var keystrokesLast10s: Int
    public var secondsSinceInput: Double
    public var micInUse: Bool
    public var cameraInUse: Bool
    public var screenSharing: Bool
    /// Coco itself is recording (push-to-talk): the mic being busy is then not a call.
    public var selfRecording: Bool

    public init(keystrokesLast10s: Int, secondsSinceInput: Double, micInUse: Bool, cameraInUse: Bool, screenSharing: Bool,
                selfRecording: Bool = false) {
        self.keystrokesLast10s = keystrokesLast10s; self.secondsSinceInput = secondsSinceInput
        self.micInUse = micInUse; self.cameraInUse = cameraInUse; self.screenSharing = screenSharing
        self.selfRecording = selfRecording
    }
}

public enum ActivityClassifier {
    public static let typingKeystrokesPer10s = 15
    public static let idleAfterSeconds = 120.0

    public static func classify(_ s: ActivitySignals) -> ActivityState {
        if s.screenSharing { return .sharing }
        if (s.micInUse && !s.selfRecording) || s.cameraInUse { return .inCall }
        if s.keystrokesLast10s >= typingKeystrokesPer10s { return .typing }
        if s.secondsSinceInput >= idleAfterSeconds { return .idle }
        return .reading
    }
}

public struct KeystrokeWindow: Sendable {
    private static let capacity = 500
    private var times: [TimeInterval] = []

    public init() {}

    public mutating func record(at time: TimeInterval) {
        times.append(time)
        if times.count > Self.capacity { times.removeFirst(times.count - Self.capacity) }
    }

    public func count(now: TimeInterval, window: TimeInterval) -> Int {
        times.reduce(0) { $1 > now - window ? $0 + 1 : $0 }
    }
}
