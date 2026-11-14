import Foundation

public enum DeadlineError: Error, Equatable { case timedOut }

/// Runs an async operation but gives up after `seconds`. Unlike a task group, this returns on time even when the
/// operation ignores cancellation and never completes (ScreenCaptureKit calls occasionally do exactly that); the
/// abandoned operation is cancelled and its eventual result, if any, is dropped.
public enum Deadline {
    public static func run<T>(seconds: TimeInterval, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let once = ResumeOnce()
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            let task = Task {
                do {
                    let value = try await operation()
                    if once.claim() { continuation.resume(returning: value) }
                } catch {
                    if once.claim() { continuation.resume(throwing: error) }
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
                guard once.claim() else { return }
                task.cancel()
                continuation.resume(throwing: DeadlineError.timedOut)
            }
        }
    }
}

/// Lets exactly one of the racing completions resume the continuation.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
