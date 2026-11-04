import Foundation
import Darwin

private struct ProcessRow: Encodable {
    let pid: Int32
    let observation: NativeProcessObservation
}
private struct ProcessBatch: Encodable {
    let observations: [ProcessRow]
}
private struct ExecutableProcess: Encodable {
    let pid: Int32
    let executable: String
    let observation: NativeProcessObservation
}
@main
struct ReadProcessIdentity {
    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--executable" {
            guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[2]), pid > 0 else { exit(2) }
            let before = ProcessIdentityProbe.read(pid: pid)
            guard before.status == "alive", let identity = before.identity else { exit(2) }
            var path = [UInt8](repeating: 0, count: 4096)
            let count = proc_pidpath(pid, &path, UInt32(path.count))
            guard count > 0, count < path.count, let end = path.firstIndex(of: 0),
                  let executable = String(bytes: path[..<end], encoding: .utf8), executable.hasPrefix("/") else { exit(2) }
            let after = ProcessIdentityProbe.read(pid: pid)
            guard after.status == "alive", after.identity == identity else { exit(2) }
            FileHandle.standardOutput.write(try JSONEncoder().encode(ExecutableProcess(pid: pid, executable: executable, observation: after)))
            return
        }
        if CommandLine.arguments.dropFirst().first == "--batch" {
            let values = CommandLine.arguments.dropFirst(2)
            guard !values.isEmpty, values.count <= 4096 else { exit(2) }
            let pids = values.compactMap { Int32($0) }
            guard pids.count == values.count, pids.allSatisfy({ $0 > 0 }), Set(pids).count == pids.count else { exit(2) }
            let batch = ProcessBatch(observations: pids.map { ProcessRow(pid: $0, observation: ProcessIdentityProbe.read(pid: $0)) })
            FileHandle.standardOutput.write(try JSONEncoder().encode(batch))
            return
        }
        let observation: NativeProcessObservation
        if CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) {
            observation = ProcessIdentityProbe.read(pid: pid)
        } else {
            observation = ProcessIdentityProbe.read(pid: 0)
        }
        FileHandle.standardOutput.write(try JSONEncoder().encode(observation))
    }
}
