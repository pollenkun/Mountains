import AppKit
import Foundation
import Darwin

// Candidate only: no web-tool entry point or release executable uses this yet.
// It retains an actual launch result. It never rediscovers an application by
// PID/name, activates it, or treats a quit request as proof of actual exit.
struct RetainedApplicationOwner: Equatable {
    let birth: NativeProcessIdentity
    let executable: String
}
struct RetainedApplicationObservation {
    let objectPID: Int32
    let objectTerminated: Bool
    let process: NativeProcessObservation
    let executable: String?
}
@MainActor
struct RetainedApplicationPort {
    let owner: RetainedApplicationOwner
    let reused: Bool
    let observe: () throws -> RetainedApplicationObservation
    let terminate: () throws -> Bool
    let forceTerminate: () throws -> Bool
}
enum RetainedApplicationProblem: Error, Equatable {
    case reusedInstance, invalidOwner, changedObject, unknownProcess, changedExecutable
    case ownershipRevoked, observationFailed, requestFailed, deliveryFailed, deadline
}
struct RetainedApplicationCloseResult: Equatable {
    let originalExitConfirmed: Bool
    let terminationRequests: Int
    let forceRequests: Int
    let problems: [RetainedApplicationProblem]
}

@MainActor
final class RetainedApplicationCloser {
    struct Limits { var graceMs = 1000.0; var totalMs = 3000.0 }
    private enum State { case alive, settling, exited }
    private let port: RetainedApplicationPort
    private let mayClose: () throws -> Bool
    private let now: () -> Double
    private let tick: () async throws -> Void
    private let emit: (String) throws -> Void
    private let limits: Limits
    private var closing: Task<RetainedApplicationCloseResult, Never>?

    init(port: RetainedApplicationPort, limits: Limits = Limits(),
         mayClose: @escaping () throws -> Bool, now: @escaping () -> Double,
         tick: @escaping () async throws -> Void, emit: @escaping (String) throws -> Void) {
        self.port = port; self.limits = limits; self.mayClose = mayClose
        self.now = now; self.tick = tick; self.emit = emit
    }
    func close() async -> RetainedApplicationCloseResult {
        if let closing { return await closing.value }
        // MainActor publishes the one task before any synchronous callback can
        // reenter. Repeated close never sends another terminate/force request.
        let began = now()
        let task = Task { await self.finish(began: began) }; closing = task
        return await task.value
    }
    private func state() throws -> State {
        let value = try port.observe(), owner = port.owner
        guard value.objectPID == owner.birth.pid || value.objectTerminated && value.objectPID == -1 else {
            throw RetainedApplicationProblem.changedObject
        }
        let gone: Bool
        switch value.process.status {
        case "absent": gone = true
        case "alive":
            guard let actual = value.process.identity, actual.pid == owner.birth.pid else { throw RetainedApplicationProblem.unknownProcess }
            gone = actual != owner.birth
        default: throw RetainedApplicationProblem.unknownProcess
        }
        if gone { return value.objectTerminated ? .exited : .settling }
        if value.objectTerminated { return .settling }
        guard value.executable == owner.executable else { throw RetainedApplicationProblem.changedExecutable }
        return .alive
    }
    private func finish(began: Double) async -> RetainedApplicationCloseResult {
        let end = began + limits.totalMs
        var previous = began, normalAt: Double?
        var problems: [RetainedApplicationProblem] = [], normal = 0, forced = 0, confirmed = false
        func note(_ problem: RetainedApplicationProblem) { if !problems.contains(problem) { problems.append(problem) } }
        func beforeDeadline() throws {
            let value = now()
            guard value.isFinite, value >= previous, value < end else { throw RetainedApplicationProblem.deadline }
            previous = value
        }
        func authorized() throws {
            let allowed: Bool
            do { allowed = try mayClose() } catch { throw RetainedApplicationProblem.ownershipRevoked }
            guard allowed else { throw RetainedApplicationProblem.ownershipRevoked }
            try beforeDeadline()
        }
        func event(_ value: String) {
            do { try emit(value) } catch { note(.deliveryFailed) }
        }
        do {
            guard port.owner.birth.pid > 0, UUID(uuidString: port.owner.birth.bootId) != nil,
                  Int64(port.owner.birth.startSeconds).map({ $0 > 0 }) == true,
                  (0..<1_000_000).contains(port.owner.birth.startMicroseconds),
                  port.owner.executable.hasPrefix("/"), limits.graceMs.isFinite, limits.graceMs >= 0,
                  limits.totalMs.isFinite, limits.totalMs > 0, limits.graceMs < limits.totalMs else { throw RetainedApplicationProblem.invalidOwner }
            guard !port.reused else { throw RetainedApplicationProblem.reusedInstance }
            guard began.isFinite, end.isFinite else { throw RetainedApplicationProblem.deadline }
            try beforeDeadline()
            while !confirmed {
                var current = try state(); try beforeDeadline()
                if current == .exited { confirmed = true; break }
                if current == .alive && normal == 0 {
                    event("terminate-requested"); try authorized()
                    current = try state(); try beforeDeadline(); try authorized()
                    if current == .alive {
                        normal += 1; normalAt = previous
                        do { _ = try port.terminate() }
                        catch let problem as RetainedApplicationProblem { throw problem }
                        catch { note(.requestFailed) }
                        try beforeDeadline()
                        // Even a throwing request may have reached the original
                        // object. Observe it before deciding whether to force.
                        continue
                    }
                }
                // Disagreement between the original object and the OS never
                // grants signal authority. Wait for an actual main-loop tick.
                if current == .alive, let normalAt, previous >= normalAt + limits.graceMs, forced == 0 {
                    event("force-requested"); try authorized()
                    current = try state(); try beforeDeadline(); try authorized()
                    if current == .alive {
                        forced += 1
                        do { _ = try port.forceTerminate() }
                        catch let problem as RetainedApplicationProblem { throw problem }
                        catch { note(.requestFailed) }
                        try beforeDeadline()
                        continue
                    }
                }
                try await tick(); try beforeDeadline()
            }
            event("original-exit-confirmed"); try beforeDeadline()
        } catch let problem as RetainedApplicationProblem { note(problem) }
        catch { note(.observationFailed) }
        // A deadline overrun or broken report is retained even if actual exit
        // was observed. Callers must not equate resource exit with task success.
        return RetainedApplicationCloseResult(originalExitConfirmed: confirmed,
            terminationRequests: normal, forceRequests: forced, problems: problems)
    }
}

@MainActor
final class RetainedApplicationLaunchCapture {
    private(set) var application: NSRunningApplication?
    private(set) var unverifiedOwner: RetainedApplicationOwner?
    private(set) var admitted = false

    // A concrete reviewable adapter, not a production change to open -g.
    // The caller owns cancellation and must drain this actual callback even
    // after its deadline; it cannot infer that a failed launch created nothing.
    func launch(bundle: URL, executable: String, arguments: [String],
                admit: () throws -> Void) async throws -> RetainedApplicationPort {
        guard !admitted, application == nil, bundle.isFileURL,
              bundle.standardizedFileURL.resolvingSymlinksInPath() == bundle,
              executable.hasPrefix("/"), !arguments.contains(where: { $0.contains("\0") }) else {
            throw RetainedApplicationProblem.invalidOwner
        }
        let prior = NSWorkspace.shared.runningApplications
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false; configuration.hidesOthers = false
        configuration.createsNewApplicationInstance = true
        configuration.allowsRunningApplicationSubstitution = false
        configuration.promptsUserIfNeeded = false; configuration.addsToRecentItems = false
        configuration.arguments = arguments
        // No suspension/run-loop turn between admission and the real request.
        try admit(); admitted = true
        let returned = try await NSWorkspace.shared.openApplication(at: bundle, configuration: configuration)
        application = returned
        do { return try Self.bind(returned, prior: prior, executable: executable) }
        catch {
            let value = ProcessIdentityProbe.read(pid: returned.processIdentifier)
            if let birth = value.identity { unverifiedOwner = RetainedApplicationOwner(birth: birth, executable: executable) }
            throw error
        }
    }
    private static func path(_ pid: Int32) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 4096)
        let count = proc_pidpath(pid, &bytes, UInt32(bytes.count))
        guard count > 0, count < bytes.count, let end = bytes.firstIndex(of: 0), end == count,
              let value = String(bytes: bytes[..<end], encoding: .utf8), value.hasPrefix("/") else {
            throw RetainedApplicationProblem.unknownProcess
        }
        return value
    }
    private static func bind(_ application: NSRunningApplication, prior: [NSRunningApplication], executable: String) throws -> RetainedApplicationPort {
        guard !prior.contains(where: { $0.isEqual(application) }) else { throw RetainedApplicationProblem.reusedInstance }
        let pid = application.processIdentifier, value = ProcessIdentityProbe.read(pid: application.processIdentifier)
        guard pid > 0, value.status == "alive", let birth = value.identity, !application.isTerminated,
              application.executableURL?.resolvingSymlinksInPath().path == executable, try path(pid) == executable,
              ProcessIdentityProbe.read(pid: pid).identity == birth else { throw RetainedApplicationProblem.unknownProcess }
        let owner = RetainedApplicationOwner(birth: birth, executable: executable)
        func observe() throws -> RetainedApplicationObservation {
            let before = ProcessIdentityProbe.read(pid: pid)
            let executable: String?
            if before.status == "alive" {
                executable = try path(pid)
                guard ProcessIdentityProbe.read(pid: pid).identity == before.identity else { throw RetainedApplicationProblem.unknownProcess }
            } else { executable = nil }
            return RetainedApplicationObservation(objectPID: application.processIdentifier,
                objectTerminated: application.isTerminated, process: before, executable: executable)
        }
        func guardOriginal() throws {
            let value = try observe()
            guard !value.objectTerminated, value.objectPID == pid,
                  value.process.status == "alive", value.process.identity == owner.birth else { throw RetainedApplicationProblem.changedObject }
            guard value.executable == owner.executable else { throw RetainedApplicationProblem.changedExecutable }
        }
        return RetainedApplicationPort(owner: owner, reused: false, observe: observe,
            terminate: { try guardOriginal(); return application.terminate() },
            forceTerminate: { try guardOriginal(); return application.forceTerminate() })
    }
}
