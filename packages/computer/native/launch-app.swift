import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// NSWorkspace's activates=false is only a request: Chrome can still activate itself.
// During --watch, return to the original app only while no user input or other front
// application has been observed. This repairs an interruption; it cannot prevent one.
// Usage: launch-app [--new] [--watch <seconds>] [--settle <seconds>] <app bundle path> [app arguments...]
// With --settle, a "ready" line on stdin (the caller saw the app finish starting) ends the watch once
// that many quiet seconds have passed, instead of always waiting out --watch.
// The first JSON line keeps the existing {"pid":N} protocol. The final line reports
// observed foreground entries separately from confirmed returns; an API success is
// never counted as a return. Hardware-input counters are read without an event tap.

struct LaunchPreflightRefusal: Encodable, Equatable {
	let error: String
	let code = "background_launch_preflight_refused"
	let outcome = "not_executed"
	let dispatched = false
	let retryUnsafe = false
}

// Match the browser bundle itself, never its name, path, framework or helpers.
// Keep this exact set aligned with requiresManagedChromeLaunch in launcher-mac.ts.
func chromiumLaunchRefusal(bundleIdentifier: String?, arguments: [String]) -> LaunchPreflightRefusal? {
	let browsers: Set<String> = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
		"com.google.Chrome.canary", "com.google.chrome.for.testing", "org.chromium.Chromium"]
	guard let bundleIdentifier, browsers.contains(bundleIdentifier) else { return nil }
	var switches: [String: String] = [:]
	// Match Chromium's ASCII trimming, POSIX prefixes and "--" terminator.
	let whitespace = CharacterSet(charactersIn: " \t\n\r\u{0B}\u{0C}")
	for rawArgument in arguments {
		let argument = rawArgument.trimmingCharacters(in: whitespace)
		if argument == "--" { break }
		let prefix = argument.hasPrefix("--") ? 2 : argument.hasPrefix("-") ? 1 : 0
		guard prefix > 0, argument.count > prefix else { continue }
		let parts = argument.dropFirst(prefix).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
		switches[String(parts[0])] = parts.count > 1 ? String(parts[1]) : ""
	}
	let guidance = "Use web_read to start without a window, then create a background browser window."
	if switches["app"] != nil || switches["app-id"] != nil {
		return LaunchPreflightRefusal(error: "Background Chrome app-mode startup is refused because it can interrupt the foreground app. " + guidance)
	}
	let headless = switches["headless"].map { $0.isEmpty || $0 == "new" } ?? false
	if !headless && switches["no-startup-window"] == nil {
		return LaunchPreflightRefusal(error: "Background Chrome must start without a window. " + guidance)
	}
	return nil
}

struct LaunchFocusWatch {
	let previousPID: pid_t
	private(set) var targetPID: pid_t?
	private(set) var fronts: [pid_t]
	private(set) var gaveBack = 0
	private(set) var restoreRequests = 0
	private(set) var keyRestoreRequests = 0
	private(set) var keyRestorePairsSent = 0
	private(set) var pendingReturn = false
	private(set) var stopped: String?
	private var nextRequest = 0.0
	private var nextKeyRequest = 0.0
	private var originalActive = false
	private var keyRequestSentForReturn = false
	var frontTaken: Int { guard let targetPID, targetPID != previousPID else { return 0 }; return fronts.filter { $0 == targetPID }.count }
	var returnFailed: Bool {
		let userTookOver = stopped == "user-input" || stopped == "another-front-app"
		return !userTookOver && (pendingReturn || (targetPID != nil && targetPID != previousPID && fronts.last == targetPID))
	}

	init(previousPID: pid_t) { self.previousPID = previousPID; fronts = [previousPID] }
	mutating func stop(_ reason: String) { stopped = stopped ?? reason }
	mutating func launched(_ pid: pid_t) {
		targetPID = pid
		if pid == previousPID { stopped = stopped ?? "already-frontmost" }
		else if fronts.contains(where: { $0 != previousPID && $0 != pid }) { stopped = stopped ?? "another-front-app" }
	}
	mutating func observe(front: pid_t, previousActive: Bool, previousWindowFocused: Bool, inputChanged: Bool, previousTerminated: Bool) {
		originalActive = previousActive
		if fronts.last != front { fronts.append(front) }
		// An observed user choice permanently ends restoration, including during launch.
		if inputChanged { stopped = stopped ?? "user-input" }
		if previousTerminated { stopped = stopped ?? "previous-app-exited" }
		if front == 0 { stopped = stopped ?? "front-app-unavailable" }
		if let targetPID, front != previousPID, front != targetPID { stopped = stopped ?? "another-front-app" }
		guard stopped == nil else { return }
		if pendingReturn, keyRequestSentForReturn, front == previousPID, previousActive, previousWindowFocused {
			gaveBack += 1
			pendingReturn = false
		}
	}
	func shouldRestore(at time: Double) -> Bool {
		stopped == nil && targetPID != nil && fronts.last == targetPID && time >= nextRequest
	}
	func shouldRestoreKey(at time: Double) -> Bool {
		stopped == nil && pendingReturn && originalActive && fronts.last == previousPID && time >= nextKeyRequest
	}
	mutating func requestedKey(at time: Double, sent: Bool) {
		keyRestoreRequests += 1
		if sent { keyRestorePairsSent += 1; keyRequestSentForReturn = true }
		nextKeyRequest = time + 0.25
	}
	mutating func requested(at time: Double) {
		restoreRequests += 1
		pendingReturn = true
		keyRequestSentForReturn = false
		nextRequest = time + 0.25
	}
}

private typealias ProcessForPID = @convention(c) (Int32, UnsafeMutableRawPointer) -> Int32
private typealias SetFrontProcess = @convention(c) (UnsafeMutableRawPointer, UInt32, UInt32) -> Int32
private typealias PostRecord = @convention(c) (UnsafeMutableRawPointer, UnsafeRawPointer) -> Int32
private typealias ElementWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

private struct ForegroundRestorer {
	let processForPID: ProcessForPID?
	let setFront: SetFrontProcess?
	let postRecord: PostRecord?
	let elementWindow: ElementWindow?
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
		elementWindow = load(services, "_AXUIElementGetWindow")
	}
	// AXFocusedWindow is the application's key window, not merely its main or
	// frontmost window. Missing permission/readback is unknown; never ask for TCC.
	func focusedWindow(_ pid: pid_t) -> CGWindowID? {
		guard let elementWindow else { return nil }
		let app = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(app, 0.05)
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
			let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
		var window: CGWindowID = 0
		guard elementWindow(value as! AXUIElement, &window) == .success, window != 0, windowOwner(window) == pid else { return nil }
		return window
	}
	func restoreKey(_ previous: NSRunningApplication, window: CGWindowID, stillAllowed: () -> Bool) -> Bool {
		guard let processForPID, let postRecord, window != 0 else { return false }
		var serial = [UInt32](repeating: 0, count: 2)
		return serial.withUnsafeMutableBytes { bytes -> Bool in
			guard let address = bytes.baseAddress, processForPID(previous.processIdentifier, address) == 0 else { return false }
			// WindowServer make-key pair used by yabai; only address the window
			// that was independently read as key before startup. Never AXRaise.
			var record = [UInt8](repeating: 0, count: 0xf8)
			record[4] = 0xf8; record[0x3a] = 0x10
			for index in 0..<4 { record[0x3c + index] = UInt8(truncatingIfNeeded: window >> (index * 8)) }
			for index in 0x20..<0x30 { record[index] = 0xff }
			for kind: UInt8 in [1, 2] {
				guard !previous.isTerminated, windowOwner(window) == previous.processIdentifier, stillAllowed() else { return false }
				record[8] = kind
				let status = record.withUnsafeBytes { data -> Int32 in
					guard let base = data.baseAddress else { return -1 }
					return postRecord(address, base)
				}
				if status != 0 { return false }
			}
			return true
		}
	}
	func restore(_ previous: NSRunningApplication, window: CGWindowID, stillAllowed: () -> Bool) {
		if let processForPID, let setFront, window != 0 {
			var serial = [UInt32](repeating: 0, count: 2)
			let sent = serial.withUnsafeMutableBytes { bytes -> Bool in
				guard let address = bytes.baseAddress, processForPID(previous.processIdentifier, address) == 0,
					!previous.isTerminated, windowOwner(window) == previous.processIdentifier, stillAllowed() else { return false }
				// WindowServer request also used by yabai. It works from an unrelated
				// background launcher; cooperative AppKit activation need not do so.
				return setFront(address, window, 0x200) == 0
			}
			if sent { return }
		}
		// Keep older systems/apps usable if the private entry point is unavailable.
		// AppKit's Boolean only acknowledges the request; observe the result later.
		if !previous.isTerminated, stillAllowed() { _ = previous.activate(options: []) }
	}
}

private func windowList() -> [[String: Any]] {
	CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}
private func windowOwner(_ window: CGWindowID) -> pid_t? {
	windowList().first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window }
		.flatMap { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value }
}
private func inputCounters() -> [UInt32] {
	[CGEventType.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
	 .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .keyDown, .keyUp, .flagsChanged, .scrollWheel].map {
		CGEventSource.counterForEventType(.hidSystemState, eventType: $0)
	}
}

/** Set from stdin's reader when the caller reports that the app finished starting. */
private final class ReadySignal: @unchecked Sendable {
	private let lock = NSLock()
	private var buffer = Data(), ready = false
	func take(_ data: Data) { lock.lock(); buffer.append(data); if buffer.split(separator: 10).contains(where: { String(decoding: $0, as: UTF8.self) == "ready" }) { ready = true }; if buffer.count > 4096 { buffer.removeAll() }; lock.unlock() }
	var isReady: Bool { lock.lock(); defer { lock.unlock() }; return ready }
}

private final class Outcome: @unchecked Sendable {
	private let lock = NSLock()
	private var value: Result<NSRunningApplication, Error>?
	func finish(_ result: Result<NSRunningApplication, Error>) { lock.lock(); value = result; lock.unlock() }
	func result() -> Result<NSRunningApplication, Error>? { lock.lock(); defer { lock.unlock() }; return value }
}

private func fail(_ message: String) -> Never {
	FileHandle.standardError.write(Data((message + "\n").utf8))
	exit(1)
}

#if !LAUNCH_APP_TEST
@main
struct LaunchApp {
	static func main() {
		var args = Array(CommandLine.arguments.dropFirst())
		let newInstance = args.first == "--new"
		if newInstance { args.removeFirst() }
		var watch = 0.0
		if args.first == "--watch", args.count > 1, let seconds = Double(args[1]), seconds >= 0, seconds <= 30 { watch = seconds; args.removeFirst(2) }
		var settle: Double?
		if args.first == "--settle", args.count > 1, let seconds = Double(args[1]), seconds >= 0, seconds <= 30 { settle = seconds; args.removeFirst(2) }
		guard let path = args.first, path.hasSuffix(".app") else { fail("usage: launch-app [--new] [--watch <seconds>] [--settle <seconds>] <app bundle path> [arguments...]") }
		let readySignal = ReadySignal()
		if settle != nil {
			FileHandle.standardInput.readabilityHandler = { handle in
				let data = handle.availableData
				if data.isEmpty { handle.readabilityHandler = nil } else { readySignal.take(data) }
			}
		}
		let url = URL(fileURLWithPath: path)
		guard let bundle = Bundle(url: url) else { fail("no app bundle at \(path)") }
		let applicationArguments = Array(args.dropFirst())
		if let refusal = chromiumLaunchRefusal(bundleIdentifier: bundle.bundleIdentifier, arguments: applicationArguments) {
			if let data = try? JSONEncoder().encode(refusal) {
				FileHandle.standardOutput.write(data + Data("\n".utf8))
			}
			FileHandle.standardError.write(Data((refusal.error + "\n").utf8))
			exit(2)
		}
		let previous = NSWorkspace.shared.frontmostApplication
		let previousPID = previous?.processIdentifier
		let restorer = ForegroundRestorer()
		let originalInput = inputCounters(), window = previous.flatMap { restorer.focusedWindow($0.processIdentifier) } ?? 0
		var focus = previous.map { LaunchFocusWatch(previousPID: $0.processIdentifier) }

		let configuration = NSWorkspace.OpenConfiguration()
		configuration.activates = false
		configuration.addsToRecentItems = false
		configuration.promptsUserIfNeeded = false
		configuration.createsNewApplicationInstance = newInstance
		configuration.arguments = applicationArguments
		let outcome = Outcome(), deadline = ProcessInfo.processInfo.systemUptime + 15
		NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
			if let app { outcome.finish(.success(app)) }
			else { outcome.finish(.failure(error ?? NSError(domain: "launch-app", code: 1, userInfo: [NSLocalizedDescriptionKey: "the app did not start"]))) }
		}
		var pid: pid_t?, launched: NSRunningApplication?, watchEnd = 0.0, settled = false
		while true {
			let now = ProcessInfo.processInfo.systemUptime
			// The caller saw the app finish starting: keep watching only for the quiet period.
			if pid != nil, !settled, let settle, readySignal.isReady { settled = true; watchEnd = min(watchEnd, now + settle) }
			if pid == nil, let result = outcome.result() {
				switch result {
				case .success(let app):
					let launchedPID = app.processIdentifier
					launched = app
					pid = launchedPID; focus?.launched(launchedPID); watchEnd = now + watch
					print("{\"pid\":\(launchedPID)}"); fflush(stdout)
				case .failure(let error): fail(error.localizedDescription)
				}
			}
			let focusedWindow = NSWorkspace.shared.frontmostApplication?.processIdentifier == previousPID
				? previous.flatMap { restorer.focusedWindow($0.processIdentifier) } : nil
			focus?.observe(front: NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
				previousActive: previous?.isActive ?? false, previousWindowFocused: window != 0 && focusedWindow == window, inputChanged: inputCounters() != originalInput,
				previousTerminated: previous?.isTerminated != false || previous?.processIdentifier != previousPID)
			if let launched, launched.isTerminated || launched.processIdentifier != pid { focus?.stop("launched-app-exited") }
			if pid == nil, now >= deadline { fail("the app did not start within 15 seconds") }
			if pid != nil, now >= watchEnd || focus?.stopped != nil || previous == nil { break }
			if let pid, let previous, let launched, focus?.shouldRestore(at: now) == true {
				// Recheck immediately before a request. Any user activity or different
				// front app cancels restoration instead of overwriting their choice.
				let allowed = {
					!previous.isTerminated && previous.processIdentifier == previousPID && !launched.isTerminated && launched.processIdentifier == pid &&
					inputCounters() == originalInput && NSWorkspace.shared.frontmostApplication?.isEqual(launched) == true
				}
				if allowed() {
					focus?.requested(at: now)
					restorer.restore(previous, window: window, stillAllowed: allowed)
				}
			}
			if let previous, focus?.shouldRestoreKey(at: now) == true, window != 0 {
				if let focusedWindow, focusedWindow != window { focus?.stop("previous-window-changed") }
				else {
					let allowed = {
						let focused = restorer.focusedWindow(previous.processIdentifier)
						return (focused.map { $0 == window } ?? true) &&
							!previous.isTerminated && previous.processIdentifier == previousPID && previous.isActive &&
							inputCounters() == originalInput && NSWorkspace.shared.frontmostApplication?.isEqual(previous) == true
					}
					if allowed() {
						let sent = restorer.restoreKey(previous, window: window, stillAllowed: allowed)
						focus?.requestedKey(at: now, sent: sent)
					}
				}
			}
			RunLoop.current.run(until: Date().addingTimeInterval(0.02))
		}
		guard let pid else { fail("the app did not start") }
		let result: [String: Any] = ["pid": pid, "originalWindow": window, "gaveBack": focus?.gaveBack ?? 0, "frontTaken": focus?.frontTaken ?? 0,
			"restoreRequests": focus?.restoreRequests ?? 0, "keyRestoreRequests": focus?.keyRestoreRequests ?? 0,
			"keyRestorePairsSent": focus?.keyRestorePairsSent ?? 0, "returnFailed": focus?.returnFailed ?? false,
			"watchStopped": focus?.stopped as Any? ?? NSNull()]
		if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
			FileHandle.standardOutput.write(data + Data("\n".utf8))
		}
	}
}
#endif
