import ApplicationServices
import Foundation

final class FocusSubscriptionContext: Sendable {
    let owner: FocusMonitor
    let generation: UUID
    init(owner: FocusMonitor, generation: UUID) { self.owner = owner; self.generation = generation }
}
struct FocusSubscriptionFailure: Sendable {
    let notification: String
    let error: Int32
}
struct FocusSubscriptionReceipt: Sendable {
    let pid: pid_t
    let before: NativeProcessObservation
    let after: NativeProcessObservation
    let notifications: [String]
    let failures: [FocusSubscriptionFailure]
    let observerAddress: UInt?
    let generation: UUID?
    let reason: String?
}

// AX registration can block on an unresponsive app. Keep all C references on
// this actor and return values only; the main run loop remains free to sample.
actor FocusSubscriptions {
    private struct Entry {
        let observer: AXObserver
        let source: CFRunLoopSource
        let identity: NativeProcessIdentity
        var notifications: [String]
        let context: FocusSubscriptionContext
        var active: Bool
        var address: UInt { UInt(bitPattern: Unmanaged.passUnretained(observer).toOpaque()) }
    }
    private var entries: [pid_t: Entry] = [:]
    private var stopped = false
    // A removed run-loop source can have a callback in flight. Keep activated
    // C contexts alive until this short-lived monitor process exits.
    private var callbackLifetimes: [FocusSubscriptionContext] = []

    func remove(pid: pid_t, generation: UUID) {
        guard let entry = entries[pid], entry.context.generation == generation else { return }
        if entry.active { CFRunLoopRemoveSource(CFRunLoopGetMain(), entry.source, .commonModes) }
        entries.removeValue(forKey: pid)
    }
    func prepare(pid: pid_t, owner: FocusMonitor) -> FocusSubscriptionReceipt {
        let before = ProcessIdentityProbe.read(pid: pid)
        func unavailable(_ after: NativeProcessObservation, _ reason: String, _ failures: [FocusSubscriptionFailure] = []) -> FocusSubscriptionReceipt {
            FocusSubscriptionReceipt(pid: pid, before: before, after: after, notifications: [], failures: failures, observerAddress: nil, generation: nil, reason: reason)
        }
        guard !Task.isCancelled else { return unavailable(before, "subscription request cancelled") }
        guard !stopped else { return unavailable(before, "monitor is stopping") }
        guard before.status == "alive", let identity = before.identity else {
            if let entry = entries[pid] { remove(pid: pid, generation: entry.context.generation) }
            return unavailable(before, "process identity unavailable")
        }
        if let entry = entries[pid] {
            if entry.identity == identity {
                var updated = entry, failures: [FocusSubscriptionFailure] = []
                let application = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(application, 0.15)
                for name in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification] where !updated.notifications.contains(name) {
                    if Task.isCancelled { return unavailable(before, "subscription request cancelled") }
                    let error = AXObserverAddNotification(entry.observer, application, name as CFString, Unmanaged.passUnretained(entry.context).toOpaque())
                    if error == .success { updated.notifications.append(name) }
                    else { failures.append(FocusSubscriptionFailure(notification: name, error: error.rawValue)) }
                }
                let after = ProcessIdentityProbe.read(pid: pid)
                if after.status == "alive", after.identity == identity {
                    entries[pid] = updated
                    return FocusSubscriptionReceipt(pid: pid, before: before, after: after, notifications: updated.notifications,
                        failures: failures, observerAddress: entry.address, generation: entry.context.generation, reason: nil)
                }
                remove(pid: pid, generation: entry.context.generation)
                return unavailable(after, "process identity changed while subscribing")
            }
            remove(pid: pid, generation: entry.context.generation)
        }
        var observer: AXObserver?
        guard !Task.isCancelled else { return unavailable(before, "subscription request cancelled") }
        let error = AXObserverCreate(pid, focusCallback, &observer)
        guard error == .success, let observer else {
            return unavailable(before, "observer creation failed", [FocusSubscriptionFailure(notification: "", error: error.rawValue)])
        }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.15)
        let callbackContext = FocusSubscriptionContext(owner: owner, generation: UUID())
        let context = Unmanaged.passUnretained(callbackContext).toOpaque()
        var supported: [String] = [], failures: [FocusSubscriptionFailure] = []
        for name in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification] {
            if Task.isCancelled { break }
            let error = AXObserverAddNotification(observer, application, name as CFString, context)
            if error == .success { supported.append(name) }
            else { failures.append(FocusSubscriptionFailure(notification: name, error: error.rawValue)) }
        }
        let after = ProcessIdentityProbe.read(pid: pid)
        guard !Task.isCancelled, after.status == "alive", after.identity == identity, !supported.isEmpty else {
            for name in supported { AXObserverRemoveNotification(observer, application, name as CFString) }
            return unavailable(after, Task.isCancelled ? "subscription request cancelled" : supported.isEmpty ? "notifications unavailable" : "process identity changed while subscribing", failures)
        }
        let source = AXObserverGetRunLoopSource(observer)
        let entry = Entry(observer: observer, source: source, identity: identity, notifications: supported, context: callbackContext, active: false)
        entries[pid] = entry
        return FocusSubscriptionReceipt(pid: pid, before: before, after: after, notifications: supported,
            failures: failures, observerAddress: entry.address, generation: callbackContext.generation, reason: nil)
    }
    func activate(pid: pid_t, generation: UUID, identity: NativeProcessIdentity) -> Bool {
        guard !stopped, !Task.isCancelled else { return false }
        guard var entry = entries[pid], entry.context.generation == generation, entry.identity == identity else { return false }
        let current = ProcessIdentityProbe.read(pid: pid)
        guard current.status == "alive", current.identity == identity else { remove(pid: pid, generation: generation); return false }
        if !entry.active { callbackLifetimes.append(entry.context); CFRunLoopAddSource(CFRunLoopGetMain(), entry.source, .commonModes); entry.active = true; entries[pid] = entry }
        return true
    }
    func shutdown() {
        stopped = true
        for entry in entries.values where entry.active { CFRunLoopRemoveSource(CFRunLoopGetMain(), entry.source, .commonModes) }
        entries.removeAll()
    }
}
