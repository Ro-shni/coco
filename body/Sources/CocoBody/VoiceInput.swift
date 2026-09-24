import AVFoundation
import Foundation
import Speech

/// Push-to-talk speech input: Apple on-device recognition only. Audio never leaves the Mac —
/// `requiresOnDeviceRecognition` is always set, and if the device can't recognise en-US on-device,
/// voice input is disabled rather than falling back to Apple's servers.
final class VoiceInput {
    /// Live partial transcript while listening.
    var onPartial: ((String) -> Void)?
    /// Final transcript (possibly empty) once a listening session ends — always called exactly once per
    /// successful `start()`.
    var onFinal: ((String) -> Void)?
    /// A user-facing problem (missing permission, on-device speech unavailable, audio failure).
    var onProblem: ((String) -> Void)?

    static let maxSeconds: TimeInterval = 60
    /// How long to wait for the recogniser's final result after the key is released before using the last partial.
    private static let finalGrace: TimeInterval = 2

    private enum State { case idle, listening, finishing }
    private var state = State.idle
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var latest = ""
    private var session = 0
    private var maxTimer: Timer?
    private var graceTimer: Timer?

    /// macOS kills an app that asks for mic/speech access without these Info.plist keys (bundle.sh adds
    /// them), so an unbundled dev build must never ask.
    static var usageDescriptionsPresent: Bool {
        ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"].allSatisfy {
            Bundle.main.object(forInfoDictionaryKey: $0) != nil
        }
    }

    /// Starts listening. Returns false (after reporting why via `onProblem`) when it can't.
    @discardableResult
    func start() -> Bool {
        guard state == .idle else { return false }
        guard Self.usageDescriptionsPresent else {
            onProblem?("Voice needs the bundled Coco.app (scripts/bundle.sh).")
            return false
        }
        guard permissionsReady() else { return false }
        guard let recognizer, recognizer.supportsOnDeviceRecognition else {
            onProblem?("On-device speech isn't available for this language, so voice input is off.")
            return false
        }
        guard recognizer.isAvailable else {
            onProblem?("Speech recognition isn't available right now.")
            return false
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true  // privacy: never send audio off-device
        request.shouldReportPartialResults = true
        request.addsPunctuation = true

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0 else {
            onProblem?("I can't find a microphone.")
            return false
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            FileLog.body.warn("voice: audio engine failed to start: \(error.localizedDescription)")
            onProblem?("I couldn't start the microphone.")
            return false
        }

        session += 1
        let current = session
        latest = ""
        self.engine = engine
        self.request = request
        state = .listening
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            DispatchQueue.main.async { self?.handle(session: current, text: text, isFinal: isFinal, failed: failed) }
        }
        maxTimer = Timer.scheduledTimer(withTimeInterval: Self.maxSeconds, repeats: false) { [weak self] _ in self?.stop() }
        return true
    }

    /// Stops capturing audio and asks for the final transcript; `onFinal` follows shortly.
    func stop() {
        guard state == .listening else { return }
        state = .finishing
        stopAudio()
        request?.endAudio()
        let current = session
        graceTimer = Timer.scheduledTimer(withTimeInterval: Self.finalGrace, repeats: false) { [weak self] _ in
            guard let self, self.session == current else { return }
            self.finish()
        }
    }

    private func handle(session current: Int, text: String?, isFinal: Bool, failed: Bool) {
        guard current == session, state != .idle else { return }
        if let text { latest = text }
        if state == .listening, let text, !isFinal { onPartial?(text) }
        if isFinal || failed {
            // An error (e.g. "no speech detected") ends the session with whatever was heard.
            if state == .listening { stopAudio() }
            finish()
        }
    }

    private func finish() {
        guard state != .idle else { return }
        state = .idle
        stopAudio()
        maxTimer?.invalidate(); maxTimer = nil
        graceTimer?.invalidate(); graceTimer = nil
        task?.cancel(); task = nil
        request = nil
        session += 1  // ignore any late callbacks from this session
        onFinal?(latest.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func stopAudio() {
        guard let engine else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        self.engine = nil
    }

    /// Checks Speech Recognition + Microphone authorization, prompting on first use.
    private func permissionsReady() -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { _ in }
            onProblem?("Allow Speech Recognition, then hold ⌥Space again.")
            return false
        default:
            onProblem?("Speech Recognition is off for Coco. Turn it on in Permissions….")
            return false
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            onProblem?("Allow the microphone, then hold ⌥Space again.")
            return false
        default:
            onProblem?("Microphone access is off for Coco. Turn it on in Permissions….")
            return false
        }
    }
}
