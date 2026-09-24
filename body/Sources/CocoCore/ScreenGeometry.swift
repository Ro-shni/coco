import CoreGraphics

public enum ScreenGeometry {
    public enum Corner: String, Codable, Sendable { case bottomRight, bottomLeft, topRight, topLeft }

    /// `normalized`: Vision rect (origin bottom-left, 0...1) inside the window.
    /// `windowBounds`: CGWindowList bounds (global, origin top-left of the primary display).
    /// Returns AppKit global coordinates (origin bottom-left of the primary display).
    public static func appKitRect(normalized n: CGRect, windowBounds w: CGRect, primaryScreenHeight h: CGFloat) -> CGRect {
        let width = n.width * w.width
        let height = n.height * w.height
        let x = w.minX + n.minX * w.width
        let topY = w.minY + (1 - n.maxY) * w.height
        return CGRect(x: x, y: h - (topY + height), width: width, height: height)
    }

    public static func clampOrigin(_ origin: CGPoint, size: CGSize, in frame: CGRect) -> CGPoint {
        CGPoint(x: min(max(origin.x, frame.minX), frame.maxX - size.width),
                y: min(max(origin.y, frame.minY), frame.maxY - size.height))
    }

    public static func homeOrigin(corner: Corner, size: CGSize, visibleFrame f: CGRect, margin m: CGFloat) -> CGPoint {
        switch corner {
        case .bottomRight: return CGPoint(x: f.maxX - size.width - m, y: f.minY + m)
        case .bottomLeft: return CGPoint(x: f.minX + m, y: f.minY + m)
        case .topRight: return CGPoint(x: f.maxX - size.width - m, y: f.maxY - size.height - m)
        case .topLeft: return CGPoint(x: f.minX + m, y: f.maxY - size.height - m)
        }
    }
}
