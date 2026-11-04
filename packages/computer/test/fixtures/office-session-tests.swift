import Foundation
import Testing
@testable import OfficeTree

private enum FakeError: Error { case brokenPipe, unreadable, closeFailed }
@MainActor
private final class FakeOffice {
    let birth = NativeProcessIdentity(pid: 55, bootId: "12345678-1234-1234-1234-123456789abc", startSeconds: "1792300000", startMicroseconds: 1)
    var clock = 0.0
    var pid: Int32 = 55
    var executable = "/system/own/Preview"
    var observed: NativeProcessObservation?
    var terminated = false
    var reused = false
    var scope = OfficeDocumentScope.image(number: 45, edited: false)
    var closes: [UInt32] = []
    var quits = 0
    var acceptsQuit = true
    var exitsAfterQuit = true
    var closeChangesScope = true
    var failClose = false
    var failInspect = false
    var events: [String] = []
    var brokenEvent: String?
    var launchCount = 0
    var launchContinuation: CheckedContinuation<OfficeApplicationPort, Never>?
    var deferLaunch = false
    var failLaunch = false
    var inspectDelay = 0.0
    var closeDelay = 0.0
    var quitDelay = 0.0
    var failQuit = false
    var onEvent: ((OfficeSessionEvent) -> Void)?
    var deferBeforeAdmission = false
    var preludeContinuation: CheckedContinuation<Void, Never>?

    func port() -> OfficeApplicationPort {
        OfficeApplicationPort(owner: OfficeSessionOwner(birth: birth, executable: "/system/own/Preview"), wasAlreadyRunning: reused,
            currentPID: { self.pid }, currentExecutable: { self.executable },
            originalProcess: { self.observed ?? NativeProcessObservation(status: "alive", identity: self.birth, reason: nil) },
            isTerminated: { self.terminated }, inspect: { self.clock += self.inspectDelay; if self.failInspect { throw FakeError.unreadable }; return self.scope },
            closeDocument: { number in
                self.closes.append(number)
                self.clock += self.closeDelay
                if self.failClose { throw FakeError.closeFailed }
                if self.closeChangesScope { self.scope = .empty }
            }, requestTermination: {
                self.quits += 1
                self.clock += self.quitDelay
                if self.failQuit { throw FakeError.unreadable }
                if self.exitsAfterQuit { self.observed = NativeProcessObservation(status: "absent", identity: nil, reason: nil); self.terminated = true }
                return self.acceptsQuit
            })
    }
    func session() -> OfficeSession {
        OfficeSession(limits: .init(startupMs: 4, closeMs: 3, exitMs: 3), launch: { admit in
            if self.deferBeforeAdmission { await withCheckedContinuation { self.preludeContinuation = $0 } }
            try admit()
            self.launchCount += 1
            if self.failLaunch { throw FakeError.unreadable }
            if self.deferLaunch { return await withCheckedContinuation { self.launchContinuation = $0 } }
            return self.port()
        }, now: { self.clock }, tick: { self.clock += 1; await Task.yield() }, emit: { event in
            self.events.append(event.kind)
            self.onEvent?(event)
            if event.kind == self.brokenEvent { throw FakeError.brokenPipe }
        })
    }
    func waitFor(_ predicate: () -> Bool) async {
        for _ in 0..<100 { if predicate() { return }; await Task.yield() }
        Issue.record("test session did not reach the expected suspension")
    }
}

@Test @MainActor func normalOfficeCloseUsesOneDocumentActionAndConfirmsActualExit() async {
    let f = FakeOffice(), session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }
    session.requestClose()
    let result = await work.value
    #expect(result.readyPublished && result.cleanupConfirmed && result.problem == nil)
    #expect(f.closes == [45] && f.quits == 1)
}
@Test @MainActor func eofBeforeLaunchDoesNotStartAnApplication() async {
    let f = FakeOffice(), session = f.session()
    session.requestClose(problem: "controller EOF; input release unknown")
    let result = await session.run()
    #expect(f.launchCount == 0 && result.cleanupConfirmed && !result.readyPublished)
    #expect(result.problem?.contains("input release unknown") == true)
}
@Test @MainActor func eofWhileLaunchPendingWaitsForItsActualResultAndNeverPublishesReady() async {
    let f = FakeOffice(); f.deferLaunch = true
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.launchContinuation != nil }
    session.requestClose(problem: "controller EOF; input release unknown")
    #expect(f.closes.isEmpty && !f.events.contains("cleanup-confirmed"))
    let continuation = f.launchContinuation; f.launchContinuation = nil; continuation?.resume(returning: f.port())
    let result = await work.value
    #expect(!result.readyPublished && result.cleanupConfirmed)
    #expect(result.problem?.contains("input release unknown") == true)
    #expect(f.closes == [45] && f.quits == 1 && !f.events.contains("ready"))
}
@Test @MainActor func actualLateLaunchIsCleanedAndNeverReportedReady() async {
    let f = FakeOffice(); f.deferLaunch = true
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.launchContinuation != nil }; f.clock = 5
    let continuation = f.launchContinuation; f.launchContinuation = nil; continuation?.resume(returning: f.port())
    let result = await work.value
    #expect(result.cleanupConfirmed && !result.readyPublished && result.problem?.contains("startupDeadline") == true)
    #expect(f.closes == [45] && f.quits == 1)
}
@Test @MainActor func reusedApplicationIsNeverClosedOrQuit() async {
    let f = FakeOffice(); f.reused = true
    let result = await f.session().run()
    #expect(!result.cleanupConfirmed && !result.readyPublished && result.problem?.contains("reusedApplication") == true)
    #expect(f.closes.isEmpty && f.quits == 0)
}
@Test @MainActor func launchErrorCannotProveNoApplicationWasCreated() async {
    let f = FakeOffice(); f.failLaunch = true
    let result = await f.session().run()
    #expect(!result.cleanupConfirmed && !result.readyPublished && result.problem != nil)
}
@Test @MainActor func desktopPreflightFailureBeforeAdmissionDoesNotCreateAnApplication() async {
    let f = FakeOffice()
    let session = OfficeSession(launch: { _ in throw FakeError.unreadable }, now: { f.clock },
        tick: { await Task.yield() }, emit: { event in f.events.append(event.kind) })
    let result = await session.run()
    #expect(result.cleanupConfirmed && !result.readyPublished && result.owner == nil && result.problem != nil)
    #expect(f.launchCount == 0 && f.closes.isEmpty && f.quits == 0)
}
@Test @MainActor func brokenReadyReplyStillCleansTheOriginalApplication() async {
    let f = FakeOffice(); f.brokenEvent = "ready"
    let result = await f.session().run()
    #expect(!result.readyPublished && result.cleanupConfirmed && result.problem?.contains("delivery failed") == true)
    #expect(f.closes == [45] && f.quits == 1)
}
@Test @MainActor func brokenInitialReplyDoesNotLaunch() async {
    let f = FakeOffice(); f.brokenEvent = "launch-requested"
    let result = await f.session().run()
    #expect(f.launchCount == 0 && result.cleanupConfirmed && result.problem != nil)
}
@Test(arguments: [false, true]) @MainActor
func acceptedOrRefusedQuitWithoutActualExitDoesNotConfirmCleanup(_ accepted: Bool) async {
    let f = FakeOffice(); f.acceptsQuit = accepted; f.exitsAfterQuit = false
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem != nil && f.quits == 1)
}
@Test(arguments: [false, true]) @MainActor
func unknownOrEditedDocumentCannotBeClosed(_ edited: Bool) async {
    let f = FakeOffice(); f.scope = .image(number: 45, edited: edited ? true : nil)
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("unsavedOrUnknownDocument") == true)
    #expect(f.closes.isEmpty && f.quits == 0)
}
@Test @MainActor func changedObjectPIDIsNotFollowedEvenWhenOriginalProcessIsGone() async {
    let f = FakeOffice(), session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }
    f.pid = 56; f.observed = NativeProcessObservation(status: "absent", identity: nil, reason: nil); session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("changedProcess") == true)
    #expect(f.closes.isEmpty && f.quits == 0)
}
@Test @MainActor func unreadableProcessDoesNotAuthorizeCleanup() async {
    let f = FakeOffice(), session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }
    f.observed = NativeProcessObservation(status: "unknown", identity: nil, reason: "process-query-failed"); session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("unknownProcess") == true && f.closes.isEmpty && f.quits == 0)
}
@Test @MainActor func aCloseErrorIsNeverRetriedOrHiddenByTheOriginalEOF() async {
    let f = FakeOffice(), session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; f.failClose = true; session.requestClose(problem: "controller EOF")
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("controller EOF") == true && result.problem?.contains("closeFailed") == true)
    #expect(f.closes == [45] && f.quits == 0)
}
@Test @MainActor func closeReceiptWithoutActualWindowDisappearanceDoesNotQuit() async {
    let f = FakeOffice(); f.closeChangesScope = false
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("documentCloseDeadline") == true && f.closes == [45] && f.quits == 0)
}

@Test @MainActor func inspectionCrossingStartupDeadlineCannotPublishReady() async {
    let f = FakeOffice(); f.inspectDelay = 5
    let result = await f.session().run()
    #expect(!result.readyPublished && !f.events.contains("ready"))
    #expect(result.problem?.contains("startupDeadline") == true)
    #expect(f.closes.isEmpty && f.quits == 0)
}
@Test @MainActor func aSlowCloseCannotBecomeSuccessfulCleanup() async {
    let f = FakeOffice(), session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; f.closeDelay = 4; session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("documentCloseDeadline") == true)
    #expect(f.closes == [45] && f.quits == 0)
}
@Test @MainActor func aSlowQuitCannotBecomeSuccessfulCleanupEvenAfterExit() async {
    let f = FakeOffice(), session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; f.quitDelay = 4; session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("exitDeadline") == true)
    #expect(f.closes == [45] && f.quits == 1 && f.terminated)
}
@Test @MainActor func documentChangedWhileWritingCloseEventCannotBeClosed() async {
    let f = FakeOffice()
    f.onEvent = { event in if event.kind == "document-close-requested" { f.scope = .image(number: 46, edited: false) } }
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("unexpectedDocument") == true)
    #expect(f.closes.isEmpty && f.quits == 0)
}
@Test @MainActor func aDocumentAppearingWhileWritingQuitEventCannotBeQuit() async {
    let f = FakeOffice()
    f.onEvent = { event in if event.kind == "termination-requested" { f.scope = .image(number: 46, edited: false) } }
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; session.requestClose()
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("unexpectedDocument") == true)
    #expect(f.closes == [45] && f.quits == 0)
}
@Test @MainActor func cancellationInsideLaunchEventDoesNotCreateApplication() async {
    let f = FakeOffice(), session = f.session()
    f.onEvent = { event in if event.kind == "launch-requested" { session.requestClose(problem: "cancelled while writing") } }
    let result = await session.run()
    #expect(f.launchCount == 0 && result.cleanupConfirmed && !result.readyPublished)
    #expect(result.problem?.contains("cancelled while writing") == true)
}
@Test @MainActor func deadlineCrossedInsideLaunchEventDoesNotCreateApplication() async {
    let f = FakeOffice()
    f.onEvent = { event in if event.kind == "launch-requested" { f.clock = 5 } }
    let result = await f.session().run()
    #expect(f.launchCount == 0 && result.cleanupConfirmed && !result.readyPublished)
    #expect(result.problem?.contains("startupDeadline") == true)
}
@Test(arguments: [false, true]) @MainActor
func preludeCancellationOrDeadlineIsCheckedBeforeActualCreation(_ deadline: Bool) async {
    let f = FakeOffice(); f.deferBeforeAdmission = true
    let session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.preludeContinuation != nil }
    if deadline { f.clock = 5 } else { session.requestClose(problem: "cancelled in launch prelude") }
    let continuation = f.preludeContinuation; f.preludeContinuation = nil; continuation?.resume()
    let result = await work.value
    #expect(f.launchCount == 0 && result.cleanupConfirmed && !result.readyPublished)
    #expect(f.closes.isEmpty && f.quits == 0)
    #expect(result.problem?.contains(deadline ? "startupDeadline" : "cancelled in launch prelude") == true)
}
@Test @MainActor func lateReadyDeliveryIsAnAttemptAndCannotAuthorizeInput() async {
    let f = FakeOffice()
    f.onEvent = { event in if event.kind == "ready" { f.clock = 5 } }
    let result = await f.session().run()
    #expect(f.events.contains("ready") && !result.readyPublished && result.cleanupConfirmed)
    #expect(result.problem?.contains("startupDeadline") == true && f.closes == [45] && f.quits == 1)
}
@Test @MainActor func aThrowingQuitRetainsTheOriginalFailureAndCannotConfirmCleanup() async {
    let f = FakeOffice(), session = f.session(), work = Task { await session.run() }
    await f.waitFor { f.events.contains("ready") }; f.failQuit = true; session.requestClose(problem: "controller EOF")
    let result = await work.value
    #expect(!result.cleanupConfirmed && result.problem?.contains("controller EOF") == true && result.problem?.contains("unreadable") == true)
    #expect(f.closes == [45] && f.quits == 1)
}
