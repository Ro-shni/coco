import AppKit
import SwiftUI

private final class PermissionsModel: ObservableObject {
    @Published var granted: [Permission: Bool] = [:]
    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() { granted = Dictionary(uniqueKeysWithValues: Permission.allCases.map { ($0, $0.isGranted) }) }
}

private struct PermissionsView: View {
    @StateObject var model = PermissionsModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Coco needs a few permissions").font(.headline)
            ForEach(Permission.allCases, id: \.self) { permission in
                HStack(alignment: .top) {
                    Text(model.granted[permission] == true ? "✅" : "❌")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(permission.title).bold()
                        Text(permission.why).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.granted[permission] != true { Button("Grant…") { permission.request() } }
                }
            }
            Text("After granting Screen Recording, macOS may ask you to quit and reopen Coco.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 460)
    }
}

final class PermissionsWindowController {
    private var window: NSWindow?

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 460, height: 280), styleMask: [.titled, .closable],
                             backing: .buffered, defer: false)
            w.title = "Coco permissions"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: PermissionsView())
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}
