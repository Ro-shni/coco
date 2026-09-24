import AppKit
import ScreenCaptureKit

struct WindowInfo {
    let id: CGWindowID
    let bounds: CGRect
}

enum CaptureError: Error { case windowNotFound }

enum WindowCapture {
    private static var cachedWindows: [CGWindowID: SCWindow] = [:]

    /// Frontmost normal window of `pid`. CGWindowList is ordered front to back.
    static func frontWindow(pid: pid_t) -> WindowInfo? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict),
                  bounds.width > 50, bounds.height > 50 else { continue }
            return WindowInfo(id: id, bounds: bounds)
        }
        return nil
    }

    static func capture(windowID: CGWindowID, maxDimension: CGFloat) async throws -> CGImage {
        let window = try await scWindow(id: windowID)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        let pixels = CGSize(width: window.frame.width * scale, height: window.frame.height * scale)
        let shrink = min(1, maxDimension / max(pixels.width, pixels.height))
        let config = SCStreamConfiguration()
        config.width = max(1, Int(pixels.width * shrink))
        config.height = max(1, Int(pixels.height * shrink))
        config.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    private static func scWindow(id: CGWindowID) async throws -> SCWindow {
        if let cached = await MainActor.run(body: { cachedWindows[id] }) { return cached }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let byId = Dictionary(content.windows.map { ($0.windowID, $0) }, uniquingKeysWith: { a, _ in a })
        await MainActor.run { cachedWindows = byId }
        guard let window = byId[id] else { throw CaptureError.windowNotFound }
        return window
    }

    static func jpegBase64(_ image: CGImage, quality: CGFloat = 0.6) -> String? {
        NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: quality])?.base64EncodedString()
    }

    /// 8×8 grayscale thumbnail for AverageHash.
    static func grayThumbnail(_ image: CGImage) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: 64)
        pixels.withUnsafeMutableBytes { buffer in
            guard let ctx = CGContext(data: buffer.baseAddress, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 8,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            ctx.interpolationQuality = .medium
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        return pixels
    }
}
