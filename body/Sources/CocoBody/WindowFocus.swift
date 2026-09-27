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

    // MARK: - M1: installed-app cache

    /// All access (reads and writes) happens on main: either directly in `installedAppCandidates()`, or
    /// inside a `DispatchQueue.main.async` completion below. The disk scan itself (`scanInstalledApps`) runs
    /// off-main and touches none of this state — only its *result* is handed back to main.
    private static var cachedApps: [InstalledAppCandidate] = []
    private static var cacheBuiltAt: Date = .distantPast
    private static let cacheTTL: TimeInterval = 600
    private static var notificationTokens: [NSObjectProtocol] = []

    /// Call once at startup (AppDelegate). Scans installed apps off-main so the first real focus/launch
    /// doesn't hitch on it, and keeps the cache fresh afterwards via NSWorkspace launch/terminate
    /// notifications (idempotent: a second call adds no duplicate observers).
    static func prewarmInstalledAppCache() {
        dispatchPrecondition(condition: .onQueue(.main))
        refreshCacheInBackground()
        guard notificationTokens.isEmpty else { return }
        let nc = NSWorkspace.shared.notificationCenter
        let refresh: (Notification) -> Void = { _ in refreshCacheInBackground() }
        notificationTokens.append(nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main, using: refresh))
        notificationTokens.append(nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main, using: refresh))
    }

    private static func refreshCacheInBackground() {
        DispatchQueue.global(qos: .utility).async {
            let apps = scanInstalledApps()
            DispatchQueue.main.async {
                cachedApps = apps
                cacheBuiltAt = Date()
            }
        }
    }

    /// Finds the best-matching running app, installed-but-not-running app, or window and brings it to the
    /// front (launching it, for an installed app). Calls `completion` with the display name that was
    /// activated/launched (e.g. "Arc (launched)"), or nil if nothing matched. Must run on main: it drives
    /// AppKit/AX APIs synchronously; `completion` is also delivered on main.
    ///
    /// I4: for kind `.app`, order is running app → installed app (launch) → window title match. A window
    /// title match is last resort on purpose — otherwise a browser tab titled "LeetCode – Dynamic
    /// Programming" would steal "open code" from actually launching VS Code.
    static func focus(target: String, kind: FocusKind, completion: @escaping (String?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        let apps = candidateApps()
        switch kind {
        case .app:
            if let matched = focusApp(target: target, apps: apps) { return completion(matched) }
            if let best = AppMatcher.bestInstalledApp(for: target, in: installedAppCandidates()) {
                return launch(best, completion: completion)
            }
            completion(focusWindow(target: target, apps: apps))
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
    /// M1: served from the cache prewarmed at startup and refreshed on app launch/terminate or once it's
    /// older than 10 minutes — `focus`/`URLOpener` never scan synchronously on main after warm-up. Only a
    /// genuinely cold call (before the prewarm has completed) scans here, synchronously, so a focus/launch
    /// right at startup still works.
    static func installedAppCandidates() -> [InstalledAppCandidate] {
        dispatchPrecondition(condition: .onQueue(.main))
        if cachedApps.isEmpty {
            let apps = scanInstalledApps()
            cachedApps = apps
            cacheBuiltAt = Date()
            return apps
        }
        if Date().timeIntervalSince(cacheBuiltAt) >= cacheTTL { refreshCacheInBackground() }
        return cachedApps
    }

    /// Scans each search root's *.app entries plus one nested folder level. Pure: touches no shared state,
    /// safe to call off the main thread (see `refreshCacheInBackground`).
    private static func scanInstalledApps() -> [InstalledAppCandidate] {
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

    private static func launch(_ app: InstalledAppCandidate, completion: @escaping (String?) -> Void) {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: app.url, configuration: configuration) { _, error in
            DispatchQueue.main.async {
                completion(error == nil ? "\(app.name) (launched)" : nil)
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
