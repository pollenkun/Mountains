import Foundation
import AppKit
import ApplicationServices
import CryptoKit
import Darwin

private enum GuardianError: Error { case invalid(String) }
private let previewExecutable = "/System/Applications/Preview.app/Contents/MacOS/Preview"
@MainActor
private func requireUnlockedDesktop() throws {
    guard let front = NSWorkspace.shared.frontmostApplication, !front.isTerminated, front.processIdentifier > 0,
          let path = front.executableURL?.resolvingSymlinksInPath().path,
          try OfficeWindowReader().processExecutable(front.processIdentifier) == path else { throw GuardianError.invalid("desktop-state-unknown") }
    guard path != "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow" else {
        throw GuardianError.invalid("desktop-locked; no application created")
    }
}
private struct UnverifiedLaunchReceipt: Encodable {
    let pid: Int32
    let objectExecutable: String?
    let process: NativeProcessObservation
    let problem: String
}
@MainActor
private final class GuardianLifetime {
    var input: GuardianInput?
    var returnedApplication: NSRunningApplication?
}
private struct GuardianConfig {
    let root: String
    let image: String
    static func load(_ root: String) throws -> GuardianConfig {
        let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/Mountains 测试素材").resolvingSymlinksInPath().path
        guard URL(fileURLWithPath: root).standardizedFileURL.resolvingSymlinksInPath().path == root,
              URL(fileURLWithPath: root).deletingLastPathComponent().path == base else { throw GuardianError.invalid("run-root") }
        for directory in [root, root + "/workspace", root + "/evidence", root + "/build"] {
            var info = stat()
            guard lstat(directory, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
                  info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw GuardianError.invalid("private-run-directory") }
        }
        let file = root + "/workspace/rotate.png"
        var info = stat()
        guard lstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              info.st_uid == getuid(), info.st_size > 0, info.st_size < 32 * 1024 * 1024,
              URL(fileURLWithPath: file).resolvingSymlinksInPath().path == file else { throw GuardianError.invalid("own-image") }
        let manifestPath = root + "/manifest.json"
        guard lstat(manifestPath, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              info.st_uid == getuid(), info.st_size < 1024 * 1024,
              let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: manifestPath))) as? [String: Any],
              manifest["root"] as? String == root, manifest["phase"] as? String == "prepared_only",
              let assets = manifest["assets"] as? [String: Any], let expected = assets["imageSha256"] as? String,
              let hashes = manifest["fixtureHashes"] as? [String: String] else { throw GuardianError.invalid("manifest") }
        let imageHash = SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: file))).map { String(format: "%02x", $0) }.joined()
        let ownPath = root + "/build/OfficeSession"
        guard imageHash == expected,
              URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path == ownPath,
              let expectedOwn = hashes[ownPath],
              SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: ownPath))).map({ String(format: "%02x", $0) }).joined() == expectedOwn else {
            throw GuardianError.invalid("image-or-guardian-hash")
        }
        return GuardianConfig(root: root, image: file)
    }
}

@MainActor
private final class GuardianJournal {
    private let file: FileHandle
    private var sequence = 0
    init(root: String) throws {
        let fd = open(root + "/evidence/office-lifetime.jsonl", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw GuardianError.invalid("new-private-journal") }
        file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
    func record<Value: Encodable>(_ kind: String, _ value: Value) throws {
        sequence += 1
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
        var data = try JSONSerialization.data(withJSONObject: ["sequence": sequence, "pid": getpid(), "at": Date().timeIntervalSince1970 * 1000,
            "uptimeMs": ProcessInfo.processInfo.systemUptime * 1000, "kind": kind, "payload": payload], options: [.sortedKeys])
        data.append(10)
        try file.write(contentsOf: data)
        guard fsync(file.fileDescriptor) == 0 else { throw GuardianError.invalid("journal-flush") }
        // SIGPIPE is ignored. Broken stdout throws into the same real cleanup
        // path; it never exits before a pending NSWorkspace launch is awaited.
        try FileHandle.standardOutput.write(contentsOf: data)
    }
    func close() throws { try file.close() }
}

@MainActor
private final class GuardianInput {
    private let session: OfficeSession
    private var source: (any DispatchSourceRead)?
    private var signals: [any DispatchSourceSignal] = []
    private var buffer = Data()
    private var normalClose = false
    init(session: OfficeSession) { self.session = session }
    func start() throws {
        let flags = fcntl(STDIN_FILENO, F_GETFL)
        guard flags >= 0, fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else { throw GuardianError.invalid("control-pipe") }
        let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        input.setEventHandler { MainActor.assumeIsolated { self.read() } }
        source = input; input.resume()
        guard mountains_office_signals_install() == 0 else { throw GuardianError.invalid("signal-handler") }
        for value in [SIGINT, SIGTERM] {
            let item = DispatchSource.makeSignalSource(signal: value, queue: .main)
            item.setEventHandler { MainActor.assumeIsolated { self.session.requestClose(problem: "guardian signal; input release unverified") } }
            signals.append(item); item.resume()
        }
        // The async main can reach NSWorkspace before the main queue delivers
        // its first readability callback. Consume already-present EOF/close.
        drain()
    }
    private func read() {
        var bytes = [UInt8](repeating: 0, count: 512)
        while true {
            let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if count > 0 {
                buffer.append(contentsOf: bytes.prefix(count))
                guard buffer.count <= 512 else { session.requestClose(problem: "invalid control input"); source?.cancel(); return }
                while let end = buffer.firstIndex(of: 10) {
                    let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
                    guard line == Data("close".utf8), !normalClose else { session.requestClose(problem: "invalid or repeated close command"); source?.cancel(); return }
                    normalClose = true; session.requestClose()
                }
                continue
            }
            if count == 0 {
                source?.cancel()
                if !normalClose || !buffer.isEmpty { session.requestClose(problem: "controller EOF; input release unverified") }
                return
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK { return }
            session.requestClose(problem: "control pipe failed; input release unverified"); source?.cancel(); return
        }
    }
    func drain() {
        if mountains_office_signal_received() != 0 { session.requestClose(problem: "guardian signal; input release unverified") }
        read()
        if mountains_office_signal_received() != 0 { session.requestClose(problem: "guardian signal; input release unverified") }
    }
    func close() { source?.cancel(); source = nil; for item in signals { item.cancel() }; signals.removeAll() }
}

@MainActor
private func applicationPort(_ application: NSRunningApplication, prior: [NSRunningApplication], image: String) throws -> OfficeApplicationPort {
    let pid = application.processIdentifier, before = ProcessIdentityProbe.read(pid: pid)
    guard pid > 0, before.status == "alive", let birth = before.identity,
          try OfficeWindowReader().processExecutable(pid) == previewExecutable,
          application.processIdentifier == pid, application.executableURL?.resolvingSymlinksInPath().path == previewExecutable,
          ProcessIdentityProbe.read(pid: pid).identity == birth else { throw GuardianError.invalid("launch-receipt-identity") }
    let owner = OfficeSessionOwner(birth: birth, executable: previewExecutable)
    func sameObject() throws {
        guard application.processIdentifier == pid, ProcessIdentityProbe.read(pid: pid).identity == birth else { throw GuardianError.invalid("original-application-changed") }
    }
    func scope() throws -> OfficeDocumentScope {
        try sameObject()
        let value = try OfficeWindowReader().imageScope(birth: birth, expectedExecutable: previewExecutable, file: image)
        try sameObject()
        switch value {
        case .empty: return .empty
        case .image(let window):
            guard let number = window.number else { throw GuardianError.invalid("owned-window-number") }
            return .image(number: number, edited: window.edited)
        }
    }
    return OfficeApplicationPort(owner: owner, wasAlreadyRunning: prior.contains(where: { $0.isEqual(application) }),
        currentPID: { application.processIdentifier }, currentExecutable: { try OfficeWindowReader().processExecutable(pid) },
        originalProcess: { ProcessIdentityProbe.read(pid: pid) }, isTerminated: { application.isTerminated }, inspect: { try scope() },
        closeDocument: { number in
            try sameObject()
            try OfficeWindowReader().closeImage(birth: birth, expectedExecutable: previewExecutable, file: image, number: number)
        }, requestTermination: {
            try sameObject()
            guard try scope() == .empty else { throw GuardianError.invalid("new-document-before-quit") }
            try OfficeWindowReader().requireBackground(pid)
            try sameObject()
            return application.terminate()
        })
}

@main
private struct OfficeSessionMain {
    @MainActor
    static func main() async {
        guard CommandLine.arguments.count == 2 else { exit(2) }
        signal(SIGPIPE, SIG_IGN)
        do {
            let config = try GuardianConfig.load(CommandLine.arguments[1]), journal = try GuardianJournal(root: config.root)
            let began = ContinuousClock.now
            let lifetime = GuardianLifetime()
            let session = OfficeSession(launch: { admit in
                // This acceptance helper requires a usable user desktop. A
                // locked session can return placeholder AX application nodes
                // where document windows are expected. Do not launch and leak
                // another instance when its ownership cannot be established.
                try requireUnlockedDesktop()
                let prior = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.apple.Preview" }
                let options = NSWorkspace.OpenConfiguration()
                options.activates = false; options.createsNewApplicationInstance = true
                options.addsToRecentItems = false; options.promptsUserIfNeeded = false
                options.allowsRunningApplicationSubstitution = false
                // Revalidate the own file and frozen executable after any
                // launch preparation, before consuming creation admission.
                _ = try GuardianConfig.load(config.root)
                guard let input = lifetime.input else { throw GuardianError.invalid("control-not-started") }
                try requireUnlockedDesktop()
                input.drain()
                // This synchronous consume is directly adjacent to the actual
                // OS request. Do not insert another await or RunLoop turn.
                try admit()
                let application = try await NSWorkspace.shared.open([URL(fileURLWithPath: config.image)], withApplicationAt: URL(fileURLWithPath: "/System/Applications/Preview.app"), configuration: options)
                lifetime.returnedApplication = application
                do { return try applicationPort(application, prior: prior, image: config.image) }
                catch {
                    // Keep the returned object alive and preserve its candidate
                    // identity. This is diagnostic evidence, never permission
                    // to close/terminate an application that failed binding.
                    try? journal.record("unverified-launch-receipt", UnverifiedLaunchReceipt(pid: application.processIdentifier,
                        objectExecutable: application.executableURL?.path,
                        process: ProcessIdentityProbe.read(pid: application.processIdentifier), problem: String(describing: error)))
                    throw error
                }
            }, now: {
                let elapsed = began.duration(to: .now).components
                return Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15
            }, tick: { try await Task.sleep(for: .milliseconds(20)) }, emit: { event in try journal.record(event.kind, event) })
            let control = GuardianInput(session: session)
            lifetime.input = control
            try control.start()
            let outcome = await session.run()
            control.close()
            try journal.record("terminal", outcome)
            try journal.close()
            withExtendedLifetime(lifetime.returnedApplication) {}
            exit(outcome.cleanupConfirmed && outcome.problem == nil ? 0 : 1)
        } catch {
            // No alternate launch, app-name termination or foreground fallback.
            try? FileHandle.standardError.write(contentsOf: Data("office guardian failed: \(error)\n".utf8))
            exit(1)
        }
    }
}
