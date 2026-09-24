import CocoCore
import SwiftUI

/// Paints Coco exactly as docs/design/coco-look-mock.html does: a 200×200 design space scaled to the canvas.
/// Draw order, coordinates, gradients and colours follow the mock's SVG generator `coco(mood,size)`.
struct CocoArt {
    var mood: Mood
    var speaking: Bool
    var look: CharacterLook
    /// Cursor tracking offset in design units (max ±3).
    var eyeOffset: CGSize
    /// Seconds, drives the star pulse / flicker and the drifting zzz.
    var time: TimeInterval
    var reduceMotion: Bool

    /// `inset` leaves a margin (in points) around the 200×200 box so glows and the drifting zzz are not clipped.
    func draw(in context: GraphicsContext, size: CGSize, inset: CGFloat) {
        var ctx = context
        let scale = max(0, min(size.width, size.height) - 2 * inset) / 200
        ctx.translateBy(x: (size.width - 200 * scale) / 2, y: (size.height - 200 * scale) / 2)
        ctx.scaleBy(x: scale, y: scale)

        drawAntenna(ctx, scale: scale)
        ctx.fill(ellipse(100, 172, 54, 10), with: .color(.black.opacity(0.08)))
        drawHeadphones(ctx)
        drawShell(ctx)
        if mood == .worried { drawBrows(ctx) }
        drawEye(ctx, style: look.leftEye, cx: 82, scale: scale)
        drawEye(ctx, style: look.rightEye, cx: 118, scale: scale)
        for cx in [70.0, 130.0] {
            ctx.fill(ellipse(cx, 127, 7, 3.6), with: .color(Palette.blush.opacity(look.blush)))
        }
        drawMouth(ctx)
        for cx in [78.0, 122.0] {
            let paw = ellipse(cx, 160, 19, 13)
            fillGradient(ctx, paw, Palette.paw, center: UnitPoint(x: 0.4, y: 0.3), radius: 0.8)
            ctx.stroke(paw, with: .color(Palette.shellStroke), lineWidth: 1)
        }
        if look.extras.contains(.sweat) { drawSweat(ctx) }
        if look.extras.contains(.zzz) { drawZzz(ctx) }
    }

    // MARK: Antenna + star

    private func drawAntenna(_ ctx: GraphicsContext, scale: CGFloat) {
        let droop = look.antenna == .droop
        var stem = Path()
        stem.move(to: CGPoint(x: 100, y: 52))
        if droop {
            stem.addCurve(to: CGPoint(x: 78, y: 30), control1: CGPoint(x: 98, y: 38), control2: CGPoint(x: 86, y: 30))
        } else {
            stem.addCurve(to: CGPoint(x: 110, y: 22), control1: CGPoint(x: 100, y: 38), control2: CGPoint(x: 106, y: 28))
        }
        ctx.stroke(stem, with: .color(Palette.stem), style: StrokeStyle(lineWidth: 3.2, lineCap: .round))

        let color: Color, baseOpacity: Double
        switch look.star {
        case .bright: color = Palette.starBright; baseOpacity = 1
        case .dim: color = Palette.starDim; baseOpacity = 0.55
        case .amber: color = Palette.starAmber; baseOpacity = 1
        }
        let animate = !reduceMotion
        // ~2.4 s glow pulse on the bright star; an irregular flicker on the amber (worried) one.
        let pulse = (animate && look.star == .bright) ? sin(2 * .pi * time / 2.4) : 0
        let flicker = (animate && look.star == .amber) ? max(0, sin(time * 13) * sin(time * 7.3)) * 0.45 : 0

        var star = ctx
        star.translateBy(x: droop ? 74 : 111, y: droop ? 30 : 19)
        star.opacity = baseOpacity * (1 - flicker)
        var glow = star
        glow.addFilter(.blur(radius: 4 * scale))
        let glowRadius = 13 * (1 + 0.08 * pulse)
        glow.fill(ellipse(0, 0, glowRadius, glowRadius), with: .color(color.opacity(0.55 * (1 + 0.35 * pulse))))
        let shape = relativePolygon(start: CGPoint(x: 0, y: -11),
                                    [(3.2, 6.6), (7.3, 1), (-5.3, 5.1), (1.3, 7.2), (-6.5, -3.4),
                                     (-6.5, 3.4), (1.3, -7.2), (-5.3, -5.1), (7.3, -1)])
        star.fill(shape, with: .color(color))
        star.stroke(shape, with: .color(Palette.starStroke), style: StrokeStyle(lineWidth: 1, lineJoin: .round))
    }

    // MARK: Head

    private func drawHeadphones(_ ctx: GraphicsContext) {
        ctx.fill(ellipse(38, 114, 15, 25), with: .color(Palette.headphones))
        ctx.fill(ellipse(34, 114, 9, 17), with: .color(Palette.cup))
        var heart = ctx
        heart.translateBy(x: 29, y: 108)
        heart.scaleBy(x: 0.9, y: 0.9)
        var h = Path()
        h.move(to: CGPoint(x: 0, y: 3))
        h.addCurve(to: CGPoint(x: 5, y: 2.5), control1: CGPoint(x: 0, y: -1), control2: CGPoint(x: 5, y: -1))
        h.addCurve(to: CGPoint(x: 10, y: 3), control1: CGPoint(x: 5, y: -1), control2: CGPoint(x: 10, y: -1))
        h.addCurve(to: CGPoint(x: 5, y: 10), control1: CGPoint(x: 10, y: 6.5), control2: CGPoint(x: 5, y: 9))
        h.addCurve(to: CGPoint(x: 0, y: 3), control1: CGPoint(x: 5, y: 9), control2: CGPoint(x: 0, y: 6.5))
        h.closeSubpath()
        heart.fill(h, with: .color(Palette.heart))
        ctx.fill(ellipse(162, 114, 15, 25), with: .color(Palette.headphones))
        ctx.fill(ellipse(166, 114, 9, 17), with: .color(Palette.cup))
    }

    private func drawShell(_ ctx: GraphicsContext) {
        let shell = ellipse(100, 108, 64, 58)
        fillGradient(ctx, shell, Palette.shell, center: UnitPoint(x: 0.38, y: 0.28), radius: 0.8)
        ctx.stroke(shell, with: .color(Palette.shellStroke), lineWidth: 1.2)
        var shine = Path()
        shine.move(to: CGPoint(x: 52, y: 86))
        shine.addQuadCurve(to: CGPoint(x: 148, y: 86), control: CGPoint(x: 100, y: 50))
        ctx.stroke(shine, with: .color(.white.opacity(0.55)), style: StrokeStyle(lineWidth: 7, lineCap: .round))
        fillGradient(ctx, ellipse(100, 117, 47, 37), Palette.visor, center: UnitPoint(x: 0.45, y: 0.3), radius: 0.8)
        ctx.fill(ellipse(86, 97, 18, 6), with: .color(.white.opacity(0.08)))
    }

    private func drawBrows(_ ctx: GraphicsContext) {
        var brows = Path()
        brows.move(to: CGPoint(x: 72, y: 95)); brows.addLine(to: CGPoint(x: 86, y: 91))
        brows.move(to: CGPoint(x: 128, y: 95)); brows.addLine(to: CGPoint(x: 114, y: 91))
        ctx.stroke(brows, with: .color(Palette.eyeLine), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
    }

    // MARK: Eyes

    /// Eye centre height and iris radius per mood, as placed in the mock.
    private var eyeGeometry: (cy: CGFloat, r: CGFloat) {
        if CharacterLook.showsSpeakingFace(mood: mood, speaking: speaking) { return (112, 9) }
        switch mood {
        case .curious: return (112, 9)
        case .focused: return (113, 8)
        case .worried: return (111, 11)
        case .bored: return (114, 8)
        case .sleepy: return (113, 9)
        }
    }

    private func drawEye(_ ctx: GraphicsContext, style: EyeStyle, cx: CGFloat, scale: CGFloat) {
        let (cy, r) = eyeGeometry
        let line = StrokeStyle(lineWidth: 3, lineCap: .round)
        switch style {
        case .closed:
            var p = Path()
            p.move(to: CGPoint(x: cx - 8, y: cy))
            p.addQuadCurve(to: CGPoint(x: cx + 8, y: cy), control: CGPoint(x: cx, y: cy + 7))
            ctx.stroke(p, with: .color(Palette.eyeLine), style: line)
        case .wink:
            var p = Path()
            p.move(to: CGPoint(x: cx - 8, y: cy + 2))
            p.addQuadCurve(to: CGPoint(x: cx + 8, y: cy + 2), control: CGPoint(x: cx, y: cy - 6))
            ctx.stroke(p, with: .color(Palette.eyeLine), style: line)
            var lashes = Path()
            lashes.move(to: CGPoint(x: cx + 7, y: cy - 4)); lashes.addLine(to: CGPoint(x: cx + 11, y: cy - 7))
            lashes.move(to: CGPoint(x: cx + 8, y: cy)); lashes.addLine(to: CGPoint(x: cx + 13, y: cy - 1))
            ctx.stroke(lashes, with: .color(Palette.eyeLine), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
        case .open, .wide:
            var eye = ctx
            eye.translateBy(x: eyeOffset.width, y: eyeOffset.height)
            drawOpenEye(eye, cx: cx, cy: cy, r: r, scale: scale)
        case .halfLid:
            var eye = ctx
            eye.translateBy(x: eyeOffset.width, y: eyeOffset.height)
            drawOpenEye(eye, cx: cx, cy: cy, r: r, scale: scale)
            let lid = Path(CGRect(x: cx - r - 4, y: cy - r - 7, width: 2 * r + 8, height: r + 6))
            fillGradient(eye, lid, Palette.visor, center: UnitPoint(x: 0.45, y: 0.3), radius: 0.8)
            var edge = Path()
            edge.move(to: CGPoint(x: cx - r - 1, y: cy - 1)); edge.addLine(to: CGPoint(x: cx + r + 1, y: cy - 1))
            eye.stroke(edge, with: .color(Palette.eyeLine.opacity(0.8)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
    }

    private func drawOpenEye(_ ctx: GraphicsContext, cx: CGFloat, cy: CGFloat, r: CGFloat, scale: CGFloat) {
        let ring = mood == .worried ? Palette.ringWorried : Palette.ring
        var glow = ctx
        glow.opacity = 0.35
        glow.addFilter(.blur(radius: 3 * scale))
        glow.fill(ellipse(cx, cy, r + 2.5, r + 4), with: .color(ring))
        let iris = ellipse(cx, cy, r, r + 2)
        fillGradient(ctx, iris, Palette.iris, center: UnitPoint(x: 0.5, y: 0.6), radius: 0.7)
        ctx.stroke(iris, with: .color(ring), lineWidth: 2)
        // The curious face glances up-right with its highlights.
        let glance = (mood == .curious && !speaking) ? CGSize(width: 3, height: -1) : .zero
        let sparkle = relativePolygon(start: CGPoint(x: cx - 3 + glance.width, y: cy - 5 + glance.height),
                                      [(1.2, 2.6), (2.8, 0.3), (-2.1, 1.9), (0.6, 2.8), (-2.5, -1.4),
                                       (-2.5, 1.4), (0.6, -2.8), (-2.1, -1.9), (2.8, -0.3)])
        ctx.fill(sparkle, with: .color(.white))
        ctx.fill(ellipse(cx + 4 + glance.width, cy + 4 + glance.height, 1.6, 1.6), with: .color(.white.opacity(0.9)))
    }

    // MARK: Mouth + extras

    private func drawMouth(_ ctx: GraphicsContext) {
        let line = StrokeStyle(lineWidth: 2.2, lineCap: .round)
        var p = Path()
        switch look.mouth {
        case .smile:
            p.move(to: CGPoint(x: 93, y: 131))
            p.addQuadCurve(to: CGPoint(x: 107, y: 131), control: CGPoint(x: 100, y: 140))
            p.closeSubpath()
            ctx.fill(p, with: .color(Palette.mouth))
        case .bigSmile:
            p.move(to: CGPoint(x: 92, y: 130))
            p.addQuadCurve(to: CGPoint(x: 108, y: 130), control: CGPoint(x: 100, y: 141))
            p.closeSubpath()
            ctx.fill(p, with: .color(Palette.mouth))
            var tongue = Path()
            tongue.move(to: CGPoint(x: 96, y: 133))
            tongue.addQuadCurve(to: CGPoint(x: 104, y: 133), control: CGPoint(x: 100, y: 136))
            tongue.closeSubpath()
            ctx.fill(tongue, with: .color(Palette.tongue))
        case .soft:
            p.move(to: CGPoint(x: 95, y: 132))
            p.addQuadCurve(to: CGPoint(x: 105, y: 132), control: CGPoint(x: 100, y: 135))
            ctx.stroke(p, with: .color(Palette.mouthLine), style: line)
        case .wavy:
            p.move(to: CGPoint(x: 93, y: 134))
            p.addQuadCurve(to: CGPoint(x: 100, y: 134), control: CGPoint(x: 96.5, y: 131))
            p.addQuadCurve(to: CGPoint(x: 107, y: 134), control: CGPoint(x: 103.5, y: 137))
            ctx.stroke(p, with: .color(Palette.mouthLine), style: line)
        case .flat:
            p.move(to: CGPoint(x: 95, y: 133))
            p.addLine(to: CGPoint(x: 105, y: 133))
            ctx.stroke(p, with: .color(Palette.mouthLine), style: line)
        case .o:
            ctx.fill(ellipse(100, 133, 3, 2.4), with: .color(Palette.mouth))
        }
    }

    private func drawSweat(_ ctx: GraphicsContext) {
        var drop = Path()
        drop.move(to: CGPoint(x: 150, y: 78))
        drop.addQuadCurve(to: CGPoint(x: 150, y: 89), control: CGPoint(x: 155, y: 86))
        drop.addQuadCurve(to: CGPoint(x: 150, y: 78), control: CGPoint(x: 145, y: 86))
        drop.closeSubpath()
        ctx.fill(drop, with: .color(Palette.sweat.opacity(0.9)))
    }

    /// Two z's at the mock's positions; unless motion is reduced they drift up and fade on a staggered 3 s loop.
    private func drawZzz(_ ctx: GraphicsContext) {
        let letters: [(x: CGFloat, y: CGFloat, size: CGFloat, color: Color, delay: Double)] = [
            (146, 62, 16, Palette.zzzBig, 0), (160, 46, 11, Palette.zzzSmall, 1.5),
        ]
        for z in letters {
            var layer = ctx
            if !reduceMotion {
                let phase = ((time + z.delay) / 3).truncatingRemainder(dividingBy: 1)
                layer.translateBy(x: 4 * phase, y: -14 * phase)
                layer.opacity = phase < 0.15 ? phase / 0.15 : 1 - (phase - 0.15) / 0.85
            }
            let text = Text("z").font(.system(size: z.size, weight: .bold)).foregroundColor(z.color)
            layer.draw(text, at: CGPoint(x: z.x, y: z.y), anchor: .bottomLeading)
        }
    }

    // MARK: Helpers

    private func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry))
    }

    /// SVG `M start l dx dy …z`: a closed polygon from relative steps.
    private func relativePolygon(start: CGPoint, _ steps: [(CGFloat, CGFloat)]) -> Path {
        var p = Path()
        var point = start
        p.move(to: point)
        for (dx, dy) in steps {
            point = CGPoint(x: point.x + dx, y: point.y + dy)
            p.addLine(to: point)
        }
        p.closeSubpath()
        return p
    }

    /// An SVG radialGradient in objectBoundingBox units: centre and radius are fractions of the shape's
    /// bounds, so the gradient stretches into an ellipse on non-square shapes.
    private func fillGradient(_ ctx: GraphicsContext, _ path: Path, _ gradient: Gradient, center: UnitPoint, radius: CGFloat) {
        let box = path.boundingRect
        var layer = ctx
        layer.clip(to: path)
        layer.translateBy(x: box.minX, y: box.minY)
        layer.scaleBy(x: box.width, y: box.height)
        layer.fill(Path(CGRect(x: 0, y: 0, width: 1, height: 1)),
                   with: .radialGradient(gradient, center: CGPoint(x: center.x, y: center.y), startRadius: 0, endRadius: radius))
    }
}

private enum Palette {
    static let shell = Gradient(stops: [.init(color: hex(0xFFFDF8), location: 0), .init(color: hex(0xFBF1E4), location: 0.55),
                                        .init(color: hex(0xE9D8C4), location: 1)])
    static let visor = Gradient(stops: [.init(color: hex(0x4A3760), location: 0), .init(color: hex(0x2A1D3A), location: 0.6),
                                        .init(color: hex(0x1A1224), location: 1)])
    static let iris = Gradient(stops: [.init(color: hex(0xB8742F), location: 0), .init(color: hex(0x5B2E5E), location: 0.45),
                                       .init(color: hex(0x1E1030), location: 1)])
    static let paw = Gradient(colors: [hex(0xFFF9F1), hex(0xEAD6C0)])
    static let shellStroke = hex(0xE6D3BD)
    static let ring = hex(0xFFC98A)
    static let ringWorried = hex(0xFFB36B)
    static let eyeLine = hex(0xFFD9A0)
    static let headphones = hex(0xC9B3F2)
    static let cup = hex(0xFFE9A3)
    static let heart = hex(0xFFC56B)
    static let blush = hex(0xFF9FB2)
    static let mouth = hex(0xFF8FA3)
    static let mouthLine = hex(0xFF9FB2)
    static let tongue = hex(0xFFC2CD)
    static let starBright = hex(0xFFE680)
    static let starDim = hex(0xF3E3A0)
    static let starAmber = hex(0xFFB347)
    static let starStroke = hex(0xF5C84C)
    static let stem = hex(0x6B4A3A)
    static let sweat = hex(0xA8D8FF)
    static let zzzBig = hex(0xB79BEA)
    static let zzzSmall = hex(0xCDB8F2)

    static func hex(_ rgb: UInt32) -> Color {
        Color(.sRGB, red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255,
              blue: Double(rgb & 0xFF) / 255, opacity: 1)
    }
}
