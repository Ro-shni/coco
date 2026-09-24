import AppKit
import ApplicationServices
import IOKit.hid

enum Permission: CaseIterable {
    case screenRecording, accessibility, inputMonitoring

    var title: String {
        switch self {
        case .screenRecording: return "Screen Recording"
        case .accessibility: return "Accessibility"
        case .inputMonitoring: return "Input Monitoring"
        }
    }

    var why: String {
        switch self {
        case .screenRecording: return "Read text on the window you're looking at (stays on this Mac)."
        case .accessibility: return "Know the focused app, window title, selection and URL."
        case .inputMonitoring: return "Count keystrokes (never which keys) so Coco stays quiet while you type."
        }
    }

    var isGranted: Bool {
        switch self {
        case .screenRecording: return CGPreflightScreenCaptureAccess()
        case .accessibility: return AXIsProcessTrusted()
        case .inputMonitoring: return IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
        }
    }

    func request() {
        switch self {
        case .screenRecording: _ = CGRequestScreenCaptureAccess()
        case .accessibility: _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case .inputMonitoring: _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
        }
        NSWorkspace.shared.open(settingsURL)
    }

    private var settingsURL: URL {
        let anchor: String
        switch self {
        case .screenRecording: anchor = "Privacy_ScreenCapture"
        case .accessibility: anchor = "Privacy_Accessibility"
        case .inputMonitoring: anchor = "Privacy_ListenEvent"
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }

    static var allGranted: Bool { allCases.allSatisfy(\.isGranted) }
}
