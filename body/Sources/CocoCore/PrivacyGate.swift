import Foundation

public struct PrivacyConfig: Codable, Equatable, Sendable {
    public var denyBundleIds: [String]
    public var denyUrlPatterns: [String]
    public var denyTitlePatterns: [String]

    public init(denyBundleIds: [String], denyUrlPatterns: [String], denyTitlePatterns: [String]) {
        self.denyBundleIds = denyBundleIds; self.denyUrlPatterns = denyUrlPatterns; self.denyTitlePatterns = denyTitlePatterns
    }

    public static let defaults = PrivacyConfig(
        denyBundleIds: [
            "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
            "com.apple.keychainaccess", "com.apple.Passwords", "com.lastpass.LastPass",
        ],
        denyUrlPatterns: [
            "(?i)(netbanking|onlinebanking|hdfcbank\\.com|icicibank\\.com|onlinesbi|axisbank\\.com|kotak\\.com|paypal\\.com)",
            "(?i)accounts\\.google\\.com/(v3/)?signin",
        ],
        denyTitlePatterns: ["(?i)(private browsing|incognito|password)"]
    )
}

public struct PrivacyGate {
    private let bundleIds: Set<String>
    private let urlPatterns: [NSRegularExpression]
    private let titlePatterns: [NSRegularExpression]

    public init(config: PrivacyConfig) throws {
        bundleIds = Set(config.denyBundleIds)
        urlPatterns = try config.denyUrlPatterns.map { try NSRegularExpression(pattern: $0) }
        titlePatterns = try config.denyTitlePatterns.map { try NSRegularExpression(pattern: $0) }
    }

    public func isPrivate(bundleId: String, url: String?, title: String) -> Bool {
        if bundleIds.contains(bundleId) { return true }
        if let url, Self.matches(urlPatterns, url) { return true }
        return Self.matches(titlePatterns, title)
    }

    public static func loadConfig(from url: URL) -> PrivacyConfig {
        guard let data = try? Data(contentsOf: url),
              let config = try? JSONDecoder().decode(PrivacyConfig.self, from: data) else { return .defaults }
        return config
    }

    private static func matches(_ patterns: [NSRegularExpression], _ text: String) -> Bool {
        let range = NSRange(text.startIndex..., in: text)
        return patterns.contains { $0.firstMatch(in: text, range: range) != nil }
    }
}
