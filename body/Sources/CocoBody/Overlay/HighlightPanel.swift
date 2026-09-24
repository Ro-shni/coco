import AppKit
import SwiftUI

/// Click-through dashed ring around the thing Coco is talking about.
final class HighlightPanel {
    private let panel = OverlayPanel(size: CGSize(width: 10, height: 10), clickThrough: true)
    private var hideWork: DispatchWorkItem?
    private static let padding: CGFloat = 8
    private static let visibleFor: TimeInterval = 6

    init() {
        panel.contentView = NSHostingView(rootView:
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                .padding(1))
    }

    func show(rect: CGRect) {
        panel.setFrame(rect.insetBy(dx: -Self.padding, dy: -Self.padding), display: true)
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.4; self?.panel.animator().alphaValue = 0 },
                                                 completionHandler: { self?.panel.orderOut(nil) })
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.visibleFor, execute: work)
    }
}
