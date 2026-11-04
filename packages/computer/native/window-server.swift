// mountains-window-server: window images, keeping driven web windows visible, and native popup choices.
// Never activates, raises or moves a window, and never posts keyboard or pointer events.
//
// The private WindowServer entry points below and their argument shapes follow open-computer-use (MIT,
// SkyLightSPI.swift / WindowOcclusionKeepAlive.swift) and cua-driver (MIT, set_value.rs). This is a rewrite.
//
// Input, one JSON object per line, with an "id" and an "op":
//   {"op":"capture","window":123,"file":"/path.png"}                 -> {"width":..,"height":..,"capturedAt":..}
//   {"op":"keep_visible","pid":42,"window":123,"exclude":[pids]}     -> {"pinned":true|false,"reason":".."}
//   {"op":"popup_select","pid":42,"window":123,"bounds":{x,y,width,height},"choice":"Text"}
//                                                                    -> {"changed":..,"value":..,"openMs":..,"closed":..}
//   {"op":"release_all"}
// Output: {"id":..,"ok":true,...} or {"id":..,"ok":false,"error":"..","code":".."}. End of input restores pinned windows.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

typealias MainConnection = @convention(c) () -> UInt32
typealias HardwareCapture = @convention(c) (UInt32, UnsafePointer<CGWindowID>, Int32, UInt32) -> Unmanaged<CFArray>?
typealias EnableOcclusionNotifications = @convention(c) (UInt32, CGWindowID, UInt8, UnsafeMutablePointer<UInt8>?) -> Int32
typealias ElementWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
typealias CopySpacesForWindows = @convention(c) (UInt32, Int32, CFArray) -> Unmanaged<CFArray>?

struct Failure: Error { let message: String; let code: String }

struct WindowServerAPI {
	let mainConnection: MainConnection?
	let hardwareCapture: HardwareCapture?
	let enableOcclusion: EnableOcclusionNotifications?
	let elementWindow: ElementWindow?
	let spacesForWindows: CopySpacesForWindows?

	init() {
		let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
		let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
		func symbol<T>(_ handle: UnsafeMutableRawPointer?, _ name: String) -> T? {
			guard let handle, let pointer = dlsym(handle, name) else { return nil }
			return unsafeBitCast(pointer, to: T.self)
		}
		mainConnection = symbol(sky, "SLSMainConnectionID")
		hardwareCapture = symbol(sky, "SLSHWCaptureWindowList")
		enableOcclusion = symbol(sky, "SLSPackagesEnableWindowOcclusionNotifications")
		elementWindow = symbol(services, "_AXUIElementGetWindow")
		spacesForWindows = symbol(sky, "SLSCopySpacesForWindows")
	}

	/// True when the window is on a desktop (Space) other than the one shown now. A read-only query: nothing moves.
	/// Mask 7 asks for every Space the window is on, 5 for the current ones; an ordered-out window is on none.
	func onOtherSpace(_ window: CGWindowID) -> Bool {
		guard let mainConnection, let spacesForWindows else { return false }
		let ids = [NSNumber(value: window)] as CFArray
		func count(_ mask: Int32) -> Int { spacesForWindows(mainConnection(), mask, ids).map { CFArrayGetCount($0.takeRetainedValue()) } ?? 0 }
		return count(7) > 0 && count(5) == 0
	}

	/// The window's backing store, read by WindowServer: covered windows and windows on another Space work too.
	/// Option 0x800 leaves out the global clip shape.
	func capture(_ window: CGWindowID) -> CGImage? {
		guard let mainConnection, let hardwareCapture else { return nil }
		var id = window
		guard let list = hardwareCapture(mainConnection(), &id, 1, 0x800)?.takeRetainedValue(), CFArrayGetCount(list) > 0 else { return nil }
		// The list owns its images: take our own reference (and a copy) before the list goes away.
		guard let raw = CFArrayGetValueAtIndex(list, 0) else { return nil }
		let borrowed = Unmanaged<CGImage>.fromOpaque(raw).takeUnretainedValue()
		guard let image = borrowed.copy(), image.width > 0, image.height > 0 else { return nil }
		return image
	}

	/// Returns the previous state. Turning notifications off pins the app's idea of the window at what it is now.
	func setOcclusionNotifications(_ enabled: Bool, _ window: CGWindowID) throws -> Bool {
		guard let mainConnection, let enableOcclusion else { throw Failure(message: "occlusion control is unavailable on this macOS", code: "unavailable") }
		var previous: UInt8 = 0
		let status = enableOcclusion(mainConnection(), window, enabled ? 1 : 0, &previous)
		guard status == 0 else { throw Failure(message: "WindowServer refused the occlusion change (\(status))", code: "refused") }
		return previous != 0
	}

	func window(of element: AXUIElement) -> CGWindowID? {
		guard let elementWindow else { return nil }
		var id: CGWindowID = 0
		return elementWindow(element, &id) == .success && id != 0 ? id : nil
	}
}

func now() -> Double { Date().timeIntervalSince1970 * 1000 }

func reply(_ value: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
	FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func save(_ image: CGImage, _ path: String) throws {
	guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
		throw Failure(message: "cannot create the image file", code: "io")
	}
	CGImageDestinationAddImage(destination, image, nil)
	guard CGImageDestinationFinalize(destination) else { throw Failure(message: "cannot write the image", code: "io") }
}

// MARK: Accessibility helpers

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
	var value: CFTypeRef?
	return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
	guard let value = attribute(element, name) else { return "" }
	if let string = value as? String { return string }
	if let number = value as? NSNumber { return number.stringValue }
	return ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
	guard let value = attribute(element, kAXChildrenAttribute), CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
	return (value as! [AnyObject]).map { $0 as! AXUIElement }
}
func frame(_ element: AXUIElement) -> CGRect? {
	guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute),
		CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
	var point = CGPoint.zero, extent = CGSize.zero
	guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
	return CGRect(origin: point, size: extent)
}
func same(_ a: String, _ b: String) -> Bool {
	a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == b.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

// MARK: Keeping web windows visible

/// Web engines (Chromium, Electron, CEF, WebKit) stop drawing a page and drop its accessibility subtree once
/// WindowServer says the window is covered. Native AppKit windows keep working, so they are left alone.
func usesWebEngine(_ pid: pid_t) -> Bool {
	guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
	if let id = app.bundleIdentifier, id.hasPrefix("com.apple.Safari") { return true }
	guard let bundle = app.bundleURL else { return false }
	let names = (try? FileManager.default.contentsOfDirectory(atPath: bundle.appendingPathComponent("Contents/Frameworks").path)) ?? []
	return names.contains { let name = $0.lowercased(); return name.contains("chrom") || name.contains("electron") || name.contains("cef") }
}

func windowInfo(_ options: CGWindowListOption, _ window: CGWindowID) -> [[String: Any]] {
	(CGWindowListCopyWindowInfo(options, window) as? [[String: Any]]) ?? []
}
func bounds(_ info: [String: Any]) -> CGRect? {
	guard let dictionary = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
	return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
}

/// At least one point of a 16x16 grid over the window is not under another normal window. Pinning a window that
/// is already covered would freeze it hidden, so that is refused.
func looksUncovered(_ window: CGWindowID, excluding: Set<Int>) -> Bool {
	guard let mine = windowInfo(.optionIncludingWindow, window).first, let area = bounds(mine), area.width > 0, area.height > 0 else { return false }
	let covering = windowInfo(.optionOnScreenAboveWindow, window).compactMap { info -> CGRect? in
		let layer = info[kCGWindowLayer as String] as? Int ?? 0, alpha = info[kCGWindowAlpha as String] as? Double ?? 1
		let owner = info[kCGWindowOwnerPID as String] as? Int ?? 0, number = info[kCGWindowNumber as String] as? Int ?? 0
		guard layer == 0, alpha > 0, number != Int(window), !excluding.contains(owner) else { return nil }
		return bounds(info)
	}
	for row in 0..<16 { for column in 0..<16 {
		let point = CGPoint(x: area.minX + area.width * (Double(column) + 0.5) / 16, y: area.minY + area.height * (Double(row) + 0.5) / 16)
		if !covering.contains(where: { $0.contains(point) }) { return true }
	} }
	return false
}

// MARK: Native popup choices

func findWindow(_ api: WindowServerAPI, pid: pid_t, window: CGWindowID) -> AXUIElement? {
	let app = AXUIElementCreateApplication(pid)
	guard let list = attribute(app, kAXWindowsAttribute), CFGetTypeID(list) == CFArrayGetTypeID() else { return nil }
	var pending = (list as! [AnyObject]).map { $0 as! AXUIElement }, index = 0
	while index < pending.count && index < 128 {
		let candidate = pending[index]; index += 1
		if api.window(of: candidate) == window { return candidate }
		pending += children(candidate).filter { text($0, kAXRoleAttribute) == "AXSheet" }
	}
	return nil
}

/// The one popup button at the observed place in the exact window.
func findPopup(in root: AXUIElement, at expected: CGRect) throws -> AXUIElement {
	var pending = [root], index = 0, found: [AXUIElement] = []
	while index < pending.count {
		if index >= 4000 { throw Failure(message: "window is too large to find the popup safely; no choice was sent", code: "incomplete") }
		let element = pending[index]; index += 1
		if text(element, kAXRoleAttribute) == "AXPopUpButton", let place = frame(element),
			abs(place.minX - expected.minX) <= 1, abs(place.minY - expected.minY) <= 1, abs(place.width - expected.width) <= 1, abs(place.height - expected.height) <= 1 {
			found.append(element)
		}
		pending += children(element)
	}
	guard found.count == 1 else { throw Failure(message: found.isEmpty ? "the popup is no longer at its observed place; read the window again" : "several popups share that place; no choice was sent", code: "target") }
	return found[0]
}

/// Choices while the menu is open: the items of an AXMenu child (AppKit, Chromium), or titled direct children.
func options(_ popup: AXUIElement) -> [AXUIElement] {
	var result: [AXUIElement] = []
	for child in children(popup) {
		if text(child, kAXRoleAttribute) == "AXMenu" { result += children(child) } else { result.append(child) }
	}
	return result.filter { !text($0, kAXTitleAttribute).isEmpty || !text($0, kAXValueAttribute).isEmpty }
}
func menuIsOpen(_ popup: AXUIElement) -> Bool {
	children(popup).contains { text($0, kAXRoleAttribute) == "AXMenu" && !children($0).isEmpty }
}
func current(_ popup: AXUIElement) -> String {
	let value = text(popup, kAXValueAttribute)
	return value.isEmpty ? text(popup, kAXTitleAttribute) : value
}
/** A JSON number as Double, whatever Foundation decoded it as. */
func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }
func pause(_ milliseconds: Double) { Thread.sleep(forTimeInterval: milliseconds / 1000) }

func popupSelect(_ api: WindowServerAPI, pid: pid_t, window: CGWindowID, bounds expected: CGRect, choice: String) throws -> [String: Any] {
	guard let root = findWindow(api, pid: pid, window: window) else { throw Failure(message: "the exact window is gone; read again", code: "target") }
	let popup = try findPopup(in: root, at: expected)
	if same(current(popup), choice) { return ["changed": false, "value": current(popup), "openMs": 0, "totalMs": 0, "closed": true] }
	let started = now()
	// The app runs its menu-tracking loop inside this press, so the call would otherwise wait for the full
	// accessibility timeout with the menu already open, holding the user's keyboard all that time.
	AXUIElementSetMessagingTimeout(popup, 0.5)
	defer { AXUIElementSetMessagingTimeout(popup, 0) }
	_ = AXUIElementPerformAction(popup, kAXPressAction as CFString)
	var items: [AXUIElement] = [], previous = -1, steady = 0
	while now() - started < 2500 {
		items = options(popup)
		if !items.isEmpty && items.count == previous { steady += 1; if steady >= 2 { break } } else { steady = 0 }
		previous = items.count
		pause(40)
	}
	let opened = now() - started
	func close() -> Bool {
		for child in children(popup) where text(child, kAXRoleAttribute) == "AXMenu" { _ = AXUIElementPerformAction(child, kAXCancelAction as CFString) }
		let until = now() + 300
		while menuIsOpen(popup) && now() < until { pause(30) }
		return !menuIsOpen(popup)
	}
	let matches = items.filter { same(text($0, kAXTitleAttribute), choice) || same(text($0, kAXValueAttribute), choice) }
	guard matches.count == 1 else {
		let listed = items.map { text($0, kAXTitleAttribute).isEmpty ? text($0, kAXValueAttribute) : text($0, kAXTitleAttribute) }
		let closed = close()
		throw Failure(message: matches.isEmpty
			? "no choice \(choice) in this popup\(listed.isEmpty ? "" : "; it lists \(listed.prefix(40).map { "\"\($0)\"" }.joined(separator: ", "))")\(closed ? "" : "; its menu did not close")"
			: "several choices are named \(choice); no choice was sent", code: matches.isEmpty ? "missing" : "ambiguous")
	}
	if let enabled = attribute(matches[0], kAXEnabledAttribute) as? Bool, !enabled { _ = close(); throw Failure(message: "that choice is disabled; no choice was sent", code: "disabled") }
	AXUIElementSetMessagingTimeout(matches[0], 1)
	_ = AXUIElementPerformAction(matches[0], kAXPressAction as CFString)
	let until = now() + 500
	while menuIsOpen(popup) && now() < until { pause(30) }
	let closed = menuIsOpen(popup) ? close() : true
	return ["changed": true, "value": current(popup), "openMs": Int(opened), "totalMs": Int(now() - started), "closed": closed]
}

// MARK: Menu bar status items (Wi-Fi, VPN, input method, third-party icons)

struct StatusItem { let pid: pid_t; let app: String; let index: Int; let element: AXUIElement }

/// Every app's AXExtrasMenuBar items, left to right. Mountains' own processes are left out.
func statusItems(excluding: Set<Int>) -> [StatusItem] {
	var items: [StatusItem] = []
	for app in NSWorkspace.shared.runningApplications where !excluding.contains(Int(app.processIdentifier)) {
		let element = AXUIElementCreateApplication(app.processIdentifier)
		AXUIElementSetMessagingTimeout(element, 0.1)
		guard let bar = attribute(element, "AXExtrasMenuBar") else { continue }
		let barElement = bar as! AXUIElement
		for (index, child) in children(barElement).enumerated() {
			items.append(StatusItem(pid: app.processIdentifier, app: app.localizedName ?? app.bundleIdentifier ?? "app \(app.processIdentifier)", index: index, element: child))
		}
	}
	return items.sorted { (frame($0.element)?.minX ?? 0) < (frame($1.element)?.minX ?? 0) }
}
func describe(_ item: StatusItem) -> [String: Any] {
	var out: [String: Any] = ["pid": Int(item.pid), "app": item.app, "index": item.index,
		"title": text(item.element, kAXTitleAttribute), "description": text(item.element, kAXDescriptionAttribute), "help": text(item.element, kAXHelpAttribute)]
	if let place = frame(item.element) { out["bounds"] = ["x": place.minX, "y": place.minY, "width": place.width, "height": place.height] }
	return out
}
func menuOf(_ element: AXUIElement) -> AXUIElement? {
	children(element).first { text($0, kAXRoleAttribute) == "AXMenu" && !children($0).isEmpty }
}
func menuLines(_ menu: AXUIElement, depth: Int = 0) -> [String] {
	var lines: [String] = []
	for item in children(menu) where text(item, kAXRoleAttribute) == "AXMenuItem" {
		let title = text(item, kAXTitleAttribute)
		if title.isEmpty { continue }
		let enabled = (attribute(item, kAXEnabledAttribute) as? Bool) ?? true, mark = text(item, "AXMenuItemMarkChar")
		let submenu = children(item).first { text($0, kAXRoleAttribute) == "AXMenu" }
		lines.append(String(repeating: "  ", count: depth) + title + (mark.isEmpty ? "" : " [\(mark)]") + (enabled ? "" : " [disabled]") + (submenu != nil ? " >" : ""))
	}
	return lines
}
func closeMenu(_ owner: AXUIElement) -> Bool {
	if let menu = menuOf(owner) { _ = AXUIElementPerformAction(menu, kAXCancelAction as CFString) }
	let until = now() + 400
	while menuOf(owner) != nil && now() < until { pause(30) }
	return menuOf(owner) == nil
}

/// Open one status item. With no path, list its menu and close it again. With a path, choose that item
/// (submenus by title, case-insensitive) and make sure the menu closed. An item that opens a window instead of a
/// menu (Control Center modules) is reported as such; read that app's windows next.
func statusItemAction(_ item: StatusItem, path: [String]) throws -> [String: Any] {
	let started = now()
	AXUIElementSetMessagingTimeout(item.element, 0.5)
	defer { AXUIElementSetMessagingTimeout(item.element, 0) }
	_ = AXUIElementPerformAction(item.element, kAXPressAction as CFString)
	var menu: AXUIElement?
	while menu == nil && now() - started < 1500 { menu = menuOf(item.element); if menu == nil { pause(40) } }
	guard var current = menu else { return ["kind": "window", "app": item.app, "pid": Int(item.pid), "totalMs": Int(now() - started)] }
	if path.isEmpty {
		let lines = menuLines(current)
		return ["kind": "menu", "items": lines, "closed": closeMenu(item.element), "totalMs": Int(now() - started)]
	}
	for (step, wanted) in path.enumerated() {
		let matches = children(current).filter { text($0, kAXRoleAttribute) == "AXMenuItem" && same(text($0, kAXTitleAttribute), wanted) }
		guard matches.count == 1 else {
			let listed = menuLines(current); let closed = closeMenu(item.element)
			throw Failure(message: (matches.isEmpty ? "no menu item \(wanted)" : "several menu items are named \(wanted)") + "; it lists \(listed.prefix(40).joined(separator: " | "))" + (closed ? "" : "; the menu did not close"), code: matches.isEmpty ? "missing" : "ambiguous")
		}
		let target = matches[0]
		if let enabled = attribute(target, kAXEnabledAttribute) as? Bool, !enabled { _ = closeMenu(item.element); throw Failure(message: "\(wanted) is disabled; nothing was chosen", code: "disabled") }
		if step < path.count - 1 {
			AXUIElementSetMessagingTimeout(target, 0.5)
			_ = AXUIElementPerformAction(target, kAXPressAction as CFString)
			var sub: AXUIElement?
			let until = now() + 1000
			while sub == nil && now() < until { sub = children(target).first { text($0, kAXRoleAttribute) == "AXMenu" && !children($0).isEmpty }; if sub == nil { pause(40) } }
			guard let next = sub else { _ = closeMenu(item.element); throw Failure(message: "\(wanted) has no submenu", code: "missing") }
			current = next
		} else {
			AXUIElementSetMessagingTimeout(target, 1)
			_ = AXUIElementPerformAction(target, kAXPressAction as CFString)
		}
	}
	let until = now() + 500
	while menuOf(item.element) != nil && now() < until { pause(30) }
	let closed = menuOf(item.element) == nil ? true : closeMenu(item.element)
	return ["kind": "chosen", "closed": closed, "totalMs": Int(now() - started)]
}

// MARK: Loop

@main
struct WindowServer {
	static func main() {
		let api = WindowServerAPI()
		var pinned: [CGWindowID: Bool] = [:]
		// Pins live in WindowServer, not in this process: keep a record so a crashed server's pins are put back
		// by the next one. One file per user; only windows that still exist are touched.
		let record = (ProcessInfo.processInfo.environment["MOUNTAINS_HOME"] ?? (NSHomeDirectory() + "/.mountains")) + "/window-server-pins.json"
		func persist() {
			let rows = pinned.map { ["window": Int($0.key), "previous": $0.value] as [String: Any] }
			try? FileManager.default.createDirectory(atPath: (record as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
			if let data = try? JSONSerialization.data(withJSONObject: rows) { FileManager.default.createFile(atPath: record, contents: data, attributes: [.posixPermissions: 0o600]) }
		}
		if let data = FileManager.default.contents(atPath: record), let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
			for row in rows { if let w = number(row["window"]), let previous = row["previous"] as? Bool { _ = try? api.setOcclusionNotifications(previous, CGWindowID(w)) } }
			try? FileManager.default.removeItem(atPath: record)
		}
		func releaseAll() {
			for (window, previous) in Array(pinned) { if (try? api.setOcclusionNotifications(previous, window)) != nil { pinned[window] = nil } }
			if pinned.isEmpty { try? FileManager.default.removeItem(atPath: record) } else { persist() }
		}
		while let line = readLine() {
			guard let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
			let id = command["id"] ?? NSNull()
			do {
				var result: [String: Any]
				switch command["op"] as? String {
				case "capture":
					guard let window = command["window"] as? Int, let file = command["file"] as? String else { throw Failure(message: "capture needs a window and a file", code: "usage") }
					guard let image = api.capture(CGWindowID(window)) else { throw Failure(message: "hardware window capture is unavailable", code: "unavailable") }
					try save(image, file)
					result = ["width": image.width, "height": image.height, "capturedAt": now()]
				case "keep_visible":
					guard let pid = command["pid"] as? Int, let number = command["window"] as? Int else { throw Failure(message: "keep_visible needs a pid and a window", code: "usage") }
					let window = CGWindowID(number)
					if pinned[window] != nil { result = ["pinned": true, "reason": "already"] }
					else if !usesWebEngine(pid_t(pid)) { result = ["pinned": false, "reason": "not_web"] }
					else if !looksUncovered(window, excluding: Set((command["exclude"] as? [Int]) ?? [])) { result = ["pinned": false, "reason": "covered"] }
					else { pinned[window] = try api.setOcclusionNotifications(false, window); persist(); result = ["pinned": true, "reason": "pinned"] }
				case "popup_select":
					guard let pid = command["pid"] as? Int, let window = command["window"] as? Int, let choice = command["choice"] as? String,
						let b = command["bounds"] as? [String: Any], let x = number(b["x"]), let y = number(b["y"]), let width = number(b["width"]), let height = number(b["height"]) else {
						throw Failure(message: "popup_select needs a pid, window, bounds and choice", code: "usage")
					}
					result = try popupSelect(api, pid: pid_t(pid), window: CGWindowID(window), bounds: CGRect(x: x, y: y, width: width, height: height), choice: choice)
				case "menubar_list":
					result = ["items": statusItems(excluding: Set((command["exclude"] as? [Int]) ?? [])).map(describe)]
				case "menubar_action":
					guard let pid = command["pid"] as? Int, let index = command["index"] as? Int else { throw Failure(message: "menubar_action needs a pid and an index", code: "usage") }
					let path = (command["path"] as? [String]) ?? []
					let element = AXUIElementCreateApplication(pid_t(pid))
					guard let bar = attribute(element, "AXExtrasMenuBar") else { throw Failure(message: "that app has no menu bar items now; list them again", code: "target") }
					let items = children(bar as! AXUIElement)
					guard index >= 0, index < items.count else { throw Failure(message: "that menu bar item is gone; list them again", code: "target") }
					let item = StatusItem(pid: pid_t(pid), app: NSRunningApplication(processIdentifier: pid_t(pid))?.localizedName ?? "app", index: index, element: items[index])
					if let expected = command["description"] as? String, !expected.isEmpty, !same(text(item.element, kAXDescriptionAttribute), expected) && !same(text(item.element, kAXTitleAttribute), expected) {
						throw Failure(message: "the menu bar item changed since it was listed; list them again", code: "target")
					}
					result = try statusItemAction(item, path: path)
				case "windows_offscreen":
					// Windows of an app that are not on this screen: minimized, or on another desktop (Space).
					guard let pid = command["pid"] as? Int else { throw Failure(message: "windows_offscreen needs a pid", code: "usage") }
					let app = AXUIElementCreateApplication(pid_t(pid))
					AXUIElementSetMessagingTimeout(app, 1)
					let listed = (attribute(app, kAXWindowsAttribute) as? [AnyObject] ?? []).map { $0 as! AXUIElement }
					let onScreen = Set(windowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID).compactMap { info -> Int? in
						(info[kCGWindowOwnerPID as String] as? Int) == pid ? info[kCGWindowNumber as String] as? Int : nil })
					var hidden: [[String: Any]] = []
					for window in listed {
						let minimized = (attribute(window, kAXMinimizedAttribute) as? Bool) == true
						let number = api.window(of: window).map(Int.init)
						if minimized || (number != nil && !onScreen.contains(number!)) { hidden.append(["title": text(window, kAXTitleAttribute), "minimized": minimized]) }
					}
					// A window on another desktop is missing from AXWindows altogether; the window server still lists it.
					let known = Set(listed.compactMap { api.window(of: $0) }.map(Int.init))
					for info in windowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) where (info[kCGWindowOwnerPID as String] as? Int) == pid && (info[kCGWindowLayer as String] as? Int) == 0 {
						guard let number = info[kCGWindowNumber as String] as? Int, !known.contains(number), let frame = bounds(info), frame.width >= 50, frame.height >= 50, api.onOtherSpace(CGWindowID(number)) else { continue }
						hidden.append(["title": info[kCGWindowName as String] as? String ?? "", "minimized": false])
					}
					result = ["windows": hidden]
				case "unminimize":
					guard let pid = command["pid"] as? Int, let title = command["title"] as? String else { throw Failure(message: "unminimize needs a pid and a title", code: "usage") }
					let app = AXUIElementCreateApplication(pid_t(pid))
					let windows = (attribute(app, kAXWindowsAttribute) as? [AnyObject] ?? []).map { $0 as! AXUIElement }
						.filter { (attribute($0, kAXMinimizedAttribute) as? Bool) == true && same(text($0, kAXTitleAttribute), title) }
					guard windows.count == 1 else { throw Failure(message: windows.isEmpty ? "no minimized window titled \(title)" : "several minimized windows are titled \(title)", code: windows.isEmpty ? "missing" : "ambiguous") }
					AXUIElementSetMessagingTimeout(windows[0], 1)
					let status = AXUIElementSetAttributeValue(windows[0], kAXMinimizedAttribute as CFString, kCFBooleanFalse)
					guard status == .success else { throw Failure(message: "the app refused to restore the window (\(status.rawValue))", code: "refused") }
					let until = now() + 2000
					while (attribute(windows[0], kAXMinimizedAttribute) as? Bool) == true && now() < until { pause(50) }
					result = ["restored": (attribute(windows[0], kAXMinimizedAttribute) as? Bool) != true]
				case "panel_field", "panel_press":
					// An element of a file panel by its identifier (saveAsNameTextField, OKButton). Breadth first with
					// short per-request timeouts: an expanded panel's file browser can stall accessibility reads.
					guard let pid = command["pid"] as? Int, let number = number(command["window"]), let identifier = command["identifier"] as? String else { throw Failure(message: "panel_field needs a pid, a window and an identifier", code: "usage") }
					guard let root = findWindow(api, pid: pid_t(pid), window: CGWindowID(number)) else { throw Failure(message: "the exact panel window is gone; read again", code: "target") }
					var pending = [root], index = 0, found: AXUIElement?
					while index < pending.count && index < 600 && found == nil {
						let element = pending[index]; index += 1
						AXUIElementSetMessagingTimeout(element, 0.5)
						if text(element, "AXIdentifier") == identifier { found = element; break }
						let role = text(element, kAXRoleAttribute)
						if role == "AXBrowser" || role == "AXOutline" || role == "AXTable" || role == "AXList" { continue }
						pending += children(element)
					}
					guard let element = found else { throw Failure(message: "the panel has no \(identifier)", code: "missing") }
					if command["op"] as? String == "panel_press" {
						if let enabled = attribute(element, kAXEnabledAttribute) as? Bool, !enabled { throw Failure(message: "\(identifier) is disabled; nothing was pressed", code: "disabled") }
						AXUIElementSetMessagingTimeout(element, 1)
						let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
						result = ["pressed": status == .success || status == .cannotComplete]
					} else {
						if let value = command["value"] as? String {
							let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
							guard status == .success else { throw Failure(message: "the panel refused the value (\(status.rawValue))", code: "refused") }
						}
						var read = text(element, kAXValueAttribute)
						if let value = command["value"] as? String { let until = now() + 800; while read != value && now() < until { pause(50); read = text(element, kAXValueAttribute) } }
						result = ["value": read]
					}
				case "display_name":
					guard let path = command["path"] as? String else { throw Failure(message: "display_name needs a path", code: "usage") }
					result = ["name": FileManager.default.displayName(atPath: path)]
				case "release_all":
					releaseAll(); result = ["remaining": pinned.count]
				default:
					throw Failure(message: "unknown command", code: "usage")
				}
				result["id"] = id; result["ok"] = true
				reply(result)
			} catch let failure as Failure {
				reply(["id": id, "ok": false, "error": failure.message, "code": failure.code])
			} catch {
				reply(["id": id, "ok": false, "error": error.localizedDescription, "code": "error"])
			}
		}
		releaseAll()
	}
}
