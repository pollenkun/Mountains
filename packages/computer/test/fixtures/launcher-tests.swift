import Foundation
import Testing
@testable import Launcher

@Test(arguments: ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
                  "com.google.Chrome.canary", "com.google.chrome.for.testing", "org.chromium.Chromium"])
func everyKnownBrowserRequiresWindowlessStartup(_ bundleIdentifier: String) {
    #expect(chromiumLaunchRefusal(bundleIdentifier: bundleIdentifier, arguments: []) != nil)
    #expect(chromiumLaunchRefusal(bundleIdentifier: bundleIdentifier, arguments: ["--no-startup-window"]) == nil)
}

@Test(arguments: ["--app", "--app=", "--app=https://example.test/", "--app-id", "--app-id=abcdef", "-app=test", "-app-id=test", " --app=test ", "\t-app-id=test\n"])
func appModeIsRefusedEvenWithWindowlessOrHeadlessFlags(_ argument: String) {
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: ["--no-startup-window", argument]) != nil)
    #expect(chromiumLaunchRefusal(bundleIdentifier: "org.chromium.Chromium", arguments: ["--headless=new", argument]) != nil)
}

@Test(arguments: [nil, "org.electron.Electron", "com.example.ChromeEditor", "com.google.Chrome.helper",
                  "org.chromium.Chromium.helper", "com.google.Chrome.beta.other", "com.google.chrome", "com.microsoft.edgemac"] as [String?])
func unrelatedApplicationsAndHelpersAreNotRestricted(_ bundleIdentifier: String?) {
    #expect(chromiumLaunchRefusal(bundleIdentifier: bundleIdentifier, arguments: ["--app=test"]) == nil)
    #expect(chromiumLaunchRefusal(bundleIdentifier: bundleIdentifier, arguments: []) == nil)
}

@Test(arguments: ["--headless", "--headless=new", "-headless=new"])
func recognizedHeadlessStartupNeedsNoVisibleWindowFlag(_ argument: String) {
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: [argument]) == nil)
}

@Test(arguments: ["--headless=false", "--headless=old", "--headless-extra", "--no-startup-window-extra",
                  "https://example.test/?flag=--no-startup-window"])
func lookalikeOrUnsupportedFlagsCannotBypassWindowlessStartup(_ argument: String) {
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: [argument]) != nil)
}

@Test func chromiumSwitchTerminatorAndLastValueAreRespected() {
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: ["--", "--headless=new", "--no-startup-window"]) != nil)
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: [" \t--\n", "--headless=new", "--no-startup-window"]) != nil)
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: ["--no-startup-window", "--", "--app=test"]) == nil)
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: ["--headless=new", "--headless=false"]) != nil)
    #expect(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: ["--no-startup-window", "https://example.test/?app=--app=test"]) == nil)
}

@Test func preflightRefusalExplicitlyReportsNoLaunchWasDispatched() throws {
    let refusal = try #require(chromiumLaunchRefusal(bundleIdentifier: "com.google.Chrome", arguments: ["--app=test"]))
    let value = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(refusal)) as? [String: Any])
    #expect(value["code"] as? String == "background_launch_preflight_refused")
    #expect(value["outcome"] as? String == "not_executed")
    #expect(value["dispatched"] as? Bool == false && value["retryUnsafe"] as? Bool == false)
    #expect(value["pid"] == nil && refusal.error.contains("web_read"))
}

private func launchedWatch() -> LaunchFocusWatch {
    var watch = LaunchFocusWatch(previousPID: 10)
    watch.launched(20)
    return watch
}
private extension LaunchFocusWatch {
    mutating func sample(_ pid: Int32, active: Bool = false, key: Bool = true, input: Bool = false, exited: Bool = false) {
        observe(front: pid, previousActive: active, previousWindowFocused: key, inputChanged: input, previousTerminated: exited)
    }
}

@Test func activationRequestAloneNeverCountsAsReturn() {
    var watch = launchedWatch()
    watch.sample(20)
    #expect(watch.shouldRestore(at: 0))
    watch.requested(at: 0)
    watch.sample(20)
    #expect(watch.gaveBack == 0 && watch.returnFailed)
    #expect(watch.frontTaken == 1 && watch.restoreRequests == 1)
}

@Test func returnRequiresOriginalFrontPIDAndActiveState() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0)
    watch.sample(20, active: true)
    #expect(watch.gaveBack == 0)
    watch.sample(10)
    #expect(watch.gaveBack == 0)
    watch.sample(10, active: true)
    #expect(watch.gaveBack == 0, "a possibly stale key-window read cannot skip the make-key pair")
    watch.requestedKey(at: 0, sent: true)
    watch.sample(10, active: true)
    #expect(watch.gaveBack == 1 && !watch.returnFailed)
    watch.sample(10, active: true)
    #expect(watch.gaveBack == 1)
}

@Test func foregroundReturnWithoutOriginalKeyWindowNeverCountsAsRestored() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0)
    watch.sample(10, active: true, key: false)
    #expect(watch.gaveBack == 0 && watch.returnFailed && watch.shouldRestoreKey(at: 0))
    watch.requestedKey(at: 0, sent: true)
    watch.sample(10, active: true, key: false)
    #expect(watch.gaveBack == 0 && watch.returnFailed)
    watch.sample(10, active: true, key: true)
    #expect(watch.gaveBack == 1 && !watch.returnFailed && !watch.shouldRestoreKey(at: 1))
}

@Test func keyRestorationWaitsForOriginalFrontAndStopsOnUserInput() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0)
    #expect(!watch.shouldRestoreKey(at: 0))
    watch.sample(10, key: false)
    #expect(!watch.shouldRestoreKey(at: 0))
    watch.sample(10, active: true, key: false)
    #expect(watch.shouldRestoreKey(at: 0))
    watch.sample(10, active: true, key: false, input: true)
    #expect(!watch.shouldRestoreKey(at: 10) && watch.gaveBack == 0)
}

@Test func failedKeyRequestsAreLimitedAndNeverCountAsEvidence() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0); watch.sample(10, active: true, key: false)
    watch.requestedKey(at: 1, sent: false)
    watch.sample(10, active: true, key: true)
    #expect(!watch.shouldRestoreKey(at: 1.249) && watch.shouldRestoreKey(at: 1.25))
    #expect(watch.keyRestoreRequests == 1 && watch.keyRestorePairsSent == 0 && watch.gaveBack == 0 && watch.returnFailed)
}

@Test func repeatedRequestsForOneInterruptionCountOneReturn() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0)
    watch.requested(at: 0.25); watch.requested(at: 0.5)
    watch.sample(10, active: true, key: false); watch.requestedKey(at: 0.5, sent: true)
    watch.sample(10, active: true)
    #expect(watch.restoreRequests == 3 && watch.frontTaken == 1 && watch.gaveBack == 1)
}

@Test func eachObservedForegroundEntryStaysVisibleAfterRepair() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0); watch.sample(10, active: true, key: false)
    watch.requestedKey(at: 0, sent: true); watch.sample(10, active: true)
    watch.sample(20); watch.requested(at: 0.5); watch.sample(10, active: true)
    #expect(watch.gaveBack == 1, "the earlier make-key pair cannot prove a later return")
    watch.requestedKey(at: 0.5, sent: true); watch.sample(10, active: true)
    #expect(watch.frontTaken == 2 && watch.gaveBack == 2)
}

@Test func spontaneousReturnWithoutRequestDoesNotClaimCredit() {
    var watch = launchedWatch()
    watch.sample(20); watch.sample(10, active: true)
    #expect(watch.frontTaken == 1 && watch.gaveBack == 0 && watch.restoreRequests == 0)
}

@Test func takeoverAtWatchDeadlineIsReportedEvenWithoutTimeToRequestReturn() {
    var watch = launchedWatch()
    watch.sample(20)
    #expect(watch.frontTaken == 1 && watch.gaveBack == 0 && watch.restoreRequests == 0)
    #expect(watch.returnFailed)
}

@Test func secondTakeoverAtDeadlineDoesNotReuseEarlierSuccessfulReturn() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0); watch.sample(10, active: true, key: false)
    watch.requestedKey(at: 0, sent: true); watch.sample(10, active: true)
    watch.sample(20)
    #expect(watch.frontTaken == 2 && watch.gaveBack == 1 && watch.restoreRequests == 1)
    #expect(watch.returnFailed)
}

@Test func userChoosingLaunchedAppPermanentlyStopsRestoration() {
    var watch = launchedWatch()
    watch.sample(20, input: true)
    watch.sample(20)
    #expect(watch.stopped == "user-input" && !watch.shouldRestore(at: 100))
    #expect(watch.gaveBack == 0)
}

@Test func userReturningManuallyIsNotCountedAsAutomaticRepair() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0)
    watch.sample(10, active: true, input: true)
    #expect(watch.stopped == "user-input" && watch.gaveBack == 0)
    #expect(!watch.returnFailed)
}

@Test func userInputBeforeLaunchCallbackAlsoCancelsRestoration() {
    var watch = LaunchFocusWatch(previousPID: 10)
    watch.sample(20, input: true)
    watch.launched(20)
    #expect(watch.frontTaken == 1 && watch.stopped == "user-input" && !watch.shouldRestore(at: 100))
}

@Test func thirdAppSeenBeforeCallbackIsNotForgottenWhenChromeTakesOver() {
    var watch = LaunchFocusWatch(previousPID: 10)
    watch.sample(30); watch.sample(10, active: true); watch.sample(20)
    watch.launched(20)
    #expect(watch.stopped == "another-front-app" && !watch.shouldRestore(at: 100))
}

@Test func launchTimeForegroundEntryIsCountedOnceWhenPIDArrives() {
    var watch = LaunchFocusWatch(previousPID: 10)
    watch.sample(20); watch.sample(20); watch.launched(20); watch.sample(20)
    #expect(watch.frontTaken == 1 && watch.shouldRestore(at: 0))
}

@Test(arguments: [Int32(0), Int32(30)]) func unrelatedOrUnknownForegroundStopsRequests(_ pid: Int32) {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 0)
    watch.sample(pid); watch.sample(20)
    #expect(watch.stopped != nil && !watch.shouldRestore(at: 100))
    #expect(watch.gaveBack == 0 && watch.returnFailed == (pid == 0))
}

@Test func originalAppExitAndAlreadyFrontAppNeverCauseRestoration() {
    var watch = launchedWatch()
    watch.sample(20, exited: true)
    #expect(watch.stopped == "previous-app-exited" && !watch.shouldRestore(at: 100))
    #expect(watch.returnFailed)
    var same = LaunchFocusWatch(previousPID: 10)
    same.launched(10); same.sample(10, active: true)
    #expect(same.frontTaken == 0 && same.gaveBack == 0 && !same.shouldRestore(at: 100))
}

@Test func unsuccessfulRequestsAreLimitedToFourPerSecond() {
    var watch = launchedWatch()
    watch.sample(20); watch.requested(at: 1)
    #expect(!watch.shouldRestore(at: 1.249))
    #expect(watch.shouldRestore(at: 1.25))
}
