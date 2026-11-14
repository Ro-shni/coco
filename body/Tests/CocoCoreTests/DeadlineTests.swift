import Foundation
import Testing
@testable import CocoCore

@Suite struct DeadlineTests {
    @Test func returnsValueWhenOperationFinishesInTime() async throws {
        let value = try await Deadline.run(seconds: 1) { 42 }
        #expect(value == 42)
    }

    @Test func rethrowsOperationError() async {
        struct Boom: Error {}
        await #expect(throws: Boom.self) {
            try await Deadline.run(seconds: 1) { () async throws -> Int in throw Boom() }
        }
    }

    /// The real failure: an ScreenCaptureKit call whose completion never fires. The deadline must still return.
    @Test func timesOutWhenOperationNeverReturns() async {
        let started = Date()
        await #expect(throws: DeadlineError.timedOut) {
            try await Deadline.run(seconds: 0.2) { () async throws -> Int in
                try await withCheckedThrowingContinuation { (_: CheckedContinuation<Int, Error>) in }
            }
        }
        #expect(Date().timeIntervalSince(started) < 2)
    }
}
