import AppKit
import CocoCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let paths = CocoPaths.load()
    private var brain: BrainClient!
    private var perception: Perception!
    private let sensor = ActivitySensor()
    private var overlay: OverlayController!
    private let chat = ChatWindowController()
    private var menu: StatusMenu!
    private let permissions = PermissionsWindowController()
    private let studio = StudioWindowController()
    private var paused = false
    private let voiceInput = VoiceInput()
    private let voiceOutput = VoiceOutput()
    private let pushToTalk = PushToTalkHotkey()
    /// True from the Right ⌘ hold starting until the final transcript arrives.
    private var recording = false
    /// True while a cancelled recording's final transcript is still in flight — `endListening` must drop
    /// it instead of sending, since `cancelListening` already tore down the UI/sensor state itself.
    private var discardingVoice = false
    private var lastActivity: ActivityState = .reading
    private var hotkeyMonitors: [Any] = []
    private static let pauseKeyCode: UInt16 = 35  // "P"
    /// Diagnostics only (counts/ids, never OCR text/title/URL content): last bundleId logged via context_out.
    private var lastContextLogBundleId: String?
    /// Keep in sync with the brain's UtterancePayload.text schema (brain/src/protocol.ts): past this, the brain
    /// rejects the message outright and it is silently dropped.
    private static let chatMaxChars = 4000

    func applicationDidFinishLaunching(_ notification: Notification) {
        FileLog.body.info("launching; brain=\(paths.brainDir.path) config=\(paths.configDir.path)")
        seedConfigIfNeeded()
        let privacy = PrivacyGate.loadConfig(from: paths.configDir.appendingPathComponent("privacy.json"))
        let gate = (try? PrivacyGate(config: privacy)) ?? (try! PrivacyGate(config: .defaults))
        perception = Perception(gate: gate)
        overlay = OverlayController()
        brain = BrainClient(paths: paths)
        menu = StatusMenu()
        wire()
        installPauseHotkey()
        pushToTalk.install()
        WindowFocus.prewarmInstalledAppCache()
        brain.start()
        perception.start()
        sensor.start()
        if !Permission.allGranted { permissions.show() }
    }

    func applicationWillTerminate(_ notification: Notification) { brain.stop() }

    /// Copies any default config file the user doesn't already have into their config dir.
    /// Never overwrites an existing file — user edits always win. `config-defaults` is staged
    /// into the app bundle by bundle.sh; if it's missing (e.g. a dev build without bundling),
    /// this is a no-op and the user keeps whatever is already in configDir.
    private func seedConfigIfNeeded() {
        let fm = FileManager.default
        try? fm.createDirectory(at: paths.configDir, withIntermediateDirectories: true)
        guard let defaultsDir = Bundle.main.resourceURL?.appendingPathComponent("config-defaults"),
              let defaultFiles = try? fm.contentsOfDirectory(atPath: defaultsDir.path) else { return }
        let existing = Set((try? fm.contentsOfDirectory(atPath: paths.configDir.path)) ?? [])
        let toSeed = ConfigSeeder.filesToSeed(defaults: defaultFiles, existing: existing)
        for name in toSeed {
            try? fm.copyItem(at: defaultsDir.appendingPathComponent(name), to: paths.configDir.appendingPathComponent(name))
        }
        FileLog.body.info(toSeed.isEmpty ? "config seed: nothing missing" : "config seed: \(toSeed.joined(separator: ", "))")
    }

    private func wire() {
        brain.onStatus = { [weak self] status in
            guard let self else { return }
            self.chat.model.brainStatus = status.label
            if case .failed(let why) = status {
                self.overlay.setMood(.sleepy)
                self.overlay.showLocal("My brain won't start: \(why)")
            }
            if status == .connected {
                // The (re)started brain has no memory of the last context we sent; re-send the current one.
                self.perception.resendContext()
            }
        }
        brain.onMessage = { [weak self] msg in self?.handle(msg) }
        perception.onContext = { [weak self] payload in
            self?.logContextOut(payload)
            self?.brain.send(.context(payload))
        }
        perception.onKeyframe = { [weak self] frame in self?.brain.send(.keyframe(frame)) }
        perception.onPermissionMissing = { [weak self] text in self?.overlay.showLocal(text) }
        sensor.onActivity = { [weak self] activity in
            self?.lastActivity = activity
            self?.overlay.setActivity(activity)
            self?.brain.send(.activity(ActivityPayload(state: activity, ts: nowMs())))
        }
        overlay.onChip = { [weak self] id, choice in self?.brain.send(.chip(ChipPayload(nudgeId: id, choice: choice))) }
        overlay.onOpenChat = { [weak self] in self?.chat.show() }
        chat.onChip = { [weak self] id, choice in self?.brain.send(.chip(ChipPayload(nudgeId: id, choice: choice))) }
        chat.onSend = { [weak self] text in
            guard let self else { return }
            let wasTruncated = text.count > Self.chatMaxChars
            // The user's own line always shows what they typed, in full, with a note if the brain will see less.
            self.chat.append(fromUser: true, text: wasTruncated ? "\(text) …(truncated)" : text)
            self.brain.send(.utterance(UtterancePayload(text: String(text.prefix(Self.chatMaxChars)), source: .chat)))
        }
        menu.onOpenChat = { [weak self] in self?.chat.show() }
        menu.onOpenStudio = { [weak self] in
            guard let self, let port = self.brain.port else {
                FileLog.body.warn("studio: brain not ready")
                return
            }
            self.studio.show(port: port, token: self.brain.studioToken)
        }
        menu.onPermissions = { [weak self] in self?.permissions.show() }
        menu.onTogglePause = { [weak self] in self?.togglePause() }
        menu.onSetHome = { [weak self] spec in self?.overlay.setHome(spec) }
        menu.onVoiceEnabledChanged = { [weak self] enabled in if !enabled { self?.voiceOutput.stop() } }
        wireVoice()
    }

    private func wireVoice() {
        pushToTalk.onDown = { [weak self] in self?.beginListening() }
        pushToTalk.onUp = { [weak self] in self?.voiceInput.stop() }
        pushToTalk.onCancel = { [weak self] in self?.cancelListening() }
        pushToTalk.onPermissionMissing = { [weak self] text in self?.overlay.showLocal(text) }
        voiceInput.onPartial = { [weak self] text in self?.overlay.setListeningText(text) }
        voiceInput.onFinal = { [weak self] text in self?.endListening(text) }
        voiceInput.onProblem = { [weak self] text in self?.overlay.showLocal(text) }
        voiceOutput.onSpeakingChanged = { [weak self] speaking in self?.overlay.setVoiceSpeaking(speaking) }
    }

    /// Also used for a quick re-press while the previous session is still finishing: `start()` then delivers
    /// that session's transcript (via endListening) before the new one begins.
    private func beginListening() {
        voiceOutput.stop()  // barge-in: the user talking always cuts Coco off
        sensor.selfRecording = true  // set before the mic starts so Coco's own recording never reads as a call
        guard voiceInput.start() else {
            sensor.selfRecording = recording
            return
        }
        sensor.selfRecording = true  // a flushed previous session's endListening cleared it
        recording = true
        overlay.setListening(true)
    }

    private func endListening(_ text: String) {
        guard !discardingVoice else {
            discardingVoice = false  // cancelListening already tore down recording/selfRecording/overlay
            return
        }
        recording = false
        sensor.selfRecording = false
        if !text.isEmpty { overlay.setListeningText(text) }  // the final transcript can differ from the last partial
        overlay.setListening(false, heardSomething: !text.isEmpty)
        guard !text.isEmpty else { return }
        chat.append(fromUser: true, text: "🎙 \(text)")  // like typed lines, marked as spoken
        brain.send(.utterance(UtterancePayload(text: String(text.prefix(Self.chatMaxChars)), source: .voice)))
    }

    /// Right ⌘ was released early by an interruption (another key or modifier): stop capturing and discard
    /// whatever was heard — no utterance is sent, no 🎙 chat line is added. `voiceInput.stop()` still runs
    /// its normal teardown; `endListening` sees `discardingVoice` and drops that transcript when it arrives.
    private func cancelListening() {
        guard recording else { return }
        discardingVoice = true
        recording = false
        sensor.selfRecording = false
        overlay.setListening(false, heardSomething: false)
        voiceInput.stop()
    }

    private func handle(_ msg: BrainToBody) {
        switch msg {
        case .say(let say):
            chat.append(fromUser: false, text: say.text, nudgeId: say.nudgeId, draft: say.draft, draftApp: say.draftApp)
            // The chat window already shows a reply while it's open; otherwise the overlay does.
            if !(say.kind == .reply && chat.isVisible) {
                overlay.show(say, anchor: say.pointAt.flatMap { perception.anchorRect(for: $0) })
            }
            // Only the text is spoken — a draft never is.
            if SpeakPolicy.shouldSpeak(say: say, voiceEnabled: VoiceOutput.isEnabled, activity: lastActivity, recording: recording) {
                voiceOutput.speak(say.text)
            }
        case .requestKeyframe:
            perception.captureKeyframe()
        case .mood(let payload):
            overlay.setMood(payload.mood)
        case .focus(let f):
            WindowFocus.focus(target: f.target, kind: f.kind) { [weak self] matched in
                self?.brain.send(.focusResult(FocusResultPayload(requestId: f.requestId, ok: matched != nil, matched: matched)))
            }
        case .paste(let p):
            Paster.paste(text: p.text, intoApp: p.app) { [weak self] ok, detail in
                self?.brain.send(.pasteResult(PasteResultPayload(requestId: p.requestId, ok: ok, detail: detail)))
            }
        case .openUrl(let o):
            URLOpener.open(url: o.url, browser: o.browser) { [weak self] ok, opened, error in
                self?.brain.send(.openUrlResult(OpenUrlResultPayload(requestId: o.requestId, ok: ok, opened: opened, error: error)))
            }
        }
    }

    /// Diagnostics only (counts/ids, never OCR text/title/URL content): logs once per bundleId change.
    private func logContextOut(_ payload: ContextPayload) {
        guard payload.bundleId != lastContextLogBundleId else { return }
        lastContextLogBundleId = payload.bundleId
        let ocrChars = payload.ocrText?.count ?? 0
        FileLog.body.info("context_out app=\(payload.bundleId) ocrChars=\(ocrChars) private=\(payload.isPrivate)")
    }

    private func togglePause() {
        paused.toggle()
        perception.paused = paused
        menu.setPaused(paused)
        overlay.showLocal(paused ? "Not watching. ⌃⌥P to resume." : "Watching again.")
    }

    /// ⌃⌥P toggles watching. The global monitor needs Accessibility; the local one covers Coco's own windows.
    private func installPauseHotkey() {
        let matches: (NSEvent) -> Bool = { event in
            event.keyCode == Self.pauseKeyCode && event.modifierFlags.intersection(.deviceIndependentFlagsMask) == [.control, .option]
        }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
            if matches(e) { self?.togglePause() }
        }) { hotkeyMonitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
            guard matches(e) else { return e }
            self?.togglePause()
            return nil
        }) { hotkeyMonitors.append(local) }
    }
}
