import Foundation

public struct AppCandidate: Equatable, Sendable {
    public var name: String
    public var bundleId: String
    public var pid: Int32
    public init(name: String, bundleId: String, pid: Int32) {
        self.name = name; self.bundleId = bundleId; self.pid = pid
    }
}

/// An app found on disk (not necessarily running), e.g. from scanning /Applications. Pure data: no pid,
/// since launching doesn't need one — just the bundle's URL.
public struct InstalledAppCandidate: Equatable, Sendable {
    public var name: String
    public var bundleId: String
    public var url: URL
    public init(name: String, bundleId: String, url: URL) {
        self.name = name; self.bundleId = bundleId; self.url = url
    }
}

public struct WindowCandidate: Equatable, Sendable {
    public var appName: String
    public var pid: Int32
    public var title: String
    /// Position in that app's AX windows list, so WindowFocus can re-locate the AXUIElement to raise.
    public var index: Int
    public init(appName: String, pid: Int32, title: String, index: Int) {
        self.appName = appName; self.pid = pid; self.title = title; self.index = index
    }
}

public enum AppMatcher {
    private static let appThreshold = 0.7
    private static let windowThreshold = 0.5

    /// Query (normalised) -> canonical normalised app names it may refer to.
    private static let aliases: [String: [String]] = [
        "vscode": ["code", "visualstudiocode"],
        "code": ["code", "visualstudiocode"],
        "chrome": ["googlechrome"],
        "iterm": ["iterm2"],
        "teams": ["microsoftteams"],
        "outlook": ["microsoftoutlook"],
        "mail": ["mail"],
        "slack": ["slack"],
    ]

    public static func bestApp(for query: String, in apps: [AppCandidate]) -> AppCandidate? {
        bestByNameAndBundle(query: query, candidates: apps, name: \.name, bundleId: \.bundleId)
    }

    /// Same matching logic as `bestApp`, over apps found on disk rather than running processes.
    public static func bestInstalledApp(for query: String, in apps: [InstalledAppCandidate]) -> InstalledAppCandidate? {
        bestByNameAndBundle(query: query, candidates: apps, name: \.name, bundleId: \.bundleId)
    }

    private static func bestByNameAndBundle<Candidate>(
        query: String,
        candidates: [Candidate],
        name: (Candidate) -> String,
        bundleId: (Candidate) -> String
    ) -> Candidate? {
        let normalisedQuery = normalise(query)
        guard !normalisedQuery.isEmpty else { return nil }
        let canonicalForms = aliases[normalisedQuery]
        var best: (candidate: Candidate, score: Double)?
        for candidate in candidates {
            let score = nameBundleScore(name: name(candidate), bundleId: bundleId(candidate), normalisedQuery: normalisedQuery, canonicalForms: canonicalForms)
            guard score >= appThreshold else { continue }
            if let current = best {
                if score < current.score { continue }
                if score == current.score && name(candidate).count >= name(current.candidate).count { continue }
            }
            best = (candidate, score)
        }
        return best?.candidate
    }

    public static func bestWindow(for query: String, in windows: [WindowCandidate]) -> WindowCandidate? {
        let normalisedQuery = normalise(query)
        let queryTokens = Set(tokens(query))
        guard !normalisedQuery.isEmpty || !queryTokens.isEmpty else { return nil }
        var best: (candidate: WindowCandidate, score: Double)?
        for candidate in windows {
            guard !candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let score = windowScore(candidate: candidate, normalisedQuery: normalisedQuery, queryTokens: queryTokens)
            guard score >= windowThreshold else { continue }
            if let current = best {
                if score < current.score { continue }
                if score == current.score && candidate.title.count >= current.candidate.title.count { continue }
            }
            best = (candidate, score)
        }
        return best?.candidate
    }

    private static func nameBundleScore(name: String, bundleId: String, normalisedQuery: String, canonicalForms: [String]?) -> Double {
        let normalisedName = normalise(name)
        guard !normalisedName.isEmpty else { return bundleScore(bundleId: bundleId, normalisedQuery: normalisedQuery) }
        if normalisedName == normalisedQuery { return 1.0 }
        if let canonicalForms, canonicalForms.contains(normalisedName) { return 1.0 }
        if normalisedName.hasPrefix(normalisedQuery) { return 0.9 }
        let shortestLength = min(normalisedName.count, normalisedQuery.count)
        if shortestLength >= 3 && (normalisedName.contains(normalisedQuery) || normalisedQuery.contains(normalisedName)) {
            return 0.8
        }
        return bundleScore(bundleId: bundleId, normalisedQuery: normalisedQuery)
    }

    private static func bundleScore(bundleId: String, normalisedQuery: String) -> Double {
        let normalisedBundle = normalise(bundleId)
        return !normalisedBundle.isEmpty && normalisedBundle.contains(normalisedQuery) ? 0.7 : 0
    }

    private static func windowScore(candidate: WindowCandidate, normalisedQuery: String, queryTokens: Set<String>) -> Double {
        let normalisedTitle = normalise(candidate.title)
        if !normalisedQuery.isEmpty && normalisedTitle.contains(normalisedQuery) { return 1.0 }
        guard !queryTokens.isEmpty else { return 0 }
        let titleTokens = Set(tokens(candidate.title))
        return Double(queryTokens.filter(titleTokens.contains).count) / Double(queryTokens.count)
    }

    /// Lowercase, alphanumerics only — used for exact/prefix/contains comparisons.
    private static func normalise(_ s: String) -> String {
        s.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    /// Lowercase, split on everything except alphanumerics and '-' — used for token overlap.
    private static func tokens(_ s: String) -> [String] {
        s.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-")).inverted)
            .filter { !$0.isEmpty }
    }
}
