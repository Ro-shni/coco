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

    /// Matches the brain's `LAUNCH_NONCE` pattern exactly (brain/src/studio/http.ts): 32 bytes of entropy,
    /// hex-encoded lowercase -> 64 characters.
    private static let noncePattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")

    /// Parses the `POST /api/launch-nonce` response body. Accepts only `{"nonce":"<64 lowercase hex chars>"}` —
    /// wrong shape, wrong length, uppercase hex, or unparseable JSON all return nil, so a malformed or
    /// unexpected response can never become a value the caller trusts.
    public static func parseNonce(_ data: Data) -> String? {
        struct Response: Decodable { let nonce: String }
        guard let response = try? JSONDecoder().decode(Response.self, from: data) else { return nil }
        let range = NSRange(response.nonce.startIndex..., in: response.nonce)
        guard noncePattern.firstMatch(in: response.nonce, range: range) != nil else { return nil }
        return response.nonce
    }
}
