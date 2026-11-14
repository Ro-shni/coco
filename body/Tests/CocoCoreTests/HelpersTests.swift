import CoreGraphics
import Testing
@testable import CocoCore

@Suite struct AverageHashTests {
    @Test func identicalImagesHaveZeroDistance() {
        let px = (0..<64).map { UInt8($0 * 4) }
        #expect(AverageHash.distance(AverageHash.hash(gray: px), AverageHash.hash(gray: px)) == 0)
    }
    @Test func invertedImagesAreFarApart() {
        let px = (0..<64).map { UInt8($0 * 4) }
        let inverted = px.map { 255 - $0 }
        #expect(AverageHash.distance(AverageHash.hash(gray: px), AverageHash.hash(gray: inverted)) > 50)
    }
    @Test func smallBrightnessShiftIsBelowThreshold() {
        let px = (0..<64).map { UInt8($0 * 4) }
        let brighter = px.map { UInt8(min(255, Int($0) + 2)) }
        #expect(AverageHash.distance(AverageHash.hash(gray: px), AverageHash.hash(gray: brighter)) <= AverageHash.changeThreshold)
    }
}

@Suite struct ContextChangeDetectorTests {
    func payload(title: String = "t", ocr: String? = "a b") -> ContextPayload {
        ContextPayload(app: "A", bundleId: "a", windowTitle: title, ocrText: ocr, isPrivate: false, ts: 1)
    }
    @Test func sendsFirstThenOnlyOnChange() {
        var d = ContextChangeDetector()
        let first = d.shouldSend(payload())
        #expect(first)
        let second = d.shouldSend(payload())
        #expect(!second)
        let third = d.shouldSend(payload(ocr: "A   B"))  // whitespace/case-insensitive
        #expect(!third)
        let fourth = d.shouldSend(payload(title: "other"))
        #expect(fourth)
    }
    @Test func timestampAloneIsNotAChange() {
        var d = ContextChangeDetector()
        var p = payload()
        let first = d.shouldSend(p)
        #expect(first)
        p.ts = 999
        let second = d.shouldSend(p)
        #expect(!second)
    }
    @Test func resetForcesNextSend() {
        var d = ContextChangeDetector()
        let first = d.shouldSend(payload())
        #expect(first)
        d.reset()
        let second = d.shouldSend(payload())
        #expect(second)
    }
}

@Suite struct AnchorMatcherTests {
    let boxes = [
        TextBox(text: "p99 latency", rect: CGRect(x: 0.1, y: 0.8, width: 0.2, height: 0.05)),
        TextBox(text: "spike at 10:40 on supply-prd", rect: CGRect(x: 0.5, y: 0.4, width: 0.3, height: 0.05)),
        TextBox(text: "10:40", rect: CGRect(x: 0.6, y: 0.1, width: 0.05, height: 0.03)),
    ]
    @Test func prefersTheMostSpecificFullMatch() {
        #expect(AnchorMatcher.bestMatch(for: "10:40", in: boxes)?.text == "10:40")
    }
    @Test func matchesPartialPhrases() {
        #expect(AnchorMatcher.bestMatch(for: "the spike on supply-prd", in: boxes)?.text == "spike at 10:40 on supply-prd")
    }
    @Test func returnsNilBelowHalfTheTokens() {
        #expect(AnchorMatcher.bestMatch(for: "memory usage graph", in: boxes) == nil)
        #expect(AnchorMatcher.bestMatch(for: "   ", in: boxes) == nil)
    }
}

@Suite struct ScreenGeometryTests {
    @Test func convertsVisionRectToAppKitCoordinates() {
        let r = ScreenGeometry.appKitRect(normalized: CGRect(x: 0.1, y: 0.2, width: 0.2, height: 0.1),
                                          windowBounds: CGRect(x: 100, y: 50, width: 1000, height: 800),
                                          primaryScreenHeight: 1000)
        #expect(r == CGRect(x: 200, y: 310, width: 200, height: 80))
    }
    @Test func clampsIntoFrame() {
        let frame = CGRect(x: 0, y: 0, width: 1000, height: 800)
        #expect(ScreenGeometry.clampOrigin(CGPoint(x: 990, y: -20), size: CGSize(width: 60, height: 60), in: frame) == CGPoint(x: 940, y: 0))
    }
    @Test func clampsOnASecondaryDisplayLeftOfPrimary() {
        let left = CGRect(x: -1920, y: 0, width: 1920, height: 1080)
        #expect(ScreenGeometry.clampOrigin(CGPoint(x: -1950, y: 1070), size: CGSize(width: 300, height: 100), in: left) == CGPoint(x: -1920, y: 980))
    }
    @Test func homeCorners() {
        let vf = CGRect(x: 0, y: 25, width: 1000, height: 775)
        let size = CGSize(width: 60, height: 60)
        #expect(ScreenGeometry.homeOrigin(corner: .bottomRight, size: size, visibleFrame: vf, margin: 16) == CGPoint(x: 924, y: 41))
        #expect(ScreenGeometry.homeOrigin(corner: .topLeft, size: size, visibleFrame: vf, margin: 16) == CGPoint(x: 16, y: 724))
    }
}
