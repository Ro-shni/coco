import SwiftUI

final class BubbleModel: ObservableObject {
    @Published var text = ""
    @Published var chips: [String] = []
    @Published var nudgeId = ""
}

struct BubbleView: View {
    @ObservedObject var model: BubbleModel
    var onChip: (String) -> Void
    var onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 6) {
                Text(model.text)
                    .font(.system(size: 13))
                    .foregroundStyle(.black)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.gray)
                }
                .buttonStyle(.plain)
            }
            if !model.chips.isEmpty {
                HStack(spacing: 6) {
                    ForEach(model.chips, id: \.self) { chip in
                        Button(chip) { onChip(chip) }
                            .buttonStyle(.plain)
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(Color.purple.opacity(0.12)))
                            .foregroundStyle(Color.purple)
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(.white).shadow(color: .black.opacity(0.25), radius: 8, y: 3))
        .padding(10)
    }
}
