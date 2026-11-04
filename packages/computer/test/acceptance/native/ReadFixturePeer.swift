import Darwin
import Foundation

private struct Peer: Encodable {
    let pid: Int32
    let executable: String
    let observation: NativeProcessObservation
}

// Reads only OS metadata for the connected stream inherited at fd 3. It never
// reads stream contents, sends input, signals another process or visits accounts.
@main
struct ReadFixturePeer {
    static func main() throws {
        var pid: pid_t = 0
        var size = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0,
              size == MemoryLayout<pid_t>.size, pid > 0 else { exit(2) }
        let before = ProcessIdentityProbe.read(pid: pid)
        guard before.status == "alive", let identity = before.identity else { exit(2) }
        var path = [UInt8](repeating: 0, count: 4096)
        let count = proc_pidpath(pid, &path, UInt32(path.count))
        guard count > 0, count < path.count, let end = path.firstIndex(of: 0),
              let executable = String(bytes: path[..<end], encoding: .utf8), executable.hasPrefix("/") else { exit(2) }
        let after = ProcessIdentityProbe.read(pid: pid)
        guard after.status == "alive", after.identity == identity else { exit(2) }
        FileHandle.standardOutput.write(try JSONEncoder().encode(Peer(pid: pid, executable: executable, observation: after)))
    }
}
