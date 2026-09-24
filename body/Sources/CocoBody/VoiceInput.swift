import AVFoundation
import CocoCore
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
    private static let finalGrace: TimeInterval = 1

    private var session = VoiceSession()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var maxTimer: Timer?
    private var graceTimer: Timer?

    /// macOS kills an app that asks for mic/speech access without these Info.plist keys (bundle.sh adds
    /// them), so an unbundled dev build must never ask.
    static var usageDescriptionsPresent: Bool {
        ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"].allSatisfy {
            Bundle.main.object(forInfoDictionaryKey: $0) != nil
        }
    }

    /// Starts listening. Returns false (after reporting why via `onProblem`) when it can't, or when already
    /// listening. If the previous session is still waiting for its final transcript, that session is finalized
    /// right away (its `onFinal` fires with whatever was heard) before the new one starts.
    @discardableResult
    func start() -> Bool {
        guard session.phase != .listening else { return false }
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

        guard case .started(let flushed) = session.begin() else {
            engine.stop()
            input.removeTap(onBus: 0)
            return false
        }
        if let flushed {
            // Quick re-press during the grace period: deliver the previous session now rather than drop it.
            tearDownRecognition()
            onFinal?(flushed)
        }
        let current = session.id
        self.engine = engine
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            DispatchQueue.main.async { self?.handle(session: current, text: text, isFinal: isFinal, failed: failed) }
        }
        maxTimer = Timer.scheduledTimer(withTimeInterval: Self.maxSeconds, repeats: false) { [weak self] _ in self?.stop() }
        return true
    }

    /// Stops capturing audio and asks for the final transcript; `onFinal` follows within `finalGrace`.
    func stop() {
        guard session.end() else { return }
        stopAudio()
        request?.endAudio()
        maxTimer?.invalidate(); maxTimer = nil
        let current = session.id
        graceTimer = Timer.scheduledTimer(withTimeInterval: Self.finalGrace, repeats: false) { [weak self] _ in
            self?.finish(session: current)
        }
    }

    private func handle(session current: Int, text: String?, isFinal: Bool, failed: Bool) {
        if let text, session.heard(text, session: current), !isFinal { onPartial?(text) }
        // A final result, or an error (e.g. "no speech detected"), ends the session with whatever was heard.
        if isFinal || failed { finish(session: current) }
    }

    private func finish(session current: Int) {
        guard let text = session.finish(session: current) else { return }
        tearDownRecognition()
        onFinal?(text)
    }

    /// Releases the audio engine, timers and recogniser task of the session that just ended.
    private func tearDownRecognition() {
        stopAudio()
        maxTimer?.invalidate(); maxTimer = nil
        graceTimer?.invalidate(); graceTimer = nil
        task?.cancel(); task = nil
        request = nil
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
            onProblem?("Allow Speech Recognition, then hold Right ⌘ again.")
            return false
        default:
            onProblem?("Speech Recognition is off for Coco. Turn it on in Permissions….")
            return false
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            onProblem?("Allow the microphone, then hold Right ⌘ again.")
            return false
        default:
            onProblem?("Microphone access is off for Coco. Turn it on in Permissions….")
            return false
        }
    }
}
