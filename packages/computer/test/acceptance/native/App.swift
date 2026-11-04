import AppKit
import Foundation
import CryptoKit
import Darwin

// open -g does not preserve stdin. A private stream is the lifetime boundary;
// closing it, including controller death, exits only this disposable process.
func connectController(_ path: String) throws -> FileHandle {
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
guard CommandLine.arguments.count == 3 else { exit(2) }
let fixtureController = try connectController(CommandLine.arguments[2])
fixtureController.readabilityHandler = { handle in
    if handle.availableData.isEmpty { Darwin.exit(0) }
}

struct SavedDocument: Codable {
    let document: String
    let tag: String
    let name: String
    let quantity: Int
    let body: String
    let option: String
    let enabled: Bool
    let receipt: String
}

struct QueueItem: Codable {
    let id: String
    let title: String
    var done: Bool
}

@MainActor
final class Journal {
    let directory: URL
    private let events: FileHandle
    private let signingKey = SymmetricKey(size: .bits256)
    private var sequence = 0
    init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("native-events.jsonl")
        let descriptor = Darwin.open(path.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        events = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        // The key leaves memory only over the controller's private stream.
        // It is never written to a run file, argv, stdout or the environment.
        let keyBytes = signingKey.withUnsafeBytes { Data($0) }
        var hello = try JSONSerialization.data(withJSONObject: ["pid": getpid(), "key": keyBytes.base64EncodedString()])
        hello.append(10)
        try fixtureController.write(contentsOf: hello)
    }
    func event(_ kind: String, document: String, fields: [String: Any] = [:]) {
        var object = fields
        object["kind"] = kind
        object["document"] = document
        object["at"] = Date().timeIntervalSince1970
        sequence += 1
        object["sequence"] = sequence
        object["pid"] = getpid()
        do {
            let payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            object["signedPayload"] = payload.base64EncodedString()
            object["signature"] = HMAC<SHA256>.authenticationCode(for: payload, using: signingKey).map { String(format: "%02x", $0) }.joined()
            var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            data.append(10)
            try events.write(contentsOf: data)
            try events.synchronize()
        } catch { NSLog("Journal error: %@", String(describing: error)) }
    }
    func write<T: Encodable>(_ value: T, name: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: directory.appendingPathComponent(name), options: .atomic)
    }
}

@MainActor
final class RowView: NSView {
    let label = NSTextField(labelWithString: "")
    let box = NSButton(checkboxWithTitle: "Complete", target: nil, action: nil)
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.row)
        setAccessibilityLabel(nil)
        label.frame = NSRect(x: 10, y: 6, width: 340, height: 22)
        box.frame = NSRect(x: 360, y: 3, width: 130, height: 28)
        addSubview(label)
        addSubview(box)
        setAccessibilityChildren([label, box])
    }
    required init?(coder: NSCoder) { nil }
}

@MainActor
final class DocumentController: NSObject, NSTextFieldDelegate {
    let identifier: String
    let window: NSWindow
    let journal: Journal
    let tag = NSTextField(string: "")
    let name = NSTextField(string: "")
    let quantity = NSTextField(string: "1")
    let body = NSTextField(string: "")
    let option = NSPopUpButton(frame: .zero, pullsDown: false)
    let enabled = NSButton(checkboxWithTitle: "Enabled", target: nil, action: nil)
    let status = NSTextField(labelWithString: "Ready")
    let receipt = NSTextField(labelWithString: "")
    var touched: (() -> Void)?
    private var queue: [QueueItem] = [
        QueueItem(id: "row-A", title: "Alpha receipt", done: false),
        QueueItem(id: "row-B", title: "Beta receipt", done: false),
        QueueItem(id: "row-C", title: "Gamma receipt", done: false)
    ]
    private var rows: [RowView] = []
    private var panel: NSPanel?
    private var dialogField: NSTextField?
    private var lastState = ""
    private var runNonce = UUID().uuidString
    private var reconciled = false

    init(identifier: String, origin: NSPoint, journal: Journal) {
        self.identifier = identifier
        self.journal = journal
        window = NSWindow(contentRect: NSRect(origin: origin, size: NSSize(width: 650, height: 680)),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Mountains QA"
        window.identifier = NSUserInterfaceItemIdentifier("document-" + identifier)
        window.setAccessibilityIdentifier("document-" + identifier)
        window.isReleasedWhenClosed = false
        makeForm()
        journal.event("opened", document: identifier)
        update()
        window.orderBack(nil)
    }

    private func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat = 600) {
        let view = NSTextField(labelWithString: text)
        view.frame = NSRect(x: x, y: y, width: width, height: 24)
        window.contentView?.addSubview(view)
    }
    private func field(_ view: NSTextField, label text: String, y: CGFloat) {
        label(text, x: 22, y: y)
        view.frame = NSRect(x: 165, y: y, width: 455, height: 26)
        view.setAccessibilityLabel(text)
        view.setAccessibilityIdentifier(identifier + "-" + text)
        view.delegate = self
        window.contentView?.addSubview(view)
    }
    @discardableResult
    private func button(_ title: String, action: Selector, x: CGFloat, y: CGFloat, width: CGFloat) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.frame = NSRect(x: x, y: y, width: width, height: 32)
        window.contentView?.addSubview(button)
        return button
    }
    private func makeForm() {
        label("Document " + identifier, x: 22, y: 638)
        label("Local QA document. Saves are written from these fields.", x: 22, y: 610)
        field(tag, label: "Save tag", y: 570)
        field(name, label: "Name", y: 528)
        field(quantity, label: "Quantity (1 to 9)", y: 486)
        field(body, label: "Content", y: 444)
        label("Option", x: 22, y: 402)
        option.frame = NSRect(x: 165, y: 399, width: 200, height: 30)
        option.addItems(withTitles: ["Draft", "Reviewed", "Ready"])
        option.setAccessibilityLabel("Option")
        option.target = self
        option.action = #selector(controlChanged)
        window.contentView?.addSubview(option)
        enabled.frame = NSRect(x: 392, y: 399, width: 150, height: 30)
        enabled.target = self
        enabled.action = #selector(controlChanged)
        window.contentView?.addSubview(enabled)
        button("Save document", action: #selector(save), x: 22, y: 350, width: 155)
        button("Save as dialog", action: #selector(openDialog), x: 185, y: 350, width: 155)
        button("New document", action: #selector(reset), x: 350, y: 350, width: 150)
        button("Delayed save", action: #selector(delayedSave), x: 500, y: 350, width: 140)
        status.frame = NSRect(x: 22, y: 312, width: 600, height: 28)
        status.setAccessibilityIdentifier(identifier + "-status")
        window.contentView?.addSubview(status)
        receipt.frame = NSRect(x: 22, y: 278, width: 610, height: 28)
        receipt.stringValue = "Receipt " + runNonce
        window.contentView?.addSubview(receipt)
        label("Completing an item reuses rows in a different order.", x: 22, y: 232)
        for index in 0..<3 {
            let row = RowView(frame: NSRect(x: 22, y: 180 - index * 42, width: 600, height: 34))
            row.box.target = self
            row.box.action = #selector(toggleRow(_:))
            row.box.tag = index
            rows.append(row)
            window.contentView?.addSubview(row)
        }
        button("Check reconciliation", action: #selector(checkReconciliation), x: 22, y: 28, width: 230)
        refreshRows()
    }
    func controlTextDidChange(_ notification: Notification) { touched?(); update() }
    func controlTextDidEndEditing(_ notification: Notification) { touched?(); update() }
    @objc private func controlChanged() { touched?(); update() }
    private func refreshRows() {
        for (index, item) in queue.enumerated() {
            rows[index].label.stringValue = item.title
            rows[index].box.state = item.done ? .on : .off
        }
    }
    @objc private func toggleRow(_ sender: NSButton) {
        let item = queue[sender.tag]
        queue[sender.tag].done.toggle()
        journal.event("toggle", document: identifier, fields: ["item": item.id])
        queue.sort { a, b in a.done == b.done ? a.id < b.id : !a.done }
        refreshRows()
        update()
    }
    func update() {
        let state: [String: Any] = [
            "pid": getpid(), "windowNumber": window.windowNumber,
            "document": identifier, "tag": tag.stringValue, "name": name.stringValue,
            "quantity": quantity.stringValue, "body": body.stringValue,
            "option": option.titleOfSelectedItem ?? "", "enabled": enabled.state == .on,
            "receipt": runNonce, "status": status.stringValue,
            "dialogOpen": panel != nil, "dialogWindowNumber": panel.map { $0.windowNumber as Any } ?? NSNull(), "reconciled": reconciled,
            "rows": queue.map { ["id": $0.id, "title": $0.title, "done": $0.done] as [String: Any] }
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
            let current = String(decoding: data, as: UTF8.self)
            if current != lastState {
                touched?()
                try data.write(to: journal.directory.appendingPathComponent("state-" + identifier + ".json"), options: .atomic)
                lastState = current
                journal.event("state", document: identifier, fields: ["state": state])
            }
        } catch { status.stringValue = "File error: " + String(describing: error) }
    }
    @objc func save() {
        touched?()
        guard !name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            status.stringValue = "Error: name is required"
            journal.event("invalid", document: identifier, fields: ["reason": "missing-name", "name": name.stringValue, "quantity": quantity.stringValue, "tag": tag.stringValue])
            update()
            return
        }
        guard let amount = Int(quantity.stringValue), (1...9).contains(amount) else {
            status.stringValue = "Error: quantity must be 1 to 9"
            journal.event("invalid", document: identifier, fields: ["reason": "quantity-range", "name": name.stringValue, "quantity": quantity.stringValue, "tag": tag.stringValue])
            update()
            return
        }
        let fileTag = tag.stringValue
        guard !fileTag.isEmpty, fileTag.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            status.stringValue = "Error: save tag uses letters, digits, - or _"
            update()
            return
        }
        let saved = SavedDocument(document: identifier, tag: fileTag, name: name.stringValue,
                                  quantity: amount, body: body.stringValue, option: option.titleOfSelectedItem ?? "",
                                  enabled: enabled.state == .on, receipt: runNonce)
        do {
            try journal.write(saved, name: fileTag + ".json")
            status.stringValue = "Saved " + fileTag
            journal.event("saved", document: identifier, fields: ["tag": fileTag])
        } catch { status.stringValue = "File error: " + String(describing: error) }
        update()
    }
    @objc private func reset() {
        name.stringValue = ""
        body.stringValue = ""
        tag.stringValue = ""
        quantity.stringValue = "1"
        option.selectItem(at: 0)
        enabled.state = .off
        status.stringValue = "Ready"
        runNonce = UUID().uuidString
        receipt.stringValue = "Receipt " + runNonce
        reconciled = false
        journal.event("reset", document: identifier)
        update()
    }
    @objc private func checkReconciliation() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let configURL = journal.directory.deletingLastPathComponent().appendingPathComponent("web/server.json")
                let config = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as? [String: Any]
                guard let base = config?["url"] as? String, let url = URL(string: base + "/api/state") else { return }
                let (data, _) = try await URLSession.shared.data(from: url)
                let remote = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let matches = (remote?["reconciliations"] as? [[String: Any]] ?? []).filter {
                    $0["receipt"] as? String == runNonce && $0["note"] as? String == body.stringValue &&
                    $0["amount"] as? Int == Int(quantity.stringValue)
                }
                reconciled = matches.count == 1
                status.stringValue = reconciled ? "Reconciled " + runNonce : "No matching reconciliation"
                journal.event("reconciliation-checked", document: identifier, fields: ["matches": matches.count])
                update()
            } catch { status.stringValue = "Network error: " + String(describing: error); update() }
        }
    }
    @objc private func delayedSave() {
        status.stringValue = "Saving after three seconds"
        journal.event("delay-start", document: identifier)
        update()
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            self?.save()
        }
    }
    @objc private func openDialog() {
        guard panel == nil else { return }
        let dialog = NSPanel(contentRect: NSRect(x: window.frame.minX + 40, y: window.frame.minY + 240, width: 500, height: 170),
                             styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        dialog.title = "Save document " + identifier
        dialog.isReleasedWhenClosed = false
        let field = NSTextField(string: tag.stringValue)
        field.frame = NSRect(x: 24, y: 90, width: 450, height: 26)
        field.setAccessibilityLabel("Filename")
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelDialog))
        cancel.frame = NSRect(x: 270, y: 26, width: 90, height: 32)
        let save = NSButton(title: "Save", target: self, action: #selector(saveDialog))
        save.frame = NSRect(x: 372, y: 26, width: 100, height: 32)
        dialog.contentView?.addSubview(field)
        dialog.contentView?.addSubview(cancel)
        dialog.contentView?.addSubview(save)
        panel = dialog
        dialogField = field
        dialog.orderBack(nil)
        journal.event("dialog-open", document: identifier, fields: ["windowNumber": dialog.windowNumber, "parentWindowNumber": window.windowNumber])
        update()
    }
    private func closeDialog() -> Int? {
        let dialogNumber = panel?.windowNumber
        panel?.close()
        panel = nil
        dialogField = nil
        return dialogNumber
    }
    @objc private func cancelDialog() {
        let dialogNumber = closeDialog()
        journal.event("dialog-cancel", document: identifier, fields: ["windowNumber": dialogNumber.map { $0 as Any } ?? NSNull(), "parentWindowNumber": window.windowNumber])
        update()
    }
    @objc private func saveDialog() {
        tag.stringValue = dialogField?.stringValue ?? ""
        let dialogNumber = closeDialog()
        journal.event("dialog-confirm", document: identifier, fields: ["windowNumber": dialogNumber.map { $0 as Any } ?? NSNull(), "parentWindowNumber": window.windowNumber])
        update()
        save()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var documents: [DocumentController] = []
    private var lastEdited: DocumentController?
    private var timer: Timer?
    private var journal: Journal?
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 3 else { NSApp.terminate(nil); return }
        do {
            let log = try Journal(directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true))
            journal = log
            let area = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            documents = ["A", "B"].enumerated().map { index, id in
                DocumentController(identifier: id, origin: NSPoint(x: area.minX + 30 + CGFloat(index) * 660, y: area.minY + 30), journal: log)
            }
            for document in documents { document.touched = { [weak self, weak document] in self?.lastEdited = document } }
            lastEdited = documents.first
            let menu = NSMenu()
            let appItem = NSMenuItem(title: "Application", action: nil, keyEquivalent: "")
            let appMenu = NSMenu(title: "Application")
            appMenu.addItem(withTitle: "Quit Mountains QA", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            appItem.submenu = appMenu
            menu.addItem(appItem)
            let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
            let fileMenu = NSMenu(title: "File")
            let save = NSMenuItem(title: "Save", action: #selector(saveCurrent), keyEquivalent: "s")
            save.target = self
            fileMenu.addItem(save)
            let disabled = NSMenuItem(title: "Unavailable action", action: nil, keyEquivalent: "k")
            disabled.isEnabled = false
            fileMenu.addItem(disabled)
            fileItem.submenu = fileMenu
            menu.addItem(fileItem)
            let editItem = NSMenuItem(title: "Unrelated", action: nil, keyEquivalent: "")
            let editMenu = NSMenu(title: "Unrelated")
            editMenu.delegate = self
            editItem.submenu = editMenu
            menu.addItem(editItem)
            NSApp.mainMenu = menu
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { for document in self?.documents ?? [] { document.update() } }
            }
        } catch { NSLog("QA startup failed: %@", String(describing: error)); NSApp.terminate(nil) }
    }
    @objc private func saveCurrent() {
        let document = documents.first { $0.window === NSApp.keyWindow } ?? lastEdited
        journal?.event("shortcut-save", document: document?.identifier ?? "unknown")
        document?.save()
    }
    func menuNeedsUpdate(_ menu: NSMenu) { journal?.event("unrelated-menu-opened", document: "none") }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
