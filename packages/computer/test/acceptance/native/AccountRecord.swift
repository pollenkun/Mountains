import Foundation

// Foundation-only wire format, shared by the real EventKit readers/writers
// and an executable serialization test which never imports EventKit.
struct NativeAccountRecord: Codable, Sendable {
    let id: String
    let sourceId: String
    let parentId: String?
    let kind: String
    let fingerprint: String

    private enum CodingKeys: String, CodingKey { case id, sourceId, parentId, kind, fingerprint }
    func encode(to encoder: any Encoder) throws {
        var value = encoder.container(keyedBy: CodingKeys.self)
        try value.encode(id, forKey: .id)
        try value.encode(sourceId, forKey: .sourceId)
        // Synthesized Swift Codable omits nil optionals. The JS evidence
        // format deliberately distinguishes an explicit root from a missing ID.
        if let parentId { try value.encode(parentId, forKey: .parentId) }
        else { try value.encodeNil(forKey: .parentId) }
        try value.encode(kind, forKey: .kind)
        try value.encode(fingerprint, forKey: .fingerprint)
    }
}
