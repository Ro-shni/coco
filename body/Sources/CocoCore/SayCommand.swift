import Foundation

/// Pure description of how Coco invokes `say` to speak with the macOS System Voice: no `-v` flag, so it
/// always uses whatever voice is selected in Settings ▸ Accessibility ▸ Spoken Content — the only path
/// that can actually render a Siri voice (NSSpeechSynthesizer's legacy engine cannot).
public enum SayCommand {
    public static let executablePath = "/usr/bin/say"
    /// A touch slower than `say`'s own ~175 wpm default, for a sweeter delivery.
    public static let defaultRateWPM = 165

    /// Arguments for invoking `say` at the given rate. Never includes `-v`.
    public static func args(rateWPM: Int = defaultRateWPM) -> [String] {
        ["-r", String(rateWPM)]
    }
}
