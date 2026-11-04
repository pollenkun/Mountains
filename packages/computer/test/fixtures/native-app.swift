// A disposable two-window target. The model state is written independently of the driver.
// Run with an output directory and a unique title. Activation is left to the test driver.
import AppKit
import Foundation
import Darwin

// LaunchServices' stdin redirection is not a controller lifetime guarantee.
// A private Unix stream closes when its owning controller exits, including SIGKILL.
func connectFixtureController(_ path: String?) throws -> FileHandle {
    guard let path else { return FileHandle.standardInput }
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [UInt8(0)]
    guard !path.utf8.contains(0), bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENAMETOOLONG))
    }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    guard Darwin.fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 else {
        let failure = errno; Darwin.close(descriptor)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(failure))
    }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else {
        let failure = errno; Darwin.close(descriptor)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(failure))
    }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
}

// Evidence is created once. A prior file or link is an error, never a log to reset.
func createFixtureEventLog(_ path: String) throws -> FileHandle {
    let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
}
let fixtureController = try connectFixtureController(CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : nil)
fixtureController.readabilityHandler = { handle in
    if handle.availableData.isEmpty {
        FileHandle.standardError.write(Data("MOUNTAINS_FIXTURE_CONTROLLER_EOF\n".utf8))
        Darwin.exit(0)
    }
}

let output = CommandLine.arguments[1]
let title = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "Mountains Test"

final class Canvas: NSView {
	var clicked = 0, doubleClicked = 0, rightClicked = 0, dragged = 0, scrolled = 0, menuMarks = 0, keys = ""
	var mouseUps = 0, rightMouseUps = 0, mouseHeld = false, rightMouseHeld = false
	var dragWithoutDown = 0, eventLogError = false
	var eventPath = ""
	private var eventLog: FileHandle?
	var changed: () -> Void = {}
	private func recordMouse(_ kind: String, _ event: NSEvent) {
		guard !eventLogError else { return }
		do {
			if eventLog == nil {
				eventLog = try createFixtureEventLog(eventPath)
			}
			let record: [String: Any] = ["kind": kind, "pid": ProcessInfo.processInfo.processIdentifier,
				"window": event.windowNumber, "eventNumber": event.eventNumber, "at": ProcessInfo.processInfo.systemUptime * 1000,
				"x": event.locationInWindow.x, "y": event.locationInWindow.y,
				"addressedPid": event.cgEvent?.getIntegerValueField(.eventTargetUnixProcessID) ?? 0]
			var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]); data.append(10)
			try eventLog?.write(contentsOf: data)
		} catch { eventLogError = true }
	}
	override var acceptsFirstResponder: Bool { true }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	override func draw(_ rect: NSRect) {
		NSColor.systemTeal.setFill(); bounds.fill()
		("Canvas: \(clicked) clicks, \(dragged) drag events" as NSString).draw(at: NSPoint(x: 12, y: 30), withAttributes: [.foregroundColor: NSColor.white])
	}
	override func mouseDown(with event: NSEvent) { clicked += 1; mouseHeld = true; recordMouse("down", event); if event.clickCount == 2 { doubleClicked += 1 }; window?.makeFirstResponder(self); needsDisplay = true; changed() }
	override func mouseUp(with event: NSEvent) { mouseUps += 1; mouseHeld = false; recordMouse("up", event); changed() }
	override func rightMouseDown(with event: NSEvent) { rightClicked += 1; rightMouseHeld = true; recordMouse("right-down", event); changed() }
	override func rightMouseUp(with event: NSEvent) { rightMouseUps += 1; rightMouseHeld = false; recordMouse("right-up", event); changed() }
	override func mouseDragged(with event: NSEvent) { dragged += 1; if !mouseHeld { dragWithoutDown += 1 }; recordMouse("drag", event); needsDisplay = true; changed() }
	override func scrollWheel(with event: NSEvent) { scrolled += 1; changed() }
	@objc func markWindow(_ sender: Any?) { menuMarks += 1; changed() }
	override func keyDown(with event: NSEvent) { keys += event.characters ?? ""; changed() }
}

final class ControlledField: NSTextField {
    var mode = "normal"
    var writesRequested = 0
    override func setAccessibilityValue(_ value: Any?) {
        writesRequested += 1
        if mode == "ignore" { return }
        if mode == "delay" { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self.stringValue = value as? String ?? "" }; return }
        stringValue = value as? String ?? ""
    }
}
var lastCommand = ""
final class Target: NSObject {
	let window: NSWindow, counter: NSTextField, canvas: Canvas
    var field: ControlledField
	var presses = 0
    var popup: NSWindow?
	var sheet: NSWindow?
	var closedSheets = 0
	let index: Int
	init(index: Int) {
		self.index = index
		window = NSWindow(contentRect: NSRect(x: 100 + index * 60, y: 160 + index * 60, width: 460, height: 280), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
		field = ControlledField(frame: NSRect(x: 20, y: 220, width: 300, height: 26))
		counter = NSTextField(labelWithString: "Count: 0")
		canvas = Canvas(frame: NSRect(x: 20, y: 30, width: 410, height: 140))
		canvas.eventPath = "\(output)/events-\(index).jsonl"
		super.init()
		window.title = "\(title) \(index)"; window.isReleasedWhenClosed = false
		field.stringValue = "Draft \(index)"; field.setAccessibilityIdentifier("field-\(index)"); field.setAccessibilityLabel("Text \(index)")
		counter.frame = NSRect(x: 20, y: 180, width: 250, height: 22); counter.setAccessibilityIdentifier("count-\(index)")
		let button = NSButton(title: "Increment \(index)", target: self, action: #selector(press))
		button.frame = NSRect(x: 330, y: 220, width: 110, height: 28); button.setAccessibilityIdentifier("button-\(index)")
		canvas.setAccessibilityElement(true); canvas.setAccessibilityRole(.group); canvas.setAccessibilityLabel("Canvas \(index)"); canvas.setAccessibilityIdentifier("canvas-\(index)")
		canvas.changed = { [weak self] in self?.save() }
		for view in [field, counter, button, canvas] { window.contentView?.addSubview(view) }
		window.orderFront(nil)
		save()
	}
	@objc func press() { presses += 1; counter.stringValue = "Count: \(presses)"; save() }
	@objc func closeSheet() {
		guard let sheet else { return }
		window.endSheet(sheet); sheet.orderOut(nil); self.sheet = nil
		closedSheets += 1; save()
	}
    func command(_ command: [String: Any]) {
        switch command["op"] as? String {
        case "move": window.setFrameOrigin(NSPoint(x: window.frame.minX + 25, y: window.frame.minY + 25))
        case "replace":
            let fresh = ControlledField(frame: field.frame)
            fresh.stringValue = field.stringValue; fresh.setAccessibilityIdentifier("field-\(index)"); fresh.setAccessibilityLabel("Text \(index)")
            field.removeFromSuperview(); field = fresh; window.contentView?.addSubview(fresh)
        case "popup", "floatingPopup":
            popup = NSWindow(contentRect: NSRect(x: 240, y: 260, width: 220, height: 100), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            if command["op"] as? String == "floatingPopup" { popup?.level = .floating }
            popup?.title = "Disposable dialog"; popup?.isReleasedWhenClosed = false; popup?.orderFront(nil)
        case "closePopup": popup?.close(); popup = nil
		case "focusText": window.makeFirstResponder(field)
		case "sheet":
			let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 280, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
			panel.title = "Acceptance sheet"; panel.isReleasedWhenClosed = false
			panel.contentView?.wantsLayer = true
			panel.contentView?.layer?.backgroundColor = NSColor(srgbRed: 0.8, green: 0.1, blue: 0.7, alpha: 1).cgColor
			let close = NSButton(title: "Finish sheet", target: self, action: #selector(closeSheet))
			close.frame = NSRect(x: 80, y: 40, width: 120, height: 32); close.keyEquivalent = "\r"
			panel.contentView?.addSubview(close); panel.defaultButtonCell = close.cell as? NSButtonCell
			sheet = panel; window.beginSheet(panel, completionHandler: nil)
		case "closeSheet": closeSheet()
        case "value": field.stringValue = command["value"] as? String ?? ""
        case "mode": field.mode = command["mode"] as? String ?? "normal"
        default: break
        }
    }
	func save() {
        // Receiver-side AppKit state, independent of the AX menu reader.
        let menuPaths: [String] = (NSApplication.shared.mainMenu?.items ?? []).flatMap { root in
            (root.submenu?.items ?? []).compactMap { item -> String? in
                guard !item.isSeparatorItem else { return nil }
                return root.title + " > " + item.title
            }
        }
		let p = NSEvent.mouseLocation
		let values: [String: Any] = ["menuPaths": menuPaths, "pid": ProcessInfo.processInfo.processIdentifier, "window": window.windowNumber, "title": window.title, "value": field.stringValue, "mode": field.mode, "lastCommand": lastCommand,
			"writesRequested": field.writesRequested, "presses": presses, "clicks": canvas.clicked, "doubleClicks": canvas.doubleClicked, "rightClicks": canvas.rightClicked, "drags": canvas.dragged, "scrolls": canvas.scrolled,
			"mouseUps": canvas.mouseUps, "rightMouseUps": canvas.rightMouseUps, "mouseHeld": canvas.mouseHeld, "rightMouseHeld": canvas.rightMouseHeld,
			"dragWithoutDown": canvas.dragWithoutDown, "eventLogError": canvas.eventLogError,
			"menuMarks": canvas.menuMarks, "keys": canvas.keys, "front": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "mouse": [p.x, p.y], "buttons": NSEvent.pressedMouseButtons,
			"sheetWindow": sheet?.windowNumber ?? 0, "closedSheets": closedSheets,
			"returnDown": CGEventSource.keyState(.combinedSessionState, key: 36), "aDown": CGEventSource.keyState(.combinedSessionState, key: 0)]
		if let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) { try? data.write(to: URL(fileURLWithPath: "\(output)/window-\(index).json"), options: .atomic) }
	}
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let menuBar = NSMenu(), applicationRoot = NSMenuItem(), fixtureMenu = NSMenu(title: "Fixture"), fixtureRoot = NSMenuItem()
// macOS gives the first menu its application display name. Keep that empty
// application menu separate so the fixture's ordinary menu has a stable title.
applicationRoot.submenu = NSMenu(); menuBar.addItem(applicationRoot)
fixtureMenu.addItem(NSMenuItem(title: "Mark window", action: #selector(Canvas.markWindow(_:)), keyEquivalent: ""))
fixtureRoot.title = "Fixture"; fixtureRoot.submenu = fixtureMenu; menuBar.addItem(fixtureRoot); app.mainMenu = menuBar
let targets = [Target(index: 1), Target(index: 2)]
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    if let data = try? Data(contentsOf: URL(fileURLWithPath: "\(output)/control.json")),
       let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       let nonce = command["nonce"] as? String, nonce != lastCommand,
       let index = command["index"] as? Int, (1...2).contains(index) {
        targets[index - 1].command(command); lastCommand = nonce
    }
    targets.forEach { $0.save() }
}
app.run()
