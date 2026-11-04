import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { FocusTargetCandidates } from "../acceptance/focus-targets.ts";
import type { WriterProcessIdentity } from "../acceptance/process-identity.ts";

/** Pure monitor-record fixture. It never reads macOS, sends input or supplies formal evidence. */
export const focusBirth = (pid: number, startMicroseconds = 123456): WriterProcessIdentity => ({ schema: "macos-kinfo-starttime-v1", pid,
	bootId: "01234567-89ab-cdef-0123-456789abcdef", startSeconds: "1790000000", startMicroseconds });
export const focusAlive = (pid: number, microseconds = 123456) => ({ status: "alive" as const, identity: focusBirth(pid, microseconds) });
export function focusJournal(t: TestContext, { initialize = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-focus-journal-")), path = join(root, "focus.jsonl"); writeFileSync(path, "");
	let at = 1000, sequence = 0, now = at;
	const state = { foregroundPid: 10, focusPid: 10, keyboardPid: 10, focusReadable: true, focusToken: 1,
		foregroundProcess: focusAlive(10), focusProcess: focusAlive(10), keyboardProcess: focusAlive(10), pointerX: 10, pointerY: 20, modifierFlags: 0 };
	const emit = (kind: string, fields: Record<string, unknown> = {}) => {
		at += 20; now = at;
		const row = { ...state, kind, at, uptimeMs: at, sequence: ++sequence, monitorProcess: focusAlive(99), ...fields };
		appendFileSync(path, JSON.stringify(row) + "\n"); return row;
	};
	const subscribe = (pid: number, fields: Record<string, unknown> = {}) => emit("subscribed", { observedPid: pid, notifications: ["AXFocusedUIElementChanged"],
		subscriptionBefore: focusAlive(pid), subscriptionAfter: focusAlive(pid), subscriptionGeneration: randomUUID(), ...fields });
	if (initialize) { subscribe(10); subscribe(22); emit("sample"); emit("ready"); emit("sample"); }
	const reader = new FocusTargetCandidates(path, { monitorBirth: focusBirth(99), maxSampleGapMs: 150, maxFreshnessMs: 150, now: () => now });
	t.after(() => { reader.close(); rmSync(root, { recursive: true, force: true }); });
	return { root, path, reader, emit, subscribe, setNow(value: number) { now = value; }, now: () => now,
		rows: () => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
}
