import Darwin
import Foundation

// File/process-only component. NOT connected to production input senders yet.
// Durability below covers process crashes, not power loss or a kernel crash.
// No GUI frameworks, input APIs, signals, runtime compiler, or user data access.
struct ClaimFailure: Error, CustomStringConvertible {
    let description: String
    let code: String?
    init(_ message: String, code: String? = nil) { description = message; self.code = code }
}
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ClaimFailure(message) }
}
struct ProcessBirth: Codable, Equatable {
    let schema: String
    let pid: Int32
    let bootId: String
    let startSeconds: String
    let startMicroseconds: Int32
    var valid: Bool {
        schema == "macos-kinfo-starttime-v1" && pid > 0 && UUID(uuidString: bootId) != nil &&
        Int64(startSeconds).map { $0 > 0 && String($0) == startSeconds } == true &&
        (0..<1_000_000).contains(startMicroseconds)
    }
}
enum BirthObservation { case alive(ProcessBirth), absent, unknown }
enum BirthProbe {
    static func boot() -> String? {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1, size <= 128 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0,
              size > 1, size <= bytes.count, bytes[size - 1] == 0,
              let value = String(bytes: bytes.prefix(size - 1), encoding: .utf8), UUID(uuidString: value) != nil else { return nil }
        return value.lowercased()
    }
    static func read(_ pid: Int32) -> BirthObservation {
        guard pid > 0, let boot = boot() else { return .unknown }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        errno = 0
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0), error = errno
        if result == 0 && size == 0 || result != 0 && error == ESRCH { return .absent }
        guard result == 0, size == MemoryLayout<kinfo_proc>.stride, info.kp_proc.p_pid == pid else { return .unknown }
        let start = info.kp_proc.p_un.__p_starttime
        guard start.tv_sec > 0, (0..<1_000_000).contains(start.tv_usec), self.boot() == boot else { return .unknown }
        return .alive(ProcessBirth(schema: "macos-kinfo-starttime-v1", pid: pid, bootId: boot,
                                   startSeconds: String(start.tv_sec), startMicroseconds: start.tv_usec))
    }
    static func ended(_ birth: ProcessBirth) throws -> Bool {
        switch read(birth.pid) {
        case .absent: return true
        case .alive(let actual): return actual != birth
        case .unknown: throw ClaimFailure("process identity is unknown; claim retained")
        }
    }
}
struct FileIdentity: Codable, Equatable {
    let device: String
    let inode: String
    init(_ value: stat) { device = String(value.st_dev); inode = String(value.st_ino) }
}
struct StorageBinding: Codable, Equatable {
    let format: Int
    let componentOnly: Bool
    let storageId: String
    let directory: FileIdentity
    let guardFile: FileIdentity
}
enum LeasePhase: String, Codable { case open, sealed }
enum CommandPhase: String, Codable { case registered, permitted, executing, notStarted, clean, unknown }
// JSON numbers cannot carry UInt64 exactly through JavaScript. Both revisions
// and lease epochs use canonical decimal strings across every process boundary.
func sequence(_ text: String?) -> UInt64? {
    guard let text, let value = UInt64(text), String(value) == text else { return nil }
    return value
}
struct WindowBounds: Codable, Equatable {
    let x: Double, y: Double, width: Double, height: Double
    var valid: Bool { [x, y, width, height].allSatisfy(\.isFinite) && width > 0 && height > 0 }
}
struct ProcessAddress: Codable, Equatable {
    let process: ProcessBirth
    let window: UInt32?
    let bounds: WindowBounds?
    var valid: Bool {
        process.valid && (window.map { $0 > 0 && bounds?.valid == true } ?? (bounds == nil))
    }
}
struct InputAddress: Codable, Equatable {
    let schema: String
    let kind: String
    let operation: String
    let owner: ProcessAddress?
    let target: ProcessAddress?
    let clipboard: String?
    let application: String?
    var valid: Bool {
        guard schema == "mac-input-address-v1", (1...64).contains(operation.utf8.count),
              operation.utf8.allSatisfy({ (97...122).contains($0) || $0 == 95 }) else { return false }
        switch kind {
        case "process": return owner?.valid == true && target?.valid == true && clipboard == nil && application == nil
        case "clipboard": return clipboard == "general" && owner == nil && target == nil && application == nil
        case "application": return application.map { !$0.isEmpty && $0.utf8.count <= 4096 && !$0.contains("\0") } == true && owner == nil && target == nil && clipboard == nil
        default: return false
        }
    }
    func verifyLiveProcesses() throws {
        for address in [owner, target].compactMap({ $0 }) {
            guard case .alive(let actual) = BirthProbe.read(address.process.pid), actual == address.process else {
                throw ClaimFailure("input address process has ended, changed, or cannot be verified")
            }
        }
    }
}
struct RestoreObligation: Codable, Equatable {
    let id: String
    let kind: String
    let address: InputAddress
    let focusBaseline: FocusBaseline?
    var valid: Bool {
        guard UUID(uuidString: id) != nil && address.valid else { return false }
        if kind == "clipboard" { return address.kind == "clipboard" && focusBaseline == nil }
        // Each focus obligation has exactly one original destination. A host
        // ending cannot excuse an independently live keyboard destination.
        return kind == "focus" && address.kind == "process" && focusBaseline?.valid == true &&
            address.owner == address.target && address.target?.window == nil && address.target?.bounds == nil
    }
}
enum FocusResource: String, Codable { case frontmostApplication = "frontmost_application", keyboardFocus = "keyboard_focus" }
struct FocusJSONKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
func focusKeys(_ decoder: any Decoder, allowed: Set<String>, required: Set<String>) throws {
    let keys = Set(try decoder.container(keyedBy: FocusJSONKey.self).allKeys.map(\.stringValue))
    try require(keys.isSubset(of: allowed) && required.isSubset(of: keys), "invalid focus observation fields")
}
struct FocusBaseline: Codable, Equatable {
    let schema: String
    let scopeId: String
    let resource: FocusResource
    // A random sender-private reference, never a label or content fingerprint.
    let reference: String
    let uiSender: ProcessBirth?
    let keyboardAtCapture: String
    enum CodingKeys: String, CodingKey { case schema, scopeId, resource, reference, uiSender, keyboardAtCapture }
    init(from decoder: any Decoder) throws {
        try focusKeys(decoder, allowed: ["schema", "scopeId", "resource", "reference", "uiSender", "keyboardAtCapture"], required: ["schema", "scopeId", "resource", "reference", "keyboardAtCapture"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = try c.decode(String.self, forKey: .schema); scopeId = try c.decode(String.self, forKey: .scopeId)
        resource = try c.decode(FocusResource.self, forKey: .resource); reference = try c.decode(String.self, forKey: .reference)
        uiSender = try c.decodeIfPresent(ProcessBirth.self, forKey: .uiSender)
        keyboardAtCapture = try c.decode(String.self, forKey: .keyboardAtCapture)
    }
    var valid: Bool {
        schema == "input-claim-focus-baseline-v1" && UUID(uuidString: scopeId) != nil &&
            UUID(uuidString: reference) != nil && ["present", "absent"].contains(keyboardAtCapture) && (uiSender?.valid ?? true)
    }
}
struct FocusDestination: Codable, Equatable {
    let process: ProcessBirth
    let reference: String
    enum CodingKeys: String, CodingKey { case process, reference }
    init(from decoder: any Decoder) throws {
        try focusKeys(decoder, allowed: ["process", "reference"], required: ["process", "reference"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        process = try c.decode(ProcessBirth.self, forKey: .process); reference = try c.decode(String.self, forKey: .reference)
    }
    var valid: Bool { process.valid && UUID(uuidString: reference) != nil }
}
struct FocusKeyboardObservation: Codable, Equatable {
    let status: String
    let destination: FocusDestination?
    enum CodingKeys: String, CodingKey { case status, destination }
    init(from decoder: any Decoder) throws {
        let fields: Set<String> = ["status", "destination"]
        try focusKeys(decoder, allowed: fields, required: fields)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(String.self, forKey: .status)
        destination = try c.decodeIfPresent(FocusDestination.self, forKey: .destination)
    }
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(status, forKey: .status); try c.encode(destination, forKey: .destination)
    }
    var valid: Bool {
        status == "present" ? destination?.valid == true : ["absent", "unreadable"].contains(status) && destination == nil
    }
}
struct FocusObservation: Codable, Equatable {
    let schema: String
    let id: String
    let scopeId: String
    let front: FocusDestination
    // Missing focus and an unreadable focus are distinct observations.
    // Neither can settle a still-live original keyboard destination.
    let keyboard: FocusKeyboardObservation
    enum CodingKeys: String, CodingKey { case schema, id, scopeId, front, keyboard }
    init(from decoder: any Decoder) throws {
        let fields: Set<String> = ["schema", "id", "scopeId", "front", "keyboard"]
        try focusKeys(decoder, allowed: fields, required: fields)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = try c.decode(String.self, forKey: .schema); id = try c.decode(String.self, forKey: .id)
        scopeId = try c.decode(String.self, forKey: .scopeId); front = try c.decode(FocusDestination.self, forKey: .front)
        keyboard = try c.decode(FocusKeyboardObservation.self, forKey: .keyboard)
    }
    var valid: Bool {
        schema == "input-claim-focus-observation-v1" && UUID(uuidString: id) != nil &&
            UUID(uuidString: scopeId) != nil && front.valid && keyboard.valid
    }
    func destination(_ resource: FocusResource) -> FocusDestination? {
        switch resource { case .frontmostApplication: front; case .keyboardFocus: keyboard.destination }
    }
}
enum FocusResolutionReason: String, Codable {
    case alreadyAtOriginal = "already_at_original"
    case preserveCurrent = "preserve_current_destination"
    case destinationEnded = "destination_ended"
}
struct FocusResolution: Codable, Equatable {
    let restorationId: String
    let address: InputAddress
    let action: String
    let reason: FocusResolutionReason
    enum CodingKeys: String, CodingKey { case restorationId, address, action, reason }
    init(from decoder: any Decoder) throws {
        let fields: Set<String> = ["restorationId", "address", "action", "reason"]
        try focusKeys(decoder, allowed: fields, required: fields)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        restorationId = try c.decode(String.self, forKey: .restorationId); address = try c.decode(InputAddress.self, forKey: .address)
        action = try c.decode(String.self, forKey: .action); reason = try c.decode(FocusResolutionReason.self, forKey: .reason)
    }
}
struct FocusFinalization: Codable, Equatable {
    let observation: FocusObservation
    let resolutions: [FocusResolution]
    enum CodingKeys: String, CodingKey { case observation, resolutions }
    init(from decoder: any Decoder) throws {
        let fields: Set<String> = ["observation", "resolutions"]
        try focusKeys(decoder, allowed: fields, required: fields)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        observation = try c.decode(FocusObservation.self, forKey: .observation)
        resolutions = try c.decode([FocusResolution].self, forKey: .resolutions)
    }
}
enum RestorationPhase: String, Codable { case pending, restoring, restored, resolved, unknown }
struct RestorationReceipt: Codable, Equatable {
    let schema: String
    let complete: Bool
    let failed: Bool
    var clean: Bool { schema == "input-claim-restoration-v1" && complete && !failed }
}
struct RestoreRecord: Codable, Equatable {
    let senderId: String
    let commandId: String
    let obligation: RestoreObligation
    var phase: RestorationPhase
    var receipt: RestorationReceipt?
    var settled: Bool {
        obligation.kind == "focus" ? phase == .resolved : phase == .restored && receipt?.clean == true
    }
}
struct CleanupReceipt: Codable, Equatable {
    let schema: String
    let pendingKeys: Int
    let pendingButtons: Int
    let failed: Bool
    let complete: Bool
    var clean: Bool {
        schema == "input-claim-cleanup-v2" && pendingKeys == 0 && pendingButtons == 0 && !failed && complete
    }
}
enum SenderKind: String, Codable { case fileOnly = "file_only", nodeAX = "node_ax", uiInput = "ui_input" }
struct Sender: Codable, Equatable {
    let id: String
    let birth: ProcessBirth
    let kind: SenderKind
    var retired: Bool
}
struct ClaimCommand: Codable, Equatable {
    let id: String
    let token: String
    let senderId: String
    // A random route binding, NOT a digest of potentially sensitive input text.
    let route: String
    let address: InputAddress
    var openedObligations: [RestoreObligation]
    var phase: CommandPhase
    var receipt: CleanupReceipt?
}
struct Lease: Codable, Equatable {
    let id: String
    let epoch: String
    let owner: ProcessBirth
    var phase: LeasePhase
    var tainted: Bool
    var senders: [Sender]
    var commands: [ClaimCommand]
    var restorations: [RestoreRecord]
    var focusFinalization: FocusFinalization?
    var focusRecords: [RestoreRecord] { restorations.filter { $0.obligation.kind == "focus" } }
    var uiSender: Sender? { senders.first { $0.kind == .uiInput } }
    var commandsFinished: Bool { commands.allSatisfy { [.clean, .notStarted].contains($0.phase) } }
    func validateFocusGroup() throws {
        let records = focusRecords
        try require(senders.filter { $0.kind == .uiInput }.count <= 1, "multiple UI senders cannot share one focus baseline")
        guard let first = records.first, let baseline = first.obligation.focusBaseline else {
            try require(focusFinalization == nil && !(uiSender != nil && commands.contains { [.executing, .clean].contains($0.phase) }), "UI input requires an original focus group before any input")
            return
        }
        let resources = records.compactMap { $0.obligation.focusBaseline?.resource }
        try require(resources.contains(.frontmostApplication) && Set(resources).count == resources.count &&
                    records.count == (baseline.keyboardAtCapture == "present" ? 2 : 1) &&
                    (baseline.keyboardAtCapture != "present" || resources.contains(.keyboardFocus)), "focus group is incomplete or duplicated")
        try require(Set(records.compactMap { $0.obligation.focusBaseline?.reference }).count == records.count, "focus references must identify separate original resources")
        for record in records {
            guard let value = record.obligation.focusBaseline else { throw ClaimFailure("missing original focus baseline") }
            try require(value.scopeId == baseline.scopeId && value.keyboardAtCapture == baseline.keyboardAtCapture && value.uiSender == baseline.uiSender &&
                        record.senderId == first.senderId && record.commandId == first.commandId, "focus baseline group or original sender changed")
        }
        let sender = senders.first { $0.id == first.senderId }
        try require(sender != nil && (uiSender.map { $0.id == first.senderId && baseline.uiSender == $0.birth } ?? (baseline.uiSender == nil)), "focus group does not belong to its one UI sender")
        if let finalization = focusFinalization {
            try require(phase == .sealed, "final focus observation has an open lease")
            if tainted {
                try require(records.allSatisfy { $0.phase == .unknown }, "later uncertainty must invalidate the complete focus group")
            } else {
                try require(commandsFinished && restorations.filter { $0.obligation.kind != "focus" }.allSatisfy(\.settled) &&
                            records.allSatisfy { $0.phase == .resolved }, "focus was finalized before all writes ended")
            }
            try validateFocusProof(finalization, verifyProcesses: false)
        } else {
            try require(!records.contains { $0.phase == .resolved }, "resolved focus has no atomic final observation")
        }
    }
    func requireUnrelatedFocus(_ actual: ProcessBirth) throws {
        // A restoration address or a file/AX sender alone does not make a
        // destination an agent input target. Include actual host AND remote.
        try require(uiSender?.birth != actual, "UI sender cannot be preserved as user focus")
        for command in commands where [.clean, .executing, .unknown].contains(command.phase) {
            try require(command.address.kind != "application", "business destination is incomplete; cannot prove unrelated focus")
            try require(command.address.owner?.process != actual && command.address.target?.process != actual, "business host or remote target cannot be preserved as user focus")
        }
    }
    func validateFocusProof(_ finalization: FocusFinalization, verifyProcesses: Bool) throws {
        let observation = finalization.observation, records = focusRecords
        try require(observation.valid && !records.isEmpty && finalization.resolutions.count == records.count &&
                    Set(finalization.resolutions.map(\.restorationId)).count == records.count, "final focus observation or complete group is invalid")
        try require(observation.keyboard.status != "unreadable", "current keyboard focus is unreadable; cleanup remains unknown")
        // Known absence at capture is not permission to ignore a new keyboard
        // destination. It has no original reference, so it cannot use the
        // already-at-original exception.
        if !records.contains(where: { $0.obligation.focusBaseline?.resource == .keyboardFocus }),
           let current = observation.keyboard.destination { try requireUnrelatedFocus(current.process) }
        if verifyProcesses {
            for destination in [observation.front, observation.keyboard.destination].compactMap({ $0 }) {
                guard case .alive(let actual) = BirthProbe.read(destination.process.pid), actual == destination.process else {
                    throw ClaimFailure("current focus process cannot be verified")
                }
            }
        }
        for record in records {
            guard let baseline = record.obligation.focusBaseline, let original = record.obligation.address.target?.process,
                  let resolution = finalization.resolutions.first(where: { $0.restorationId == record.obligation.id }) else { throw ClaimFailure("incomplete focus resolution group") }
            try require(observation.scopeId == baseline.scopeId && resolution.address == record.obligation.address && resolution.action == "no_write", "original focus binding changed")
            let current = observation.destination(baseline.resource)
            let unchanged = current?.process == original && current?.reference == baseline.reference
            switch resolution.reason {
            case .alreadyAtOriginal:
                try require(unchanged, "current focus is not the original destination")
            case .preserveCurrent:
                try require(!unchanged && current != nil, "preserve requires a readable, different current destination")
                try requireUnrelatedFocus(current!.process)
            case .destinationEnded:
                if verifyProcesses { try require(try BirthProbe.ended(original), "original focus destination is still alive") }
                if let current { try requireUnrelatedFocus(current.process) }
            }
        }
    }
}
struct ClaimState: Codable, Equatable {
    let binding: StorageBinding
    var revision: UInt64
    var lease: Lease?
    enum CodingKeys: String, CodingKey { case binding, revision, lease }
    init(binding: StorageBinding, revision: UInt64, lease: Lease?) { self.binding = binding; self.revision = revision; self.lease = lease }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        binding = try c.decode(StorageBinding.self, forKey: .binding)
        guard let parsed = sequence(try c.decode(String.self, forKey: .revision)) else { throw ClaimFailure("invalid decimal revision") }
        revision = parsed; lease = try c.decodeIfPresent(Lease.self, forKey: .lease)
    }
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(binding, forKey: .binding); try c.encode(String(revision), forKey: .revision); try c.encodeIfPresent(lease, forKey: .lease)
    }
    func validate() throws {
        try require(binding.format == 3 && binding.componentOnly && UUID(uuidString: binding.storageId) != nil, "invalid storage binding; v1/v2 stores must not be reset or silently migrated")
        guard let lease else { return }
        try require(UUID(uuidString: lease.id) != nil && lease.owner.valid && lease.senders.count <= 64 && lease.commands.count <= 4096 &&
                    sequence(lease.epoch).map { $0 > 0 && $0 <= revision } == true, "invalid lease or epoch")
        try require(Set(lease.senders.map(\.id)).count == lease.senders.count && Set(lease.commands.map(\.id)).count == lease.commands.count &&
                    Set(lease.commands.map(\.token)).count == lease.commands.count, "duplicate claim record")
        for sender in lease.senders { try require(UUID(uuidString: sender.id) != nil && sender.birth.valid, "invalid sender") }
        for command in lease.commands {
            try require(UUID(uuidString: command.id) != nil && UUID(uuidString: command.token) != nil && UUID(uuidString: command.route) != nil &&
                        command.address.valid && lease.senders.contains { $0.id == command.senderId }, "invalid command binding")
            try require(command.openedObligations.count <= 512 && command.openedObligations.allSatisfy(\.valid), "invalid opened restorations")
            try require(![.registered, .permitted, .notStarted].contains(command.phase) || command.openedObligations.isEmpty, "unstarted command has restoration capabilities")
            try require(command.phase != .clean || command.receipt?.clean == true, "clean command has no receipt")
            try require(command.phase != .unknown || lease.tainted, "unknown command is not retained")
            try require(![.registered, .permitted, .executing].contains(command.phase) || command.receipt == nil, "live command has a terminal receipt")
            try require(command.phase != .notStarted || command.receipt == nil || command.receipt?.clean == true, "invalid not-started receipt")
            try require(lease.phase != .sealed || ![.registered, .permitted].contains(command.phase), "sealed lease has an unretired permit")
        }
        let opened = lease.commands.flatMap(\.openedObligations).map(\.id)
        try require(Set(opened).count == opened.count && opened.count == lease.restorations.count && lease.restorations.count <= 512 &&
                    Set(lease.restorations.map { $0.obligation.id }).count == lease.restorations.count, "duplicate or excessive restorations")
        for pending in lease.restorations {
            try require(pending.obligation.valid && lease.senders.contains { $0.id == pending.senderId && (!$0.retired || pending.settled || lease.tainted && lease.focusFinalization != nil && pending.obligation.kind == "focus" && pending.phase == .unknown) } &&
                        lease.commands.contains { $0.id == pending.commandId && $0.senderId == pending.senderId && $0.openedObligations.contains(pending.obligation) }, "restoration is not bound to its original sender and command")
            try require(pending.phase != .resolved || pending.obligation.kind == "focus", "only focus has an atomic no-write resolution")
            try require(pending.phase != .restored || pending.receipt?.clean == true, "restoration has no completion receipt")
            try require(pending.phase != .unknown || lease.tainted, "unknown restoration is not retained")
            try require(![.pending, .restoring].contains(pending.phase) || pending.receipt == nil, "live restoration has a terminal receipt")
        }
        try lease.validateFocusGroup()
        try require(!lease.tainted || lease.phase == .sealed, "tainted lease is open")
    }
}

// Parse the receipt separately: an authenticated malformed receipt MUST persist
// UNKNOWN, rather than throw during decoding and allow a later clean to erase it.
struct ClaimRequest: Decodable {
    let id: Int
    let op: String
    let binding: StorageBinding?
    let revision: UInt64?
    let leaseId: String?
    let epoch: String?
    let senderId: String?
    let senderPid: Int32?
    let senderKind: SenderKind?
    let processPid: Int32?
    let commandId: String?
    let token: String?
    let route: String?
    let address: InputAddress?
    let openObligations: [RestoreObligation]?
    let restorationId: String?
    let restorationReceipt: RestorationReceipt?
    let receipt: CleanupReceipt?
    let focusFinalization: FocusFinalization?
    enum CodingKeys: String, CodingKey { case id, op, binding, revision, leaseId, epoch, senderId, senderPid, senderKind, processPid, commandId, token, route, address, openObligations, restorationId, restorationReceipt, receipt, focusFinalization }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id); op = try c.decode(String.self, forKey: .op)
        binding = try c.decodeIfPresent(StorageBinding.self, forKey: .binding)
        if let text = try c.decodeIfPresent(String.self, forKey: .revision) {
            guard let parsed = sequence(text) else { throw ClaimFailure("invalid decimal revision") }; revision = parsed
        } else { revision = nil }
        leaseId = try c.decodeIfPresent(String.self, forKey: .leaseId)
        epoch = try c.decodeIfPresent(String.self, forKey: .epoch)
        senderId = try c.decodeIfPresent(String.self, forKey: .senderId)
        senderPid = try c.decodeIfPresent(Int32.self, forKey: .senderPid)
        senderKind = try c.decodeIfPresent(SenderKind.self, forKey: .senderKind)
        processPid = try c.decodeIfPresent(Int32.self, forKey: .processPid)
        commandId = try c.decodeIfPresent(String.self, forKey: .commandId)
        token = try c.decodeIfPresent(String.self, forKey: .token)
        route = try c.decodeIfPresent(String.self, forKey: .route)
        address = try? c.decode(InputAddress.self, forKey: .address)
        openObligations = try? c.decode([RestoreObligation].self, forKey: .openObligations)
        restorationId = try c.decodeIfPresent(String.self, forKey: .restorationId)
        restorationReceipt = try? c.decode(RestorationReceipt.self, forKey: .restorationReceipt)
        receipt = try? c.decode(CleanupReceipt.self, forKey: .receipt)
        focusFinalization = try? c.decode(FocusFinalization.self, forKey: .focusFinalization)
    }
}

// Sole reference type owns OS descriptors. No await or IPC under flock.
final class ClaimStore {
    let path: String
    let directoryFD: Int32
    let directoryIdentity: FileIdentity
    let caller: ProcessBirth
    let guardName = "input-claim.guard", stateName = "input-claim.state"
    init(path: String) throws {
        self.path = path
        let fd = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        try require(fd >= 0, "cannot open private component directory")
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else {
            Darwin.close(fd); throw ClaimFailure("component directory must be private and owned by this user")
        }
        guard case .alive(let identity) = BirthProbe.read(getppid()) else {
            Darwin.close(fd); throw ClaimFailure("cannot identify actual calling parent")
        }
        directoryFD = fd; directoryIdentity = FileIdentity(info); caller = identity
    }
    deinit { Darwin.close(directoryFD) }
    func checkDirectory() throws {
        var current = stat()
        try require(lstat(path, &current) == 0 && current.st_mode & S_IFMT == S_IFDIR &&
                    current.st_uid == getuid() && current.st_mode & 0o7777 == 0o700 && FileIdentity(current) == directoryIdentity,
                    "component directory was replaced or changed")
    }
    func checkFile(_ fd: Int32, name: String) throws -> FileIdentity {
        var info = stat(), linked = stat()
        try require(fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFREG && info.st_uid == getuid() &&
                    info.st_mode & 0o7777 == 0o600 && info.st_nlink == 1, "claim file is not a private regular file")
        try require(fstatat(directoryFD, name, &linked, AT_SYMLINK_NOFOLLOW) == 0 && FileIdentity(info) == FileIdentity(linked), "claim file was replaced")
        return FileIdentity(info)
    }
    func writeAll(_ data: Data, _ fd: Int32) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if written < 0 && errno == EINTR { continue }
                try require(written > 0, "claim write failed")
                offset += written
            }
        }
    }
    func readData(_ fd: Int32, limit: Int) throws -> Data {
        var output = Data(), bytes = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count < 0 && errno == EINTR { continue }
            try require(count >= 0, "claim read failed")
            if count == 0 { return output }
            try require(output.count + count <= limit, "claim file exceeds size limit")
            output.append(contentsOf: bytes.prefix(count))
        }
    }
    func locked<T>(creating: Bool = false, _ operation: (Int32, FileIdentity) throws -> T) throws -> T {
        try checkDirectory()
        let flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW | (creating ? O_CREAT | O_EXCL : 0)
        let fd = openat(directoryFD, guardName, flags, 0o600)
        try require(fd >= 0, "guard is missing, unsafe, or already initialized; no automatic reset")
        defer { Darwin.close(fd) }
        let identity = try checkFile(fd, name: guardName)
        let deadline = DispatchTime.now().uptimeNanoseconds + 500_000_000
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            try require(errno == EWOULDBLOCK || errno == EINTR, "claim lock failed")
            try require(DispatchTime.now().uptimeNanoseconds < deadline, "claim lock busy")
            usleep(2_000)
        }
        defer { _ = flock(fd, LOCK_UN) }
        try checkDirectory(); try require(try checkFile(fd, name: guardName) == identity, "guard was replaced")
        return try operation(fd, identity)
    }
    func save(_ state: ClaimState, guardFD: Int32) throws {
        try state.validate(); try checkDirectory()
        try require(try checkFile(guardFD, name: guardName) == state.binding.guardFile, "guard binding changed")
        let temporary = "input-claim.tmp-" + UUID().uuidString.lowercased()
        let fd = openat(directoryFD, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        try require(fd >= 0, "cannot create claim transaction")
        defer { Darwin.close(fd); _ = unlinkat(directoryFD, temporary, 0) }
        let data = try JSONEncoder().encode(state)
        try require(data.count <= 4 * 1024 * 1024, "claim state exceeds size limit")
        try writeAll(data, fd); try require(fsync(fd) == 0, "cannot sync claim transaction")
        try checkDirectory(); try require(try checkFile(guardFD, name: guardName) == state.binding.guardFile, "guard binding changed")
        try require(renameat(directoryFD, temporary, directoryFD, stateName) == 0, "cannot commit claim transaction")
        try require(fsync(directoryFD) == 0, "cannot sync claim directory; outcome unknown")
    }
    func initialize() throws -> ClaimState {
        try require(try FileManager.default.contentsOfDirectory(atPath: path).isEmpty, "initialize requires a fresh empty component directory")
        return try locked(creating: true) { fd, identity in
            let binding = StorageBinding(format: 3, componentOnly: true, storageId: UUID().uuidString.lowercased(),
                                         directory: directoryIdentity, guardFile: identity)
            try writeAll(JSONEncoder().encode(binding), fd)
            try require(fsync(fd) == 0, "cannot sync new guard")
            let state = ClaimState(binding: binding, revision: 0, lease: nil)
            try save(state, guardFD: fd)
            return state
        }
    }
    func load(_ binding: StorageBinding, guardFD: Int32, guardIdentity: FileIdentity) throws -> ClaimState {
        try require(binding.directory == directoryIdentity && binding.guardFile == guardIdentity, "storage identity changed")
        try require(lseek(guardFD, 0, SEEK_SET) == 0, "cannot read guard")
        let header = try JSONDecoder().decode(StorageBinding.self, from: readData(guardFD, limit: 4096))
        try require(header == binding, "guard binding changed")
        let fd = openat(directoryFD, stateName, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        try require(fd >= 0, "claim state is missing; no automatic reset")
        defer { Darwin.close(fd) }
        _ = try checkFile(fd, name: stateName)
        let state = try JSONDecoder().decode(ClaimState.self, from: readData(fd, limit: 4 * 1024 * 1024))
        try state.validate(); try require(state.binding == binding, "claim state binding changed")
        return state
    }
    func owner(_ lease: Lease) throws { try require(lease.owner == caller, "actual caller is not lease owner") }
    func compare(_ request: ClaimRequest, _ state: ClaimState) throws {
        if request.revision != state.revision { throw ClaimFailure("claim revision changed", code: "revision_conflict") }
    }
    func seal(_ lease: inout Lease) {
        lease.phase = .sealed
        for index in lease.commands.indices where [.registered, .permitted].contains(lease.commands[index].phase) {
            lease.commands[index].phase = .notStarted
        }
    }
    func mutate(_ request: ClaimRequest, state: inout ClaimState) throws {
        try require(try !BirthProbe.ended(caller), "calling parent has ended")
        if request.op == "acquire" {
            guard let id = request.leaseId, UUID(uuidString: id) != nil else { throw ClaimFailure("invalid new lease nonce") }
            if let old = state.lease {
                // A lost acquire response may be retried using its original revision.
                // Reusing the same nonce in a later epoch cannot revive old requests.
                if old.id == id && old.owner == caller && request.revision == sequence(old.epoch).map({ $0 - 1 }) &&
                    (request.epoch == nil || request.epoch == old.epoch) { return }
                throw ClaimFailure("lease busy; seal and recover the old lease explicitly")
            }
            try compare(request, state)
            try require(request.epoch == nil && state.revision < UInt64.max, "new lease epoch is assigned by storage, or revision exhausted")
            state.lease = Lease(id: id, epoch: String(state.revision + 1), owner: caller, phase: .open, tainted: false, senders: [], commands: [], restorations: [])
            return
        }
        guard var lease = state.lease, request.leaseId == lease.id, request.epoch == lease.epoch else { throw ClaimFailure("stale or missing lease epoch") }
        switch request.op {
        case "register":
            try owner(lease); try compare(request, state)
            try require(lease.phase == .open && !lease.tainted, "lease is sealed")
            guard let senderId = request.senderId, UUID(uuidString: senderId) != nil, let pid = request.senderPid, let kind = request.senderKind,
                  case .alive(let birth) = BirthProbe.read(pid) else { throw ClaimFailure("cannot identify sender") }
            if let old = lease.senders.first(where: { $0.id == senderId }) {
                try require(old.birth == birth && old.kind == kind && !old.retired, "sender binding changed")
            } else {
                try require(lease.senders.count < 64 && !lease.senders.contains { $0.birth == birth }, "sender already registered or limit reached")
                if kind == .uiInput {
                    try require(lease.uiSender == nil && lease.focusRecords.isEmpty && !lease.commands.contains { [.executing, .clean, .unknown].contains($0.phase) }, "UI sender must be unique and registered before any input")
                }
                lease.senders.append(Sender(id: senderId, birth: birth, kind: kind, retired: false))
            }
        case "stage":
            try owner(lease); try compare(request, state)
            try require(lease.phase == .open && !lease.tainted, "lease is sealed")
            guard let id = request.commandId, let token = request.token, let route = request.route, let senderId = request.senderId,
                  UUID(uuidString: id) != nil, UUID(uuidString: token) != nil, UUID(uuidString: route) != nil,
                  let address = request.address, address.valid,
                  let sender = lease.senders.first(where: { $0.id == senderId && !$0.retired }) else { throw ClaimFailure("invalid command ticket") }
            try require(try !BirthProbe.ended(sender.birth), "sender has ended")
            try address.verifyLiveProcesses()
            if let old = lease.commands.first(where: { $0.id == id }) {
                try require(old.token == token && old.route == route && old.senderId == senderId && old.address == address && old.phase == .registered, "command cannot be restaged")
            } else {
                try require(lease.commands.count < 4096 && !lease.commands.contains { $0.token == token }, "command limit or duplicate token")
                lease.commands.append(ClaimCommand(id: id, token: token, senderId: senderId, route: route, address: address, openedObligations: [], phase: .registered))
            }
        case "seal", "recoverSeal":
            if request.op == "seal" { try owner(lease) }
            else { try require(try BirthProbe.ended(lease.owner), "old owner is still alive") }
            try compare(request, state); seal(&lease)
        case "release", "recover":
            try compare(request, state)
            if request.op == "release" { try owner(lease) }
            else { try require(try BirthProbe.ended(lease.owner), "old owner is still alive") }
            try require(lease.phase == .sealed && !lease.tainted && lease.restorations.allSatisfy(\.settled) && lease.commands.allSatisfy { [.clean, .notStarted].contains($0.phase) }, "input cleanup remains unknown or restorations are pending; claim retained")
            for sender in lease.senders {
                if request.op == "recover" || !sender.retired {
                    try require(try BirthProbe.ended(sender.birth), "old sender is still alive and has not retired")
                }
            }
            state.lease = nil; return
        case "retire":
            guard let senderId = request.senderId, let index = lease.senders.firstIndex(where: { $0.id == senderId }) else { throw ClaimFailure("unknown sender") }
            try require(lease.senders[index].birth == caller, "actual caller is not registered sender")
            try require(lease.phase == .sealed && !lease.restorations.contains { $0.senderId == senderId && !$0.settled } && lease.commands.filter { $0.senderId == senderId }.allSatisfy { [.clean, .notStarted].contains($0.phase) }, "sender still has live command capabilities or pending restorations")
            lease.senders[index].retired = true
        case "beginRestore", "restorationReceipt":
            guard let index = lease.restorations.firstIndex(where: { $0.obligation.id == request.restorationId }),
                  let sender = lease.senders.first(where: { $0.id == lease.restorations[index].senderId && !$0.retired }), sender.birth == caller else {
                throw ClaimFailure("actual caller is not original restoration sender")
            }
            if lease.restorations[index].phase == .unknown { throw ClaimFailure("unknown restoration cannot be overwritten") }
            let original = lease.restorations[index].obligation
            if lease.focusFinalization != nil {
                try require(request.op == "restorationReceipt", "focus group is finalized; no further restoration is allowed")
                if request.address != original.address || request.restorationReceipt?.clean != true ||
                   request.restorationReceipt != lease.restorations[index].receipt {
                    lease.restorations[index].phase = .unknown
                    if lease.restorations[index].receipt == nil { lease.restorations[index].receipt = request.restorationReceipt }
                    for focus in lease.restorations.indices where lease.restorations[focus].obligation.kind == "focus" { lease.restorations[focus].phase = .unknown }
                    lease.tainted = true; seal(&lease)
                }
                state.lease = lease; return
            }
            if request.op == "beginRestore" {
                try require(lease.restorations[index].phase == .pending && request.address == original.address, "restoration address changed or permit was already consumed")
                if original.kind == "focus" { try require(lease.phase == .sealed && lease.commandsFinished, "focus writes must wait until all input commands end and lease is sealed") }
                try original.address.verifyLiveProcesses()
                try require(!lease.restorations.contains { $0.phase == .restoring } && !lease.commands.contains { $0.phase == .executing && $0.senderId != sender.id }, "another input sender or restoration is still executing")
                // Clipboard saves are nested. Frontmost app and keyboard focus
                // are independent members of one group, not nested saves. A dead
                // member must not block a necessary write to its live sibling.
                if original.kind == "clipboard" {
                    try require(!lease.restorations.dropFirst(index + 1).contains { $0.obligation.kind == "clipboard" && $0.phase != .restored }, "a nested restoration still owns this resource")
                }
                lease.restorations[index].phase = .restoring
            } else if [.restoring, .restored].contains(lease.restorations[index].phase), request.address == original.address, let receipt = request.restorationReceipt, receipt.clean,
               lease.restorations[index].receipt == nil || lease.restorations[index].receipt == receipt {
                lease.restorations[index].phase = .restored; lease.restorations[index].receipt = receipt
            } else {
                lease.restorations[index].phase = .unknown
                if lease.restorations[index].receipt == nil { lease.restorations[index].receipt = request.restorationReceipt }
                lease.tainted = true; seal(&lease)
            }
        case "resolveFocus":
            let records = lease.focusRecords
            guard let first = records.first, request.senderId == first.senderId,
                  let sender = lease.senders.first(where: { $0.id == first.senderId && !$0.retired }), sender.birth == caller else {
                throw ClaimFailure("actual caller is not original focus sender")
            }
            if let previous = lease.focusFinalization {
                try require(!lease.tainted, "unknown cleanup cannot be erased by a previous focus observation")
                try require(request.focusFinalization == previous, "final focus observation cannot be replaced")
                return
            }
            try require(lease.phase == .sealed && !lease.tainted && lease.commandsFinished &&
                        lease.restorations.filter { $0.obligation.kind != "focus" }.allSatisfy(\.settled) &&
                        records.allSatisfy { $0.phase == .pending || $0.phase == .restored && $0.receipt?.clean == true }, "focus resolution must wait until all writes end; unknown cleanup is retained")
            do {
                guard let finalization = request.focusFinalization else { throw ClaimFailure("missing or malformed final focus observation") }
                try lease.validateFocusProof(finalization, verifyProcesses: true)
                lease.focusFinalization = finalization
                for index in lease.restorations.indices where lease.restorations[index].obligation.kind == "focus" { lease.restorations[index].phase = .resolved }
            } catch {
                // An authenticated invalid observation is terminal uncertainty.
                // Never let a later good observation erase the missing evidence.
                for index in lease.restorations.indices where lease.restorations[index].obligation.kind == "focus" { lease.restorations[index].phase = .unknown }
                lease.tainted = true; seal(&lease)
            }
        case "permit", "begin", "receipt":
            guard let index = lease.commands.firstIndex(where: { $0.id == request.commandId }),
                  lease.commands[index].token == request.token, lease.commands[index].route == request.route,
                  let sender = lease.senders.first(where: { $0.id == lease.commands[index].senderId }) else { throw ClaimFailure("command ticket does not match") }
            let phase = lease.commands[index].phase
            if request.op == "permit" {
                try owner(lease); try compare(request, state)
                try require(lease.phase == .open && !lease.tainted && !sender.retired && [.registered, .permitted].contains(phase), "command cannot be permitted")
                try require(request.address == lease.commands[index].address, "original input address changed")
                try lease.commands[index].address.verifyLiveProcesses()
                lease.commands[index].phase = .permitted
            } else {
                try require(sender.birth == caller && !sender.retired, "actual caller is not registered sender")
                if request.op == "begin" {
                    try require(lease.phase == .open && !lease.tainted && phase == .permitted, "command cannot begin or was already consumed")
                    try require(!lease.commands.contains { $0.phase == .executing } && !lease.restorations.contains { $0.phase == .restoring }, "another input command or restoration is still executing")
                    try require(request.address == lease.commands[index].address, "original input address changed")
                    try lease.commands[index].address.verifyLiveProcesses()
                    guard let opened = request.openObligations, opened.count <= 512, opened.allSatisfy(\.valid),
                          Set(opened.map(\.id)).count == opened.count else { throw ClaimFailure("begin requires explicit valid restoration declarations") }
                    let previous = Set(lease.commands.flatMap(\.openedObligations).map(\.id))
                    try require(opened.allSatisfy { !previous.contains($0.id) } && lease.restorations.count + opened.count <= 512, "restoration ID was reused or pending limit reached")
                    let newFocus = opened.filter { $0.kind == "focus" }
                    if !newFocus.isEmpty { try require(lease.focusRecords.isEmpty && !lease.commands.contains { [.executing, .clean, .unknown].contains($0.phase) }, "original focus baseline must precede all input and cannot be replaced") }
                    for obligation in opened { try obligation.address.verifyLiveProcesses() }
                    lease.commands[index].openedObligations = opened
                    lease.restorations.append(contentsOf: opened.map { RestoreRecord(senderId: sender.id, commandId: lease.commands[index].id, obligation: $0, phase: .pending) })
                    lease.commands[index].phase = .executing
                } else if lease.focusFinalization != nil {
                    if request.address != lease.commands[index].address || request.receipt?.clean != true || request.receipt != lease.commands[index].receipt {
                        // Keep the first receipt and final observation as history,
                        // but do not let either excuse later reported uncertainty.
                        for focus in lease.restorations.indices where lease.restorations[focus].obligation.kind == "focus" { lease.restorations[focus].phase = .unknown }
                        lease.tainted = true; seal(&lease)
                    }
                } else if phase == .unknown {
                    throw ClaimFailure("unknown cleanup cannot be overwritten")
                } else if request.address != lease.commands[index].address {
                    lease.commands[index].phase = .unknown; lease.tainted = true; seal(&lease)
                } else if phase == .clean || phase == .notStarted {
                    if let receipt = request.receipt, receipt.clean,
                       lease.commands[index].receipt == nil || lease.commands[index].receipt == receipt {
                        lease.commands[index].receipt = receipt
                    } else {
                        // Keep the first terminal receipt, but retain the conflict.
                        lease.tainted = true; seal(&lease)
                    }
                } else if let receipt = request.receipt, receipt.clean {
                    lease.commands[index].receipt = receipt
                    lease.commands[index].phase = phase == .executing ? .clean : .notStarted
                } else {
                    lease.commands[index].phase = .unknown
                    lease.commands[index].receipt = request.receipt
                    lease.tainted = true; seal(&lease)
                }
            }
        default: throw ClaimFailure("unsupported component operation")
        }
        state.lease = lease
    }
    func handle(_ request: ClaimRequest) throws -> ClaimState {
        if request.op == "initialize" {
            try require(request.binding == nil, "original binding forbids reinitialization")
            return try initialize()
        }
        guard let binding = request.binding else { throw ClaimFailure("original storage binding is required") }
        return try locked { fd, identity in
            var state = try load(binding, guardFD: fd, guardIdentity: identity)
            if request.op == "inspect" || request.op == "processIdentity" { return state }
            let before = state
            try mutate(request, state: &state)
            if state != before {
                try require(state.revision < UInt64.max, "claim revision exhausted")
                state.revision += 1; try save(state, guardFD: fd)
            }
            return state
        }
    }
}

// Private newline JSON only. Cap framing before parsing; never accept tickets in argv.
@main enum InputClaimMain {
    private struct Envelope: Decodable { let id: Int }
    static func main() {
        umask(0o077)
        do {
            try require(CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--component-only", "input-claim is not connected to production senders; --component-only DIR required")
            let store = try ClaimStore(path: CommandLine.arguments[2])
            var pending = Data(), bytes = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
                if count < 0 && errno == EINTR { continue }
                try require(count >= 0, "component input failed")
                if count == 0 { try require(pending.isEmpty, "incomplete component request"); return }
                pending.append(contentsOf: bytes.prefix(count))
                while let newline = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<newline]); pending.removeSubrange(...newline)
                    try require(line.count <= 65_536, "component request exceeds size limit")
                    // Preserve a valid correlation ID even when another field
                    // fails decoding. Otherwise the parent discards the error
                    // as unrelated and waits until its command deadline.
                    var id = (try? JSONDecoder().decode(Envelope.self, from: line).id) ?? -1
                    var result: [String: Any]
                    do {
                        let request = try JSONDecoder().decode(ClaimRequest.self, from: line); id = request.id
                        let state = try store.handle(request)
                        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state))
                        result = ["id": id, "ok": true, "componentOnly": true, "state": object]
                        if request.op == "processIdentity" {
                            guard let pid = request.processPid, case .alive(let birth) = BirthProbe.read(pid) else {
                                throw ClaimFailure("process identity is absent or cannot be verified")
                            }
                            result["processBirth"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(birth))
                        }
                    } catch {
                        result = ["id": id, "ok": false, "error": String(describing: error), "componentOnly": true]
                        if let failure = error as? ClaimFailure, let code = failure.code { result["code"] = code }
                    }
                    let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) + Data([10])
                    try store.writeAll(output, STDOUT_FILENO)
                }
                try require(pending.count <= 65_536, "component request exceeds size limit")
            }
        } catch {
            FileHandle.standardError.write(Data((String(describing: error) + "\n").utf8))
            exit(1)
        }
    }
}
