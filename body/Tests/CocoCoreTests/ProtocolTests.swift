import Foundation
import Testing
@testable import CocoCore

private let fixturesRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // CocoCoreTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // body
    .deletingLastPathComponent()  // coco
    .appendingPathComponent("protocol/fixtures")

private func fixtures(_ dir: String) throws -> [(String, Data)] {
    let url = fixturesRoot.appendingPathComponent(dir)
    return try FileManager.default.contentsOfDirectory(atPath: url.path).sorted().map {
        ($0, try Data(contentsOf: url.appendingPathComponent($0)))
    }
}

private func jsonObject(_ data: Data) throws -> NSDictionary {
    try #require(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
}

@Suite struct ProtocolContractTests {
    @Test func bodyFixturesRoundTrip() throws {
        let all = try fixtures("body")
        #expect(all.count == 6)
        for (name, data) in all {
            let msg = try JSONDecoder().decode(BodyToBrain.self, from: data)
            let back = try JSONEncoder().encode(msg)
            #expect(try jsonObject(back) == jsonObject(data), "fixture \(name) did not round-trip")
        }
    }

    @Test func brainFixturesRoundTrip() throws {
        let all = try fixtures("brain")
        #expect(all.count == 4)
        for (name, data) in all {
            let msg = try JSONDecoder().decode(BrainToBody.self, from: data)
            let back = try JSONEncoder().encode(msg)
            #expect(try jsonObject(back) == jsonObject(data), "fixture \(name) did not round-trip")
        }
    }

    @Test func decodesInCallActivity() throws {
        let data = Data(#"{"v":1,"type":"activity","state":"in_call","ts":5}"#.utf8)
        #expect(try JSONDecoder().decode(BodyToBrain.self, from: data) == .activity(ActivityPayload(state: .inCall, ts: 5)))
    }

    @Test func rejectsWrongVersionAndUnknownType() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(BrainToBody.self, from: Data(#"{"v":2,"type":"mood","mood":"bored"}"#.utf8))
        }
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(BrainToBody.self, from: Data(#"{"v":1,"type":"dance"}"#.utf8))
        }
    }

    @Test func solicitedKinds() {
        #expect(SayKind.reply.isSolicited && SayKind.status.isSolicited)
        #expect(!SayKind.quip.isSolicited && !SayKind.suggestion.isSolicited && !SayKind.question.isSolicited)
    }
}
