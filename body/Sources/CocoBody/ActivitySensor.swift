import CocoCore
import CoreGraphics
import Foundation

final class ActivitySensor {
    var onActivity: ((ActivityState) -> Void)?
    private(set) var typingDetectionAvailable = false
    private var keys = KeystrokeWindow()
    private var tap: CFMachPort?
    private var timer: Timer?

    func start() {
        installKeyTap()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.report() }
        report()
    }

    fileprivate func recordKeystroke() { keys.record(at: Date().timeIntervalSince1970) }
    fileprivate func reenableTap() { if let tap { CGEvent.tapEnable(tap: tap, enable: true) } }

    /// Listen-only tap that counts key-downs (never reads which keys). Needs Input Monitoring.
    private func installKeyTap() {
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let sensor = Unmanaged<ActivitySensor>.fromOpaque(refcon).takeUnretainedValue()
            switch type {
            case .keyDown: sensor.recordKeystroke()
            case .tapDisabledByTimeout, .tapDisabledByUserInput: sensor.reenableTap()
            default: break
            }
            return Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                          eventsOfInterest: mask, callback: callback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            FileLog.body.warn("Input Monitoring not granted; typing detection is off")
            return
        }
        self.tap = tap
        typingDetectionAvailable = true
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func report() {
        let now = Date().timeIntervalSince1970
        let anyInput = CGEventType(rawValue: ~0)!
        let signals = ActivitySignals(
            keystrokesLast10s: keys.count(now: now, window: 10),
            secondsSinceInput: CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput),
            micInUse: SystemSignals.isMicInUse(),
            cameraInUse: SystemSignals.isCameraInUse(),
            screenSharing: SystemSignals.isScreenSharing()
        )
        onActivity?(ActivityClassifier.classify(signals))
    }
}
