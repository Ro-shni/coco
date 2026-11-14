import AppKit
import CocoCore
import SwiftUI

final class CharacterModel: ObservableObject {
    @Published var mood: Mood = .curious
    /// Cursor tracking offset for the eyes, in design units (max ±3).
    @Published var eyeOffset: CGSize = .zero
    @Published var dimmed = false
    @Published var speaking = false {
        didSet { if speaking && !oldValue { speakingSince = time } }
    }
    @Published private(set) var blinking = false
    /// Frame clock (seconds), advanced by the overlay's 30 Hz timer; drives every animation.
    @Published private(set) var time: TimeInterval = 0
    private(set) var speakingSince: TimeInterval = -.infinity

    private var blinkSchedule = BlinkSchedule(seed: UInt64.random(in: .min ... .max))
    private var nextBlinkAt: TimeInterval?
    private var scheduledMood: Mood?

    var look: CharacterLook { CharacterLook.look(mood: mood, speaking: speaking, blinking: blinking) }

    /// Advances the clock and the blink driver; called once per frame.
    func tick(now: TimeInterval) {
        time = now
        if scheduledMood != mood || nextBlinkAt == nil {
            scheduledMood = mood
            nextBlinkAt = now + blinkSchedule.nextInterval(mood: mood)
        }
        guard let blinkAt = nextBlinkAt else { return }
        let shouldBlink = now >= blinkAt && now < blinkAt + BlinkSchedule.blinkDuration
        if blinking != shouldBlink { blinking = shouldBlink }
        if now >= blinkAt + BlinkSchedule.blinkDuration {
            nextBlinkAt = now + blinkSchedule.nextInterval(mood: mood)
        }
    }
}

struct CharacterView: View {
    @ObservedObject var model: CharacterModel
    var onDragBegan: () -> Void
    var onDragChanged: () -> Void
    var onDragEnded: () -> Void
    @State private var isDragging = false

    /// On-screen size of the 200×200 design box, and the margin kept around it for glows and zzz.
    static let characterPoints: CGFloat = 64
    static let margin: CGFloat = 8

    var body: some View {
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let art = CocoArt(mood: model.mood, speaking: model.speaking, look: model.look, eyeOffset: model.eyeOffset,
                          time: model.time, reduceMotion: reduceMotion)
        Canvas { context, size in art.draw(in: context, size: size, inset: Self.margin) }
            .frame(width: Self.characterPoints + 2 * Self.margin, height: Self.characterPoints + 2 * Self.margin)
            .contentShape(Circle().inset(by: Self.margin))
            .opacity(model.dimmed ? 0.45 : 1)
            .scaleEffect(reduceMotion ? 1 : popScale)
            .offset(y: reduceMotion ? 0 : bobOffset)
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .onChanged { _ in
                        if !isDragging {
                            isDragging = true
                            onDragBegan()
                        }
                        onDragChanged()
                    }
                    .onEnded { _ in
                        isDragging = false
                        onDragEnded()
                    }
            )
            .help("Coco: click to chat, drag to move")
    }

    /// Gentle 2.4 s bob, 0 to 3 pt up and back (as in the mock).
    private var bobOffset: CGFloat {
        -1.5 + 1.5 * cos(2 * .pi * model.time / 2.4)
    }

    /// 1.0 → 1.08 → 1.0 over 0.3 s when speaking starts.
    private var popScale: CGFloat {
        let t = model.time - model.speakingSince
        guard t >= 0 && t < 0.3 else { return 1 }
        return 1 + 0.08 * sin(.pi * t / 0.3)
    }
}
