import Foundation

/// M13: Coco Studio's launch URL and navigation policy. Pure and Swift-Testing-covered.
///
/// Deviation from the original brief (Task 9's auth redesign postdates it): there is no cookie, and the
/// Studio token never appears in a URL. `launch(port:nonce:)` points at a one-time launch page carrying a
/// single-use nonce (minted by `POST /api/launch-nonce`, authenticated with the Studio token as a Bearer
/// header); that page exchanges the nonce for a session token itself via `POST /studio/session` and stores
/// it in `sessionStorage`, never handing it back to this process. See brain/src/studio/http.ts + sessions.ts.
public enum StudioURL {
    /// The one-time launch page URL. `nonce` is the single-use value returned by `POST /api/launch-nonce`.
    public static func launch(port: Int, nonce: String) -> URL {
        var c = URLComponents()
        c.scheme = "http"; c.host = "127.0.0.1"; c.port = port; c.path = "/studio/launch"
        c.queryItems = [URLQueryItem(name: "n", value: nonce)]
        return c.url!
    }

    public enum Navigation: Equatable { case allow, openExternally(URL), block }

    public static func decide(_ url: URL, port: Int) -> Navigation {
        let scheme = url.scheme?.lowercased()
        if scheme == "http", url.host == "127.0.0.1", url.port == port { return .allow }
        if url.host == "127.0.0.1" || url.host == "localhost" { return .block }
        if let web = WebURL.parse(url.absoluteString) { return .openExternally(web) }
        return .block
    }

    /// Matches the brain's `LAUNCH_NONCE` shape exactly (brain/src/studio/http.ts): 32 bytes of entropy,
    /// hex-encoded lowercase -> exactly 64 characters. Checked directly on UTF-8 bytes rather than with a
    /// `$`-anchored regex: `NSRegularExpression`'s default `$` semantics also match immediately before a
    /// trailing line terminator, so a value of 64 hex chars plus a trailing "\n" would incorrectly pass.
    private static func isValidNonce(_ s: String) -> Bool {
        let bytes = s.utf8
        guard bytes.count == 64 else { return false }
        return bytes.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }  // '0'-'9', 'a'-'f'
    }

    /// Parses the `POST /api/launch-nonce` response body. Accepts only `{"nonce":"<exactly 64 lowercase hex
    /// chars>"}` — wrong shape, wrong length (including a trailing newline or other stray character), uppercase
    /// hex, or unparseable JSON all return nil, so a malformed or unexpected response can never become a value
    /// the caller trusts.
    public static func parseNonce(_ data: Data) -> String? {
        struct Response: Decodable { let nonce: String }
        guard let response = try? JSONDecoder().decode(Response.self, from: data) else { return nil }
        guard isValidNonce(response.nonce) else { return nil }
        return response.nonce
    }
}
