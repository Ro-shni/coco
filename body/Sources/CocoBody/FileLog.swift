import Foundation

final class FileLog {
    static let body = FileLog(name: "body.log")
    private let url: URL
    private let queue = DispatchQueue(label: "coco.filelog")

    init(name: String) {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Coco")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent(name)
    }

    func info(_ msg: String) { write("INFO", msg) }
    func warn(_ msg: String) { write("WARN", msg) }
    func error(_ msg: String) { write("ERROR", msg) }

    private func write(_ level: String, _ msg: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(level) \(msg)\n"
        queue.async { [url] in
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close()
            } else {
                try? Data(line.utf8).write(to: url)
            }
        }
    }
}
