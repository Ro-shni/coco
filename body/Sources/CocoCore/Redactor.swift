import Foundation

public enum Redactor {
    private static let patterns: [NSRegularExpression] = [
        "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        "sk-[A-Za-z0-9_-]{16,}",
        "xox[a-z]-[A-Za-z0-9-]{10,}",
        "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
        "AKIA[0-9A-Z]{16}",
        "gh[pousr]_[A-Za-z0-9]{36,}",
    ].map { try! NSRegularExpression(pattern: $0) }

    public static func redact(_ text: String) -> String {
        patterns.reduce(text) { current, regex in
            regex.stringByReplacingMatches(in: current, range: NSRange(current.startIndex..., in: current), withTemplate: "[REDACTED]")
        }
    }
}
