import AppKit
import ApplicationServices

struct AXSnapshot {
    let app: String
    let bundleId: String
    let pid: pid_t
    let windowTitle: String
    let selection: String?
    let url: String?
}

enum AXReader {
    private static let browsers: Set<String> = [
        "com.apple.Safari", "com.google.Chrome", "company.thebrowser.Browser", "com.brave.Browser",
        "com.microsoft.edgemac", "org.mozilla.firefox",
    ]
    private static let maxNodesVisited = 300

    static func snapshot() -> AXSnapshot? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let bundleId = app.bundleIdentifier ?? ""
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        let window = element(axApp, kAXFocusedWindowAttribute)
        let title = window.flatMap { string($0, kAXTitleAttribute) } ?? ""
        let focused = element(axApp, kAXFocusedUIElementAttribute)
        let selection = focused.flatMap { string($0, kAXSelectedTextAttribute) }.flatMap { $0.isEmpty ? nil : String($0.prefix(2000)) }
        let url = browsers.contains(bundleId) ? window.flatMap(findURL) : nil
        return AXSnapshot(app: app.localizedName ?? "Unknown", bundleId: bundleId, pid: app.processIdentifier,
                          windowTitle: title, selection: selection, url: url)
    }

    private static func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    private static func element(_ el: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(el, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func string(_ el: AXUIElement, _ name: String) -> String? { attribute(el, name) as? String }

    /// Breadth-first search for the browser's web area, which exposes the page URL.
    private static func findURL(in window: AXUIElement) -> String? {
        var queue = [window]
        var visited = 0
        while !queue.isEmpty && visited < maxNodesVisited {
            let el = queue.removeFirst()
            visited += 1
            if string(el, kAXRoleAttribute) == "AXWebArea", let value = attribute(el, "AXURL") {
                if let url = value as? URL { return url.absoluteString }
                if let text = value as? String { return text }
            }
            if let children = attribute(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: children) }
        }
        return nil
    }
}
