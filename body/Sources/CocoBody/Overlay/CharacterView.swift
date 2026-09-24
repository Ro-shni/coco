import CocoCore
import SwiftUI

final class CharacterModel: ObservableObject {
    @Published var mood: Mood = .curious
    @Published var eyeOffset: CGSize = .zero
    @Published var dimmed = false
}

struct CharacterView: View {
    @ObservedObject var model: CharacterModel
    var onDragBegan: () -> Void
    var onDragChanged: () -> Void
    var onDragEnded: () -> Void
    @State private var bob = false
    @State private var isDragging = false

    var body: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [tint.opacity(0.75), tint], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 2, endRadius: 30))
                .shadow(color: tint.opacity(0.6), radius: 10)
            HStack(spacing: 8) { eye; eye }.offset(model.eyeOffset)
        }
        .frame(width: 44, height: 44)
        .opacity(model.dimmed ? 0.45 : 1)
        .offset(y: bob ? -2 : 2)
        .rotationEffect(.degrees(model.mood == .worried ? (bob ? -4 : 4) : 0))
        .animation(.easeInOut(duration: model.mood == .sleepy ? 2.4 : 1.2).repeatForever(autoreverses: true), value: bob)
        .onAppear { bob = true }
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
        .padding(8)
        .help("Coco: click to chat, drag to move")
    }

    private var eye: some View {
        Capsule().fill(.white).frame(width: 5, height: model.mood == .sleepy ? 1.5 : 8)
    }

    private var tint: Color {
        switch model.mood {
        case .curious: return .purple
        case .focused: return .indigo
        case .worried: return .orange
        case .bored: return .gray
        case .sleepy: return .blue.opacity(0.6)
        }
    }
}
