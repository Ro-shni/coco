import AppKit
import ApplicationServices
import CocoCore

enum WindowFocus {
    /// Finds the best-matching running app or window and brings it to the front. Returns the display name that
    /// was activated, or nil if nothing matched. Must run on main: it drives AppKit/AX APIs synchronously.
    static func focus(target: String, kind: FocusKind) -> String? {
        dispatchPrecondition(condition: .onQueue(.main))
        let apps = candidateApps()
        switch kind {
        case .app:
            return focusApp(target: target, apps: apps) ?? focusWindow(target: target, apps: apps)
        case .window:
            return focusWindow(target: target, apps: apps) ?? focusApp(target: target, apps: apps)
        }
    }

    private static func candidateApps() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.bundleIdentifier != Bundle.main.bundleIdentifier
        }
    }

    private static func focusApp(target: String, apps: [NSRunningApplication]) -> String? {
        let candidates = apps.map { AppCandidate(name: $0.localizedName ?? "", bundleId: $0.bundleIdentifier ?? "", pid: $0.processIdentifier) }
        guard let best = AppMatcher.bestApp(for: target, in: candidates) else { return nil }
        guard let app = apps.first(where: { $0.processIdentifier == best.pid }) else { return nil }
        app.activate()
        return best.name
    }

    private static func focusWindow(target: String, apps: [NSRunningApplication]) -> String? {
        let candidates = windowCandidates(apps)
        guard let best = AppMatcher.bestWindow(for: target, in: candidates) else { return nil }
        guard let app = apps.first(where: { $0.processIdentifier == best.pid }) else { return nil }
        if let windowElement = windowElement(for: best, app: app) {
            AXUIElementPerformAction(windowElement, kAXRaiseAction as CFString)
        }
        app.activate()
        return "\(best.title) (\(best.appName))"
    }

    private static func windowCandidates(_ apps: [NSRunningApplication]) -> [WindowCandidate] {
        var result: [WindowCandidate] = []
        for app in apps {
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(axApp, 0.25)
            guard let windows = attribute(axApp, kAXWindowsAttribute) as? [AXUIElement] else { continue }
            for (index, window) in windows.enumerated() {
                let title = (attribute(window, kAXTitleAttribute) as? String) ?? ""
                result.append(WindowCandidate(appName: app.localizedName ?? "", pid: app.processIdentifier, title: title, index: index))
            }
        }
        return result
    }

    private static func windowElement(for candidate: WindowCandidate, app: NSRunningApplication) -> AXUIElement? {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(axApp, 0.25)
        guard let windows = attribute(axApp, kAXWindowsAttribute) as? [AXUIElement], candidate.index < windows.count else { return nil }
        return windows[candidate.index]
    }

    private static func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }
}
