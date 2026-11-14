public struct ContextChangeDetector: Sendable {
    private var lastKey: String?

    public init() {}

    public mutating func shouldSend(_ payload: ContextPayload) -> Bool {
        let key = Self.key(for: payload)
        defer { lastKey = key }
        return key != lastKey
    }

    public mutating func reset() { lastKey = nil }

    static func key(for p: ContextPayload) -> String {
        [p.app, p.bundleId, p.windowTitle, p.url ?? "", normalize(p.selection ?? ""), normalize(p.ocrText ?? ""), p.isPrivate ? "1" : "0"]
            .joined(separator: "\u{1F}")
    }

    static func normalize(_ s: String) -> String {
        s.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
