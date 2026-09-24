import AppKit
import ApplicationServices
import AVFoundation
import IOKit.hid
import Speech

enum Permission: CaseIterable {
    case screenRecording, accessibility, inputMonitoring, microphone, speechRecognition

    /// Voice permissions are optional: Coco works without them (only ⌥Space talk is off), so they don't
    /// count towards `allGranted` and never pop the permissions window at launch.
    var isRequired: Bool { self != .microphone && self != .speechRecognition }

    var title: String {
        switch self {
        case .screenRecording: return "Screen Recording"
        case .accessibility: return "Accessibility"
        case .inputMonitoring: return "Input Monitoring"
        case .microphone: return "Microphone (optional)"
        case .speechRecognition: return "Speech Recognition (optional)"
        }
    }

    var why: String {
        switch self {
        case .screenRecording: return "Read text on the window you're looking at (stays on this Mac)."
        case .accessibility: return "Know the focused app, window title, selection and URL."
        case .inputMonitoring: return "Count keystrokes (never which keys) so Coco stays quiet while you type."
        case .microphone: return "Hear you only while you hold ⌥Space."
        case .speechRecognition: return "Turn what you say into text, on this Mac only (never sent anywhere)."
        }
    }

    var isGranted: Bool {
        switch self {
        case .screenRecording: return CGPreflightScreenCaptureAccess()
        case .accessibility: return AXIsProcessTrusted()
        case .inputMonitoring: return IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
        case .microphone: return AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        case .speechRecognition: return SFSpeechRecognizer.authorizationStatus() == .authorized
        }
    }

    func request() {
        switch self {
        case .screenRecording: _ = CGRequestScreenCaptureAccess()
        case .accessibility: _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case .inputMonitoring: _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
        case .microphone where !VoiceInput.usageDescriptionsPresent, .speechRecognition where !VoiceInput.usageDescriptionsPresent:
            break  // unbundled dev build: asking would crash; just open System Settings
        case .microphone:
            // First time: the system prompt is enough. After a denial only System Settings can change it.
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                AVCaptureDevice.requestAccess(for: .audio) { _ in }
                return
            }
        case .speechRecognition:
            if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
                SFSpeechRecognizer.requestAuthorization { _ in }
                return
            }
        }
        NSWorkspace.shared.open(settingsURL)
    }

    private var settingsURL: URL {
        let anchor: String
        switch self {
        case .screenRecording: anchor = "Privacy_ScreenCapture"
        case .accessibility: anchor = "Privacy_Accessibility"
        case .inputMonitoring: anchor = "Privacy_ListenEvent"
        case .microphone: anchor = "Privacy_Microphone"
        case .speechRecognition: anchor = "Privacy_SpeechRecognition"
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }

    static var allGranted: Bool { allCases.filter(\.isRequired).allSatisfy(\.isGranted) }
}
