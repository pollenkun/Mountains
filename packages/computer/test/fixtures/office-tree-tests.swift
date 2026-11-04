import Testing
import Foundation
import ApplicationServices
@testable import OfficeTree

private enum ReadFailure: Error { case unavailable }
private func walk(_ graph: [Int: (String, [Int])], failingRole: Int? = nil, failingChildren: Int? = nil, maximum: Int = 2000) throws {
    try verifyOfficeDocumentTree(root: 0, maximumNodes: maximum, equal: { $0 == $1 }, readRole: { node in
        guard node != failingRole, let row = graph[node] else { throw ReadFailure.unavailable }
        return row.0
    }, readChildren: { node in
        guard node != failingChildren, let row = graph[node] else { throw ReadFailure.unavailable }
        return row.1
    })
}

@Test func plainDocument() throws {
    try walk([0: ("AXWindow", [1, 2]), 1: ("AXGroup", [3]), 2: ("AXGroup", [4]), 3: ("AXImage", []), 4: ("AXButton", [])])
}
@Test func anApplicationReturnedAsAWindowDoesNotExpandIntoItsMenus() {
    #expect(throws: OfficeDocumentTreeError.rootIsNotWindow) {
        try verifyOfficeDocumentTree(root: 0, equal: { $0 == $1 }, readRole: { _ in "AXApplication" },
            readChildren: { _ in throw ReadFailure.unavailable })
    }
}
@Test func aCFArrayCastDoesNotProveItsItemsAreAccessibilityElements() {
    let strings = ["not an accessibility object"] as CFArray
    #expect(throws: OfficeDocumentTreeError.invalidElementArray) { try officeAXElements(strings, maximum: 128) }
    #expect(throws: OfficeDocumentTreeError.invalidElementArray) { try officeAXElements(kCFBooleanTrue!, maximum: 128) }
}
@Test func actualAccessibilityTypeTagsRetainTheSameElementAndRespectTheLimit() throws {
    // This only creates a local reference to this test's own process. No remote
    // AX attribute, window, focus, permission prompt or action is requested.
    let item = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
    let array = [item] as CFArray, result = try officeAXElements(array, maximum: 1)
    #expect(result.count == 1 && CFEqual(result[0], item))
    #expect(throws: OfficeDocumentTreeError.tooLarge) { try officeAXElements(array, maximum: 0) }
    #expect(try officeAXElements([] as CFArray, maximum: 0).isEmpty)
}
@Test(arguments: [false, true])
func sharedChildOrCycleIsNotACompleteTree(_ cycle: Bool) {
    #expect(throws: OfficeDocumentTreeError.repeatedNode) {
        try walk(cycle ? [0: ("AXWindow", [1]), 1: ("AXGroup", [0])] :
            [0: ("AXWindow", [1, 2]), 1: ("AXGroup", [3]), 2: ("AXGroup", [3]), 3: ("AXImage", [])])
    }
}
@Test(arguments: ["AXSheet", "AXWindow", "AXDialog"])
func nestedWindowIsNotAPlainDocument(_ role: String) {
    #expect(throws: OfficeDocumentTreeError.attachedWindow) {
        try walk([0: ("AXWindow", [1]), 1: ("AXGroup", [2]), 2: (role, [])])
    }
}
@Test func unreadableRoleIsNotACompleteTree() {
    #expect(throws: ReadFailure.self) { try walk([0: ("AXWindow", [1]), 1: ("AXGroup", [])], failingRole: 1) }
}
@Test func unreadableChildrenAreNotAnEmptyLeaf() {
    #expect(throws: ReadFailure.self) { try walk([0: ("AXWindow", [1]), 1: ("AXGroup", [])], failingChildren: 1) }
}
@Test func emptyRoleIsNotAccepted() {
    #expect(throws: OfficeDocumentTreeError.incompleteRole) { try walk([0: ("AXWindow", [1]), 1: ("", [])]) }
}
@Test func truncatedTreeDoesNotPass() {
    #expect(throws: OfficeDocumentTreeError.tooLarge) {
        try walk([0: ("AXWindow", [1]), 1: ("AXGroup", [2]), 2: ("AXSheet", [])], maximum: 2)
    }
}
@Test func undeclaredOptionalAttributeIsTheOnlyKnownAbsence() throws {
    #expect(try officeAttributeHasValue(declared: false, optional: true, readSucceeded: false, hasValue: false) == false)
    #expect(try officeAttributeHasValue(declared: true, optional: true, readSucceeded: true, hasValue: true))
}
@Test(arguments: [(false, false), (false, true), (true, false)])
func declaredButUnreadableAttributeIsNotAnEmptyLeaf(_ flags: (Bool, Bool)) {
    #expect(throws: OfficeDocumentTreeError.incompleteAttribute) {
        try officeAttributeHasValue(declared: true, optional: true, readSucceeded: flags.0, hasValue: flags.1)
    }
}
@Test func requiredMissingAttributeIsIncomplete() {
    #expect(throws: OfficeDocumentTreeError.undeclaredAttribute) {
        try officeAttributeHasValue(declared: false, optional: false, readSucceeded: false, hasValue: false)
    }
}
