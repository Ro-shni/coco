import Foundation

struct CocoPaths {
    let brainDir: URL
    let configDir: URL
    let nodePath: URL
    let supportDir: URL
    let logsDir: URL

    /// Paths come from env (dev overrides), then CocoPaths.plist written by bundle.sh, then defaults.
    static func load() -> CocoPaths {
        let env = ProcessInfo.processInfo.environment
        let plist = Bundle.main.url(forResource: "CocoPaths", withExtension: "plist")
            .flatMap { NSDictionary(contentsOf: $0) as? [String: String] } ?? [:]
        func path(_ key: String, _ envKey: String, _ fallback: String) -> URL {
            URL(fileURLWithPath: env[envKey] ?? plist[key] ?? fallback)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        return CocoPaths(
            brainDir: path("brainDir", "COCO_BRAIN_DIR", "brain"),
            configDir: path("configDir", "COCO_CONFIG_DIR", "config"),
            nodePath: path("nodePath", "COCO_NODE", "/opt/homebrew/bin/node"),
            supportDir: home.appendingPathComponent("Library/Application Support/Coco"),
            logsDir: home.appendingPathComponent("Library/Logs/Coco")
        )
    }
}
