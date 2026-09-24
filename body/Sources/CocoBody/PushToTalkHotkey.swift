import Carbon.HIToolbox

/// Hold ⌥Space to talk, registered as a Carbon system hotkey: the system consumes the keystroke (it never
/// reaches the focused app) and no extra permission is needed. Active from the press until the hotkey is
/// released; auto-repeat presses while held are ignored.
final class PushToTalkHotkey {
    var onDown: (() -> Void)?
    var onUp: (() -> Void)?

    private(set) var isActive = false
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private static let signature: OSType = 0x436F_636F  // 'Coco'
    private static let hotKeyID: UInt32 = 1

    func install() {
        guard hotKeyRef == nil else { return }
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let callback: EventHandlerUPP = { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            let hotkey = Unmanaged<PushToTalkHotkey>.fromOpaque(userData).takeUnretainedValue()
            return hotkey.handle(event)
        }
        // passUnretained is safe: the handler is removed in stop()/deinit before this object goes away.
        let status = InstallEventHandler(GetApplicationEventTarget(), callback, specs.count, &specs,
                                         Unmanaged.passUnretained(self).toOpaque(), &handlerRef)
        guard status == noErr else {
            FileLog.body.warn("push-to-talk: InstallEventHandler failed (\(status))")
            return
        }
        let id = EventHotKeyID(signature: Self.signature, id: Self.hotKeyID)
        let registered = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
        if registered != noErr {
            FileLog.body.warn("push-to-talk: ⌥Space is taken by another app (\(registered)); voice hotkey is off")
            stop()
        }
    }

    /// Unregisters the hotkey and its handler. Safe to call more than once.
    func stop() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
        hotKeyRef = nil
        handlerRef = nil
        isActive = false
    }

    deinit { stop() }

    private func handle(_ event: EventRef) -> OSStatus {
        var id = EventHotKeyID()
        let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                       nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
        guard status == noErr, id.signature == Self.signature, id.id == Self.hotKeyID else {
            return OSStatus(eventNotHandledErr)
        }
        switch Int(GetEventKind(event)) {
        case kEventHotKeyPressed:
            guard !isActive else { break }  // auto-repeat while held
            isActive = true
            onDown?()
        case kEventHotKeyReleased:
            guard isActive else { break }
            isActive = false
            onUp?()
        default:
            return OSStatus(eventNotHandledErr)
        }
        return noErr
    }
}
