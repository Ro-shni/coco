import Testing
@testable import CocoCore

@Suite struct ConfigSeederTests {
    @Test func allMissingReturnsAll() {
        let result = ConfigSeeder.filesToSeed(defaults: ["persona.md", "config.yaml", "privacy.json"], existing: [])
        #expect(Set(result) == ["persona.md", "config.yaml", "privacy.json"])
    }
    @Test func somePresentReturnsOnlyMissing() {
        let result = ConfigSeeder.filesToSeed(defaults: ["persona.md", "config.yaml", "privacy.json"], existing: ["persona.md"])
        #expect(Set(result) == ["config.yaml", "privacy.json"])
    }
    @Test func noneMissingReturnsEmpty() {
        let result = ConfigSeeder.filesToSeed(defaults: ["persona.md", "config.yaml"], existing: ["persona.md", "config.yaml"])
        #expect(result.isEmpty)
    }
}
