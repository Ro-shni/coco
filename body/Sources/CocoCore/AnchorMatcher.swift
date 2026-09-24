import CoreGraphics
import Foundation

public struct TextBox: Equatable, Sendable {
    public var text: String
    /// Vision-normalized rect (0...1, origin bottom-left) within the captured window.
    public var rect: CGRect
    public init(text: String, rect: CGRect) { self.text = text; self.rect = rect }
}

public enum AnchorMatcher {
    private static let minimumScore = 0.5

    public static func bestMatch(for query: String, in boxes: [TextBox]) -> TextBox? {
        let wanted = tokens(query)
        guard !wanted.isEmpty else { return nil }
        var best: (box: TextBox, score: Double)?
        for box in boxes {
            let have = Set(tokens(box.text))
            let score = Double(wanted.filter(have.contains).count) / Double(wanted.count)
            guard score >= minimumScore else { continue }
            if let current = best, score < current.score || (score == current.score && box.text.count >= current.box.text.count) { continue }
            best = (box, score)
        }
        return best?.box
    }

    static func tokens(_ s: String) -> [String] {
        s.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ":.-")).inverted)
            .filter { !$0.isEmpty }
    }
}
