import AppKit
import CocoCore
import WebKit

/// Hosts Coco Studio (served by the brain on 127.0.0.1) in a native window. Only our own origin loads inside;
/// web links (OAuth sign-in, docs) open in the default browser; anything else is blocked.
///
/// Deviation from the brief (Task 9's auth redesign postdates it): there is no cookie, and the Studio token
/// must never appear in a URL. `show(port:token:)` takes the Studio token (`BrainClient.studioToken`) and uses
/// it only as a Bearer header on `POST /api/launch-nonce`, which mints a single-use nonce; the WebView then
/// loads `/studio/launch?n=<nonce>`, and that page exchanges the nonce for a session token itself — this
/// process never sees or stores the session token.
final class StudioWindowController: NSObject, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var port = 0
    private let session = URLSession(configuration: .default)
    private static let nonceRequestTimeout: TimeInterval = 5

    /// Call on the main thread. Mints a fresh launch nonce and (re)loads the launch URL — on reopen this
    /// always fetches a new nonce, since each one is single-use and short-lived.
    func show(port: Int, token: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        self.port = port
        fetchLaunchNonce(port: port, token: token) { [weak self] nonce in
            guard let self else { return }
            guard let nonce else {
                FileLog.body.warn("studio: couldn't mint a launch nonce")
                self.showUnavailableAlert()
                return
            }
            self.loadAndShow(port: port, nonce: nonce)
        }
    }

    private func loadAndShow(port: Int, nonce: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        if window == nil {
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()   // the session token never outlives the window's lifetime
            let web = WKWebView(frame: .zero, configuration: config)
            web.navigationDelegate = self
            web.uiDelegate = self
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "Coco Studio"
            w.contentView = web
            w.isReleasedWhenClosed = false
            w.center()
            w.collectionBehavior.insert(.moveToActiveSpace)
            window = w
            webView = web
        }
        webView?.load(URLRequest(url: StudioURL.launch(port: port, nonce: nonce)))
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }

    /// POSTs to `/api/launch-nonce` with the Studio token as a Bearer header (never in the URL, never a cookie).
    /// Delivers nil on any failure — network error, timeout, non-200 status, or a body that doesn't parse as a
    /// valid nonce — so the caller has one "not ready" path rather than several partial-failure shapes.
    private func fetchLaunchNonce(port: Int, token: String, completion: @escaping (String?) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/launch-nonce")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = Self.nonceRequestTimeout
        session.dataTask(with: request) { data, response, error in
            var nonce: String?
            if error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200, let data {
                nonce = StudioURL.parseNonce(data)
            }
            DispatchQueue.main.async { completion(nonce) }
        }.resume()
    }

    private func showUnavailableAlert() {
        dispatchPrecondition(condition: .onQueue(.main))
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Couldn't open Coco Studio — the brain isn't ready yet."
        alert.runModal()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        switch StudioURL.decide(url, port: port) {
        case .allow: decisionHandler(.allow)
        case .openExternally(let web): NSWorkspace.shared.open(web); decisionHandler(.cancel)
        case .block: decisionHandler(.cancel)
        }
    }

    /// target="_blank" links arrive here; never open a second web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, case .openExternally(let web) = StudioURL.decide(url, port: port) {
            NSWorkspace.shared.open(web)
        }
        return nil
    }
}
