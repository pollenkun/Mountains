// Read-only acceptance evidence. This program has no creation, deletion,
// permission-request or UI entry points. It is not an account safety bypass.
import CryptoKit
import EventKit
import Foundation
import Synchronization

private struct Request: Decodable { let version: Int; let key: String }

@main
private struct ReadReminders {
    static func main() async {
        // Also bounds a sender which never closes stdin and an EventKit
        // callback which never arrives. No partial success is emitted.
        let deadline = DispatchSource.makeTimerSource(queue: .global())
        deadline.schedule(deadline: .now() + .seconds(8))
        deadline.setEventHandler {
            FileHandle.standardError.write(Data("read-only reminder inventory timed out\n".utf8))
            exit(2)
        }
        deadline.resume()
        defer { deadline.cancel() }
        do {
            // The key travels on the private pipe, never argv, public output,
            // an account, the model journal or a diagnostic error message.
            // Its controller keeps a private copy for crash recovery.
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 1025 - input.count), !chunk.isEmpty {
                input.append(chunk)
                guard input.count <= 1024 else { throw ReminderEvidence.Failure(message: "request is too large") }
            }
            let request = try JSONDecoder().decode(Request.self, from: input)
            guard request.version == 1, let bytes = Data(base64Encoded: request.key), bytes.count == 32 else {
                throw ReminderEvidence.Failure(message: "invalid inventory request")
            }
            guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
                throw ReminderEvidence.Failure(message: "existing full reminder access is required; no permission was requested")
            }
            let store = EKEventStore(), key = SymmetricKey(data: bytes)
            let changed = Mutex(false)
            let observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: nil) { _ in
                changed.withLock { $0 = true }
            }
            defer { NotificationCenter.default.removeObserver(observer) }
            let sources = store.sources.map(ReminderEvidence.source).sorted { $0.id < $1.id }
            let calendars = store.calendars(for: .reminder)
            let before = try calendars.map { try ReminderEvidence.calendar($0, key: key) }.sorted { $0.id < $1.id }
            let entries: [ReminderEvidence.Record]
            if calendars.isEmpty { entries = [] } else {
                // Convert inside the callback. EKReminder never crosses an
                // actor boundary; only immutable Sendable records do.
                entries = try await withCheckedThrowingContinuation { continuation in
                    store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { reminders in
                        guard let reminders else {
                            continuation.resume(throwing: ReminderEvidence.Failure(message: "nil reminder result is not an empty inventory")); return
                        }
                        do { continuation.resume(returning: try reminders.map { try ReminderEvidence.reminder($0, key: key) }) }
                        catch { continuation.resume(throwing: ReminderEvidence.Failure(message: "reminder fields could not be fingerprinted")) }
                    }
                }
            }
            let after = try store.calendars(for: .reminder).map { try ReminderEvidence.calendar($0, key: key) }.sorted { $0.id < $1.id }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            guard !changed.withLock({ $0 }), try encoder.encode(before) == encoder.encode(after),
                  try encoder.encode(sources) == encoder.encode(store.sources.map(ReminderEvidence.source).sorted { $0.id < $1.id }),
                  EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
                throw ReminderEvidence.Failure(message: "account store changed during the read; no complete inventory is available")
            }
            let records = (before + entries).sorted { $0.id < $1.id }
            guard Set(records.map(\.id)).count == records.count else { throw ReminderEvidence.Failure(message: "duplicate persistent object ID") }
            let parents = Dictionary(uniqueKeysWithValues: before.map { ($0.id, $0.sourceId) })
            guard entries.allSatisfy({ parents[$0.parentId ?? ""] == $0.sourceId }) else {
                throw ReminderEvidence.Failure(message: "reminder parent or source changed during the read")
            }
            FileHandle.standardOutput.write(try encoder.encode(ReminderEvidence.Inventory(sources: sources, records: records)))
        } catch {
            // Never print raw EventKit errors or exception data containing
            // titles, URLs, account names, contents or the fingerprint key.
            let message = (error as? ReminderEvidence.Failure)?.message ?? "read-only reminder inventory failed"
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(1)
        }
    }
}
