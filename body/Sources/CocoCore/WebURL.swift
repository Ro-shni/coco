import Foundation

/// M5: the one place that decides whether a string is a link Coco may ever open. http/https only — never
/// file:, javascript:, a custom app scheme (x-apple-reminderkit://, slack://…), or anything unparseable.
/// Pure, so it's testable in CocoCore rather than only reachable through CocoBody's AppKit-touching code.
public enum WebURL {
    public static func parse(_ raw: String) -> URL? {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }
}
