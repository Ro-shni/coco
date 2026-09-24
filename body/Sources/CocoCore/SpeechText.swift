import Foundation

/// Turns a brain reply's markdown/chat-shaped text into something pleasant to hear.
public enum SpeechText {
    private static let codeFence = try! NSRegularExpression(pattern: #"(?m)^```[^\n]*$"#)
    private static let url = try! NSRegularExpression(pattern: #"https?://\S+"#)
    private static let header = try! NSRegularExpression(pattern: #"(?m)^#+\s*"#)
    private static let bullet = try! NSRegularExpression(pattern: #"(?m)^[-*]\s+"#)
    private static let whitespace = try! NSRegularExpression(pattern: #"\s+"#)

    /// Strips markdown decoration, code fences, URLs, and emoji; turns arrows into "to"; collapses
    /// whitespace. Numbers are left exactly as written (no "p99" -> "p ninety-nine").
    public static func clean(_ text: String) -> String {
        var s = replaceAll(codeFence, in: text, with: "")
        s = replaceAll(url, in: s, with: "a link")
        s = replaceAll(header, in: s, with: "")
        s = replaceAll(bullet, in: s, with: "")

        s = s.replacingOccurrences(of: "**", with: "")
        s = s.replacingOccurrences(of: "`", with: "")
        s = s.replacingOccurrences(of: "_", with: "")
        s = s.replacingOccurrences(of: "->", with: "to")
        s = s.replacingOccurrences(of: "\u{2192}", with: "to")  // "→"

        s = stripEmoji(s)
        s = replaceAll(whitespace, in: s, with: " ")
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func replaceAll(_ regex: NSRegularExpression, in text: String, with replacement: String) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: replacement)
    }

    /// Drops emoji and their modifiers (variation selectors, ZWJ, skin tones, flag letters) while
    /// leaving ordinary text, digits, and punctuation untouched.
    private static func stripEmoji(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { !isEmojiScalar($0) }))
    }

    private static func isEmojiScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x1F300...0x1FAFF,  // pictographs, emoticons, transport, supplemental symbols
             0x2600...0x27BF,  // misc symbols & dingbats
             0x2300...0x23FF,  // misc technical (⌚⏰ etc.)
             0x2B00...0x2BFF,  // misc symbols and arrows (⭐⬛ etc.)
             0x1F1E6...0x1F1FF,  // regional indicators (flag letters)
             0xFE0F,  // variation selector-16 (emoji presentation)
             0x200D:  // zero-width joiner
            return true
        default:
            return false
        }
    }
}
