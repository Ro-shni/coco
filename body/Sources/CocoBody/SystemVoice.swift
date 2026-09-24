import CocoCore
import Darwin
import Foundation

/// Speaks through the macOS System Voice (Settings ▸ Accessibility ▸ Spoken Content) — whatever voice
/// the user picked there, including a Siri voice. The only reliable way to reach it is `/usr/bin/say`
/// with no `-v` flag: `NSSpeechSynthesizer(voice: nil)` almost always *initializes*, but its legacy
/// engine can't render Siri/neural system voices and silently falls back to a classic one, so it isn't
/// used here at all.
final class SystemVoiceSpeaker: NSObject {
    /// True while `say` is running.
    var onSpeakingChanged: ((Bool) -> Void)?

    /// How long after SIGTERM we wait before escalating to SIGKILL, so `stop()` can never hang and never
    /// leaves a zombie `say` process behind.
    private static let killEscalationDelay: TimeInterval = 0.2

    private var sayProcess: Process?

    func speak(_ text: String, rateWPM: Int = SayCommand.defaultRateWPM) {
        stop()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: SayCommand.executablePath)
        process.arguments = SayCommand.args(rateWPM: rateWPM)
        let stdin = Pipe()
        process.standardInput = stdin
        // Foundation reaps the process and calls this once it exits, whether that's naturally, via
        // SIGTERM from stop(), or via the SIGKILL escalation below — no waitUntilExit/zombie risk.
        process.terminationHandler = { [weak self] _ in
            self?.sayProcess = nil
            self?.report(false)
        }
        do {
            try process.run()
            sayProcess = process
            report(true)
            stdin.fileHandleForWriting.write(text.data(using: .utf8) ?? Data())
            try? stdin.fileHandleForWriting.close()
        } catch {
            sayProcess = nil
            report(false)
        }
    }

    /// Stops speech immediately — for barge-in. Sends SIGTERM right away; if `say` hasn't exited within
    /// `killEscalationDelay`, escalates to SIGKILL. Never blocks the caller.
    func stop() {
        guard let process = sayProcess else { return }
        sayProcess = nil
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.killEscalationDelay) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    private func report(_ speaking: Bool) {
        DispatchQueue.main.async { [weak self] in self?.onSpeakingChanged?(speaking) }
    }
}
