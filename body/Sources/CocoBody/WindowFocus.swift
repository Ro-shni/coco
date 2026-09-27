import AppKit
import ApplicationServices
import CocoCore

enum WindowFocus {
    /// Where to search for installed-but-not-running apps: one level of *.app inside each of these, plus one
    /// nested folder level (e.g. /Applications/Adobe/Something.app).
    private static var searchRoots: [URL] {
        [
            URL(fileURLWithPath: "/Applications"),
            URL(fileURLWithPath: "/Applications/Utilities"),
            URL(fileURLWithPath: "/System/Applications"),
            URL(fileURLWithPath: "/System/Applications/Utilities"),
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications"),
        ]
    }

    /// Finds the best-matching running app or window and brings it to the front; for kind `.app` with no
    /// running/window match, falls back to launching an installed app. Calls `completion` with the display
    /// name that was activated/launched (e.g. "Arc (launched)"), or nil if nothing matched. Must run on
    /// main: it drives AppKit/AX APIs synchronously; `completion` is also delivered on main.
    static func focus(target: String, kind: FocusKind, completion: @escaping (String?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        let apps = candidateApps()
        switch kind {
        case .app:
            if let matched = focusApp(target: target, apps: apps) { return completion(matched) }
            if let matched = focusWindow(target: target, apps: apps) { return completion(matched) }
            launchInstalledApp(target: target, completion: completion)
        case .window:
            if let matched = focusWindow(target: target, apps: apps) { return completion(matched) }
            completion(focusApp(target: target, apps: apps))
        }
    }

    /// Running regular (Dock-visible) apps other than Coco itself. Shared with Paster for resolving which
    /// app to paste into.
    static func candidateApps() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.bundleIdentifier != Bundle.main.bundleIdentifier
        }
    }

    /// Apps found on disk (not necessarily running), for launching and for browser resolution (URLOpener).
    /// Scans each search root's *.app entries plus one nested folder level.
    static func installedAppCandidates() -> [InstalledAppCandidate] {
        let fm = FileManager.default
        var seenPaths = Set<String>()
        var result: [InstalledAppCandidate] = []
        func add(_ appURL: URL) {
            guard appURL.pathExtension == "app", seenPaths.insert(appURL.path).inserted else { return }
            if let candidate = installedAppCandidate(at: appURL) { result.append(candidate) }
        }
        for root in searchRoots {
            guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) else { continue }
            for entry in entries {
                if entry.pathExtension == "app" {
                    add(entry)
                } else if (try? entry.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true {
                    let nested = (try? fm.contentsOfDirectory(at: entry, includingPropertiesForKeys: nil)) ?? []
                    for nestedEntry in nested { add(nestedEntry) }
                }
            }
        }
        return result
    }

    private static func installedAppCandidate(at appURL: URL) -> InstalledAppCandidate? {
        guard let bundle = Bundle(url: appURL) else { return nil }
        let name = (bundle.infoDictionary?["CFBundleDisplayName"] as? String)
            ?? (bundle.infoDictionary?["CFBundleName"] as? String)
            ?? appURL.deletingPathExtension().lastPathComponent
        return InstalledAppCandidate(name: name, bundleId: bundle.bundleIdentifier ?? "", url: appURL)
    }

    private static func launchInstalledApp(target: String, completion: @escaping (String?) -> Void) {
        guard let best = AppMatcher.bestInstalledApp(for: target, in: installedAppCandidates()) else {
            completion(nil)
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: best.url, configuration: configuration) { _, error in
            DispatchQueue.main.async {
                completion(error == nil ? "\(best.name) (launched)" : nil)
            }
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
