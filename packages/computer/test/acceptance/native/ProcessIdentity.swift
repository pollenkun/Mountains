import Darwin
import Foundation

// OS process metadata only. No EventKit, UI, signal delivery or permission
// requests. kinfo_proc exposes start time to microseconds in the active SDK.
struct NativeProcessIdentity: Codable, Sendable, Equatable {
    let schema = "macos-kinfo-starttime-v1"
    let pid: Int32
    let bootId: String
    let startSeconds: String
    let startMicroseconds: Int32

    private enum CodingKeys: String, CodingKey { case schema, pid, bootId, startSeconds, startMicroseconds }
}
struct NativeProcessObservation: Encodable, Sendable {
    let status: String
    let identity: NativeProcessIdentity?
    let reason: String?
}
enum ProcessIdentityProbe {
    private static func unknown(_ reason: String) -> NativeProcessObservation {
        NativeProcessObservation(status: "unknown", identity: nil, reason: reason)
    }
    private static func bootId() -> String? {
        // This sysctl is available on the tested host but is not a documented
        // stable SDK constant. Unsupported hosts remain unknown, never absent.
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1, size <= 128 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0,
              size > 1, size <= bytes.count, bytes[size - 1] == 0,
              let text = String(bytes: bytes.prefix(size - 1), encoding: .utf8), UUID(uuidString: text) != nil else { return nil }
        return text.lowercased()
    }
    static func read(pid: Int32) -> NativeProcessObservation {
        guard pid > 0 else { return unknown("invalid-pid") }
        guard let boot = bootId() else { return unknown("boot-session-unavailable") }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        errno = 0
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        let error = errno
        if result == 0 && size == 0 || result != 0 && error == ESRCH {
            return NativeProcessObservation(status: "absent", identity: nil, reason: nil)
        }
        guard result == 0 else { return unknown("process-query-failed") }
        guard size == MemoryLayout<kinfo_proc>.stride, info.kp_proc.p_pid == pid else { return unknown("process-query-incomplete") }
        let start = info.kp_proc.p_un.__p_starttime
        guard start.tv_sec > 0, start.tv_usec >= 0, start.tv_usec < 1_000_000, bootId() == boot else {
            return unknown("start-time-unavailable")
        }
        return NativeProcessObservation(status: "alive", identity: NativeProcessIdentity(pid: pid, bootId: boot,
                                        startSeconds: String(start.tv_sec), startMicroseconds: start.tv_usec), reason: nil)
    }
}
