import CocoCore
import Foundation
import Security

final class BrainClient {
    enum Status: Equatable {
        case starting, connected, restarting, failed(String)
        var label: String {
            switch self {
            case .starting: return "starting…"
            case .connected: return "connected"
            case .restarting: return "restarting…"
            case .failed(let why): return "failed: \(why)"
            }
        }
    }

    var onMessage: ((BrainToBody) -> Void)?
    var onStatus: ((Status) -> Void)?

    private let paths: CocoPaths
    private let token = BrainClient.makeToken()
    /// A separate per-launch secret from `token`: it authenticates only `POST /api/launch-nonce`
    /// (see StudioWindowController), never the WebSocket. Internal so AppDelegate can read it.
    let studioToken = BrainClient.makeToken()
    private let session = URLSession(configuration: .default)
    private var process: Process?
    private var socket: URLSessionWebSocketTask?
    private var limiter = RestartLimiter()
    private var stopping = false
    private static let readyPrefix = "COCO_READY "
    /// Set once the brain reports its port; nil until then (e.g. before the first COCO_READY line).
    private(set) var port: Int?

    init(paths: CocoPaths) { self.paths = paths }

    /// Call on the main thread; all callbacks are delivered on main.
    func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        onStatus?(.starting)
        writeTokenFile()
        launch()
    }

    func send(_ msg: BodyToBrain) {
        guard let socket, let data = try? JSONEncoder().encode(msg), let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { error in
            if let error { FileLog.body.warn("send failed: \(error.localizedDescription)") }
        }
    }

    func stop() {
        stopping = true
        socket?.cancel(with: .goingAway, reason: nil)
        process?.terminate()
    }

    private static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func writeTokenFile() {
        do {
            try FileManager.default.createDirectory(at: paths.supportDir, withIntermediateDirectories: true)
        } catch {
            FileLog.body.warn("couldn't write brain.token")
            return
        }
        let url = paths.supportDir.appendingPathComponent("brain.token")
        let created = FileManager.default.createFile(atPath: url.path, contents: Data(token.utf8), attributes: [.posixPermissions: 0o600])
        if !created { FileLog.body.warn("couldn't write brain.token") }
    }

    private func logHandle() -> FileHandle? {
        try? FileManager.default.createDirectory(at: paths.logsDir, withIntermediateDirectories: true)
        let url = paths.logsDir.appendingPathComponent("brain.log")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        let handle = try? FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
        return handle
    }

    private func launch() {
        let p = Process()
        p.executableURL = paths.nodePath
        p.arguments = [paths.brainDir.appendingPathComponent("dist/main.js").path]
        p.currentDirectoryURL = paths.brainDir
        var env = ProcessInfo.processInfo.environment
        env["COCO_TOKEN"] = token
        env["COCO_STUDIO_TOKEN"] = studioToken
        env["COCO_CONFIG_DIR"] = paths.configDir.path
        env["COCO_DATA_DIR"] = paths.supportDir.path
        p.environment = env
        let stdout = Pipe()
        p.standardOutput = stdout
        p.standardInput = Pipe()  // the brain exits when this pipe closes, i.e. when the Body dies
        p.standardError = logHandle() ?? FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.handleExit(code: proc.terminationStatus) }
        }
        do {
            try p.run()
        } catch {
            onStatus?(.failed("couldn't start node at \(paths.nodePath.path): \(error.localizedDescription)"))
            return
        }
        process = p
        awaitReady(stdout.fileHandleForReading)
    }

    /// Reference box so the @Sendable readability handler can accumulate output without mutating a captured var.
    private final class OutputBuffer: @unchecked Sendable { var data = Data() }

    private func awaitReady(_ handle: FileHandle) {
        let buffer = OutputBuffer()
        handle.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty else { h.readabilityHandler = nil; return }
            buffer.data.append(chunk)
            guard let text = String(data: buffer.data, encoding: .utf8),
                  let line = text.split(separator: "\n").first(where: { $0.hasPrefix(BrainClient.readyPrefix) }),
                  let json = line.dropFirst(BrainClient.readyPrefix.count).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
                  let port = object["port"] as? Int else { return }
            h.readabilityHandler = nil
            DispatchQueue.main.async { self?.connect(port: port) }
        }
    }

    private func connect(port: Int) {
        self.port = port
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 8 * 1024 * 1024
        socket = task
        task.resume()
        receive(on: task)
        onStatus?(.connected)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, task === self.socket else { return }
            switch result {
            case .success(.string(let text)):
                if let data = text.data(using: .utf8), let msg = try? JSONDecoder().decode(BrainToBody.self, from: data) {
                    DispatchQueue.main.async { self.onMessage?(msg) }
                } else {
                    FileLog.body.warn("ignored an invalid message from the brain")
                }
                self.receive(on: task)
            case .success:
                self.receive(on: task)
            case .failure(let error):
                FileLog.body.warn("socket closed: \(error.localizedDescription)")  // process exit drives restarts
            }
        }
    }

    private func handleExit(code: Int32) {
        socket?.cancel()
        socket = nil
        process = nil
        guard !stopping else { return }
        FileLog.body.error("brain exited with code \(code)")
        if limiter.shouldRestart(now: Date().timeIntervalSince1970) {
            onStatus?(.restarting)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.launch() }
        } else {
            onStatus?(.failed("the brain crashed 3 times in a minute (exit \(code)). See ~/Library/Logs/Coco/brain.log"))
        }
    }
}
