import AppKit
import CocoCore

final class Perception {
    var onContext: ((ContextPayload) -> Void)?
    var onKeyframe: ((KeyframePayload) -> Void)?
    var onPermissionMissing: ((String) -> Void)?
    var paused = false { didSet { detector.reset() } }

    private let gate: PrivacyGate
    private var detector = ContextChangeDetector()
    private var timer: Timer?
    private var capturing = false
    private var lastHash: (window: CGWindowID, hash: UInt64)?
    private var lastOCR = ""
    private var lastBoxes: [TextBox] = []
    private var lastWindowBounds: CGRect = .zero
    private var warnedScreenRecording = false
    private var warnedMissingURLBundleIds: Set<String> = []

    private static let ocrMaxDimension: CGFloat = 1600
    private static let keyframeMaxDimension: CGFloat = 1280
    private static let ocrMaxChars = 4000

    init(gate: PrivacyGate) { self.gate = gate }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.step() }
    }

    /// Call after the brain (re)connects: it has no memory of the last context we sent, so force the next sample through.
    func resendContext() {
        detector.reset()
    }

    /// Main thread only.
    func anchorRect(for text: String) -> CGRect? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let box = AnchorMatcher.bestMatch(for: text, in: lastBoxes),
              let primary = NSScreen.screens.first else { return nil }
        return ScreenGeometry.appKitRect(normalized: box.rect, windowBounds: lastWindowBounds, primaryScreenHeight: primary.frame.height)
    }

    func captureKeyframe() {
        guard !paused, let snap = AXReader.snapshot(), snap.bundleId != Bundle.main.bundleIdentifier, !isPrivate(snap),
              let window = WindowCapture.frontWindow(pid: snap.pid, focusedTitle: snap.windowTitle) else { return }
        Task {
            guard let image = try? await WindowCapture.capture(windowID: window.id, maxDimension: Self.keyframeMaxDimension),
                  let jpeg = WindowCapture.jpegBase64(image) else {
                FileLog.body.warn("keyframe capture failed")
                return
            }
            let payload = KeyframePayload(jpegBase64: jpeg, width: image.width, height: image.height, ts: nowMs())
            await MainActor.run { self.onKeyframe?(payload) }
        }
    }

    private func isPrivate(_ s: AXSnapshot) -> Bool { gate.isPrivate(bundleId: s.bundleId, url: s.url, title: s.windowTitle) }

    private func emit(_ payload: ContextPayload) {
        if detector.shouldSend(payload) { onContext?(payload) }
    }

    private func step() {
        guard !capturing else { return }
        if paused {
            emit(ContextPayload(app: "Coco (paused)", bundleId: "", windowTitle: "", isPrivate: true, ts: nowMs()))
            return
        }
        guard let snap = AXReader.snapshot(), snap.bundleId != Bundle.main.bundleIdentifier else { return }
        warnMissingURLOnce(snap)
        if isPrivate(snap) {
            lastBoxes = []
            emit(ContextPayload(app: snap.app, bundleId: snap.bundleId, windowTitle: "", isPrivate: true, ts: nowMs()))
            return
        }
        let base = ContextPayload(app: snap.app, bundleId: snap.bundleId, windowTitle: Redactor.redact(snap.windowTitle),
                                  url: snap.url.map(Redactor.redact), selection: snap.selection.map(Redactor.redact),
                                  isPrivate: false, ts: nowMs())
        guard CGPreflightScreenCaptureAccess() else {
            warnScreenRecordingOnce()
            emit(base)
            return
        }
        guard let window = WindowCapture.frontWindow(pid: snap.pid, focusedTitle: snap.windowTitle) else { emit(base); return }
        capturing = true
        Task { await self.captureAndRead(window: window, base: base) }
    }

    private func captureAndRead(window: WindowInfo, base: ContextPayload) async {
        defer { Task { @MainActor in self.capturing = false } }
        do {
            let image = try await WindowCapture.capture(windowID: window.id, maxDimension: Self.ocrMaxDimension)
            let hash = AverageHash.hash(gray: WindowCapture.grayThumbnail(image))
            let previous = await MainActor.run { self.lastHash }
            let changed = previous == nil || previous!.window != window.id || AverageHash.distance(previous!.hash, hash) > AverageHash.changeThreshold
            let boxes: [TextBox]? = changed ? try TextRecognizer.recognize(image) : nil
            await MainActor.run {
                self.lastHash = (window.id, hash)
                self.lastWindowBounds = window.bounds
                if let boxes {
                    self.lastBoxes = boxes
                    // Redact before truncating: a secret straddling the 4000-char cutoff must still be caught.
                    let joined = boxes.map(\.text).joined(separator: "\n")
                    self.lastOCR = String(Redactor.redact(joined).prefix(Self.ocrMaxChars))
                    // capture-diag: fires exactly when `changed` was true (new windowID or hash moved),
                    // i.e. at most once per windowID+hash change. Counts only — never OCR text/titles/URLs.
                    let charCount = boxes.reduce(0) { $0 + $1.text.count }
                    FileLog.body.info("capture-diag ok bundleId=\(base.bundleId) windowID=\(window.id) image=\(image.width)x\(image.height) boxes=\(boxes.count) chars=\(charCount)")
                }
                var payload = base
                payload.ocrText = self.lastOCR.isEmpty ? nil : self.lastOCR
                self.emit(payload)
            }
        } catch {
            FileLog.body.warn("capture failed: \(error.localizedDescription)")
            await MainActor.run { self.emit(base) }
        }
    }

    /// A browser whose AX URL lookup came back nil relies on the title-based privacy fallback; that's worth knowing about.
    private func warnMissingURLOnce(_ snap: AXSnapshot) {
        guard snap.url == nil, AXReader.browsers.contains(snap.bundleId), !warnedMissingURLBundleIds.contains(snap.bundleId) else { return }
        warnedMissingURLBundleIds.insert(snap.bundleId)
        FileLog.body.info("browser URL lookup returned nil for \(snap.bundleId)")
    }

    private func warnScreenRecordingOnce() {
        guard !warnedScreenRecording else { return }
        warnedScreenRecording = true
        onPermissionMissing?("I can only read window titles right now: Screen Recording is off for Coco. Menu bar ● → Permissions.")
    }
}
