import AppKit
import ApplicationServices
import Foundation

import Darwin

// Capture C callback data synchronously as values. No AX/observer reference is
// sent across actor boundaries or queued for a later read.
private struct FocusNotice: Sendable {
    let observerAddress: UInt
    let generation: UUID
    let observedPid: pid_t
    let role: String
    let recipientPid: pid_t
    let recipientToken: CFHashCode
    let windowPid: pid_t
    let windowToken: CFHashCode
    let keyboardPid: pid_t
    let keyboardReadError: Int32
    let keyboardHasValue: Bool
    let keyboardElementTypeValid: Bool
    let keyboardPidReadError: Int32?

    init(observer: AXObserver, element: AXUIElement, generation: UUID) {
        func attribute(_ item: AXUIElement, _ name: CFString) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(item, name, &value) == .success ? value : nil
        }
        func process(_ item: AXUIElement) -> pid_t {
            var pid: pid_t = 0
            return AXUIElementGetPid(item, &pid) == .success ? pid : 0
        }
        observerAddress = UInt(bitPattern: Unmanaged.passUnretained(observer).toOpaque())
        self.generation = generation
        observedPid = process(element)
        role = attribute(element, kAXRoleAttribute as CFString) as? String ?? "unknown"
        let recipient: AXUIElement
        if role == kAXApplicationRole, let value = attribute(element, kAXFocusedUIElementAttribute as CFString), CFGetTypeID(value) == AXUIElementGetTypeID() {
            recipient = unsafeDowncast(value, to: AXUIElement.self)
        } else { recipient = element }
        recipientPid = process(recipient)
        recipientToken = CFHash(recipient)
        if let window = attribute(recipient, kAXWindowAttribute as CFString), CFGetTypeID(window) == AXUIElementGetTypeID() {
            let item = unsafeDowncast(window, to: AXUIElement.self)
            windowPid = process(item); windowToken = CFHash(item)
        } else { windowPid = 0; windowToken = 0 }
        var keyboard: CFTypeRef?
        let keyboardError = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &keyboard)
        keyboardReadError = keyboardError.rawValue
        keyboardHasValue = keyboard != nil
        keyboardElementTypeValid = keyboard.map { CFGetTypeID($0) == AXUIElementGetTypeID() } ?? false
        if keyboardError == .success, keyboardElementTypeValid, let keyboard {
            var value: pid_t = 0
            let error = AXUIElementGetPid(unsafeDowncast(keyboard, to: AXUIElement.self), &value)
            keyboardPidReadError = error.rawValue
            keyboardPid = error == .success ? value : 0
        } else { keyboardPid = 0; keyboardPidReadError = nil }
    }
}

// No event taps and no input injection. AX notifications supplement 20 ms sampling.
@MainActor
final class FocusMonitor {
    private struct PendingSubscription { let id: UUID; let task: Task<Void, Never> }
    private let output: FileHandle
    private let system = AXUIElementCreateSystemWide()
    private var focus: AXUIElement?
    private var focusNumber = 0
    private var focusError = AXError.success
    private var keyboardPid: pid_t = 0
    private var keyboardReadError = AXError.success
    private var keyboardPidReadError: AXError?
    private var keyboardElementTypeValid = false
    private var keyboardHasValue = false
    private var foreground: pid_t = 0
    private let subscriptions = FocusSubscriptions()
    private var observerAddresses: [pid_t: UInt] = [:]
    private var observerGenerations: [pid_t: UUID] = [:]
    private var observerNotifications: [pid_t: Set<String>] = [:]
    private var observerIdentities: [pid_t: NativeProcessIdentity] = [:]
    private var pendingSubscriptions: [pid_t: PendingSubscription] = [:]
    private var failedSubscriptions: [pid_t: (identity: NativeProcessIdentity, retryAt: TimeInterval)] = [:]
    private var activationToken: NSObjectProtocol?
    private var launchToken: NSObjectProtocol?
    private var terminationToken: NSObjectProtocol?
    private var timer: Timer?
    private var lastBeat = Date.distantPast
    private var sequence = 0
    private var stopping = false
    init(path: String) throws {
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }
    private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
    }
    private func focused() -> AXUIElement? {
        var application: CFTypeRef?
        keyboardReadError = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &application)
        keyboardHasValue = application != nil
        keyboardElementTypeValid = application.map { CFGetTypeID($0) == AXUIElementGetTypeID() } ?? false
        keyboardPid = 0
        keyboardPidReadError = nil
        if keyboardReadError == .success, keyboardElementTypeValid, let application {
            var value: pid_t = 0
            let error = AXUIElementGetPid(unsafeDowncast(application, to: AXUIElement.self), &value)
            keyboardPidReadError = error
            if error == .success { keyboardPid = value }
        }
        var value: CFTypeRef?
        focusError = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &value)
        if focusError == .attributeUnsupported, let application = attribute(system, kAXFocusedApplicationAttribute as CFString),
           CFGetTypeID(application) == AXUIElementGetTypeID() {
            focusError = AXUIElementCopyAttributeValue(unsafeDowncast(application, to: AXUIElement.self), kAXFocusedUIElementAttribute as CFString, &value)
        }
        guard focusError == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }
    private func pid(_ element: AXUIElement?) -> pid_t? {
        guard let element else { return nil }
        var value: pid_t = 0
        return AXUIElementGetPid(element, &value) == .success ? value : nil
    }
    private func hardwareAge() -> Double {
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .mouseMoved, .keyDown, .flagsChanged, .scrollWheel, .otherMouseDown]
        return types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) * 1000 }.min() ?? .infinity
    }
    private func processRecord(_ observation: NativeProcessObservation) -> [String: Any] {
        do {
            return try JSONSerialization.jsonObject(with: JSONEncoder().encode(observation)) as? [String: Any]
                ?? ["status": "unknown", "reason": "process-query-incomplete"]
        } catch { return ["status": "unknown", "reason": "process-query-incomplete"] }
    }
    private func aliveIdentity(_ observation: NativeProcessObservation) -> NativeProcessIdentity? {
        observation.status == "alive" ? observation.identity : nil
    }
    private func unsubscribe(pid: pid_t) {
        observerAddresses.removeValue(forKey: pid)
        if let generation = observerGenerations.removeValue(forKey: pid) {
            Task { await subscriptions.remove(pid: pid, generation: generation) }
        }
        observerIdentities.removeValue(forKey: pid)
        observerNotifications.removeValue(forKey: pid)
    }
    private func emit(_ kind: String, fields: [String: Any] = [:]) {
        var record = fields
        sequence += 1
        record["kind"] = kind
        record["sequence"] = sequence
        record["at"] = Date().timeIntervalSince1970 * 1000
        record["uptimeMs"] = ProcessInfo.processInfo.systemUptime * 1000
        record["hardwareAgeMs"] = hardwareAge()
        record["foregroundPid"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        record["focusPid"] = pid(focus) ?? 0
        record["focusToken"] = focusNumber
        record["keyboardPid"] = keyboardPid
        record["keyboardReadError"] = keyboardReadError.rawValue
        record["keyboardHasValue"] = keyboardHasValue
        record["keyboardElementTypeValid"] = keyboardElementTypeValid
        if let keyboardPidReadError { record["keyboardPidReadError"] = keyboardPidReadError.rawValue }
        else { record["keyboardPidReadError"] = NSNull() }
        record["focusReadError"] = focusError.rawValue
        record["focusReadable"] = focusError == .success && focus != nil
        record["noFocusedElement"] = focusError == .noValue
        record["monitorProcess"] = processRecord(ProcessIdentityProbe.read(pid: getpid()))
        // No names, paths or focused text. OS birth metadata distinguishes a
        // recycled PID from the process that was actually subscribed.
        var processes: [pid_t: NativeProcessObservation] = [:]
        for (key, value) in [("foregroundProcess", record["foregroundPid"]), ("focusProcess", record["focusPid"]), ("keyboardProcess", record["keyboardPid"])] {
            let process = value as? pid_t ?? 0
            let observation = processes[process] ?? ProcessIdentityProbe.read(pid: process)
            processes[process] = observation
            record[key] = processRecord(observation)
        }
        do {
            var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            data.append(10)
            try output.write(contentsOf: data)
        } catch {
            NSLog("Focus journal failed: %@", String(describing: error))
            exit(3) // A missing record cannot silently become evidence of no focus theft.
        }
    }
    func start() async {
        guard !stopping else { return }
        guard AXIsProcessTrusted() else { emit("fatal", fields: ["reason": "accessibility not authorized"]); exit(2) }
        // The system-wide object sets this process's default AX timeout.
        // Per-application timeouts do not cover fresh callback recipients.
        // Ten milliseconds caused a verified no-input read failure on the
        // foreground app. Give a single AX query 50 ms; unchanged strict
        // sampling-gap checks still reject a slow/missing observation.
        AXUIElementSetMessagingTimeout(system, 0.05)
        foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        focus = focused()
        focusNumber = 1
        emit("start", fields: ["samplingMs": 20, "usesEventTap": false])
        activationToken = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notice in
            let activatedPid = (notice.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated {
                guard let self, let activatedPid else { return }
                self.foreground = activatedPid
                self.emit("foreground-notification", fields: ["activatedPid": activatedPid])
                self.subscribe(pid: self.foreground)
                self.sample(source: "activation")
            }
        }
        launchToken = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] notice in
            let app = notice.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let launchedPid = app?.processIdentifier
            MainActor.assumeIsolated { if let self, let launchedPid { self.subscribe(pid: launchedPid) } }
        }
        terminationToken = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] notice in
            let endedPid = (notice.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated {
                if let self, let endedPid {
                    let expected = self.observerIdentities[endedPid]
                    let current = ProcessIdentityProbe.read(pid: endedPid)
                    // Workspace termination notices can be delayed past PID
                    // reuse. A notice is not proof that our current birth died.
                    if let expected, self.aliveIdentity(current) == expected {
                        self.emit("termination-hint", fields: ["observedPid": endedPid,
                            "observedProcess": self.processRecord(current), "reason": "current subscribed birth is still alive"])
                        return
                    }
                    self.unsubscribe(pid: endedPid)
                    self.emit("process-terminated", fields: ["observedPid": endedPid,
                        "previousIdentity": expected.map { self.processRecord(NativeProcessObservation(status: "alive", identity: $0, reason: nil)) } ?? ["status": "unknown", "reason": "process-query-incomplete"],
                        "observedProcess": self.processRecord(current)])
                }
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample(source: "timer") }
        }
        var initialPids = Set(NSWorkspace.shared.runningApplications.map(\.processIdentifier))
        initialPids.insert(foreground); initialPids.insert(keyboardPid)
        if let focusedPid = pid(focus) { initialPids.insert(focusedPid) }
        let initial = initialPids.compactMap { subscribe(pid: $0) }
        for task in initial { await task.value }
        guard !stopping else { return }
        sample(source: "ready")
        emit("ready")
    }
    func stop() async {
        guard !stopping else { return }
        stopping = true
        let pending = pendingSubscriptions.values.map(\.task)
        for task in pending { task.cancel() }
        await subscriptions.shutdown()
        for task in pending { await task.value }
        emit("monitor-observers-stopped", fields: ["pendingSubscriptions": pendingSubscriptions.count])
        timer?.invalidate()
        sample(source: "controller EOF")
        emit("stopped")
        do { try output.synchronize() }
        catch { emit("fatal", fields: ["reason": "final focus journal sync failed"]); Darwin.exit(3) }
        Darwin.exit(0)
    }
    @discardableResult
    private func subscribe(pid: pid_t) -> Task<Void, Never>? {
        guard pid > 0, !stopping else { return nil }
        if let pending = pendingSubscriptions[pid] { return pending.task }
        let before = ProcessIdentityProbe.read(pid: pid)
        guard let identity = aliveIdentity(before) else {
            unsubscribe(pid: pid)
            emit("notification-unavailable", fields: ["observedPid": pid, "observedProcess": processRecord(before), "reason": "process identity unavailable"])
            return nil
        }
        if observerAddresses[pid] != nil {
            if observerIdentities[pid] == identity {
                if observerNotifications[pid]?.contains(kAXFocusedUIElementChangedNotification) == true { return nil }
            } else {
                unsubscribe(pid: pid)
                emit("subscription-invalidated", fields: ["observedPid": pid, "observedProcess": processRecord(before), "reason": "process identity changed"])
            }
        }
        if let failed = failedSubscriptions[pid], failed.identity == identity, failed.retryAt > ProcessInfo.processInfo.systemUptime { return nil }
        let requestId = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            let receipt = await self.subscriptions.prepare(pid: pid, owner: self)
            defer { if self.pendingSubscriptions[pid]?.id == requestId { self.pendingSubscriptions.removeValue(forKey: pid) } }
            guard !self.stopping, !Task.isCancelled, self.pendingSubscriptions[pid]?.id == requestId else {
                if let generation = receipt.generation { await self.subscriptions.remove(pid: pid, generation: generation) }
                return
            }
            for failure in receipt.failures {
                self.emit("notification-unavailable", fields: ["observedPid": pid, "notification": failure.notification, "error": failure.error])
            }
            guard let address = receipt.observerAddress, let generation = receipt.generation, let birth = receipt.after.identity, receipt.after.status == "alive" else {
                self.unsubscribe(pid: pid)
                self.failedSubscriptions[pid] = (identity, ProcessInfo.processInfo.systemUptime + 5)
                self.emit("notification-unavailable", fields: ["observedPid": pid, "reason": receipt.reason ?? "subscription unavailable",
                    "subscriptionBefore": self.processRecord(receipt.before), "subscriptionAfter": self.processRecord(receipt.after)])
                return
            }
            self.observerAddresses[pid] = address
            self.observerIdentities[pid] = birth
            self.observerGenerations[pid] = generation
            self.observerNotifications[pid] = Set(receipt.notifications)
            let active = await self.subscriptions.activate(pid: pid, generation: generation, identity: birth)
            let current = ProcessIdentityProbe.read(pid: pid)
            guard active, !self.stopping, !Task.isCancelled, self.observerGenerations[pid] == generation, self.aliveIdentity(current) == birth else {
                if self.observerGenerations[pid] == generation { self.unsubscribe(pid: pid) }
                else { await self.subscriptions.remove(pid: pid, generation: generation) }
                self.emit("subscription-invalidated", fields: ["observedPid": pid, "reason": "process changed before source activation"])
                return
            }
            if receipt.notifications.contains(kAXFocusedUIElementChangedNotification) { self.failedSubscriptions.removeValue(forKey: pid) }
            else { self.failedSubscriptions[pid] = (identity, ProcessInfo.processInfo.systemUptime + 5) }
            self.emit("subscribed", fields: ["observedPid": pid, "supported": receipt.notifications.count, "notifications": receipt.notifications,
                "subscriptionGeneration": generation.uuidString.lowercased(),
                "subscriptionBefore": self.processRecord(receipt.before), "subscriptionAfter": self.processRecord(receipt.after)])
        }
        pendingSubscriptions[pid] = PendingSubscription(id: requestId, task: task)
        return task
    }
    fileprivate func notification(event: FocusNotice, name: String) {
        // Preserve the notified element before the next system-wide sample. A
        // brief transfer may already have been restored by the time we sample.
        let observedPid = event.observedPid
        let observation = ProcessIdentityProbe.read(pid: observedPid)
        guard let expected = observerIdentities[observedPid],
              let current = observerAddresses[observedPid], event.observerAddress == current,
              observerGenerations[observedPid] == event.generation,
              aliveIdentity(observation) == expected else {
            emit("notification-identity-unavailable", fields: ["observedPid": observedPid, "notification": name,
                "observedProcess": processRecord(observation)])
            return
        }
        var fields: [String: Any] = [
            "observedPid": observedPid, "notification": name,
            "observedProcess": processRecord(observation),
            "subscriptionProcess": processRecord(NativeProcessObservation(status: "alive", identity: expected, reason: nil)),
            "subscriptionGeneration": event.generation.uuidString.lowercased(),
            "notifiedElementPid": event.recipientPid,
            "notifiedElementToken": event.recipientToken,
            "notifiedRole": event.role,
            "notifiedWindowToken": event.windowToken,
            "notifiedWindowPid": event.windowPid,
            "systemKeyboardPidAtNotification": event.keyboardPid,
            "systemKeyboardReadErrorAtNotification": event.keyboardReadError,
            "systemKeyboardHasValueAtNotification": event.keyboardHasValue,
            "systemKeyboardElementTypeValidAtNotification": event.keyboardElementTypeValid,
            "inSystemFocusedApplication": observedPid > 0 && observedPid == event.keyboardPid,
        ]
        if let error = event.keyboardPidReadError { fields["systemKeyboardPidReadErrorAtNotification"] = error }
        else { fields["systemKeyboardPidReadErrorAtNotification"] = NSNull() }
        emit("AX-notification", fields: fields)
        sample(source: "AX notification")
    }
    func sample(source: String) {
        let actualFront = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if actualFront != foreground {
            foreground = actualFront
            emit("foreground-sample", fields: ["source": source])
            subscribe(pid: foreground)
        }
        let oldKeyboard = keyboardPid, oldError = focusError
        let current = focused()
        if oldKeyboard != keyboardPid { emit("keyboard-application", fields: ["source": source]) }
        if oldError != focusError { emit("focus-read-state", fields: ["source": source]) }
        let changed: Bool
        if let focus, let current { changed = !CFEqual(focus, current) }
        else { changed = (focus == nil) != (current == nil) }
        if changed {
            focus = current
            focusNumber += 1
            emit("focus", fields: ["source": source])
            if let focusedPid = pid(current) { subscribe(pid: focusedPid) }
        }
        if Date().timeIntervalSince(lastBeat) >= 1 {
            lastBeat = Date()
            for running in NSWorkspace.shared.runningApplications { subscribe(pid: running.processIdentifier) }
            let location = CGEvent(source: nil)?.location ?? .zero
            emit("heartbeat", fields: ["pointerX": location.x, "pointerY": location.y,
                                        "modifierFlags": CGEventSource.flagsState(.combinedSessionState).rawValue])
        }
        let location = CGEvent(source: nil)?.location ?? .zero
        emit("sample", fields: ["source": source, "pointerX": location.x, "pointerY": location.y,
                                "modifierFlags": CGEventSource.flagsState(.combinedSessionState).rawValue])
    }
}

let focusCallback: AXObserverCallback = { observer, element, notice, context in
    guard let context else { return }
    let capturedName = notice as String
    let registration = Unmanaged<FocusSubscriptionContext>.fromOpaque(context).takeUnretainedValue()
    let monitor = registration.owner
    let event = FocusNotice(observer: observer, element: element, generation: registration.generation)
    MainActor.assumeIsolated {
        monitor.notification(event: event, name: capturedName)
    }
}

@main
struct MonitorMain {
    @MainActor
    static func main() throws {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        guard CommandLine.arguments.count >= 2 else { exit(2) }
        let monitor = try FocusMonitor(path: CommandLine.arguments[1])
        Task { @MainActor in await monitor.start() }
        // EOF also follows a killed controller. Record one final observation
        // before exiting; missing controller stop/end still fails acceptance.
        FileHandle.standardInput.readabilityHandler = { handle in
            if handle.availableData.isEmpty {
                handle.readabilityHandler = nil
                Task { @MainActor in await monitor.stop() }
            }
        }
        application.run()
    }
}
