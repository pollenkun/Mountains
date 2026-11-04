// Independent live probe. Compile only on the host; run only in the disposable VM.
// MOUNTAINS_LAUNCH_PROBE=1 ./launch-activation-probe MODE WITNESS_PID WITNESS_STATE REPORT APP [APP_ARGS...]
// MODE: none, plain, from, slps, slps-key; append -hidden to test NSWorkspace's hidden launch.
// The witness must already be frontmost. The probe never activates itself, requests permissions,
// or touches any app except the supplied witness and the new application instance it launches.
import AppKit
import CoreGraphics
import Foundation

private typealias ProcessForPID = @convention(c) (Int32, UnsafeMutableRawPointer) -> Int32
private typealias SetFrontProcess = @convention(c) (UnsafeMutableRawPointer, UInt32, UInt32) -> Int32
private typealias PostRecord = @convention(c) (UnsafeMutableRawPointer, UnsafeRawPointer) -> Int32

private struct ActivationAPI {
    let processForPID: ProcessForPID?
    let setFront: SetFrontProcess?
    let postRecord: PostRecord?

    init() {
        let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
        let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        func load<T>(_ handle: UnsafeMutableRawPointer?, _ name: String) -> T? {
            guard let handle, let address = dlsym(handle, name) else { return nil }
            return unsafeBitCast(address, to: T.self)
        }
        processForPID = load(services, "GetProcessForPID")
        setFront = load(sky, "_SLPSSetFrontProcessWithOptions")
        postRecord = load(sky, "SLPSPostEventRecordTo")
    }

    func restore(pid: pid_t, window: CGWindowID, makeKey: Bool) -> [String: Any] {
        guard let processForPID, let setFront, window != 0 else { return ["available": false] }
        var serial = [UInt32](repeating: 0, count: 2)
        return serial.withUnsafeMutableBytes { serialBytes in
            guard let serialAddress = serialBytes.baseAddress else { return ["available": false] }
            let found = processForPID(pid, serialAddress)
            guard found == 0 else { return ["processStatus": found] }
            let status = setFront(serialAddress, window, 0x200)
            var result: [String: Any] = ["processStatus": found, "frontStatus": status]
            if makeKey, status == 0, let postRecord {
                // WindowServer make-key record layout used by yabai and Amethyst.
                var record = [UInt8](repeating: 0, count: 0xf8)
                record[4] = 0xf8
                record[0x3a] = 0x10
                for index in 0..<4 { record[0x3c + index] = UInt8(truncatingIfNeeded: window >> (index * 8)) }
                for index in 0x20..<0x30 { record[index] = 0xff }
                var statuses: [Int32] = []
                for kind: UInt8 in [1, 2] {
                    record[8] = kind
                    statuses.append(record.withUnsafeBytes { bytes in
                        guard let address = bytes.baseAddress else { return -1 }
                        return postRecord(serialAddress, address)
                    })
                }
                result["makeKeyStatuses"] = statuses
            }
            return result
        }
    }
}

private final class LaunchOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Result<pid_t, Error>?
    func finish(_ value: Result<pid_t, Error>) { lock.lock(); stored = value; lock.unlock() }
    func read() -> Result<pid_t, Error>? { lock.lock(); defer { lock.unlock() }; return stored }
}

private func timestamp() -> Double { Date().timeIntervalSince1970 * 1000 }
private func witnessState(_ path: String) -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: path),
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return value
}
private func inputCounters() -> [UInt32] {
    [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .flagsChanged, .scrollWheel].map {
        CGEventSource.counterForEventType(.hidSystemState, eventType: $0)
    }
}
private func windowForPID(_ pid: pid_t) -> CGWindowID {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.first { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
        .flatMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value } ?? 0
}

@main
private struct Probe {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard ProcessInfo.processInfo.environment["MOUNTAINS_LAUNCH_PROBE"] == "1", args.count >= 5,
              let witnessPID = Int32(args[1]), let previous = NSRunningApplication(processIdentifier: witnessPID) else {
            fputs("Set MOUNTAINS_LAUNCH_PROBE=1; arguments: MODE WITNESS_PID WITNESS_STATE REPORT APP [APP_ARGS...]\n", stderr)
            exit(2)
        }
        let hidden = args[0].hasSuffix("-hidden")
        let mode = hidden ? String(args[0].dropLast(7)) : args[0]
        guard ["none", "plain", "from", "slps", "slps-key"].contains(mode),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == witnessPID,
              witnessState(args[2])["active"] as? Bool == true else {
            fputs("Unknown mode, or the supplied witness is not already frontmost and active. No application was launched.\n", stderr)
            exit(2)
        }
        let reportPath = args[3], appPath = args[4], statePath = args[2]
        let initialState = witnessState(statePath), initialInput = inputCounters(), window = windowForPID(witnessPID)
        let api = ActivationAPI(), began = timestamp()
        var events: [[String: Any]] = [], launchedPID: pid_t = 0, lastFront: pid_t = witnessPID
        var lastRequest = 0.0, gaveBack = 0, pendingRestore = false, relinquished = false
        var seenOtherPIDs = Set<pid_t>(), error: String?
        var requests = 0
        let outcome = LaunchOutcome()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = hidden
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        configuration.createsNewApplicationInstance = true
        configuration.arguments = Array(args.dropFirst(5))
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: appPath), configuration: configuration) { app, failure in
            if let app { outcome.finish(.success(app.processIdentifier)) }
            else { outcome.finish(.failure(failure ?? NSError(domain: "probe", code: 1))) }
        }
        var watchEnd = began + 20_000
        while timestamp() < watchEnd, !previous.isTerminated {
            let at = timestamp(), front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
            if launchedPID == 0, let result = outcome.read() {
                switch result {
                case .success(let pid):
                    launchedPID = pid
                    watchEnd = at + 5_000
                    events.append(["at": at, "event": "launch-returned", "pid": pid])
                    if seenOtherPIDs.contains(where: { $0 != pid }) { relinquished = true }
                case .failure(let failure): error = String(describing: failure)
                }
                if error != nil { break }
            }
            if inputCounters() != initialInput, !relinquished {
                relinquished = true
                events.append(["at": at, "event": "physical-input-observed-stop-restoring"])
            }
            if front != lastFront {
                events.append(["at": at, "event": "front-changed", "from": lastFront, "to": front, "witness": witnessState(statePath)])
                lastFront = front
            }
            if front != witnessPID, front != 0 { seenOtherPIDs.insert(front) }
            if launchedPID != 0, front != witnessPID, front != launchedPID, !relinquished {
                relinquished = true
                events.append(["at": at, "event": "another-front-app-stop-restoring", "pid": front])
            }
            if pendingRestore, front == witnessPID, witnessState(statePath)["active"] as? Bool == true {
                gaveBack += 1
                pendingRestore = false
                events.append(["at": at, "event": "return-observed", "gaveBack": gaveBack])
            }
            if launchedPID != 0, front == launchedPID, !relinquished, mode != "none", at - lastRequest >= 250 {
                // Recheck directly before every request; a different app/user input cancels the probe's restoration.
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == launchedPID,
                      inputCounters() == initialInput else { relinquished = true; continue }
                lastRequest = at; requests += 1; pendingRestore = true
                var value: [String: Any] = ["at": at, "event": "restore-request", "mode": mode]
                switch mode {
                case "plain": value["accepted"] = previous.activate(options: [])
                case "from":
                    if #available(macOS 14.0, *), let launched = NSRunningApplication(processIdentifier: launchedPID) {
                        value["accepted"] = previous.activate(from: launched, options: [])
                    } else { value["available"] = false }
                case "slps", "slps-key": value["privateReply"] = api.restore(pid: witnessPID, window: window, makeKey: mode == "slps-key")
                default: break
                }
                value["frontImmediatelyAfter"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
                events.append(value)
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        let endState = witnessState(statePath)
        let report: [String: Any] = [
            "mode": mode, "hiddenLaunch": hidden, "started": began, "ended": timestamp(),
            "launcherPID": getpid(), "parentPID": getppid(), "witnessPID": witnessPID, "witnessWindow": window,
            "launchedPID": launchedPID, "gaveBack": gaveBack, "restoreRequests": requests,
            "stoppedForUserOrOtherApp": relinquished, "frontAtEnd": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
            "witnessBefore": initialState, "witnessAfter": endState, "events": events,
            "error": error as Any? ?? NSNull(),
            "resignActiveDelta": (endState["resignActive"] as? Int ?? 0) - (initialState["resignActive"] as? Int ?? 0),
            "note": "gaveBack requires both frontmost PID and the witness's own active state; any recorded deactivation remains a launch focus interruption. The launched app is left running for the caller to inspect and clean up."
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: reportPath), options: .atomic)
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        } catch { fputs("Could not write probe report: \(error)\n", stderr); exit(1) }
    }
}
