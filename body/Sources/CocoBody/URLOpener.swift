import AppKit
import CocoCore

/// Opens a website in the default browser, or a specific one when asked. Never touches anything that
/// isn't an http/https link.
enum URLOpener {
    /// Call on main; completion (ok, opened, error) is delivered on main.
    static func open(url rawURL: String, browser: String?, completion: @escaping (Bool, String?, String?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        // M5: the scheme check itself lives in CocoCore (WebURL), pure and Swift-Testing-covered.
        guard let url = WebURL.parse(rawURL) else {
            completion(false, nil, "not a web address")
            return
        }
        if let browser, !browser.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            openWithBrowser(url, browser: browser, completion: completion)
        } else {
            let name = defaultBrowserName(for: url)
            let opened = NSWorkspace.shared.open(url)
            completion(opened, opened ? name : nil, opened ? nil : "couldn't open the default browser")
        }
    }

    private static func openWithBrowser(_ url: URL, browser: String, completion: @escaping (Bool, String?, String?) -> Void) {
        guard let best = AppMatcher.bestInstalledApp(for: browser, in: WindowFocus.installedAppCandidates()) else {
            completion(false, nil, "\(browser) isn't installed")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: best.url, configuration: configuration) { _, error in
            DispatchQueue.main.async {
                completion(error == nil, error == nil ? best.name : nil, error?.localizedDescription)
            }
        }
    }

    private static func defaultBrowserName(for url: URL) -> String? {
        guard let appURL = NSWorkspace.shared.urlForApplication(toOpen: url) else { return nil }
        return Bundle(url: appURL)?.infoDictionary?["CFBundleDisplayName"] as? String
            ?? Bundle(url: appURL)?.infoDictionary?["CFBundleName"] as? String
            ?? appURL.deletingPathExtension().lastPathComponent
    }
}
