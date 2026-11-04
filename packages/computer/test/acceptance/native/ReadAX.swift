import Foundation
import AppKit
import CryptoKit
import ApplicationServices
import CoreGraphics

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func serializable(_ value: CFTypeRef?) -> Any? {
    guard let value else { return nil }
    if CFGetTypeID(value) == AXUIElementGetTypeID() { return nil }
    if let date = value as? Date { return ISO8601DateFormatter().string(from: date) }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number }
    if let rich = value as? NSAttributedString { return rich.string }
    return nil
}
func children(_ element: AXUIElement, key: String = kAXChildrenAttribute) throws -> [AXUIElement] {
    var names: CFArray?
    let listed = AXUIElementCopyAttributeNames(element, &names)
    guard listed == .success, let attributes = names as? [String] else {
        throw NSError(domain: "IndependentAX", code: Int(listed.rawValue), userInfo: [NSLocalizedDescriptionKey: "Cannot enumerate AX attributes"])
    }
    guard attributes.contains(key) else { return [] }
    var value: CFTypeRef?
    let copied = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    guard copied == .success, let value, CFGetTypeID(value) == CFArrayGetTypeID(), let array = value as? [AXUIElement] else {
        throw NSError(domain: "IndependentAX", code: Int(copied.rawValue), userInfo: [NSLocalizedDescriptionKey: "AX children read failed; absence is unverified"])
    }
    return array
}
if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--clipboard" {
    let board = NSPasteboard.general
    let originalCount = board.changeCount
    let items = try (board.pasteboardItems ?? []).map { item in
        try item.types.map { type in
            guard let data = item.data(forType: type) else {
                throw NSError(domain: "IndependentClipboard", code: 1, userInfo: [NSLocalizedDescriptionKey: "Clipboard type could not be read; empty data is not a fingerprint"])
            }
            return ["type": type.rawValue, "bytes": data.count,
                    "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()] as [String: Any]
        }.sorted { ($0["type"] as? String ?? "") < ($1["type"] as? String ?? "") }
    }
    guard board.changeCount == originalCount else { fputs("Clipboard changed during independent read\n", stderr); exit(3) }
    let result: [String: Any] = ["items": items, "changeCount": board.changeCount, "contentsLogged": false]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
    exit(0)
}
guard CommandLine.arguments.count == 3, let pid = pid_t(CommandLine.arguments[1]), pid > 0,
      let number = UInt32(CommandLine.arguments[2]) else { exit(2) }
let listed = CGWindowListCopyWindowInfo(.optionIncludingWindow, number) as? [[String: Any]] ?? []
let exact = listed.first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
guard let bounds = exact?[kCGWindowBounds as String] as? [String: NSNumber],
      let x = bounds["X"]?.doubleValue, let y = bounds["Y"]?.doubleValue,
      let width = bounds["Width"]?.doubleValue, let height = bounds["Height"]?.doubleValue else { exit(3) }
func matches(_ window: AXUIElement) -> Bool {
    guard let position = attribute(window, kAXPositionAttribute), let size = attribute(window, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return false }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeDowncast(size, to: AXValue.self), .cgSize, &dimensions) else { return false }
    return abs(point.x - x) <= 1 && abs(point.y - y) <= 1 && abs(dimensions.width - width) <= 1 && abs(dimensions.height - height) <= 1
}
guard AXIsProcessTrusted() else { fputs("AX permission missing\n", stderr); exit(2) }
let app = AXUIElementCreateApplication(pid)
var result: [[String: Any]] = []
var windowRoots = try children(app, key: kAXWindowsAttribute)
var rootIndex = 0
while rootIndex < windowRoots.count {
    guard rootIndex < 128 else { fputs("too many nested window sheets\n", stderr); exit(3) }
    for child in try children(windowRoots[rootIndex]) where attribute(child, kAXRoleAttribute) as? String == kAXSheetRole {
        if !windowRoots.contains(where: { CFEqual($0, child) }) { windowRoots.append(child) }
    }
    rootIndex += 1
}
let candidates = windowRoots.filter(matches)
guard candidates.count == 1 else { fputs("exact owned window unavailable or ambiguous\n", stderr); exit(3) }
for (index, window) in candidates.enumerated() {
    var queue: [(AXUIElement, String)] = [(window, "w\(index)")]
    var entries: [[String: Any]] = []
    var position = 0
    while position < queue.count, position < 3000 {
        let (element, path) = queue[position]
        var row: [String: Any] = ["path": path]
        let keys = ["role": kAXRoleAttribute, "name": kAXTitleAttribute, "description": kAXDescriptionAttribute,
                    "value": kAXValueAttribute, "identifier": kAXIdentifierAttribute,
                    "selected": kAXSelectedAttribute, "enabled": kAXEnabledAttribute, "expanded": kAXExpandedAttribute]
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(element, &names) == .success, let declared = names as? [String] else {
            fputs("AX attributes unavailable; independent tree incomplete\n", stderr); exit(3)
        }
        for (name, key) in keys where declared.contains(key) {
            var raw: CFTypeRef?
            let copied = AXUIElementCopyAttributeValue(element, key as CFString, &raw)
            guard copied == .success || copied == .noValue else {
                fputs("Declared AX attribute read failed: \(key), error \(copied.rawValue)\n", stderr); exit(3)
            }
            if let value = serializable(raw) { row[name] = value }
        }
        guard row["role"] is String else { fputs("AX role missing\n", stderr); exit(3) }
        entries.append(row)
        for (childIndex, child) in try children(element).enumerated() { queue.append((child, path + "/\(childIndex)")) }
        position += 1
    }
    result.append(["windowNumber": number, "entries": entries, "complete": position == queue.count,
                   "name": serializable(attribute(window, kAXTitleAttribute)) ?? ""])
}
let data = try JSONSerialization.data(withJSONObject: ["pid": pid, "windows": result], options: [.sortedKeys])
FileHandle.standardOutput.write(data)
