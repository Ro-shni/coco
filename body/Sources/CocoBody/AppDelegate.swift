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
    private var paused = false
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
        menu.onPermissions = { [weak self] in self?.permissions.show() }
        menu.onTogglePause = { [weak self] in self?.togglePause() }
        menu.onSetHome = { [weak self] spec in self?.overlay.setHome(spec) }
    }

    private func handle(_ msg: BrainToBody) {
        switch msg {
        case .say(let say):
            chat.append(fromUser: false, text: say.text, nudgeId: say.nudgeId, draft: say.draft, draftApp: say.draftApp)
            if say.kind == .reply && chat.isVisible { return }  // the chat window already shows it
            overlay.show(say, anchor: say.pointAt.flatMap { perception.anchorRect(for: $0) })
        case .requestKeyframe:
            perception.captureKeyframe()
        case .mood(let payload):
            overlay.setMood(payload.mood)
        case .focus(let f):
            let matched = WindowFocus.focus(target: f.target, kind: f.kind)
            brain.send(.focusResult(FocusResultPayload(requestId: f.requestId, ok: matched != nil, matched: matched)))
        case .paste(let p):
            Paster.paste(text: p.text, intoApp: p.app) { [weak self] ok, detail in
                self?.brain.send(.pasteResult(PasteResultPayload(requestId: p.requestId, ok: ok, detail: detail)))
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
