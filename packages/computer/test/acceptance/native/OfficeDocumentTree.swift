import CoreFoundation
import ApplicationServices

enum OfficeDocumentTreeError: Error, Equatable {
    case incompleteRole
    case attachedWindow
    case tooLarge
    case undeclaredAttribute
    case incompleteAttribute
    case repeatedNode
    case rootIsNotWindow
    case invalidElementArray
}

// Swift can cast arbitrary CF objects to CF wrapper classes. The array cast
// alone does not prove that any item is an AXUIElement. Check every CF type tag
// before making an AX call or retaining it as a window/child.
func officeAXElements(_ raw: CFTypeRef, maximum: Int) throws -> [AXUIElement] {
    guard CFGetTypeID(raw) == CFArrayGetTypeID() else { throw OfficeDocumentTreeError.invalidElementArray }
    let array = unsafeDowncast(raw, to: CFArray.self), count = CFArrayGetCount(array)
    guard maximum >= 0, count <= maximum else { throw OfficeDocumentTreeError.tooLarge }
    return try (0..<count).map { index in
        guard let pointer = CFArrayGetValueAtIndex(array, index) else { throw OfficeDocumentTreeError.invalidElementArray }
        let value = Unmanaged<CFTypeRef>.fromOpaque(pointer).takeUnretainedValue()
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw OfficeDocumentTreeError.invalidElementArray }
        return unsafeDowncast(value, to: AXUIElement.self)
    }
}

// Real AX adapters call this exact conversion. An unreported attribute is
// different from an advertised attribute whose value could not be read.
func officeAttributeHasValue(declared: Bool, optional: Bool, readSucceeded: Bool, hasValue: Bool) throws -> Bool {
    if !declared {
        guard optional else { throw OfficeDocumentTreeError.undeclaredAttribute }
        return false
    }
    guard readSucceeded, hasValue else { throw OfficeDocumentTreeError.incompleteAttribute }
    return true
}

// Shared by the actual AX reader and pure Swift tests. Callbacks must throw on
// partial reads; unsupported AXChildren at a genuine leaf is an empty list.
func verifyOfficeDocumentTree<Node>(
    root: Node, maximumNodes: Int = 2000,
    equal: (Node, Node) -> Bool,
    readRole: (Node) throws -> String,
    readChildren: (Node) throws -> [Node]
) throws {
    var queue = [root], seen: [Node] = [], index = 0
    while index < queue.count {
        guard maximumNodes > 0, queue.count <= maximumNodes else { throw OfficeDocumentTreeError.tooLarge }
        let node = queue[index]
        index += 1
        guard !seen.contains(where: { equal($0, node) }) else { throw OfficeDocumentTreeError.repeatedNode }
        seen.append(node)
        let role = try readRole(node)
        guard !role.isEmpty else { throw OfficeDocumentTreeError.incompleteRole }
        if equal(node, root) && role != "AXWindow" { throw OfficeDocumentTreeError.rootIsNotWindow }
        if !equal(node, root) && ["AXSheet", "AXWindow", "AXDialog"].contains(role) {
            throw OfficeDocumentTreeError.attachedWindow
        }
        queue.append(contentsOf: try readChildren(node))
    }
}
