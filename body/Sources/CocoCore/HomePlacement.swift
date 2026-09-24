import CoreGraphics
import Foundation

/// Where Coco's home position lives: either a named screen corner, or a custom spot the
/// user dragged Coco to, remembered as a fraction of the display it was dropped on.
public enum HomeSpec: Codable, Equatable, Sendable {
    case corner(ScreenGeometry.Corner)
    /// `fx`/`fy` = the panel's origin as a fraction (0...1) of that display's visibleFrame.
    case custom(displayID: UInt32, fx: Double, fy: Double)
}

public enum HomePlacement {
    public static let defaultSpec: HomeSpec = .corner(.bottomRight)

    public static func origin(for spec: HomeSpec, visibleFrame: CGRect, size: CGSize, margin: CGFloat = 16) -> CGPoint {
        switch spec {
        case .corner(let corner):
            return ScreenGeometry.homeOrigin(corner: corner, size: size, visibleFrame: visibleFrame, margin: margin)
        case .custom(_, let fx, let fy):
            let available = CGSize(width: visibleFrame.width - size.width, height: visibleFrame.height - size.height)
            let proposed = CGPoint(x: visibleFrame.origin.x + CGFloat(fx) * available.width,
                                    y: visibleFrame.origin.y + CGFloat(fy) * available.height)
            return ScreenGeometry.clampOrigin(proposed, size: size, in: visibleFrame)
        }
    }

    public static func customSpec(origin: CGPoint, size: CGSize, visibleFrame: CGRect, displayID: UInt32) -> HomeSpec {
        let availableW = visibleFrame.width - size.width
        let availableH = visibleFrame.height - size.height
        let fx = availableW > 0 ? Double((origin.x - visibleFrame.origin.x) / availableW) : 0
        let fy = availableH > 0 ? Double((origin.y - visibleFrame.origin.y) / availableH) : 0
        return .custom(displayID: displayID, fx: min(max(fx, 0), 1), fy: min(max(fy, 0), 1))
    }

    public static func encode(_ spec: HomeSpec) -> Data? {
        try? JSONEncoder().encode(spec)
    }

    public static func decode(_ data: Data?) -> HomeSpec {
        guard let data, let spec = try? JSONDecoder().decode(HomeSpec.self, from: data) else { return defaultSpec }
        return spec
    }
}

/// Tracks a drag gesture using absolute screen points (not gesture-local translation), so
/// callers can move an `NSPanel` directly from `NSEvent.mouseLocation` deltas.
public struct DragTracker: Sendable {
    public static let threshold: CGFloat = 4

    private var start: CGPoint = .zero
    private var last: CGPoint = .zero

    public init() {}

    public mutating func begin(at point: CGPoint) {
        start = point
        last = point
    }

    /// Returns the delta since the last `begin`/`move` call.
    public mutating func move(to point: CGPoint) -> CGSize {
        let delta = CGSize(width: point.x - last.x, height: point.y - last.y)
        last = point
        return delta
    }

    /// Whether the straight-line distance from `begin` to the most recent point has crossed `threshold`.
    public var isDrag: Bool {
        let dx = last.x - start.x, dy = last.y - start.y
        return (dx * dx + dy * dy).squareRoot() >= Self.threshold
    }
}
