import AppKit
import SwiftUI

final class ChatModel: ObservableObject {
    struct Line: Identifiable {
        let id = UUID()
        let fromUser: Bool
        let text: String
        /// Set together, only on a `say` line that carries a draft (P2 draft & paste).
        let nudgeId: String?
        let draft: String?
        let draftApp: String?

        init(fromUser: Bool, text: String, nudgeId: String? = nil, draft: String? = nil, draftApp: String? = nil) {
            self.fromUser = fromUser; self.text = text
            self.nudgeId = nudgeId; self.draft = draft; self.draftApp = draftApp
        }
    }
    @Published var lines: [Line] = []
    @Published var brainStatus = "starting…"
    @Published var draft = ""
}

struct ChatView: View {
    @ObservedObject var model: ChatModel
    var onSend: (String) -> Void
    /// (nudgeId, chip choice) — same chip-forwarding contract as the overlay bubble's chips.
    var onChip: (String, String) -> Void
    var onOpenStudio: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("brain: \(model.brainStatus)")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Studio", action: onOpenStudio).font(.caption)
            }
            .padding(8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.lines) { line in
                            VStack(alignment: line.fromUser ? .trailing : .leading, spacing: 6) {
                                HStack {
                                    if line.fromUser { Spacer(minLength: 40) }
                                    Text(line.text)
                                        .textSelection(.enabled)
                                        .padding(8)
                                        .background(RoundedRectangle(cornerRadius: 10)
                                            .fill(line.fromUser ? Color.accentColor.opacity(0.2) : Color.purple.opacity(0.12)))
                                    if !line.fromUser { Spacer(minLength: 40) }
                                }
                                if let draft = line.draft, let nudgeId = line.nudgeId {
                                    draftBox(draft: draft, appName: line.draftApp, nudgeId: nudgeId)
                                }
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

    /// The draft Coco offers to paste, plus the button that's the ONLY way it ever reaches another app's
    /// text field — never automatically, never with Return pressed afterwards.
    @ViewBuilder
    private func draftBox(draft: String, appName: String?, nudgeId: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(draft)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.25)))
            if let appName {
                Button("Paste into \(appName)") { onChip(nudgeId, "paste into \(appName)") }
            }
        }
        .padding(.trailing, 40)
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
    var onChip: ((String, String) -> Void)?
    var onOpenStudio: (() -> Void)?
    private var window: NSWindow?

    var isVisible: Bool { window?.isVisible ?? false }

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 380, height: 480),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.title = "Coco"
            w.isReleasedWhenClosed = false
            w.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            w.contentView = NSHostingView(rootView: ChatView(
                model: model,
                onSend: { [weak self] in self?.onSend?($0) },
                onChip: { [weak self] nudgeId, choice in self?.onChip?(nudgeId, choice) },
                onOpenStudio: { [weak self] in self?.onOpenStudio?() }))
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
    }

    func append(fromUser: Bool, text: String, nudgeId: String? = nil, draft: String? = nil, draftApp: String? = nil) {
        model.lines.append(ChatModel.Line(fromUser: fromUser, text: text, nudgeId: nudgeId, draft: draft, draftApp: draftApp))
    }
}
