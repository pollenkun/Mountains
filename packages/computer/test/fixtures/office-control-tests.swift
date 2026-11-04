// Linked after the actual GuardianInput source by the Node test. No AppKit,
// NSWorkspace or AX call is linked into this executable; only OS pipe delivery.
@MainActor
private final class ControlLifetime { var input: GuardianInput? }
@MainActor
private final class ControlApp {
    let birth = NativeProcessIdentity(pid: 100, bootId: "12345678-1234-1234-1234-123456789abc", startSeconds: "1792300000", startMicroseconds: 1)
    var created = false
    var exited = false
    var closes = 0
    var quits = 0
    var scope: OfficeDocumentScope = .image(number: 45, edited: false)
    func port() -> OfficeApplicationPort {
        OfficeApplicationPort(owner: OfficeSessionOwner(birth: birth, executable: "/own/Preview"), wasAlreadyRunning: false,
            currentPID: { 100 }, currentExecutable: { "/own/Preview" },
            originalProcess: { NativeProcessObservation(status: self.exited ? "absent" : "alive", identity: self.exited ? nil : self.birth, reason: nil) },
            isTerminated: { self.exited }, inspect: { self.scope },
            closeDocument: { _ in self.closes += 1; self.scope = .empty },
            requestTermination: { self.quits += 1; self.exited = true; return true })
    }
}
@main
private struct ControlProbe {
    @MainActor
    static func main() async throws {
        let app = ControlApp(), began = ContinuousClock.now, lifetime = ControlLifetime()
        let session = OfficeSession(launch: { admit in
            lifetime.input?.drain()
            try admit(); app.created = true; await Task.yield(); return app.port()
        }, now: {
            let value = began.duration(to: .now).components
            return Double(value.seconds) * 1000 + Double(value.attoseconds) / 1e15
        }, tick: { try await Task.sleep(for: .milliseconds(1)) }, emit: { _ in })
        let input = GuardianInput(session: session); lifetime.input = input; try input.start()
        if CommandLine.arguments.dropFirst().first == "signal-pending" {
            try FileHandle.standardOutput.write(contentsOf: Data("INPUT_READY\n".utf8))
            // Hold this actor synchronously until the POSIX handler has received
            // the parent's actual signal. Dispatch's main callback cannot run.
            let end = ContinuousClock.now.advanced(by: .seconds(2))
            while mountains_office_signal_received() == 0, ContinuousClock.now < end { usleep(1000) }
        }
        let outcome = await session.run(); input.close()
        let result: [String: Any] = ["created": app.created, "closes": app.closes, "quits": app.quits,
            "receivedSignal": mountains_office_signal_received(),
            "outcome": try JSONSerialization.jsonObject(with: JSONEncoder().encode(outcome))]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
    }
}
