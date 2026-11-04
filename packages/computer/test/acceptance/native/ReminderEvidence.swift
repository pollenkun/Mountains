import CryptoKit
import EventKit
import Foundation

// Shared, explicit public-field schema. No permission requests or writes.
enum ReminderEvidence {
    struct Failure: Error { let message: String }
    struct Source: Encodable, Sendable {
        let id: String
        let storage: String
        let proof = "EventKit.sourceType"
    }
    typealias Record = NativeAccountRecord
    struct Inventory: Encodable {
        let version = 1
        let kind = "reminders"
        let authorization = "full"
        let coverage = "all-objects"
        let complete = true
        // EventKit does not expose every field shown by modern Reminders. This
        // explicit scope must not be presented as a full database export.
        let fieldScope = "EventKit-public-reminder-v1"
        let sources: [Source]
        let records: [Record]
    }

    static func value(_ optional: Any?) -> Any { optional ?? NSNull() }
    static func date(_ optional: Date?) -> Any { value(optional?.timeIntervalSince1970) }
    static func components(_ optional: DateComponents?) throws -> Any {
        guard let optional else { return NSNull() }
        return try JSONSerialization.jsonObject(with: JSONEncoder().encode(optional))
    }
    static func fingerprint(_ fields: [String: Any], key: SymmetricKey) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        return HMAC<SHA256>.authenticationCode(for: bytes, using: key)
            .map { String(format: "%02x", $0) }.joined()
    }
    static func source(_ item: EKSource) -> Source {
        let storage: String
        switch item.sourceType {
        case .local: storage = "local"
        case .exchange, .calDAV, .mobileMe, .subscribed, .birthdays: storage = "remote"
        @unknown default: storage = "unknown"
        }
        return Source(id: item.sourceIdentifier, storage: storage)
    }
    static func calendar(_ item: EKCalendar, key: SymmetricKey) throws -> Record {
        guard let account = item.source, !item.calendarIdentifier.isEmpty, !account.sourceIdentifier.isEmpty else {
            throw Failure(message: "calendar identity is incomplete")
        }
        let color: Any = if let color = item.cgColor {
            ["space": value(color.colorSpace?.name as String?), "components": value(color.components)]
        } else { NSNull() }
        return Record(id: item.calendarIdentifier, sourceId: account.sourceIdentifier, parentId: nil,
                      kind: "container", fingerprint: try fingerprint([
                        "title": item.title, "type": item.type.rawValue,
                        "modifiable": item.allowsContentModifications, "subscribed": item.isSubscribed,
                        "immutable": item.isImmutable, "entityTypes": item.allowedEntityTypes.rawValue,
                        "availability": item.supportedEventAvailabilities.rawValue, "color": color
                      ], key: key))
    }
    static func reminder(_ item: EKReminder, key: SymmetricKey) throws -> Record {
        guard let container = item.calendar, let account = container.source,
              !item.calendarItemIdentifier.isEmpty, !container.calendarIdentifier.isEmpty else {
            throw Failure(message: "reminder identity is incomplete")
        }
        let alarms: [[String: Any]] = (item.alarms ?? []).map { alarm in
            let location = alarm.structuredLocation
            let point = location?.geoLocation
            return ["absolute": date(alarm.absoluteDate), "offset": alarm.relativeOffset,
                    "proximity": alarm.proximity.rawValue, "type": alarm.type.rawValue,
                    "email": value(alarm.emailAddress), "sound": value(alarm.soundName),
                    "location": value(location?.title), "radius": value(location?.radius),
                    "latitude": value(point?.coordinate.latitude), "longitude": value(point?.coordinate.longitude),
                    "altitude": value(point?.altitude), "accuracy": value(point?.horizontalAccuracy)]
        }
        let rules: [[String: Any]] = (item.recurrenceRules ?? []).map { rule in
            ["calendar": rule.calendarIdentifier, "frequency": rule.frequency.rawValue,
             "interval": rule.interval, "firstDay": rule.firstDayOfTheWeek,
             "days": value(rule.daysOfTheWeek?.map { ["day": $0.dayOfTheWeek.rawValue, "week": $0.weekNumber] }),
             "monthDays": value(rule.daysOfTheMonth), "months": value(rule.monthsOfTheYear),
             "weeks": value(rule.weeksOfTheYear), "yearDays": value(rule.daysOfTheYear),
             "positions": value(rule.setPositions), "endDate": date(rule.recurrenceEnd?.endDate),
             "occurrences": value(rule.recurrenceEnd?.occurrenceCount)]
        }
        let attendees: [[String: Any]] = (item.attendees ?? []).map {
            ["url": $0.url.absoluteString, "name": value($0.name), "status": $0.participantStatus.rawValue,
             "role": $0.participantRole.rawValue, "type": $0.participantType.rawValue, "self": $0.isCurrentUser]
        }
        return Record(id: item.calendarItemIdentifier, sourceId: account.sourceIdentifier,
                      parentId: container.calendarIdentifier, kind: "object", fingerprint: try fingerprint([
                        "externalId": value(item.calendarItemExternalIdentifier), "title": value(item.title),
                        "location": value(item.location), "notes": value(item.notes), "url": value(item.url?.absoluteString),
                        "created": date(item.creationDate), "modified": date(item.lastModifiedDate),
                        "timeZone": value(item.timeZone?.identifier), "start": try components(item.startDateComponents),
                        "due": try components(item.dueDateComponents), "completed": item.isCompleted,
                        "completion": date(item.completionDate), "priority": item.priority,
                        "alarms": alarms, "rules": rules, "attendees": attendees,
                        "hasAlarms": item.hasAlarms, "hasRules": item.hasRecurrenceRules,
                        "hasAttendees": item.hasAttendees, "hasNotes": item.hasNotes
                      ], key: key))
    }
}
