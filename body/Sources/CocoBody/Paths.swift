import Foundation

struct CocoPaths {
    let brainDir: URL
    let configDir: URL
    let nodePath: URL
    let supportDir: URL
    let logsDir: URL

    /// nodePath comes from env (dev override), then CocoPaths.plist written by bundle.sh, then a default.
    /// brainDir and configDir are derived at runtime, not read from the plist: the app must never depend
    /// on files in the source repo. brainDir defaults to the app bundle's own Resources/brain (staged by
    /// bundle.sh); configDir defaults to Application Support so user edits survive rebuilds/reinstalls.
    /// Both accept an env override for development.
    static func load() -> CocoPaths {
        let env = ProcessInfo.processInfo.environment
        let plist = Bundle.main.url(forResource: "CocoPaths", withExtension: "plist")
            .flatMap { NSDictionary(contentsOf: $0) as? [String: String] } ?? [:]
        let home = FileManager.default.homeDirectoryForCurrentUser
        let supportDir = home.appendingPathComponent("Library/Application Support/Coco")
        let brainDir = env["COCO_BRAIN_DIR"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL?.appendingPathComponent("brain")
            ?? URL(fileURLWithPath: "brain")
        let configDir = env["COCO_CONFIG_DIR"].map { URL(fileURLWithPath: $0) }
            ?? supportDir.appendingPathComponent("config")
        return CocoPaths(
            brainDir: brainDir,
            configDir: configDir,
            nodePath: URL(fileURLWithPath: env["COCO_NODE"] ?? plist["nodePath"] ?? "/opt/homebrew/bin/node"),
            supportDir: supportDir,
            logsDir: home.appendingPathComponent("Library/Logs/Coco")
        )
    }
}
