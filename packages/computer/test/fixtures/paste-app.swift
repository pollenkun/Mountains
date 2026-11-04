// Disposable rich-text editor. Reports its attributed text independently of AX.
import AppKit
import Foundation
import Darwin

// This process belongs to one test controller. Its pipe closing (including
// controller SIGKILL) must not leave a disposable app/monitor running.
FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { Darwin.exit(0) }
}

let output = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let menuBar = NSMenu(), appRoot = NSMenuItem(), editRoot = NSMenuItem(), editMenu = NSMenu(title: "Edit")
appRoot.submenu = NSMenu(title: "Application")
menuBar.addItem(appRoot)
editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSTextView.paste(_:)), keyEquivalent: "v"))
editRoot.submenu = editMenu
menuBar.addItem(editRoot)
app.mainMenu = menuBar
var copyDuringPaste = false
var pastes = 0
var lastCommand = ""
var cleanupToken = ""
let newerCopy = "New copy during paste — 保留"

final class PasteEditor: NSTextView {
    override func paste(_ sender: Any?) {
        super.paste(sender)
        pastes += 1
        if copyDuringPaste {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(newerCopy, forType: .string)
            markTestClipboard()
        }
    }
}
let window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 520, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Mountains Clipboard Verification"
window.isReleasedWhenClosed = false
var editor = PasteEditor(frame: NSRect(x: 20, y: 20, width: 480, height: 280))
editor.isRichText = true
editor.isEditable = true
editor.setAccessibilityLabel("Rich editor")
window.contentView?.addSubview(editor)
window.orderFront(nil)
window.makeFirstResponder(editor)

@MainActor func seedClipboard() {
    let first = NSPasteboardItem(), second = NSPasteboardItem()
    first.setString("Original test copy — 原文", forType: .string)
    first.setString("<b>Original test copy</b>", forType: .html)
    first.setData(Data([0, 1, 127, 255]), forType: NSPasteboard.PasteboardType("dev.mountains.test.binary"))
    second.setData(Data([4, 3, 2, 1]), forType: NSPasteboard.PasteboardType("dev.mountains.test.second"))
    NSPasteboard.general.clearContents()
    NSPasteboard.general.writeObjects([first, second])
    markTestClipboard()
}
@MainActor func markTestClipboard() {
    guard !cleanupToken.isEmpty,
          let data = try? JSONSerialization.data(withJSONObject: ["token": cleanupToken, "changeCount": NSPasteboard.general.changeCount]),
          let marker = String(data: data, encoding: .utf8) else { return }
    NSPasteboard.general.setString(marker, forType: NSPasteboard.PasteboardType("org.mountains.clipboard-transaction"))
}
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    MainActor.assumeIsolated {
    if let data = try? Data(contentsOf: URL(fileURLWithPath: "\(output)/control.json")),
       let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       let nonce = command["nonce"] as? String, nonce != lastCommand {
        if let token = command["cleanupToken"] as? String { cleanupToken = token }
        if command["op"] as? String == "reset" {
            editor.textStorage?.setAttributedString(NSAttributedString(string: ""))
            editor.setSelectedRange(NSRange(location: 0, length: 0))
            window.makeFirstResponder(editor)
            copyDuringPaste = command["copyDuringPaste"] as? Bool ?? false
        }
        if command["op"] as? String == "seed" { seedClipboard() }
        if command["op"] as? String == "replace" {
            let next = PasteEditor(frame: editor.frame)
            next.isRichText = true; next.isEditable = true; next.setAccessibilityLabel("Rich editor")
            next.textStorage?.setAttributedString(NSAttributedString(string: editor.string))
            editor.removeFromSuperview(); editor = next
            window.contentView?.addSubview(next); window.makeFirstResponder(next)
        }
        lastCommand = nonce
    }
    var bold = "", italic = ""
    if let storage = editor.textStorage {
        storage.enumerateAttribute(.font, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let font = value as? NSFont else { return }
            let traits = NSFontManager.shared.traits(of: font)
            let text = (storage.string as NSString).substring(with: range)
            if traits.contains(.boldFontMask) { bold += text }
            if traits.contains(.italicFontMask) { italic += text }
        }
    }
    let p = NSEvent.mouseLocation
    let model: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "window": window.windowNumber,
        "value": editor.string, "bold": bold, "italic": italic, "pastes": pastes, "lastCommand": lastCommand,
        "front": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "mouse": [p.x, p.y],
        "buttons": NSEvent.pressedMouseButtons, "clipboardCount": NSPasteboard.general.changeCount]
    if let data = try? JSONSerialization.data(withJSONObject: model, options: [.sortedKeys]) {
        try? data.write(to: URL(fileURLWithPath: "\(output)/model.json"), options: .atomic)
    }
    }
}
app.run()
