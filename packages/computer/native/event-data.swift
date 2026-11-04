import AppKit
import Foundation

// Create data only. Input, target validation and cancellation remain in the
// pointer helper. NSEvent's opaque CGEvent return does not bridge through JXA.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func reply(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

while let line = readLine() {
    var id: Any = 0
    do {
        guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let window = request["window"] as? Int,
              let flags = request["flags"] as? UInt else {
            throw NSError(domain: "MountainsEventData", code: 1, userInfo: [NSLocalizedDescriptionKey: "event data needs a window and modifier flags"])
        }
        id = request["id"] ?? 0
        var events: [String: String] = [:]
        if let keyCode = request["keyCode"] as? UInt16, let characters = request["characters"] as? String {
            for (name, type) in ["down": NSEvent.EventType.keyDown, "up": .keyUp] {
                guard let native = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: flags), timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode),
                      let data = native.cgEvent?.data else {
                    throw NSError(domain: "MountainsEventData", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not create a native keyboard event"])
                }
                events[name] = (data as Data).base64EncodedString()
            }
            reply(["id": id, "ok": true, "events": events])
            continue
        }
        let types: [String: NSEvent.EventType] = ["down": .leftMouseDown, "up": .leftMouseUp, "rdown": .rightMouseDown, "rup": .rightMouseUp, "move": .mouseMoved, "drag": .leftMouseDragged]
        for (name, type) in types {
            guard let native = NSEvent.mouseEvent(with: type, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: flags), timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window, context: nil, eventNumber: 1, clickCount: 1, pressure: 1),
                  let event = native.cgEvent,
                  let data = event.data else {
                throw NSError(domain: "MountainsEventData", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not create a native mouse event"])
            }
            events[name] = (data as Data).base64EncodedString()
        }
        reply(["id": id, "ok": true, "events": events])
    } catch {
        reply(["id": id, "ok": false, "error": error.localizedDescription])
    }
}
