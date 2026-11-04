// Account preparation only, not a model tool. No deletion, UI, account
// fallback, permission request, retry or title-based recovery is supported.
// This executable is build-checked only while acceptance remains disabled.
import CryptoKit
import Darwin
import EventKit
import Foundation
import Synchronization

private struct Request: Decodable {
    let version: Int
    let runId: String
    let nonce: String
    let sourceId: String
    let title: String
    let key: String
}
private struct Command: Decodable { let action: String; let nonce: String }
private func line() throws -> Data {
    var bytes = Data()
    while let part = try FileHandle.standardInput.read(upToCount: 1), !part.isEmpty {
        if part[0] == 10 { return bytes }
        bytes.append(part)
        guard bytes.count <= 8192 else { throw ReminderEvidence.Failure(message: "container protocol request is too large") }
    }
    throw ReminderEvidence.Failure(message: "container protocol ended before a complete command")
}
private func append(_ value: [String: Any], to fd: Int32) throws {
    var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); data.append(10)
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    try handle.write(contentsOf: data)
    try handle.synchronize()
}
private func emit(_ value: [String: Any]) throws {
    var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); data.append(10)
    try FileHandle.standardOutput.write(contentsOf: data)
}
private func object(_ record: ReminderEvidence.Record) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(record))
}

@main
private struct StageReminderContainer {
    static func main() {
        // fd 3 is opened exclusively by the controller. It is a distinct
        // single-writer outcome file, never the controller's hash-chain log.
        let outcomeFd: Int32 = 3
        var info = stat()
        guard fstat(outcomeFd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_size == 0, (info.st_mode & 0o077) == 0,
              fcntl(outcomeFd, F_GETFL) & O_APPEND != 0 else {
            FileHandle.standardError.write(Data("private append-only container outcome file is required\n".utf8)); exit(1)
        }
        let phase = Mutex("starting")
        let deadline = DispatchSource.makeTimerSource(queue: .global())
        deadline.schedule(deadline: .now() + .seconds(30))
        deadline.setEventHandler {
            phase.withLock { state in
                guard state != "committed" && state != "not-committed" else { return }
                // A timeout after commit-started cannot be represented as a
                // rollback, even if a subsequent read currently says absent.
                try? append(["version": 1, "kind": "unknown", "phase": state], to: outcomeFd)
                FileHandle.standardError.write(Data("container operation timed out; inspect its durable outcome\n".utf8)); exit(2)
            }
        }
        deadline.resume(); defer { deadline.cancel() }
        do {
            let request = try JSONDecoder().decode(Request.self, from: line())
            guard request.version == 1, UUID(uuidString: request.runId) != nil, UUID(uuidString: request.nonce) != nil,
                  !request.sourceId.isEmpty, request.sourceId.utf8.count <= 4096,
                  request.title.hasPrefix("M20-" + request.runId.prefix(8)), request.title.utf8.count <= 256,
                  let keyBytes = Data(base64Encoded: request.key), keyBytes.count == 32 else {
                throw ReminderEvidence.Failure(message: "invalid new-container request")
            }
            guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
                throw ReminderEvidence.Failure(message: "existing full reminder access is required; no permission was requested")
            }
            // This store has no other pending writes. commit() commits the
            // entire store; it must never share a store with UI/model input.
            let store = EKEventStore(), key = SymmetricKey(data: keyBytes)
            defer { store.reset() }
            guard let source = store.source(withIdentifier: request.sourceId), source.sourceType == .local else {
                throw ReminderEvidence.Failure(message: "exact local reminder source is unavailable")
            }
            let originalIds = Set(store.calendars(for: .reminder).map(\.calendarIdentifier))
            let calendar = EKCalendar(for: .reminder, eventStore: store)
            calendar.source = source; calendar.title = request.title
            try store.saveCalendar(calendar, commit: false)
            let prepared = try ReminderEvidence.calendar(calendar, key: key)
            guard !prepared.id.isEmpty, !originalIds.contains(prepared.id), prepared.sourceId == request.sourceId else {
                throw ReminderEvidence.Failure(message: "staging did not provide a new container ID; nothing was committed")
            }
            let base: [String: Any] = ["version": 1, "runId": request.runId, "nonce": request.nonce]
            var staged = base; staged["kind"] = "prepared"; staged["record"] = try object(prepared)
            try phase.withLock { state in try append(staged, to: outcomeFd); state = "prepared" }
            try emit(staged)
            let command = try JSONDecoder().decode(Command.self, from: line())
            guard command.action == "commit", command.nonce == request.nonce,
                  EKEventStore.authorizationStatus(for: .reminder) == .fullAccess,
                  store.source(withIdentifier: request.sourceId)?.sourceType == .local else {
                throw ReminderEvidence.Failure(message: "container commit was not authorized by this controller")
            }
            var started = base; started["kind"] = "commit-started"; started["record"] = try object(prepared)
            try phase.withLock { state in try append(started, to: outcomeFd); state = "commit-started" }
            // From here onward EOF/cancellation cannot be called a rollback.
            // Finish recording the actual result before writing to the pipe.
            try store.commit()
            let actualId = calendar.calendarIdentifier
            let independent = EKEventStore()
            guard let saved = independent.calendar(withIdentifier: actualId), saved.source?.sourceType == .local,
                  saved.source?.sourceIdentifier == request.sourceId, saved.title == request.title else {
                throw ReminderEvidence.Failure(message: "committed container could not be independently confirmed")
            }
            let actual = try ReminderEvidence.calendar(saved, key: key)
            var committed = base; committed["kind"] = "committed"; committed["record"] = try object(actual)
            committed["preparedId"] = prepared.id
            try phase.withLock { state in try append(committed, to: outcomeFd); state = "committed" }
            // A changed ID/field fingerprint is recorded, never silently
            // adopted as the original expected object by the controller.
            try emit(committed)
        } catch {
            phase.withLock { state in
                // A pipe error after the durable terminal receipt cannot turn
                // a known committed result back into an unknown outcome.
                if state == "committed" { return }
                let committed = state == "commit-started"
                try? append(["version": 1, "kind": committed ? "unknown" : "not-committed", "phase": state], to: outcomeFd)
                if !committed { state = "not-committed" }
            }
            FileHandle.standardError.write(Data("container preparation failed; inspect the private outcome file\n".utf8))
            exit(1)
        }
    }
}
