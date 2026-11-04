import Foundation
import Testing
@testable import RetainedApplication

private enum FakeProblem: Error { case pipe, observation, request, lease }
@MainActor
private final class ApplicationFixture {
    let birth = NativeProcessIdentity(pid: 55, bootId: "12345678-1234-1234-1234-123456789abc", startSeconds: "1792300000", startMicroseconds: 1)
    var owner: RetainedApplicationOwner?
    var clock = 0.0
    var pid: Int32 = 55
    var terminated = false
    var process: NativeProcessObservation?
    var executable = "/Applications/Own.app/Contents/MacOS/Own"
    var reused = false
    var permitted = true
    var leaseFails = false
    var observationFails = false
    var observationDelay = 0.0
    var normalAccepts = true
    var forceAccepts = true
    var normalFails = false
    var forceFails = false
    var normalExits = false
    var forceExits = false
    var normalDelay = 0.0
    var forceDelay = 0.0
    var normal = 0
    var force = 0
    var ticks = 0
    var events: [String] = []
    var brokenEvent: String?
    var tickFails = false
    var onEvent: ((String) -> Void)?
    var onTick: (() -> Void)?

    func exited() { terminated = true; process = NativeProcessObservation(status: "absent", identity: nil, reason: nil) }
    func port() -> RetainedApplicationPort {
        RetainedApplicationPort(owner: owner ?? RetainedApplicationOwner(birth: birth, executable: executable), reused: reused,
            observe: {
                self.clock += self.observationDelay
                if self.observationFails { throw FakeProblem.observation }
                return RetainedApplicationObservation(objectPID: self.pid, objectTerminated: self.terminated,
                    process: self.process ?? NativeProcessObservation(status: "alive", identity: self.birth, reason: nil), executable: self.executable)
            }, terminate: {
                self.normal += 1; self.clock += self.normalDelay
                if self.normalExits { self.exited() }
                if self.normalFails { throw FakeProblem.request }
                return self.normalAccepts
            }, forceTerminate: {
                self.force += 1; self.clock += self.forceDelay
                if self.forceExits { self.exited() }
                if self.forceFails { throw FakeProblem.request }
                return self.forceAccepts
            })
    }
    func closer() -> RetainedApplicationCloser {
        RetainedApplicationCloser(port: port(), limits: .init(graceMs: 2, totalMs: 6), mayClose: {
            if self.leaseFails { throw FakeProblem.lease }; return self.permitted
        }, now: { self.clock }, tick: {
            self.clock += 1; self.ticks += 1; self.onTick?()
            if self.tickFails { throw FakeProblem.observation }; await Task.yield()
        }, emit: {
            self.events.append($0); self.onEvent?($0)
            if $0 == self.brokenEvent { throw FakeProblem.pipe }
        })
    }
}

@Test @MainActor func originalObjectCloseWaitsForBothIndependentExitProofs() async {
    let f = ApplicationFixture(); f.onTick = { if f.ticks == 1 { f.exited() } }
    let result = await f.closer().close()
    #expect(result.originalExitConfirmed && result.problems.isEmpty)
    #expect(result.terminationRequests == 1 && result.forceRequests == 0 && f.ticks == 1)
}
@Test(arguments: [true, false]) @MainActor func quitRequestAloneNeverProvesExit(_ accepted: Bool) async {
    let f = ApplicationFixture(); f.normalAccepts = accepted; f.forceAccepts = accepted
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.deadline])
    #expect(f.normal == 1 && f.force == 1)
}
@Test @MainActor func forceIsOneOriginalObjectRequestFollowedByIndependentExitObservation() async {
    let f = ApplicationFixture(); f.onTick = { if f.ticks == 3 { f.exited() } }
    let result = await f.closer().close()
    #expect(result.originalExitConfirmed && result.problems.isEmpty)
    #expect(f.normal == 1 && f.force == 1 && f.ticks == 3)
}
@Test @MainActor func repeatedAndConcurrentCloseShareOneActualOperation() async {
    let f = ApplicationFixture(); f.forceExits = true; let closer = f.closer()
    let one = Task { await closer.close() }, two = Task { await closer.close() }
    let a = await one.value, b = await two.value, c = await closer.close()
    #expect(a == b && b == c && c.originalExitConfirmed)
    #expect(f.normal == 1 && f.force == 1)
}
@Test @MainActor func closeDeadlineIncludesActualMainActorQueueDelay() async {
    let f = ApplicationFixture(); f.normalExits = true; let closer = f.closer()
    let blocker = Task(priority: .high) { @MainActor in f.clock = 100 }
    let atEntry = f.clock, result = await closer.close()
    await blocker.value
    #expect(atEntry == 0 && f.clock == 100)
    #expect(!result.originalExitConfirmed && result.problems == [.deadline])
    #expect(f.normal == 0 && f.force == 0)
}
@Test @MainActor func lateExitCannotWashAnEarlierCloseDeadline() async {
    let f = ApplicationFixture(), closer = f.closer(), first = await closer.close()
    f.exited(); let second = await closer.close()
    #expect(first == second && !second.originalExitConfirmed && second.problems == [.deadline])
    #expect(f.normal == 1 && f.force == 1)
}
@Test(arguments: [false, true]) @MainActor func OSAndAppKitDisagreementNeverGrantsSignalAuthority(_ appKitSaysExited: Bool) async {
    let f = ApplicationFixture()
    if appKitSaysExited { f.terminated = true } else { f.process = NativeProcessObservation(status: "absent", identity: nil, reason: nil) }
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.deadline])
    #expect(f.normal == 0 && f.force == 0)
}
@Test @MainActor func originalExitedAndPIDReusedNeverSignalsTheReplacement() async {
    let f = ApplicationFixture(); f.terminated = true; f.pid = -1
    f.process = NativeProcessObservation(status: "alive", identity: NativeProcessIdentity(pid: 55, bootId: f.birth.bootId, startSeconds: f.birth.startSeconds, startMicroseconds: 2), reason: nil)
    let result = await f.closer().close()
    #expect(result.originalExitConfirmed && result.problems.isEmpty && f.normal == 0 && f.force == 0)
}
@Test @MainActor func objectPIDReplacementIsNeverFollowed() async {
    let f = ApplicationFixture(); f.pid = 56
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.changedObject] && f.normal == 0 && f.force == 0)
}
@Test @MainActor func reusedApplicationIsNeverClosed() async {
    let f = ApplicationFixture(); f.reused = true
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.reusedInstance] && f.normal == 0 && f.force == 0)
}
@Test @MainActor func unknownOSIdentityDoesNotBecomeAbsence() async {
    let f = ApplicationFixture(); f.process = NativeProcessObservation(status: "unknown", identity: nil, reason: "denied")
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.unknownProcess] && f.normal == 0 && f.force == 0)
}
@Test @MainActor func executableChangeBetweenLogAndActionPreventsInput() async {
    let f = ApplicationFixture(); f.onEvent = { if $0 == "terminate-requested" { f.executable = "/Applications/Other" } }
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.changedExecutable] && f.normal == 0 && f.force == 0)
}
@Test(arguments: ["terminate-requested", "force-requested"]) @MainActor func revokedLeaseAtDeliveryPreventsTheCorrespondingRequest(_ event: String) async {
    let f = ApplicationFixture(); f.onEvent = { if $0 == event { f.permitted = false } }
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.ownershipRevoked])
    #expect(f.normal == (event == "terminate-requested" ? 0 : 1) && f.force == 0)
}
@Test @MainActor func throwingLeaseDoesNotBecomeAnObservationFailure() async {
    let f = ApplicationFixture(); f.leaseFails = true
    let result = await f.closer().close()
    #expect(result.problems == [.ownershipRevoked] && f.normal == 0 && f.force == 0)
}
@Test @MainActor func failedDeliveryStillCleansOriginalAndRetainsTheFailure() async {
    let f = ApplicationFixture(); f.brokenEvent = "terminate-requested"; f.forceExits = true
    let result = await f.closer().close()
    #expect(result.originalExitConfirmed && result.problems == [.deliveryFailed])
    #expect(f.normal == 1 && f.force == 1)
}
@Test(arguments: [false, true]) @MainActor func failedRequestDoesNotSkipOriginalObjectCleanup(_ forceThrows: Bool) async {
    let f = ApplicationFixture()
    if forceThrows { f.forceFails = true; f.forceExits = true } else { f.normalFails = true; f.forceExits = true }
    let result = await f.closer().close()
    #expect(result.originalExitConfirmed && result.problems == [.requestFailed])
    #expect(f.normal == 1 && f.force == 1)
}
@Test @MainActor func initialSettlingNeverSkipsNormalQuitAndGoesStraightToForce() async {
    let f = ApplicationFixture(); f.terminated = true
    f.onTick = { if f.ticks == 3 { f.terminated = false; f.normalExits = true } }
    let result = await f.closer().close()
    #expect(result.originalExitConfirmed && result.problems.isEmpty)
    #expect(f.normal == 1 && f.force == 0)
}
@Test(arguments: ["terminate-requested", "force-requested", "original-exit-confirmed"]) @MainActor func slowDeliveryCannotGrantExtraTime(_ event: String) async {
    let f = ApplicationFixture(); f.normalExits = event == "original-exit-confirmed"
    f.onEvent = { if $0 == event { f.clock = 10 } }
    let result = await f.closer().close()
    #expect(result.problems == [.deadline])
    #expect(result.originalExitConfirmed == (event == "original-exit-confirmed"))
    #expect(f.normal == (event == "terminate-requested" ? 0 : 1) && f.force == 0)
}
@Test @MainActor func slowObservationCannotAuthorizeRequestAfterDeadline() async {
    let f = ApplicationFixture(); f.observationDelay = 10
    let result = await f.closer().close()
    #expect(result.problems == [.deadline] && !result.originalExitConfirmed && f.normal == 0 && f.force == 0)
}
@Test @MainActor func slowActualRequestRetainsDeadlineEvenAfterExit() async {
    let f = ApplicationFixture(); f.normalDelay = 10; f.normalExits = true
    let result = await f.closer().close()
    #expect(result.problems == [.deadline] && !result.originalExitConfirmed && f.normal == 1 && f.force == 0)
}
@Test @MainActor func observationErrorCannotBeConfirmedAsExit() async {
    let f = ApplicationFixture(); f.observationFails = true
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.observationFailed] && f.normal == 0 && f.force == 0)
}
@Test @MainActor func invalidOwnerNeverGetsQuitAuthority() async {
    let f = ApplicationFixture(); f.owner = RetainedApplicationOwner(birth: NativeProcessIdentity(pid: 0, bootId: f.birth.bootId, startSeconds: "0", startMicroseconds: 0), executable: f.executable)
    let result = await f.closer().close()
    #expect(!result.originalExitConfirmed && result.problems == [.invalidOwner] && f.normal == 0 && f.force == 0)
}
