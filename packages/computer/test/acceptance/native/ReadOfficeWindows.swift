import Foundation
import ApplicationServices
import CoreGraphics
import Darwin

// The standalone entry only reads process/document inventory. The guardian also
// links the explicit closeImage method; no path activates or focuses an app.
private enum InventoryError: Error { case incomplete(String) }
struct OfficeWindow: Encodable {
    let number: UInt32?
    let role: String
    let documentURL: String?
    let edited: Bool?
}
struct OfficeInventory: Encodable {
    let schema = "macos-office-windows-v1"
    let pid: Int32
    let executable: String
    let before: NativeProcessObservation
    let after: NativeProcessObservation
    let windows: [OfficeWindow]
    let cgWindowNumbers: [UInt32]
    let complete: Bool
    private enum CodingKeys: String, CodingKey { case schema, pid, executable, before, after, windows, cgWindowNumbers, complete }
}
enum OfficeImageScope {
    case empty
    case image(OfficeWindow)
}

// The same implementation is linked into the lifetime guardian. Every remote
// AX object gets its own timeout; setting only the application's timeout does
// not cover its child objects (AXUIElement.h). A whole read has a finite budget.
final class OfficeWindowReader {
private let deadline = ContinuousClock.now.advanced(by: .seconds(2))
private func check(_ element: AXUIElement? = nil) throws {
    guard ContinuousClock.now < deadline else { throw InventoryError.incomplete("read-deadline") }
    if let element, AXUIElementSetMessagingTimeout(element, 0.2) != .success {
        throw InventoryError.incomplete("AX-timeout-unavailable")
    }
}

private func readAttribute(_ element: AXUIElement, _ name: CFString, optional: Bool = false) throws -> CFTypeRef? {
    try check(element)
    var rawNames: CFArray?
    let namesStatus = AXUIElementCopyAttributeNames(element, &rawNames)
    guard namesStatus == .success, let names = rawNames as? [String] else {
        throw InventoryError.incomplete("attribute-names:\(name as String):\(namesStatus.rawValue)")
    }
    guard names.contains(name as String) else {
        _ = try officeAttributeHasValue(declared: false, optional: optional, readSucceeded: false, hasValue: false)
        return nil
    }
    var value: CFTypeRef?
    try check(element)
    let status = AXUIElementCopyAttributeValue(element, name, &value)
    _ = try officeAttributeHasValue(declared: true, optional: optional, readSucceeded: status == .success, hasValue: value != nil)
    return value
}
private func verifyPID(_ element: AXUIElement, pid: Int32) throws {
    try check(element)
    var owner: pid_t = 0
    guard AXUIElementGetPid(element, &owner) == .success, owner == pid else {
        throw InventoryError.incomplete("foreign-or-unknown-AX-owner")
    }
}
private func windowList(_ app: AXUIElement) throws -> [AXUIElement] {
    guard let raw = try readAttribute(app, kAXWindowsAttribute as CFString) else {
        throw InventoryError.incomplete("window-list")
    }
    return try officeAXElements(raw, maximum: 128)
}
private func verifyNoAttachedWindows(_ window: AXUIElement, pid: Int32) throws {
    try verifyOfficeDocumentTree(root: window, equal: { CFEqual($0, $1) }, readRole: { element in
        try verifyPID(element, pid: pid)
        guard let role = try readAttribute(element, kAXRoleAttribute as CFString) as? String else {
            throw InventoryError.incomplete("document-subtree-role")
        }
        return role
    }, readChildren: { element in
        if let children = try readAttribute(element, kAXChildrenAttribute as CFString, optional: true) {
            return try officeAXElements(children, maximum: 2000)
        }
        return []
    })
}
private func executable(_ pid: Int32) throws -> String {
    try check()
    var bytes = [UInt8](repeating: 0, count: 4096)
    let count = proc_pidpath(pid, &bytes, UInt32(bytes.count))
    guard count > 0, count < bytes.count, let end = bytes.firstIndex(of: 0),
          let path = String(bytes: bytes[..<end], encoding: .utf8), path.hasPrefix("/") else {
        throw InventoryError.incomplete("executable")
    }
    return path
}
private func cgWindows(_ pid: Int32) throws -> [[String: Any]] {
    try check()
    guard let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else {
        throw InventoryError.incomplete("CG-window-list")
    }
    return all.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
}
private func cgNumbers(_ rows: [[String: Any]]) throws -> [UInt32] {
    let numbers = try rows.map { row in
        guard let value = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value, value > 0 else {
            throw InventoryError.incomplete("CG-window-number")
        }
        return value
    }
    guard Set(numbers).count == numbers.count else { throw InventoryError.incomplete("repeated-CG-window") }
    return numbers.sorted()
}
private func windowNumber(_ window: AXUIElement, cgRows: [[String: Any]]) throws -> UInt32? {
    guard let p = try readAttribute(window, kAXPositionAttribute as CFString),
          let s = try readAttribute(window, kAXSizeAttribute as CFString),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else {
        throw InventoryError.incomplete("window-bounds")
    }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(unsafeDowncast(p, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeDowncast(s, to: AXValue.self), .cgSize, &size),
          point.x.isFinite, point.y.isFinite, size.width > 0, size.height > 0 else {
        throw InventoryError.incomplete("invalid-window-bounds")
    }
    let matches: [UInt32] = cgRows.compactMap { row in
        guard let bounds = row[kCGWindowBounds as String] as? [String: NSNumber],
              let x = bounds["X"]?.doubleValue, let y = bounds["Y"]?.doubleValue,
              let width = bounds["Width"]?.doubleValue, let height = bounds["Height"]?.doubleValue,
              abs(point.x - x) <= 1, abs(point.y - y) <= 1,
              abs(size.width - width) <= 1, abs(size.height - height) <= 1,
              let number = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value, number > 0 else { return nil }
        return number
    }
    // Ambiguity is not resolved by title, list order or the first match.
    return matches.count == 1 ? matches[0] : nil
}
private func inventoryWindow(_ window: AXUIElement, pid: Int32, cgRows: [[String: Any]]) throws -> OfficeWindow {
    try verifyPID(window, pid: pid)
    guard let role = try readAttribute(window, kAXRoleAttribute as CFString) as? String else {
        throw InventoryError.incomplete("window-role")
    }
    guard role == "AXWindow" else { throw OfficeDocumentTreeError.rootIsNotWindow }
    var documentURL: String?
    if let raw = try readAttribute(window, kAXDocumentAttribute as CFString, optional: true) {
        if let text = raw as? String { documentURL = text }
        else if let url = raw as? URL { documentURL = url.absoluteString }
        else { throw InventoryError.incomplete("document-type") }
    }
    var edited: Bool?
    if let raw = try readAttribute(window, kAXEditedAttribute as CFString, optional: true) {
        guard CFGetTypeID(raw) == CFBooleanGetTypeID(), let flag = raw as? Bool else {
            throw InventoryError.incomplete("edited-type")
        }
        edited = flag
    }
    // Public AXChildren/AXSheet semantics, including nested sheets. An
    // unsupported invented "AXSheets" attribute cannot prove their absence.
    try verifyNoAttachedWindows(window, pid: pid)
    return OfficeWindow(number: try windowNumber(window, cgRows: cgRows), role: role, documentURL: documentURL, edited: edited)
}

    private func bound(_ pid: Int32) throws -> (inventory: OfficeInventory, elements: [AXUIElement]) {
        try check()
        guard pid > 0, AXIsProcessTrusted() else { throw InventoryError.incomplete("AX-permission-or-pid") }
        let before = ProcessIdentityProbe.read(pid: pid)
        guard before.status == "alive", let birth = before.identity else { throw InventoryError.incomplete("original-process") }
        let path = try executable(pid), app = AXUIElementCreateApplication(pid)
        let cg = try cgWindows(pid), numbers = try cgNumbers(cg)
        let originals = try windowList(app), windows = try originals.map { try inventoryWindow($0, pid: pid, cgRows: cg) }
        let current = try windowList(app)
        guard originals.count == current.count,
              zip(originals, current).allSatisfy({ CFEqual($0.0, $0.1) }),
              try originals.map({ try inventoryWindow($0, pid: pid, cgRows: cg) }).elementsEqual(windows, by: {
                  $0.number == $1.number && $0.role == $1.role && $0.documentURL == $1.documentURL && $0.edited == $1.edited
              }), try cgNumbers(cgWindows(pid)) == numbers, try executable(pid) == path else { throw InventoryError.incomplete("changed-inventory") }
        let after = ProcessIdentityProbe.read(pid: pid)
        guard after.status == "alive", after.identity == birth else { throw InventoryError.incomplete("changed-process") }
        try check()
        return (OfficeInventory(pid: pid, executable: path, before: before, after: after, windows: windows, cgWindowNumbers: numbers, complete: true), originals)
    }
    func read(_ pid: Int32) throws -> OfficeInventory { try bound(pid).inventory }
    func processExecutable(_ pid: Int32) throws -> String { try executable(pid) }
    private func image(_ data: OfficeInventory, birth: NativeProcessIdentity, expectedExecutable: String, file: String) throws -> OfficeImageScope {
        guard data.before.identity == birth, data.after.identity == birth, data.executable == expectedExecutable else {
            throw InventoryError.incomplete("not-original-office-instance")
        }
        var info = stat()
        guard file.hasPrefix("/"), URL(fileURLWithPath: file).standardizedFileURL.resolvingSymlinksInPath().path == file,
              lstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_nlink == 1, info.st_uid == getuid() else { throw InventoryError.incomplete("unowned-image-path") }
        if data.windows.isEmpty, data.cgWindowNumbers.isEmpty { return .empty }
        guard data.windows.count == 1, let window = data.windows.first,
              window.role == "AXWindow", let number = window.number, number > 0, data.cgWindowNumbers == [number],
              let text = window.documentURL, let url = URL(string: text), url.isFileURL,
              url.host == nil || url.host == "" || url.host == "localhost",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path == file else { throw InventoryError.incomplete("unowned-office-document-or-window") }
        try check()
        return .image(window)
    }
    func imageScope(birth: NativeProcessIdentity, expectedExecutable: String, file: String) throws -> OfficeImageScope {
        try image(read(birth.pid), birth: birth, expectedExecutable: expectedExecutable, file: file)
    }
    func requireBackground(_ pid: Int32) throws {
        let system = AXUIElementCreateSystemWide()
        for name in [kAXFocusedApplicationAttribute, kAXFocusedUIElementAttribute] {
            guard let raw = try readAttribute(system, name as CFString), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
                throw InventoryError.incomplete("global-focus-unknown")
            }
            var owner: pid_t = 0
            guard AXUIElementGetPid(unsafeDowncast(raw, to: AXUIElement.self), &owner) == .success, owner > 0, owner != pid else {
                throw InventoryError.incomplete("global-focus-is-target-or-unknown")
            }
        }
        try check()
    }
    func closeImage(birth: NativeProcessIdentity, expectedExecutable: String, file: String, number: UInt32) throws {
        let read = try bound(birth.pid)
        guard case .image(let window) = try image(read.inventory, birth: birth, expectedExecutable: expectedExecutable, file: file),
              window.number == number, window.edited == false, let element = read.elements.first else {
            throw InventoryError.incomplete("document-not-safe-to-close")
        }
        try requireBackground(birth.pid)
        guard let raw = try readAttribute(element, kAXCloseButtonAttribute as CFString), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            throw InventoryError.incomplete("document-close-button")
        }
        let button = unsafeDowncast(raw, to: AXUIElement.self)
        try verifyPID(button, pid: birth.pid)
        guard try readAttribute(button, kAXRoleAttribute as CFString) as? String == kAXButtonRole,
              let enabled = try readAttribute(button, kAXEnabledAttribute as CFString),
              CFGetTypeID(enabled) == CFBooleanGetTypeID(), enabled as? Bool == true else {
            throw InventoryError.incomplete("document-close-button-disabled")
        }
        // Recheck retained document properties after fetching its actual close
        // button. A new similarly named window cannot substitute for it.
        let currentWindows = try windowList(AXUIElementCreateApplication(birth.pid))
        let currentCG = try cgWindows(birth.pid)
        guard currentWindows.count == 1, let currentElement = currentWindows.first, CFEqual(currentElement, element),
              try cgNumbers(currentCG) == [number] else { throw InventoryError.incomplete("new-window-before-close") }
        let current = try inventoryWindow(element, pid: birth.pid, cgRows: currentCG)
        guard current.number == number, current.documentURL == window.documentURL, current.edited == false else {
            throw InventoryError.incomplete("document-changed-before-close")
        }
        try requireBackground(birth.pid)
        guard ProcessIdentityProbe.read(pid: birth.pid).identity == birth, try executable(birth.pid) == expectedExecutable else {
            throw InventoryError.incomplete("process-changed-before-close")
        }
        try check(button)
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw InventoryError.incomplete("close-not-confirmed") }
        try check()
    }
}

#if !OFFICE_SESSION
@main
private struct ReadOfficeWindows {
    static func main() {
        guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]), pid > 0 else { exit(2) }
        do { try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(OfficeWindowReader().read(pid))) }
        catch {
            try? FileHandle.standardError.write(contentsOf: Data("office inventory failed: \(error)\n".utf8))
            exit(1)
        }
    }
}
#endif
