import Testing
@testable import CocoCore

@Suite struct SayCommandTests {
    @Test func defaultRateArgs() {
        #expect(SayCommand.args() == ["-r", "165"])
    }
    @Test func customRateArgs() {
        #expect(SayCommand.args(rateWPM: 140) == ["-r", "140"])
    }
    @Test func neverIncludesVoiceFlag() {
        #expect(!SayCommand.args().contains("-v"))
        #expect(!SayCommand.args(rateWPM: 200).contains("-v"))
    }
    @Test func executablePathIsSystemSay() {
        #expect(SayCommand.executablePath == "/usr/bin/say")
    }
}
