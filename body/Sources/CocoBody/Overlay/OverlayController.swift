import AppKit
import CocoCore
import QuartzCore
import SwiftUI

final class OverlayController {
    var onChip: ((String, String) -> Void)?
    var onOpenChat: (() -> Void)?

    private let characterModel = CharacterModel()
    private let bubbleModel = BubbleModel()
    private let characterPanel = OverlayPanel(size: CGSize(width: 60, height: 60))
    private let bubblePanel = OverlayPanel(size: CGSize(width: 300, height: 120))
    private let highlight = HighlightPanel()
    private var presence = PresenceMachine()
    private var timer: Timer?
    private var atHome = false
    private var homeSpec: HomeSpec
    private var dragTracker = DragTracker()
    private var isDragging = false
    private static let characterSize = CGSize(width: 60, height: 60)
    private static let cursorOffset = CGPoint(x: 24, y: -72)
    private static let homeDefaultsKey = "coco.home"

    init() {
        homeSpec = HomePlacement.decode(UserDefaults.standard.data(forKey: Self.homeDefaultsKey))
        characterPanel.contentView = FirstClickHostingView(rootView:
            CharacterView(model: characterModel,
                          onDragBegan: { [weak self] in self?.dragBegan() },
                          onDragChanged: { [weak self] in self?.dragChanged() },
                          onDragEnded: { [weak self] in self?.dragEnded() }))
        bubblePanel.contentView = FirstClickHostingView(rootView:
            BubbleView(model: bubbleModel,
                       onChip: { [weak self] chip in self?.chipTapped(chip) },
                       onClose: { [weak self] in self?.closeTapped() }))
        characterPanel.orderFrontRegardless()
        moveHome(animated: false)
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.frameTick() }
    }

    func show(_ say: SayPayload, anchor: CGRect?) {
        guard presence.onSay(kind: say.kind, now: Date().timeIntervalSince1970) else { return }
        bubbleModel.text = say.text
        bubbleModel.chips = say.chips
        bubbleModel.nudgeId = say.nudgeId
        let mouse = NSEvent.mouseLocation
        guard let visible = screenUnderCursor()?.visibleFrame else { return }
        let target = ScreenGeometry.clampOrigin(CGPoint(x: mouse.x + Self.cursorOffset.x, y: mouse.y + Self.cursorOffset.y),
                                                size: Self.characterSize, in: visible)
        move(characterPanel, to: target, animated: true)
        atHome = false
        layoutBubble(nextTo: target, in: visible)
        bubblePanel.orderFrontRegardless()
        if let anchor { highlight.show(rect: anchor) }
    }

    func showLocal(_ text: String) {
        show(SayPayload(nudgeId: "local-\(UUID().uuidString)", text: text, kind: .status, chips: [], speak: false), anchor: nil)
    }

    func setMood(_ mood: Mood) { characterModel.mood = mood }

    func setActivity(_ activity: ActivityState) {
        presence.onActivity(activity, now: Date().timeIntervalSince1970)
        apply()
    }

    /// Saves the given home and animates Coco there.
    func setHome(_ spec: HomeSpec) {
        homeSpec = spec
        UserDefaults.standard.set(HomePlacement.encode(spec), forKey: Self.homeDefaultsKey)
        moveHome(animated: true)
    }

    func resetHome() { setHome(HomePlacement.defaultSpec) }

    private func chipTapped(_ chip: String) {
        let id = bubbleModel.nudgeId
        presence.onInteraction(now: Date().timeIntervalSince1970)
        if chip.lowercased() == "shh" { presence.dismiss(); apply() }
        if !id.hasPrefix("local-") { onChip?(id, chip) }
    }

    private func closeTapped() {
        let id = bubbleModel.nudgeId
        presence.dismiss()
        apply()
        if !id.hasPrefix("local-") { onChip?(id, "dismiss") }
    }

    private func frameTick() {
        presence.tick(now: Date().timeIntervalSince1970)
        apply()
        let mouse = NSEvent.mouseLocation
        let center = CGPoint(x: characterPanel.frame.midX, y: characterPanel.frame.midY)
        let dx = mouse.x - center.x, dy = mouse.y - center.y
        let length = max(1, (dx * dx + dy * dy).squareRoot())
        characterModel.eyeOffset = CGSize(width: dx / length * 3, height: -dy / length * 3)
    }

    private func apply() {
        switch presence.state {
        case .speaking:
            characterModel.dimmed = false
        case .home, .busy:
            characterModel.dimmed = presence.state == .busy
            if bubblePanel.isVisible { bubblePanel.orderOut(nil) }
            if !atHome && !isDragging { moveHome(animated: true) }
        }
    }

    private func moveHome(animated: Bool) {
        let screen: NSScreen?
        switch homeSpec {
        case .corner:
            screen = screenUnderCursor()
        case .custom(let displayID, _, _):
            screen = NSScreen.screens.first { Self.screenNumber(for: $0) == displayID } ?? screenUnderCursor()
        }
        guard let visible = screen?.visibleFrame else { return }
        move(characterPanel, to: HomePlacement.origin(for: homeSpec, visibleFrame: visible, size: Self.characterSize, margin: 16),
             animated: animated)
        atHome = true
    }

    private func screenUnderCursor() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
    }

    private static func screenNumber(for screen: NSScreen) -> UInt32 {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    private func dragBegan() {
        isDragging = true
        dragTracker.begin(at: NSEvent.mouseLocation)
    }

    private func dragChanged() {
        let delta = dragTracker.move(to: NSEvent.mouseLocation)
        guard dragTracker.isDrag else { return }
        if bubblePanel.isVisible { bubblePanel.orderOut(nil) }
        presence.dismiss()
        var frame = characterPanel.frame
        frame.origin.x += delta.width
        frame.origin.y += delta.height
        characterPanel.setFrame(frame, display: true)
        atHome = false
    }

    private func dragEnded() {
        isDragging = false
        if dragTracker.isDrag {
            saveHomeFromCurrentPosition()
        } else {
            onOpenChat?()
        }
    }

    /// Saves wherever the panel currently sits as the new home, as a fraction of the display its centre is on.
    private func saveHomeFromCurrentPosition() {
        let center = CGPoint(x: characterPanel.frame.midX, y: characterPanel.frame.midY)
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }) ?? screenUnderCursor() else { return }
        let displayID = Self.screenNumber(for: screen)
        let spec = HomePlacement.customSpec(origin: characterPanel.frame.origin, size: characterPanel.frame.size,
                                             visibleFrame: screen.visibleFrame, displayID: displayID)
        homeSpec = spec
        UserDefaults.standard.set(HomePlacement.encode(spec), forKey: Self.homeDefaultsKey)
        atHome = true
    }

    private func move(_ panel: NSPanel, to origin: CGPoint, animated: Bool) {
        let frame = CGRect(origin: origin, size: panel.frame.size)
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.35
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                panel.animator().setFrame(frame, display: true)
            }
        } else {
            panel.setFrame(frame, display: true)
        }
    }

    private func layoutBubble(nextTo character: CGPoint, in visible: CGRect) {
        let size = bubblePanel.contentView?.fittingSize ?? CGSize(width: 300, height: 120)
        let right = CGPoint(x: character.x + Self.characterSize.width, y: character.y + Self.characterSize.height - size.height)
        let fitsRight = right.x + size.width <= visible.maxX
        let proposed = fitsRight ? right : CGPoint(x: character.x - size.width, y: right.y)
        let origin = ScreenGeometry.clampOrigin(proposed, size: size, in: visible)
        bubblePanel.setFrame(CGRect(origin: origin, size: size), display: true)
    }
}
