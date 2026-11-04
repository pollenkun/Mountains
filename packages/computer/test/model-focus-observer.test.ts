import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { ToolExecutionIdentity, ToolExecutionOutcome, ToolObservationValue } from "@mountains/engine";
import { ModelFocusObserver, reportedFocusTargets, type ModelFocusOptions } from "./acceptance/model-focus-observer.ts";
import type { readProcessBatch } from "./acceptance/process-identity.ts";
import { focusAlive, focusBirth, focusJournal } from "./fixtures/focus-journal.ts";

const signal = () => new AbortController().signal;
const identity = (name = "web_act"): ToolExecutionIdentity => ({ executionId: randomUUID(), source: { sessionId: "own", runId: "own", turnId: "own", requestId: "own", responseId: "offline-response", attempt: 1 },
	toolCallId: randomUUID(), name, argumentsSha256: "0".repeat(64), recordedArgumentsSha256: "0".repeat(64) });
const outcome = (details: ToolObservationValue, dispatch: ToolExecutionOutcome["dispatch"] = "returned"): ToolExecutionOutcome => ({ dispatch,
	started: dispatch === "not-started" ? null : { wallTimeMs: 1, monotonicNs: "1" }, finished: dispatch === "not-started" ? null : { wallTimeMs: 2, monotonicNs: "2" },
	ok: dispatch !== "not-started", details, modelContentSha256: "0".repeat(64), recordedModelContentSha256: "0".repeat(64), reads: [], writes: [], control: null });
function fixture(t: TestContext) {
	const f = focusJournal(t), monitor = { pid: 99, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
	let probe: typeof readProcessBatch = async (_binary, pids) => new Map(pids.map(pid => [pid, focusAlive(pid)]));
	const observer = new ModelFocusObserver({ monitor: monitor as ChildProcess, monitorBirth: focusBirth(99), journal: f.reader, processBinary: { path: "/own/fixture-only", sha256: "0".repeat(64) },
		fixture: { now: f.now, read: (...args) => probe(...args) } });
	t.after(() => observer.close());
	return { ...f, observer, monitor, setProbe(next: typeof readProcessBatch) { probe = next; } };
}

test("independent focus callbacks pair private execution records and seal a prefix without claiming formal proof", async t => {
	const f = fixture(t), id = identity();
	const before = await f.observer.before(id, {}, signal()); f.emit("sample");
	const after = await f.observer.after(id, outcome({ pid: 22 }), signal()) as Record<string, any>;
	assert.equal((before as Record<string, any>).componentOnly, true); assert.equal(after.componentOnly, true); assert.deepEqual(after.reportedTargetPids, [22]);
	const final = await f.observer.finalize(signal()) as Record<string, any>; assert.equal(final.cleanupTailVerified, false); assert.ok(final.cursor.bytes > 0);
});

test("a cold target cannot borrow a later subscription or another simultaneous execution's before record", async t => {
	const f = fixture(t), first = identity(), second = identity();
	await f.observer.before(first, {}, signal()); f.subscribe(23); f.emit("sample"); await f.observer.before(second, {}, signal());
	await f.observer.after(second, outcome({ pid: 23 }), signal());
	await assert.rejects(f.observer.after(first, outcome({ pid: 23 }), signal()), /before and after/);
});

for (const change of ["monitor-reused", "target-reused", "subscription-gap", "unwatched-second-target", "missing-target", "monitor-exited"] as const) test(`model focus observation rejects ${change}`, async t => {
	const f = fixture(t), id = identity(); await f.observer.before(id, {}, signal());
	if (change === "monitor-reused" || change === "target-reused") f.setProbe(async (_binary, pids) => new Map(pids.map(pid => [pid, focusAlive(pid, pid === (change === "monitor-reused" ? 99 : 22) ? 654321 : 123456)])));
	if (change === "subscription-gap") { f.emit("subscription-invalidated", { observedPid: 22 }); f.subscribe(22); f.emit("sample"); }
	if (change === "monitor-exited") f.monitor.exitCode = 0;
	const details = change === "unwatched-second-target" ? { pid: 22, targetPids: [22, 23] } : change === "missing-target" ? { dispatched: false } : { pid: 22 };
	await assert.rejects(f.observer.after(id, outcome(details), signal()));
});

test("an engine cancellation before execution is recorded; a product false-dispatch flag cannot exempt preparation", async t => {
	const f = fixture(t), id = identity(); await f.observer.before(id, {}, signal());
	const after = await f.observer.after(id, outcome({}, "not-started"), signal()) as Record<string, any>;
	assert.equal(after.scope, "engine-did-not-execute"); assert.deepEqual(after.reportedTargetPids, []);
	assert.throws(() => reportedFocusTargets("web_act", {}, outcome({ dispatched: false })), /PID/);
});

test("every batch target must be recorded and watched, including a step in another app", async t => {
	const f = fixture(t); f.subscribe(23); f.emit("sample"); const id = identity("screen_act"), args = { steps: [{ action: "press" }, { action: "key" }] };
	await f.observer.before(id, args, signal());
	const details = { pid: 22, targetPids: [22, 23], steps: [{ pid: 22 }, { pid: 23 }] };
	const after = await f.observer.after(id, outcome(details), signal()) as Record<string, any>;
	assert.deepEqual(after.reportedTargetPids, [22, 23]); assert.equal(after.exactNativeReceiverProven, false, "UI owners must not impersonate unrecorded remote input receivers");
	assert.throws(() => reportedFocusTargets("screen_act", args, outcome({ pid: 22, steps: [{}, {}] })), /PID/);
});

test("an unfinished or mismatched observation cannot be finalized", async t => {
	const f = fixture(t), id = identity(); await f.observer.before(id, {}, signal());
	await assert.rejects(f.observer.after({ ...id, name: "screen_act" }, outcome({ pid: 22 }), signal()), /matching private before/);
	await assert.rejects(f.observer.finalize(signal()), /unfinished/);
});

test("a step's remote native address is checked even if the top-level list omits it",async t=>{
	const f=fixture(t),id=identity("screen_act"),args={steps:[{action:"key"}]};
	await f.observer.before(id,args,signal());
	await assert.rejects(f.observer.after(id,outcome({pid:22,inputTargetPids:[22],steps:[{pid:22,inputTargetPids:[23]}]}),signal()),/before and after/);
	assert.deepEqual(reportedFocusTargets("screen_act",args,outcome({pid:22,steps:[{pid:22,inputTargetPids:[23]}]})).pids,[22,23]);
});

test("cancelled OS observation does not create a successful before record or suppress later independent work", async t => {
	const f = fixture(t), stop = new AbortController(); stop.abort(); await assert.rejects(f.observer.before(identity(), {}, stop.signal));
	const id = identity(); await f.observer.before(id, {}, signal()); await f.observer.after(id, outcome({ pid: 22 }), signal());
});

test("a bridge cannot borrow another live monitor's valid journal", async t => {
	const f = fixture(t), other = new ModelFocusObserver({ monitor: { pid: 100, exitCode: null, signalCode: null } as ChildProcess,
		monitorBirth: focusBirth(100), journal: f.reader, processBinary: { path: "/own/fixture-only", sha256: "0".repeat(64) },
		fixture: { now: f.now, read: async (_binary, pids) => new Map(pids.map(pid => [pid, focusAlive(pid)])) } });
	await assert.rejects(other.before(identity(), {}, signal()), /another monitor/);
});

test("mutating constructor options cannot turn fixture observations into real OS evidence", async t => {
	const f = focusJournal(t);
	const options: ModelFocusOptions = { monitor: { pid: 99, exitCode: null, signalCode: null } as ChildProcess, monitorBirth: focusBirth(99), journal: f.reader,
		processBinary: { path: "/own/fixture-only", sha256: "0".repeat(64) }, fixture: { now: f.now, read: async (_binary, pids) => {
			delete options.fixture; return new Map(pids.map(pid => [pid, focusAlive(pid)]));
		} } };
	const observer = new ModelFocusObserver(options); t.after(() => observer.close()); const id = identity();
	for (const proof of [await observer.before(id, {}, signal()), await observer.after(id, outcome({ pid: 22 }), signal()), await observer.finalize(signal())]) assert.equal((proof as Record<string, any>).componentOnly, true);
});
