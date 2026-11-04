import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { focusAlive, focusJournal } from "./fixtures/focus-journal.ts";

test("strict focus snapshots bind live subscriptions and the exact appended prefix", t => {
	const f = focusJournal(t), first = f.reader.snapshot(); assert.deepEqual(first.subscriptions.map(s => s.pid), [10, 22]);
	const text = readFileSync(f.path, "utf8"); assert.equal(first.cursor.bytes, Buffer.byteLength(text));
	assert.equal(first.cursor.sha256, createHash("sha256").update(text).digest("hex")); assert.deepEqual(f.reader.verifyPrefix(), first.cursor);
	f.emit("sample"); const next = f.reader.snapshot(); assert.ok(next.cursor.sequence > first.cursor.sequence); assert.ok(next.cursor.bytes > first.cursor.bytes);
	assert.deepEqual(next.subscriptions, first.subscriptions);
});

for (const kind of ["fatal", "monitor-observers-stopped", "stopped"]) test(`a ${kind} monitor cannot keep granting focus evidence from cached PIDs`, t => {
	const f = focusJournal(t); f.reader.snapshot();
	if (kind === "stopped") f.emit("monitor-observers-stopped", { pendingSubscriptions: 0 });
	f.emit(kind, { pendingSubscriptions: 0 }); assert.throws(() => f.reader.snapshot());
	f.emit("sample"); assert.throws(() => f.reader.snapshot(), /failed/);
});

for (const kind of ["missing-ready", "stale", "sequence-gap", "monitor-reused", "subscription-birth", "subscription-generation", "sampling-gap", "baseline-gap"]) test(`strict snapshots reject ${kind}`, t => {
	const f = focusJournal(t, { initialize: kind !== "missing-ready" });
	if (kind === "missing-ready") { f.subscribe(10); f.emit("sample"); }
	if (kind === "stale") f.setNow(f.now() + 151);
	if (kind === "sequence-gap") f.emit("sample", { sequence: 200 });
	if (kind === "monitor-reused") f.emit("sample", { monitorProcess: focusAlive(99, 654321) });
	if (kind === "subscription-birth") f.subscribe(22, { subscriptionAfter: focusAlive(22, 654321) });
	if (kind === "subscription-generation") f.subscribe(22, { subscriptionGeneration: undefined });
	if (kind === "sampling-gap") { f.reader.snapshot(); f.emit("sample", { uptimeMs: f.now() + 200 }); }
	if (kind === "baseline-gap") { f.emit("subscription-invalidated", { observedPid: 10 }); f.subscribe(10); }
	assert.throws(() => f.reader.snapshot());
});

test("subscription replacement preserves its revision so a brief gap cannot disappear", t => {
	const f = focusJournal(t), first = f.reader.snapshot(), before = first.subscriptions.find(s => s.pid === 22)!;
	f.emit("subscription-invalidated", { observedPid: 22 }); f.subscribe(22, { subscriptionGeneration: before.generation }); f.emit("sample");
	const after = f.reader.snapshot().subscriptions.find(s => s.pid === 22)!;
	assert.equal(after.generation, before.generation); assert.ok(after.revision > before.revision);
});

test("same-length old edits and same-content file replacement cannot pass the final prefix check", t => {
	for (const mode of ["edit", "replace"]) {
		const f = focusJournal(t); f.reader.snapshot(); const original = readFileSync(f.path, "utf8");
		if (mode === "edit") writeFileSync(f.path, original.replace('"pointerX":10', '"pointerX":11'));
		else { renameSync(f.path, f.path + ".old"); writeFileSync(f.path, original); }
		assert.throws(() => f.reader.verifyPrefix(), /rewritten|replaced/);
	}
});

test("focus and uncertain notification changes remain failures even when a later sample is restored", t => {
	for (const fields of [{ kind: "focus" }, { kind: "AX-notification", notification: "AXFocusedUIElementChanged", inSystemFocusedApplication: true }, { kind: "AX-notification", notification: "AXFocusedUIElementChanged", inSystemFocusedApplication: false }]) {
		const f = focusJournal(t); f.reader.snapshot(); f.emit(String(fields.kind), fields); f.emit("sample"); assert.throws(() => f.reader.snapshot());
	}
});

test("foreground changes on ordinary notification rows cannot hide between restored samples", t => {
	const f = focusJournal(t); f.reader.snapshot();
	f.emit("termination-hint", { foregroundPid: 23, foregroundProcess: focusAlive(23) }); f.emit("sample");
	assert.throws(() => f.reader.snapshot(), /foreground changed/);
});

test("Swift submillisecond timestamps use Date.now precision without accepting a future whole millisecond", t => {
	const f = focusJournal(t); f.emit("sample", { at: f.now() + 20.5 }); assert.doesNotThrow(() => f.reader.snapshot());
	const future = focusJournal(t); future.emit("sample", { at: future.now() + 22 }); assert.throws(() => future.reader.snapshot(), /future/);
});
