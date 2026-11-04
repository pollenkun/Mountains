// Two disposable apps for test/beta1-live.ts. Each writes its own state to a JSON file, independently of Mountains.
//   witness <state.json> <title>  stays in front with a focused text field and counts every time it loses
//                                 activation or its key window, and every other app that became active.
//   target  <state.json> <title>  a background window with a native popup, a text field and a label.
// Both exit when stdin closes, so a killed driver never leaves them behind.
import AppKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 4 else { FileHandle.standardError.write(Data("usage: beta1-apps witness|target state.json title\n".utf8)); exit(2) }
let mode = arguments[1], statePath = arguments[2], title = arguments[3]

func write(_ state: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) else { return }
	let temporary = statePath + ".tmp"
	FileManager.default.createFile(atPath: temporary, contents: data)
	_ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: statePath), withItemAt: URL(fileURLWithPath: temporary))
}
func now() -> Double { Date().timeIntervalSince1970 * 1000 }

final class Witness: NSObject, NSApplicationDelegate, NSWindowDelegate {
	let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 420, height: 160), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
	let field = NSTextField(frame: NSRect(x: 20, y: 60, width: 380, height: 28))
	var resignActive = 0, resignKey = 0, otherActivations: [[String: Any]] = [], events: [[String: Any]] = []
	func save() {
		write(["pid": Int(getpid()), "active": NSApp.isActive, "key": window.isKeyWindow, "fieldFocused": window.firstResponder === field.currentEditor(),
			"resignActive": resignActive, "resignKey": resignKey, "otherActivations": otherActivations, "events": events.suffix(50).map { $0 }])
	}
	func applicationDidFinishLaunching(_ notification: Notification) {
		window.title = title; window.delegate = self
		field.placeholderString = "the user's own field"
		window.contentView?.addSubview(field)
		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
		window.makeFirstResponder(field)
		let center = NSWorkspace.shared.notificationCenter
		center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
			guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier != getpid() else { return }
			self.otherActivations.append(["at": now(), "pid": Int(app.processIdentifier), "name": app.localizedName ?? ""]); self.save()
		}
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.save() }
		// The driver can ask the witness to cover a rectangle (screen points, top-left origin) with its window.
		Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
			guard let self, let data = FileManager.default.contents(atPath: statePath + ".cover"),
				let r = (try? JSONSerialization.jsonObject(with: data)) as? [String: Double], let x = r["x"], let y = r["y"], let w = r["width"], let h = r["height"] else { return }
			try? FileManager.default.removeItem(atPath: statePath + ".cover")
			let top = NSScreen.screens.first?.frame.height ?? 0
			self.window.setFrame(NSRect(x: x - 20, y: top - y - h - 20, width: w + 40, height: h + 60), display: true)
			// A newly shown inactive web window can sit above this still-frontmost app.
			// Establish real occlusion without activating any app or resetting focus evidence.
			self.window.orderFrontRegardless()
			self.events.append(["at": now(), "event": "covered"]); self.save()
		}
	}
	func applicationDidBecomeActive(_ notification: Notification) { events.append(["at": now(), "event": "becomeActive"]); save() }
	func applicationDidResignActive(_ notification: Notification) { resignActive += 1; events.append(["at": now(), "event": "resignActive"]); save() }
	func windowDidBecomeKey(_ notification: Notification) { events.append(["at": now(), "event": "becomeKey"]); save() }
	func windowDidResignKey(_ notification: Notification) { resignKey += 1; events.append(["at": now(), "event": "resignKey"]); save() }
}

final class Target: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
	let window = NSWindow(contentRect: NSRect(x: 560, y: 120, width: 420, height: 220), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
	let popup = NSPopUpButton(frame: NSRect(x: 20, y: 150, width: 160, height: 28), pullsDown: false)
	let field = NSTextField(frame: NSRect(x: 20, y: 100, width: 380, height: 28))
	let label = NSTextField(labelWithString: "Ready")
	let spare = NSWindow(contentRect: NSRect(x: 560, y: 380, width: 300, height: 120), styleMask: [.titled, .miniaturizable], backing: .buffered, defer: false)
	var status: NSStatusItem?
	var choice = "", saved = ""
	func save() { write(["pid": Int(getpid()), "active": NSApp.isActive, "size": popup.titleOfSelectedItem ?? "", "text": field.stringValue,
		"status": choice, "saved": saved, "spareMinimized": spare.isMiniaturized, "spareVisible": spare.isVisible]) }
	@objc func chooseA() { choice = "A"; save() }
	@objc func chooseB() { choice = "B"; save() }
	@objc func saveAs() {
		// The panel opens in this run's own folder, and writes only there: a test that goes wrong cannot put a
		// file anywhere else.
		let own = URL(fileURLWithPath: (statePath as NSString).deletingLastPathComponent).resolvingSymlinksInPath()
		let panel = NSSavePanel()
		panel.directoryURL = own
		panel.nameFieldStringValue = "Untitled.txt"
		panel.beginSheetModal(for: window) { response in
			if response == .OK, let url = panel.url {
				self.saved = url.path
				if url.resolvingSymlinksInPath().path.hasPrefix(own.path + "/") { try? "Beta1".write(to: url, atomically: true, encoding: .utf8) }
			}
			self.save()
		}
	}
	func applicationDidFinishLaunching(_ notification: Notification) {
		window.title = title
		popup.addItems(withTitles: ["Small", "Medium", "Large"])
		popup.target = self; popup.action = #selector(changed)
		popup.setAccessibilityLabel("Size")
		field.placeholderString = "Notes"; field.setAccessibilityLabel("Notes"); field.delegate = self
		label.frame = NSRect(x: 20, y: 40, width: 380, height: 24)
		let saveButton = NSButton(title: "Save…", target: self, action: #selector(saveAs))
		saveButton.frame = NSRect(x: 220, y: 150, width: 120, height: 28)
		for view in [popup, field, label, saveButton] as [NSView] { window.contentView?.addSubview(view) }
		window.orderFrontRegardless()
		// A second window, minimized at once, for the off-screen window check.
		spare.title = "\(title) spare"
		spare.orderFrontRegardless(); spare.miniaturize(nil)
		for name in [NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification] {
			NotificationCenter.default.addObserver(forName: name, object: spare, queue: .main) { [weak self] _ in self?.save() }
		}
		// A menu bar status item of this app only.
		let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		item.button?.title = "B1"; item.button?.setAccessibilityLabel("Beta1 status \(title)")
		let menu = NSMenu()
		menu.addItem(withTitle: "Beta1 Option A", action: #selector(chooseA), keyEquivalent: "").target = self
		menu.addItem(withTitle: "Beta1 Option B", action: #selector(chooseB), keyEquivalent: "").target = self
		item.menu = menu; status = item
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.save() }
		save()
	}
	@objc func changed() { label.stringValue = "Size: \(popup.titleOfSelectedItem ?? "")"; save() }
	func controlTextDidChange(_ notification: Notification) { save() }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate: NSObject & NSApplicationDelegate = mode == "witness" ? Witness() : Target()
application.delegate = delegate
// End of input is the driver going away.
FileHandle.standardInput.readabilityHandler = { handle in if handle.availableData.isEmpty { DispatchQueue.main.async { exit(0) } } }
application.run()
