import Foundation
import Security
import SystemConfiguration

private let applicationName = "Whistle Mock Manager" as CFString
private let maxRequestBytes = 1024 * 1024
private let maxResponseBytes = 2 * 1024 * 1024
private let maxServices = 128
private let inactiveKey = "__INACTIVE__"

enum ProxyFailure: String, Error {
    case invalidRequest, readFailed, authorization, authorizationUnavailable, conflict
    case busy, updateFailed, commitFailed, applyFailed, responseTooLarge
}

struct ProtocolState {
    let enabled: Bool
    let configuration: [String: Any]
    // Canonical JSON keeps integer/real/boolean types distinct during comparison.
    let signature: Data
}

struct ProxyChange {
    let id: String
    let expected: ProtocolState
    let next: ProtocolState
}

struct ProxyRequest {
    let changes: [ProxyChange]
    let expectedLocation: String?
}

private func validID(_ id: String) -> Bool {
    func alphanumeric(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
    }
    let bytes = id.utf8
    guard bytes.count <= 128, let first = bytes.first, alphanumeric(first) else { return false }
    return bytes.allSatisfy { alphanumeric($0) || [45, 46, 95].contains($0) }
}

// Keep ordinary proxy keys and JSON-compatible values visible to the controller.
// Tagged scalars retain property-list types that JSON cannot round trip exactly.
// A real nested dictionary using the reserved key is escaped in the same scheme.
private struct PlistCodec {
    private static let marker = "$whistlePlist"
    private static let maxScalarBytes = 256 * 1024
    private static let safeInteger: Int64 = 9_007_199_254_740_991
    private var remaining = 16_384

    private mutating func visit(_ depth: Int) throws {
        remaining -= 1
        guard depth <= 16, remaining >= 0 else { throw ProxyFailure.invalidRequest }
    }

    private func validate(_ string: String, maxBytes: Int) throws {
        guard string.utf8.count <= maxBytes, string.unicodeScalars.allSatisfy({
            let value = $0.value
            return value == 9 || value == 10 || value == 13 || (value >= 32 && value != 0xfffe && value != 0xffff)
        }) else { throw ProxyFailure.invalidRequest }
    }

    private func tagged(_ type: String, _ value: Any) -> [String: Any] {
        [Self.marker: [type: value]]
    }

    mutating func dictionary(_ value: [String: Any], depth: Int = 0, encode: Bool) throws -> [String: Any] {
        guard value.count <= 2048 else { throw ProxyFailure.invalidRequest }
        var mapped: [String: Any] = [:]
        for (key, child) in value {
            try validate(key, maxBytes: 4096)
            mapped[key] = try convert(child, depth: depth + 1, encode: encode)
        }
        return mapped
    }

    private mutating func convert(_ value: Any, depth: Int, encode: Bool) throws -> Any {
        try visit(depth)
        if let dictionary = value as? [String: Any] {
            if dictionary[Self.marker] != nil {
                if encode { return tagged("dictionary", try self.dictionary(dictionary, depth: depth, encode: true)) }
                guard dictionary.count == 1, let tag = dictionary[Self.marker] as? [String: Any], tag.count == 1,
                      let (type, payload) = tag.first else { throw ProxyFailure.invalidRequest }
                switch type {
                case "dictionary":
                    guard let literal = payload as? [String: Any], literal[Self.marker] != nil else {
                        throw ProxyFailure.invalidRequest
                    }
                    return try self.dictionary(literal, depth: depth, encode: false)
                case "data":
                    guard let text = payload as? String, let data = Data(base64Encoded: text),
                          data.count <= Self.maxScalarBytes, data.base64EncodedString() == text else {
                        throw ProxyFailure.invalidRequest
                    }
                    return data
                case "integer":
                    guard let text = payload as? String, let number = UInt64(text), number > UInt64(Int64.max),
                          String(number) == text else {
                        guard let text = payload as? String, let number = Int64(text), String(number) == text,
                              !(-Self.safeInteger...Self.safeInteger).contains(number) else {
                            throw ProxyFailure.invalidRequest
                        }
                        return NSNumber(value: number)
                    }
                    return NSNumber(value: number)
                case "real", "date":
                    guard let text = payload as? String, let bits = UInt64(text, radix: 16),
                          String(bits, radix: 16) == text else { throw ProxyFailure.invalidRequest }
                    let number = Double(bitPattern: bits)
                    guard number.isFinite else { throw ProxyFailure.invalidRequest }
                    if type == "real" { return NSNumber(value: number) }
                    return Date(timeIntervalSinceReferenceDate: number)
                default:
                    throw ProxyFailure.invalidRequest
                }
            }
            return try self.dictionary(dictionary, depth: depth, encode: encode)
        }
        if let array = value as? [Any] {
            guard array.count <= 2048 else { throw ProxyFailure.invalidRequest }
            return try array.map { try convert($0, depth: depth + 1, encode: encode) }
        }
        if let string = value as? String {
            try validate(string, maxBytes: Self.maxScalarBytes)
            return string
        }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number }
            guard CFGetTypeID(number) == CFNumberGetTypeID() else { throw ProxyFailure.invalidRequest }
            let cfNumber = unsafeBitCast(number, to: CFNumber.self)
            if CFNumberIsFloatType(cfNumber) {
                guard number.doubleValue.isFinite else { throw ProxyFailure.invalidRequest }
                return encode ? tagged("real", String(number.doubleValue.bitPattern, radix: 16)) : number
            }
            if let signed = Int64(number.stringValue), (-Self.safeInteger...Self.safeInteger).contains(signed) {
                return number
            }
            guard encode, Int64(number.stringValue) != nil || UInt64(number.stringValue) != nil else {
                throw ProxyFailure.invalidRequest
            }
            return tagged("integer", number.stringValue)
        }
        if encode, let date = value as? Date, date.timeIntervalSinceReferenceDate.isFinite {
            return tagged("date", String(date.timeIntervalSinceReferenceDate.bitPattern, radix: 16))
        }
        if encode, let data = value as? Data, data.count <= Self.maxScalarBytes {
            return tagged("data", data.base64EncodedString())
        }
        throw ProxyFailure.invalidRequest
    }
}

private func wireConfiguration(_ configuration: [String: Any]) throws -> [String: Any] {
    var codec = PlistCodec()
    return try codec.dictionary(configuration, encode: true)
}

private func signature(_ configuration: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: wireConfiguration(configuration), options: [.sortedKeys])
}

private func parseState(_ value: Any?) throws -> ProtocolState {
    guard let state = value as? [String: Any], Set(state.keys) == ["enabled", "configuration"],
          let enabled = state["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
          let wire = state["configuration"] as? [String: Any], wire[inactiveKey] == nil else {
        throw ProxyFailure.invalidRequest
    }
    var codec = PlistCodec()
    let configuration = try codec.dictionary(wire, encode: false)
    let canonical = try signature(configuration)
    // macOS commits preferences in XML. Fail before locking if serialization
    // would otherwise silently lose a value (for example a fractional date).
    guard let xml = try? PropertyListSerialization.data(fromPropertyList: configuration, format: .xml, options: 0),
          let roundTrip = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
          try signature(roundTrip) == canonical else { throw ProxyFailure.invalidRequest }
    return ProtocolState(enabled: enabled.boolValue, configuration: configuration, signature: canonical)
}

func parseChanges(_ data: Data) throws -> ProxyRequest {
    guard data.count <= maxRequestBytes, String(data: data, encoding: .utf8) != nil,
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          Set(request.keys).isSubset(of: ["changes", "expectedLocation"]),
          let values = request["changes"] as? [[String: Any]],
          (1...maxServices).contains(values.count) else { throw ProxyFailure.invalidRequest }
    var location: String?
    if let value = request["expectedLocation"] {
        guard let id = value as? String, validID(id) else { throw ProxyFailure.invalidRequest }
        location = id
    }
    var ids = Set<String>()
    return ProxyRequest(changes: try values.map { change in
        guard Set(change.keys) == ["id", "expected", "next"], let id = change["id"] as? String,
              validID(id), ids.insert(id).inserted else { throw ProxyFailure.invalidRequest }
        return ProxyChange(id: id, expected: try parseState(change["expected"]), next: try parseState(change["next"]))
    }, expectedLocation: location)
}

private func serviceID(_ service: SCNetworkService) -> String {
    (SCNetworkServiceGetServiceID(service) as String?) ?? ""
}

private func currentLocation(_ prefs: SCPreferences) throws -> (id: String, members: Set<String>) {
    guard let set = SCNetworkSetCopyCurrent(prefs),
          let members = SCNetworkSetCopyServices(set) as? [SCNetworkService] else { throw ProxyFailure.readFailed }
    guard let id = SCNetworkSetGetSetID(set) as String?, validID(id) else { throw ProxyFailure.readFailed }
    return (id, Set(members.map(serviceID)))
}

private func proxyConfiguration(_ proto: SCNetworkProtocol) -> [String: Any] {
    var configuration = SCNetworkProtocolGetConfiguration(proto) as? [String: Any] ?? [:]
    // SystemConfiguration stores the disabled flag internally in the plist.
    // Represent it solely via the public enabled flag; the setters manage it.
    configuration.removeValue(forKey: inactiveKey)
    return configuration
}

func readSnapshot(_ prefs: SCPreferences) throws -> [String: Any] {
    let location = try currentLocation(prefs)
    guard let all = SCNetworkServiceCopyAll(prefs) as? [SCNetworkService] else { throw ProxyFailure.readFailed }
    var services: [[String: Any]] = []
    for service in all.sorted(by: { serviceID($0) < serviceID($1) }) {
        guard let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies) else { continue }
        let id = serviceID(service)
        guard validID(id), services.count < maxServices else { throw ProxyFailure.readFailed }
        let configuration: [String: Any]
        do {
            configuration = try wireConfiguration(proxyConfiguration(proto))
        } catch {
            throw ProxyFailure.readFailed
        }
        services.append([
            "id": id,
            "name": (SCNetworkServiceGetName(service) as String?) ?? id,
            "active": location.members.contains(id) && SCNetworkServiceGetEnabled(service),
            "enabled": SCNetworkProtocolGetEnabled(proto),
            "configuration": configuration,
        ])
    }
    return ["location": location.id, "services": services]
}

// Stage in an SCPreferences session. The caller holds the lock and only
// commits if every precondition and setter succeeds.
func stageChanges(_ request: ProxyRequest, _ prefs: SCPreferences) throws {
    let location = request.expectedLocation != nil ? try currentLocation(prefs) : nil
    if request.expectedLocation != location?.id { throw ProxyFailure.conflict }
    let protocols = try request.changes.map { change -> SCNetworkProtocol in
        guard let service = SCNetworkServiceCopy(prefs, change.id as CFString),
              location.map({ $0.members.contains(change.id) && SCNetworkServiceGetEnabled(service) }) ?? true,
              let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies),
              SCNetworkProtocolGetEnabled(proto) == change.expected.enabled,
              (try? signature(proxyConfiguration(proto))) == change.expected.signature else {
            throw ProxyFailure.conflict
        }
        return proto
    }
    for (change, proto) in zip(request.changes, protocols) {
        guard SCNetworkProtocolSetConfiguration(proto, change.next.configuration as CFDictionary),
              SCNetworkProtocolSetEnabled(proto, change.next.enabled) else { throw ProxyFailure.updateFailed }
    }
}

private func modificationFailure(_ status: Int32, default failure: ProxyFailure) -> ProxyFailure {
    if status == errAuthorizationCanceled || status == errAuthorizationDenied || status == kSCStatusAccessError {
        return .authorization
    }
    if status == kSCStatusPrefsBusy || status == kSCStatusLocked { return .busy }
    if status == kSCStatusStale { return .conflict }
    return failure
}

private func commitChanges(_ request: ProxyRequest) throws {
    var authorization: AuthorizationRef?
    let status = AuthorizationCreate(nil, nil, [], &authorization)
    guard status == errAuthorizationSuccess, let authorization else {
        if status == errAuthorizationCanceled || status == errAuthorizationDenied { throw ProxyFailure.authorization }
        throw ProxyFailure.authorizationUnavailable
    }
    defer { AuthorizationFree(authorization, []) }
    guard let prefs = SCPreferencesCreateWithAuthorization(nil, applicationName, nil, authorization) else {
        throw modificationFailure(SCError(), default: .authorizationUnavailable)
    }
    // Use a fresh session and perform the first preferences read under the
    // lock. SystemConfiguration requests interactive authorization as needed.
    guard SCPreferencesLock(prefs, false) else { throw modificationFailure(SCError(), default: .updateFailed) }
    defer { SCPreferencesUnlock(prefs) }
    try stageChanges(request, prefs)
    guard SCPreferencesCommitChanges(prefs) else { throw modificationFailure(SCError(), default: .commitFailed) }
    // Keep apply distinct: a failure after commit can leave persistent changes.
    guard SCPreferencesApplyChanges(prefs) else { throw ProxyFailure.applyFailed }
}

private func readRequest() throws -> ProxyRequest {
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: min(65_536, maxRequestBytes + 1 - data.count)),
          !chunk.isEmpty {
        data.append(chunk)
        guard data.count <= maxRequestBytes else { throw ProxyFailure.invalidRequest }
    }
    return try parseChanges(data)
}

#if !SYSTEM_PROXY_TEST
@main
private struct SystemProxyCommand {
    static func main() {
        do {
            let result: [String: Any]
            switch Array(CommandLine.arguments.dropFirst()) {
            case ["read"]:
                guard let prefs = SCPreferencesCreate(nil, applicationName, nil) else { throw ProxyFailure.readFailed }
                result = try readSnapshot(prefs)
            case ["write"]:
                try commitChanges(readRequest())
                result = ["ok": true]
            default:
                throw ProxyFailure.invalidRequest
            }
            var data = try JSONSerialization.data(withJSONObject: result)
            guard data.count < maxResponseBytes else { throw ProxyFailure.responseTooLarge }
            data.append(10)
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            let code = (error as? ProxyFailure ?? .invalidRequest).rawValue
            try? FileHandle.standardOutput.write(contentsOf: Data(("{\"error\":\"\(code)\"}\n").utf8))
            exit(EXIT_FAILURE)
        }
    }
}
#endif
