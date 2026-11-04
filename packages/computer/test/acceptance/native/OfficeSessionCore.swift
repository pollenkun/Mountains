import Foundation

struct OfficeSessionOwner: Equatable, Encodable {
    let birth: NativeProcessIdentity
    let executable: String
}
enum OfficeDocumentScope: Equatable {
    case notReady
    case image(number: UInt32, edited: Bool?)
    case empty
}
enum OfficeSessionError: Error, Equatable {
    case reusedApplication
    case changedProcess
    case unknownProcess
    case changedExecutable
    case startupDeadline
    case unexpectedDocument
    case unsavedOrUnknownDocument
    case documentCloseDeadline
    case terminateRefused
    case exitDeadline
    case launchCancelled
    case launchAlreadyAdmitted
    case launchNotAdmitted
}
typealias OfficeLaunchAdmission = @MainActor () throws -> Void
typealias OfficeLauncher = @MainActor (@escaping OfficeLaunchAdmission) async throws -> OfficeApplicationPort
struct OfficeSessionEvent: Encodable {
    let kind: String
    let owner: OfficeSessionOwner?
    let window: UInt32?
    let problem: String?
}
struct OfficeSessionOutcome: Encodable {
    let readyPublished: Bool
    let cleanupConfirmed: Bool
    let owner: OfficeSessionOwner?
    let problem: String?
}

// One actual NSRunningApplication object supplies these closures. Tests replace
// the OS, not this state machine. No closure may look up a new app by name/PID.
@MainActor
struct OfficeApplicationPort {
    let owner: OfficeSessionOwner
    let wasAlreadyRunning: Bool
    let currentPID: () -> Int32
    let currentExecutable: () throws -> String
    let originalProcess: () -> NativeProcessObservation
    let isTerminated: () -> Bool
    let inspect: () throws -> OfficeDocumentScope
    let closeDocument: (UInt32) throws -> Void
    let requestTermination: () throws -> Bool
}

@MainActor
final class OfficeSession {
    struct Limits {
        var startupMs: Double = 8000
        var closeMs: Double = 3000
        var exitMs: Double = 3000
    }
    private let launch: OfficeLauncher
    private let now: () -> Double
    private let tick: () async throws -> Void
    private let emit: (OfficeSessionEvent) throws -> Void
    private let limits: Limits
    private var stopped = false
    private var started = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var problem: String?
    private var port: OfficeApplicationPort?
    private var window: UInt32?
    private var ready = false

    init(limits: Limits = Limits(), launch: @escaping OfficeLauncher,
         now: @escaping () -> Double, tick: @escaping () async throws -> Void,
         emit: @escaping (OfficeSessionEvent) throws -> Void) {
        self.limits = limits
        self.launch = launch
        self.now = now
        self.tick = tick
        self.emit = emit
    }
    // EOF/cancellation is sticky failure even if exact resource cleanup later
    // succeeds. It is never evidence that the old input sender released keys.
    func requestClose(problem message: String? = nil) {
        if let message { problem = problem ?? message }
        stopped = true
        let continuation = waiter
        waiter = nil
        continuation?.resume()
    }
    @discardableResult
    private func note(_ kind: String) -> Bool {
        do { try emit(OfficeSessionEvent(kind: kind, owner: port?.owner, window: window, problem: problem)); return true }
        catch { requestClose(problem: "event delivery failed: \(error)"); return false }
    }
    private func originalExited(_ value: OfficeApplicationPort) throws -> Bool {
        let observed = value.originalProcess(), currentPID = value.currentPID()
        let gone: Bool
        switch observed.status {
        case "absent": gone = true
        case "alive":
            guard let identity = observed.identity, identity.pid == value.owner.birth.pid else { throw OfficeSessionError.unknownProcess }
            gone = identity != value.owner.birth
        default: throw OfficeSessionError.unknownProcess
        }
        if gone {
            // -1 is allowed only after the original object itself has ended.
            guard value.isTerminated(), currentPID == value.owner.birth.pid || currentPID == -1 else {
                throw OfficeSessionError.changedProcess
            }
            return true
        }
        guard currentPID == value.owner.birth.pid, !value.isTerminated() else { throw OfficeSessionError.changedProcess }
        guard try value.currentExecutable() == value.owner.executable else { throw OfficeSessionError.changedExecutable }
        return false
    }
    private func waitForStop() async {
        if stopped { return }
        await withCheckedContinuation { continuation in waiter = continuation }
    }
    private func before(_ end: Double, _ error: OfficeSessionError) throws {
        guard now() < end else { throw error }
    }
    private func clean(_ value: OfficeApplicationPort) async throws {
        let closeEnd = now() + limits.closeMs
        if try originalExited(value) { try before(closeEnd, .documentCloseDeadline); return }
        var scope = try value.inspect()
        try before(closeEnd, .documentCloseDeadline)
        if case .image(let number, let edited) = scope {
            guard number > 0 else { throw OfficeSessionError.unexpectedDocument }
            guard edited == false else { throw OfficeSessionError.unsavedOrUnknownDocument }
            if let window { guard number == window else { throw OfficeSessionError.unexpectedDocument } }
            self.window = number
            _ = note("document-close-requested")
            try before(closeEnd, .documentCloseDeadline)
            if try originalExited(value) { try before(closeEnd, .documentCloseDeadline); return }
            // Logging can be slow or reentrant. Recheck the actual scope after
            // it, immediately before the one semantic close action.
            guard try value.inspect() == .image(number: number, edited: false) else { throw OfficeSessionError.unexpectedDocument }
            try before(closeEnd, .documentCloseDeadline)
            if try originalExited(value) { try before(closeEnd, .documentCloseDeadline); return }
            try before(closeEnd, .documentCloseDeadline)
            try value.closeDocument(number) // exactly once; errors are not retried
            try before(closeEnd, .documentCloseDeadline)
            while true {
                if try originalExited(value) { try before(closeEnd, .documentCloseDeadline); return }
                scope = try value.inspect()
                try before(closeEnd, .documentCloseDeadline)
                if scope == .empty { break }
                guard case .image(let remaining, let stillEdited) = scope,
                      remaining == number, stillEdited == false else { throw OfficeSessionError.unexpectedDocument }
                try await tick()
            }
        }
        guard scope == .empty else { throw OfficeSessionError.unexpectedDocument }
        let exitEnd = now() + limits.exitMs
        _ = note("termination-requested")
        if try originalExited(value) { try before(exitEnd, .exitDeadline); return }
        // A new empty inventory after logging precedes the one quit request.
        guard try value.inspect() == .empty else { throw OfficeSessionError.unexpectedDocument }
        try before(exitEnd, .exitDeadline)
        if try originalExited(value) { try before(exitEnd, .exitDeadline); return }
        try before(exitEnd, .exitDeadline)
        if try !value.requestTermination() {
            if try originalExited(value) { try before(exitEnd, .exitDeadline); return }
            throw OfficeSessionError.terminateRefused
        }
        try before(exitEnd, .exitDeadline)
        while true {
            let gone = try originalExited(value)
            try before(exitEnd, .exitDeadline)
            if gone { break }
            try await tick()
        }
    }
    func run() async -> OfficeSessionOutcome {
        precondition(!started, "an office session can run only once")
        started = true
        var cleanupConfirmed = false
        var launchAdmitted = false
        if stopped { return OfficeSessionOutcome(readyPublished: false, cleanupConfirmed: true, owner: nil, problem: problem) }
        let began = now()
        if !note("launch-requested") {
            return OfficeSessionOutcome(readyPublished: false, cleanupConfirmed: true, owner: nil, problem: problem)
        }
        if stopped { return OfficeSessionOutcome(readyPublished: false, cleanupConfirmed: true, owner: nil, problem: problem) }
        if now() - began >= limits.startupMs {
            requestClose(problem: String(describing: OfficeSessionError.startupDeadline))
            return OfficeSessionOutcome(readyPublished: false, cleanupConfirmed: true, owner: nil, problem: problem)
        }
        do {
            // Await the actual OS launch even after requestClose/EOF. Dropping
            // this continuation could leave a later-created app unowned.
            let value = try await launch {
                guard !launchAdmitted else { throw OfficeSessionError.launchAlreadyAdmitted }
                guard !self.stopped else { throw OfficeSessionError.launchCancelled }
                try self.before(began + self.limits.startupMs, .startupDeadline)
                // The actual adapter consumes this once, immediately before
                // NSWorkspace, after any asynchronous preparation. Never call
                // it after the OS launch and drop a late-created application.
                launchAdmitted = true
            }
            port = value
            guard launchAdmitted else { throw OfficeSessionError.launchNotAdmitted }
            guard !value.wasAlreadyRunning else { throw OfficeSessionError.reusedApplication }
            guard !(try originalExited(value)) else { throw OfficeSessionError.changedProcess }
            if now() - began >= limits.startupMs { requestClose(problem: String(describing: OfficeSessionError.startupDeadline)) }
            if !stopped {
                while true {
                    guard !(try originalExited(value)) else { throw OfficeSessionError.changedProcess }
                    let scope = try value.inspect()
                    try before(began + limits.startupMs, .startupDeadline)
                    switch scope {
                    case .image(let number, _):
                        guard number > 0 else { throw OfficeSessionError.unexpectedDocument }
                        window = number
                    case .empty, .notReady:
                        guard now() - began < limits.startupMs else { throw OfficeSessionError.startupDeadline }
                        try await tick()
                        if stopped { break }
                        continue
                    }
                    break
                }
                if !stopped {
                    try before(began + limits.startupMs, .startupDeadline)
                    if note("ready") {
                        try before(began + limits.startupMs, .startupDeadline)
                        ready = true
                        await waitForStop()
                    }
                }
            }
        } catch { requestClose(problem: String(describing: error)) }
        if let value = port, !value.wasAlreadyRunning {
            do { try await clean(value); cleanupConfirmed = true }
            catch {
                problem = "\(problem.map { $0 + "; " } ?? "")cleanup: \(error)"
                requestClose()
            }
        }
        else if port == nil, !launchAdmitted { cleanupConfirmed = true }
        _ = note(cleanupConfirmed ? "cleanup-confirmed" : "cleanup-unconfirmed")
        return OfficeSessionOutcome(readyPublished: ready, cleanupConfirmed: cleanupConfirmed, owner: port?.owner, problem: problem)
    }
}
