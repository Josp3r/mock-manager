import Foundation
import SystemConfiguration

private let first = "00000000-0000-0000-0000-000000000001"
private let second = "00000000-0000-0000-0000-000000000002"
private let currentSet = "00000000-0000-0000-0000-000000000003"
private let oldSet = "00000000-0000-0000-0000-000000000004"
private let appName = "System proxy test" as CFString

private func require(_ condition: Bool, _ detail: String) {
    if !condition {
        FileHandle.standardError.write(Data((detail + "\n").utf8))
        exit(EXIT_FAILURE)
    }
}

private func rejects(_ expected: ProxyFailure, _ block: () throws -> Void) throws {
    do {
        try block()
        require(false, "operation accepted invalid request")
    } catch let actual as ProxyFailure {
        require(actual == expected, "wrong error: \(actual.rawValue)")
    }
}

private func encoded(_ changes: [[String: Any]], location: String? = nil) throws -> Data {
    var request: [String: Any] = ["changes": changes]
    if let location { request["expectedLocation"] = location }
    return try JSONSerialization.data(withJSONObject: request)
}

private func readPreferences(_ file: URL) throws -> SCPreferences {
    guard let prefs = SCPreferencesCreate(nil, appName, file.path as CFString) else {
        throw ProxyFailure.readFailed
    }
    return prefs
}

private func startFixtureProcess(_ role: String, _ directory: URL) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = [role, directory.path]
    try process.run()
    return process
}

private struct FixtureTimeout: Error {}

private func waitFor<Value>(_ probe: () -> Value?) throws -> Value {
    let deadline = DispatchTime.now() + .seconds(10)
    repeat {
        if let value = probe() { return value }
        Thread.sleep(forTimeInterval: 0.01)
    } while DispatchTime.now() < deadline
    throw FixtureTimeout()
}

private func writeAfterParentExit(_ directory: URL) throws {
    let requestingPID = getppid()
    require(requestingPID > 1, "fixture helper must start with a live parent")
    let request = try parseChanges(Data(contentsOf: directory.appendingPathComponent("request.json")))
    let prefs = try readPreferences(directory.appendingPathComponent("isolated-preferences.plist"))
    try Data().write(to: directory.appendingPathComponent("ready"), options: .atomic)
    _ = try waitFor { getppid() == 1 ? true : nil }

    let outcome: String
    do {
        try stageChanges(request, prefs, requestingPID: requestingPID)
        outcome = "staged"
    } catch let failure as ProxyFailure {
        outcome = failure.rawValue
    }
    let snapshot = try readSnapshot(prefs)
    let services = snapshot["services"] as? [[String: Any]]
    let service = services?.first { $0["id"] as? String == first }
    let configuration = service?["configuration"] as? [String: Any]
    let port = configuration?["HTTPPort"] as? Int ?? -1
    try Data("\(outcome) \(port)".utf8).write(to: directory.appendingPathComponent("outcome"), options: .atomic)
}

@main
struct IsolatedSystemProxyTest {
    static func main() throws {
        if CommandLine.arguments.count == 3 {
            let directory = URL(fileURLWithPath: CommandLine.arguments[2])
            switch CommandLine.arguments[1] {
            case "write-parent":
                let writer = try startFixtureProcess("write-child", directory)
                writer.waitUntilExit()
                return
            case "write-child":
                try writeAfterParentExit(directory)
                return
            default:
                break
            }
        }
        let requestingPID = getppid()
        let state: [String: Any] = ["enabled": true, "configuration": ["HTTPPort": 8888]]
        let valid: [String: Any] = ["id": first, "expected": state, "next": state]
        require(try parseChanges(encoded([valid])).changes.count == 1, "valid change rejected")
        for request in [
            [],
            [valid, valid],
            [valid.merging(["id": "../not-a-service"]) { _, next in next }],
            [valid.merging(["id": String(repeating: "a", count: 129)]) { _, next in next }],
            [valid.merging(["path": "/tmp/file"]) { _, next in next }],
            [valid.merging(["expected": ["enabled": 1, "configuration": [:]]]) { _, next in next }],
            [valid.merging(["next": ["enabled": true, "configuration": ["invalid": NSNull()]]]) { _, next in next }],
            [valid.merging(["next": ["enabled": true, "configuration": ["__INACTIVE__": 1]]]) { _, next in next }],
        ] as [[[String: Any]]] {
            try rejects(.invalidRequest) { _ = try parseChanges(encoded(request)) }
        }
        try rejects(.invalidRequest) { _ = try parseChanges(Data(repeating: 32, count: 2 * 1024 * 1024)) }
        try rejects(.invalidRequest) { _ = try parseChanges(encoded([valid], location: "bad/location")) }
        try rejects(.invalidRequest) {
            _ = try parseChanges(encoded((1...129).map { i in valid.merging(["id": "svc-\(i)"]) { _, next in next } }))
        }
        var deep: Any = true
        for _ in 1...17 { deep = [deep] }
        let tooDeep: [String: Any] = ["enabled": true, "configuration": ["nested": deep]]
        try rejects(.invalidRequest) { _ = try parseChanges(encoded([["id": first, "expected": state, "next": tooDeep]])) }

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("isolated-preferences.plist")
        let original: [String: Any] = [
            "HTTPEnable": 1, "HTTPProxy": "old.example.invalid", "HTTPPort": 8080,
            "ExceptionsList": ["*.local"], "Samples": [
                "date": Date(timeIntervalSinceReferenceDate: 42),
                "data": Data([0xff, 0x00, 0xaf]),
                "integer": Int64.max, "real": 42.25, "bool": true,
                "$whistlePlist": "real dictionary key",
            ],
        ]
        let fixture: [String: Any] = [
            "CurrentSet": "/Sets/\(currentSet)",
            "NetworkServices": [
                first: ["UserDefinedName": "Fixture Wi-Fi", "Interface": ["Type": "Ethernet"], "Proxies": original],
                second: ["UserDefinedName": "Fixture Ethernet", "Interface": ["Type": "Ethernet"], "Proxies": ["__INACTIVE__": 1]],
            ],
            "Sets": [
                currentSet: ["Network": ["Service": [first: ["__LINK__": "/NetworkServices/\(first)"]]]],
                oldSet: ["Network": ["Service": [second: ["__LINK__": "/NetworkServices/\(second)"]]]],
            ],
        ]
        try PropertyListSerialization.data(fromPropertyList: fixture, format: .binary, options: 0).write(to: file)
        func preferences() throws -> SCPreferences { try readPreferences(file) }
        // SCPreferencesLock for an unauthenticated session requires root even
        // for a custom path. Exercise the actual protocol setters after CAS,
        // exporting their staged values to the fixture without lock/commit/apply.
        func persistFixture(_ prefs: SCPreferences) throws {
            guard let keys = SCPreferencesCopyKeyList(prefs) as? [String] else { throw ProxyFailure.readFailed }
            var copy: [String: Any] = [:]
            for key in keys { copy[key] = SCPreferencesGetValue(prefs, key as CFString) }
            try PropertyListSerialization.data(fromPropertyList: copy, format: .xml, options: 0).write(to: file, options: .atomic)
        }
        func read(_ prefs: SCPreferences? = nil) throws -> [[String: Any]] {
            let snapshot = try readSnapshot(prefs ?? preferences())
            require(snapshot["location"] as? String == currentSet, "current location not reported")
            guard let values = snapshot["services"] as? [[String: Any]],
                  let a = values.first(where: { $0["id"] as? String == first }),
                  let b = values.first(where: { $0["id"] as? String == second }) else {
                throw ProxyFailure.readFailed
            }
            require(a["active"] as? Bool == true && b["active"] as? Bool == false, "location membership not observed")
            return [a, b]
        }

        let before = try read()
        require(before[1]["enabled"] as? Bool == false, "disabled protocol reported enabled")
        let beforeState = ["enabled": before[0]["enabled"]!, "configuration": before[0]["configuration"]!]
        var next = before[0]["configuration"] as! [String: Any]
        next["HTTPPort"] = 8899
        let nextState: [String: Any] = ["enabled": false, "configuration": next]
        let firstChange = ["id": first, "expected": beforeState, "next": nextState] as [String: Any]
        let installData = try encoded([firstChange], location: currentSet)
        let install = try parseChanges(installData)
        try installData.write(to: folder.appendingPathComponent("request.json"))
        let writerParent = try startFixtureProcess("write-parent", folder)
        defer { if writerParent.isRunning { writerParent.terminate() } }
        _ = try waitFor { FileManager.default.fileExists(atPath: folder.appendingPathComponent("ready").path) ? true : nil }
        require(kill(writerParent.processIdentifier, SIGKILL) == 0, "fixture parent could not be killed")
        writerParent.waitUntilExit()
        let orphanOutcome = try waitFor { try? String(contentsOf: folder.appendingPathComponent("outcome"), encoding: .utf8) }
        require(orphanOutcome == "requesterExited 8080", "orphaned helper entered write stage: \(orphanOutcome)")
        let staleLocation = try parseChanges(encoded([firstChange], location: oldSet))
        try rejects(.conflict) { try stageChanges(staleLocation, preferences(), requestingPID: requestingPID) }
        let secondState = ["enabled": before[1]["enabled"]!, "configuration": before[1]["configuration"]!]
        let inactive = try parseChanges(encoded([["id": second, "expected": secondState, "next": nextState]], location: currentSet))
        try rejects(.conflict) { try stageChanges(inactive, preferences(), requestingPID: requestingPID) }
        let missing = try parseChanges(encoded([["id": first, "expected": beforeState, "next": nextState],
                                                ["id": "missing", "expected": beforeState, "next": nextState]]))
        let missingSession = try preferences()
        try rejects(.conflict) { try stageChanges(missing, missingSession, requestingPID: requestingPID) }
        require((try read(missingSession)[0]["configuration"] as? [String: Any])?["HTTPPort"] as? Int == 8080,
                "missing service allowed a partial update")
        let externalSession = try preferences()
        guard let external = SCNetworkServiceCopy(externalSession, first as CFString),
              let externalProto = SCNetworkServiceCopyProtocol(external, kSCNetworkProtocolTypeProxies) else {
            throw ProxyFailure.readFailed
        }
        var externalConfig = original
        externalConfig["ExceptionsList"] = ["updated.invalid"]
        require(SCNetworkProtocolSetConfiguration(externalProto, externalConfig as CFDictionary), "fixture external edit failed")
        try rejects(.conflict) { try stageChanges(install, externalSession, requestingPID: requestingPID) }
        let installSession = try preferences()
        try stageChanges(install, installSession, requestingPID: requestingPID)
        try persistFixture(installSession)
        let installed = try read()[0]
        require(installed["enabled"] as? Bool == false, "protocol flag was not stored")
        require((installed["configuration"] as? [String: Any])?["HTTPPort"] as? Int == 8899, "port was not stored")
        try rejects(.conflict) { try stageChanges(install, preferences(), requestingPID: requestingPID) }
        let restore = try parseChanges(encoded([["id": first, "expected": nextState, "next": beforeState]]))
        let restoreSession = try preferences()
        guard let anotherLocation = SCNetworkSetCopy(restoreSession, oldSet as CFString) else { throw ProxyFailure.readFailed }
        require(SCNetworkSetSetCurrent(anotherLocation), "fixture location switch failed")
        try stageChanges(restore, restoreSession, requestingPID: requestingPID)
        try persistFixture(restoreSession)

        let restored = try preferences()
        guard let service = SCNetworkServiceCopy(restored, first as CFString),
              let protocolRef = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies),
              let config = SCNetworkProtocolGetConfiguration(protocolRef) else {
            throw ProxyFailure.readFailed
        }
        require(CFEqual(config, original as CFDictionary), "original complete plist was not restored")
        require(SCNetworkProtocolGetEnabled(protocolRef), "original enabled flag was not restored")
        print("Isolated native validation and SystemConfiguration round trip passed")
    }
}
