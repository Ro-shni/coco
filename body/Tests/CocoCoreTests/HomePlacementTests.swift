import CoreGraphics
import Foundation
import Testing
@testable import CocoCore

@Suite struct HomePlacementTests {
    let size = CGSize(width: 60, height: 60)

    @Test func cornerSpecMatchesScreenGeometryHomeOrigin() {
        let vf = CGRect(x: 0, y: 25, width: 1000, height: 775)
        let origin = HomePlacement.origin(for: .corner(.bottomRight), visibleFrame: vf, size: size)
        #expect(origin == ScreenGeometry.homeOrigin(corner: .bottomRight, size: size, visibleFrame: vf, margin: 16))
    }

    @Test func customRoundTripsWithinHalfAPoint() {
        let vf = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let original = CGPoint(x: 400, y: 300)
        let spec = HomePlacement.customSpec(origin: original, size: size, visibleFrame: vf, displayID: 1)
        let restored = HomePlacement.origin(for: spec, visibleFrame: vf, size: size)
        #expect(abs(restored.x - original.x) <= 0.5)
        #expect(abs(restored.y - original.y) <= 0.5)
    }

    @Test func customKeepsProportionalPositionOnDifferentSizedFrame() {
        let vf = CGRect(x: 0, y: 0, width: 1000, height: 1000)
        let origin = CGPoint(x: 470, y: 470)  // fx = fy = 0.5 of the available box
        let spec = HomePlacement.customSpec(origin: origin, size: size, visibleFrame: vf, displayID: 1)
        let biggerFrame = CGRect(x: 0, y: 0, width: 2000, height: 2000)
        let restored = HomePlacement.origin(for: spec, visibleFrame: biggerFrame, size: size)
        #expect(abs(restored.x - 970) <= 0.5)
        #expect(abs(restored.y - 970) <= 0.5)
    }

    @Test func clampingKeepsThePanelInside() {
        let vf = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let spec = HomeSpec.custom(displayID: 1, fx: 1.5, fy: -0.5)
        let origin = HomePlacement.origin(for: spec, visibleFrame: vf, size: size)
        #expect(origin.x <= vf.maxX - size.width)
        #expect(origin.y >= vf.minY)
    }

    @Test func decodeGarbageFallsBackToDefault() {
        #expect(HomePlacement.decode(nil) == HomePlacement.defaultSpec)
        #expect(HomePlacement.decode(Data([0x00, 0x01, 0x02])) == HomePlacement.defaultSpec)
    }
}

@Suite struct DragTrackerTests {
    @Test func belowThresholdIsNotADrag() {
        var t = DragTracker()
        t.begin(at: CGPoint(x: 10, y: 10))
        let delta = t.move(to: CGPoint(x: 12, y: 10))
        #expect(delta == CGSize(width: 2, height: 0))
        #expect(!t.isDrag)
    }

    @Test func aboveThresholdIsADrag() {
        var t = DragTracker()
        t.begin(at: CGPoint(x: 10, y: 10))
        _ = t.move(to: CGPoint(x: 15, y: 10))
        #expect(t.isDrag)
    }

    @Test func deltasSumToTotalDisplacement() {
        var t = DragTracker()
        t.begin(at: CGPoint(x: 0, y: 0))
        let d1 = t.move(to: CGPoint(x: 3, y: 1))
        let d2 = t.move(to: CGPoint(x: 3, y: 5))
        #expect(d1.width + d2.width == 3)
        #expect(d1.height + d2.height == 5)
    }
}
