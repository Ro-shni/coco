import AppKit
import CocoCore
import ScreenCaptureKit

struct WindowInfo {
    let id: CGWindowID
    let bounds: CGRect
}

enum CaptureError: Error { case windowNotFound }

enum WindowCapture {
    private static var cachedWindows: [CGWindowID: SCWindow] = [:]

    /// ScreenCaptureKit's own error domain, surfaced via NSError bridging.
    private static let scStreamErrorDomain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
    /// Observed when a cached SCWindow's frame has drifted from reality (e.g. after a
    /// Space/full-screen switch): the capture call fails even though we just refreshed nothing.
    private static let staleWindowErrorCode = -3811

    /// The real focused window of `pid`, not just whichever CGWindowList sorts first (a browser
    /// helper/popup strip can sort ahead of the actual page window). `focusedTitle` is what
    /// Accessibility reports as the frontmost window's title, used to disambiguate when `pid`
    /// owns multiple on-screen windows.
    static func frontWindow(pid: pid_t, focusedTitle: String?) -> WindowInfo? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let entries: [WindowListEntry] = list.compactMap { w in
            guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict) else { return nil }
            return WindowListEntry(id: id, bounds: bounds, name: w[kCGWindowName as String] as? String)
        }
        guard let picked = WindowPicker.pick(entries, focusedTitle: focusedTitle) else { return nil }
        return WindowInfo(id: picked.id, bounds: picked.bounds)
    }

    static func capture(windowID: CGWindowID, maxDimension: CGFloat) async throws -> CGImage {
        do {
            return try await captureOnce(windowID: windowID, maxDimension: maxDimension)
        } catch {
            guard isStaleWindowError(error) else { throw error }
            FileLog.body.info("capture-diag retry windowID=\(windowID)")
            _ = await MainActor.run { cachedWindows.removeValue(forKey: windowID) }
            return try await captureOnce(windowID: windowID, maxDimension: maxDimension)
        }
    }

    private static func captureOnce(windowID: CGWindowID, maxDimension: CGFloat) async throws -> CGImage {
        let wasCached = await MainActor.run { cachedWindows[windowID] != nil }
        let window: SCWindow
        do {
            window = try await scWindow(id: windowID)
        } catch {
            logDiagFailure(error, windowID: windowID, window: nil, fromCache: wasCached, config: nil, pointPixelScale: nil)
            throw error
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        let pixels = CGSize(width: window.frame.width * scale, height: window.frame.height * scale)
        let shrink = min(1, maxDimension / max(pixels.width, pixels.height))
        let config = SCStreamConfiguration()
        config.width = max(1, Int(pixels.width * shrink))
        config.height = max(1, Int(pixels.height * shrink))
        config.showsCursor = false
        do {
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            logDiagFailure(error, windowID: windowID, window: window, fromCache: wasCached, config: config, pointPixelScale: filter.pointPixelScale)
            throw error
        }
    }

    private static func isStaleWindowError(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == scStreamErrorDomain && nsError.code == staleWindowErrorCode
    }

    private static func scWindow(id: CGWindowID) async throws -> SCWindow {
        if let cached = await MainActor.run(body: { cachedWindows[id] }) {
            if let currentBounds = cgWindowListBounds(id: id), WindowPicker.isStale(cachedFrame: cached.frame, currentBounds: currentBounds) {
                FileLog.body.info("capture-diag cache stale windowID=\(id)")
            } else {
                return cached
            }
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let byId = Dictionary(content.windows.map { ($0.windowID, $0) }, uniquingKeysWith: { a, _ in a })
        await MainActor.run { cachedWindows = byId }
        FileLog.body.info("capture-diag cache refreshed count=\(byId.count)")
        guard let window = byId[id] else { throw CaptureError.windowNotFound }
        return window
    }

    /// Diagnostic-only (Phase 1 evidence gathering): logs everything we know about a capture
    /// failure so the stale-SCWindow-cache hypothesis (and alternatives) can be confirmed or
    /// ruled out from body.log. Never changes control flow — the caller still gets the original error.
    private static func logDiagFailure(_ error: Error, windowID: CGWindowID, window: SCWindow?, fromCache: Bool, config: SCStreamConfiguration?, pointPixelScale: Float?) {
        let nsError = error as NSError
        let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"
        let cgBounds = cgWindowListBounds(id: windowID).map { "\(Int($0.origin.x)),\(Int($0.origin.y)),\(Int($0.width))x\(Int($0.height))" } ?? "n/a"
        let scFrame = window.map { "\(Int($0.frame.origin.x)),\(Int($0.frame.origin.y)),\(Int($0.frame.width))x\(Int($0.frame.height))" } ?? "n/a"
        let isOnScreen = window.map { String($0.isOnScreen) } ?? "n/a"
        let configDims = config.map { "\($0.width)x\($0.height)" } ?? "n/a"
        let scale = pointPixelScale.map { String($0) } ?? "n/a"
        FileLog.body.warn("capture-diag fail domain=\(nsError.domain) code=\(nsError.code) bundleId=\(bundleId) windowID=\(windowID) cgBounds=\(cgBounds) scFrame=\(scFrame) fromCache=\(fromCache) isOnScreen=\(isOnScreen) config=\(configDims) pointPixelScale=\(scale)")
    }

    /// Raw CGWindowList bounds for a specific window, independent of owning pid — used only for diagnostics.
    private static func cgWindowListBounds(id: CGWindowID) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let dict = list.first?[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dict) else { return nil }
        return bounds
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
