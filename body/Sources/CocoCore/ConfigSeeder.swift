/// Decides which default config files need to be copied into the user's config directory
/// on first launch (or after an update adds a new default file). Never overwrites a file
/// the user already has — user edits always win.
public enum ConfigSeeder {
    /// `defaults` are the file names shipped in Resources/config-defaults;
    /// `existing` are the file names already present in the user's config directory.
    /// Returns the default file names that are missing and should be seeded.
    public static func filesToSeed(defaults: [String], existing: Set<String>) -> [String] {
        defaults.filter { !existing.contains($0) }
    }
}
