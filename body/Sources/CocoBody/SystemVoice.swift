import AppKit
import Foundation

/// Speaks through the macOS System Voice (Settings ▸ Accessibility ▸ Spoken Content) — whatever voice
/// the user picked there, including a Siri voice, which AVSpeechSynthesizer cannot reach. This file
/// isolates the one API that can: the deprecated-but-still-functional `NSSpeechSynthesizer(voice: nil)`,
/// which speaks with the system default voice, same as `say`. If it fails to initialize at all, speech
/// falls back to spawning `/usr/bin/say` with the text on stdin (no `-v`, so it too uses the system voice).
final class SystemVoiceSpeaker: NSObject {
    /// True while speech (either path) is in progress.
    var onSpeakingChanged: ((Bool) -> Void)?

    private var synth: NSSpeechSynthesizer?
    private var sayProcess: Process?

    override init() {
        super.init()
        let s = NSSpeechSynthesizer(voice: nil)
        if let s {
            s.delegate = self
            s.rate = s.rate * 0.92  // sweeter, calmer delivery; pitch is left alone — Siri voices ignore it
        }
        synth = s
    }

    func speak(_ text: String) {
        stop()
        guard let synth else {
            speakWithSayFallback(text)
            return
        }
        _ = synth.startSpeaking(text)
        report(true)
    }

    /// Stops speech immediately on either path — for barge-in.
    func stop() {
        synth?.stopSpeaking()
        if let sayProcess, sayProcess.isRunning { sayProcess.terminate() }
        sayProcess = nil
    }

    private func speakWithSayFallback(_ text: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        let stdin = Pipe()
        process.standardInput = stdin
        process.terminationHandler = { [weak self] _ in self?.report(false) }
        do {
            try process.run()
            sayProcess = process
            report(true)
            stdin.fileHandleForWriting.write(text.data(using: .utf8) ?? Data())
            try? stdin.fileHandleForWriting.close()
        } catch {
            report(false)
        }
    }

    private func report(_ speaking: Bool) {
        DispatchQueue.main.async { [weak self] in self?.onSpeakingChanged?(speaking) }
    }
}

extension SystemVoiceSpeaker: NSSpeechSynthesizerDelegate {
    func speechSynthesizer(_ sender: NSSpeechSynthesizer, didFinishSpeaking finishedSpeaking: Bool) {
        report(false)
    }
}
