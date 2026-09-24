import AppKit
import SwiftUI

final class ChatModel: ObservableObject {
    struct Line: Identifiable {
        let id = UUID()
        let fromUser: Bool
        let text: String
    }
    @Published var lines: [Line] = []
    @Published var brainStatus = "starting…"
    @Published var draft = ""
}

struct ChatView: View {
    @ObservedObject var model: ChatModel
    var onSend: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Text("brain: \(model.brainStatus)")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.lines) { line in
                            HStack {
                                if line.fromUser { Spacer(minLength: 40) }
                                Text(line.text)
                                    .textSelection(.enabled)
                                    .padding(8)
                                    .background(RoundedRectangle(cornerRadius: 10)
                                        .fill(line.fromUser ? Color.accentColor.opacity(0.2) : Color.purple.opacity(0.12)))
                                if !line.fromUser { Spacer(minLength: 40) }
                            }
                            .id(line.id)
                        }
                    }
                    .padding(8)
                }
                .onChange(of: model.lines.count) { _, _ in
                    if let last = model.lines.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            HStack {
                TextField("Ask Coco…", text: $model.draft).textFieldStyle(.roundedBorder).onSubmit(send)
                Button("Send", action: send)
            }
            .padding(8)
        }
        .frame(minWidth: 360, minHeight: 420)
    }

    private func send() {
        let text = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.draft = ""
        onSend(text)
    }
}

final class ChatWindowController {
    let model = ChatModel()
    var onSend: ((String) -> Void)?
    private var window: NSWindow?

    var isVisible: Bool { window?.isVisible ?? false }

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 380, height: 480),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.title = "Coco"
            w.isReleasedWhenClosed = false
            w.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            w.contentView = NSHostingView(rootView: ChatView(model: model, onSend: { [weak self] in self?.onSend?($0) }))
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
    }

    func append(fromUser: Bool, text: String) {
        model.lines.append(ChatModel.Line(fromUser: fromUser, text: text))
    }
}
