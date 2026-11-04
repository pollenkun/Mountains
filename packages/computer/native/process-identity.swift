import Darwin
import Foundation

// Read-only OS metadata. No AppKit, activation, input, signal delivery, user
// files, or runtime compilation. A failed query is unknown, never absent.
private struct Birth: Codable, Equatable {
    let pid: Int32
    let bootId: String
    let startSeconds: String
    let startMicroseconds: Int32
}
private enum BirthObservation { case alive(Birth), absent, unknown(String) }
private enum ProcessProbe {
    static func boot() -> String? {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1, size <= 128 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0,
              size > 1, size <= bytes.count, bytes[size - 1] == 0,
              let value = String(bytes: bytes.prefix(size - 1), encoding: .utf8), UUID(uuidString: value) != nil else { return nil }
        return value.lowercased()
    }
    static func birth(_ pid: Int32) -> BirthObservation {
        guard let boot = boot() else { return .unknown("boot-session-unavailable") }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        errno = 0
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0), error = errno
        if result == 0 && size == 0 || result != 0 && error == ESRCH { return .absent }
        guard result == 0 else { return .unknown("process-query-failed") }
        guard size == MemoryLayout<kinfo_proc>.stride, info.kp_proc.p_pid == pid else { return .unknown("process-query-incomplete") }
        let start = info.kp_proc.p_un.__p_starttime
        guard start.tv_sec > 0, (0..<1_000_000).contains(start.tv_usec), self.boot() == boot else { return .unknown("start-time-unavailable") }
        return .alive(Birth(pid: pid, bootId: boot, startSeconds: String(start.tv_sec), startMicroseconds: start.tv_usec))
    }
    static func read(_ pid: Int32) throws -> [String: Any] {
        let original: Birth
        switch birth(pid) {
        case .absent: return ["status": "absent"]
        case .unknown(let reason): return ["status": "unknown", "reason": reason]
        case .alive(let value): original = value
        }
        var bytes = [UInt8](repeating: 0, count: 4096)
        let count = proc_pidpath(pid, &bytes, UInt32(bytes.count))
        guard count > 0, count < bytes.count, let end = bytes.firstIndex(of: 0), end == count,
              let executable = String(bytes: bytes[..<end], encoding: .utf8), executable.hasPrefix("/"),
              executable.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            return ["status": "unknown", "reason": "executable-unavailable"]
        }
        guard case .alive(let actual) = birth(pid), actual == original else {
            return ["status": "unknown", "reason": "process-changed-during-read"]
        }
        let identity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(original))
        return ["status": "alive", "birth": identity, "executable": executable]
    }
}
private struct Request: Decodable { let id: Int64; let pid: Int32; let deadline: Double }
private struct Envelope: Decodable { let id: Int64 }
private enum Failure: Error { case protocolError }

@main
private struct Main {
    static func output(_ value: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); data.append(10)
        try FileHandle.standardOutput.write(contentsOf: data)
    }
    static func main() {
        do {
            guard CommandLine.arguments.count == 1 else { throw Failure.protocolError }
            var pending = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                guard count >= 0 else { throw Failure.protocolError }
                if count == 0 { guard pending.isEmpty else { throw Failure.protocolError }; return }
                pending.append(contentsOf: buffer.prefix(count))
                while let newline = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<newline]); pending.removeSubrange(...newline)
                    guard line.count <= 4096 else { throw Failure.protocolError }
                    let id = (try? JSONDecoder().decode(Envelope.self, from: line).id) ?? -1
                    let response: [String: Any]
                    do {
                        let request = try JSONDecoder().decode(Request.self, from: line)
                        guard request.id > 0, request.id <= 9_007_199_254_740_991, request.pid > 0,
                              request.deadline.isFinite, request.deadline > Date().timeIntervalSince1970 * 1000,
                              let fields = try JSONSerialization.jsonObject(with: line) as? [String: Any], Set(fields.keys) == ["id", "pid", "deadline"] else {
                            throw Failure.protocolError
                        }
                        let observation = try ProcessProbe.read(request.pid)
                        guard request.deadline > Date().timeIntervalSince1970 * 1000 else { throw Failure.protocolError }
                        response = ["id": request.id, "ok": true, "observation": observation]
                    } catch { response = ["id": id, "ok": false, "error": "invalid process identity request"] }
                    try output(response)
                }
                guard pending.count <= 4096 else { throw Failure.protocolError }
            }
        } catch {
            FileHandle.standardError.write(Data("process identity protocol failed\n".utf8)); exit(1)
        }
    }
}
