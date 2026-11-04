import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import type { ToolExecutionIdentity, ToolExecutionOutcome, ToolObservationValue } from "@mountains/engine";
import { observerHash, observerJson } from "../../../../apps/cli/src/tool-observer-protocol.ts";
import { FocusTargetCandidates, type FocusSnapshot, type FocusTargetBoundary } from "./focus-targets.ts";
import { readProcessBatch, writerProcessIdentity, type ProcessObservation, type WriterProcessIdentity } from "./process-identity.ts";

const object = (value: unknown): Record<string, unknown> => { assert.ok(value && typeof value === "object" && !Array.isArray(value), "missing focus target metadata"); return value as Record<string, unknown>; };
const pid = (value: unknown): number => { assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "reported UI process PID must identify a known process"); return value; };
const alive = (value: ProcessObservation | undefined, expectedPid: number): WriterProcessIdentity => {
	assert.ok(value?.status === "alive", "independent OS process observation is not live");
	const birth = writerProcessIdentity(value.identity); assert.equal(birth.pid, expectedPid); return birth;
};
interface Frame { monitor: WriterProcessIdentity; boundary: FocusTargetBoundary; subscriptions: FocusSnapshot }
interface Pending { identitySha256: string; args: ToolObservationValue; frame: Frame | null }
export interface ModelFocusOptions {
	monitor: ChildProcess;
	monitorBirth: WriterProcessIdentity;
	journal: FocusTargetCandidates;
	processBinary: { path: string; sha256: string };
	/** Explicit test injection. Its receipts are permanently marked componentOnly. Never read from CLI config. */
	fixture?: { read: typeof readProcessBatch; now?: () => number };
}

/** Returns every reported UI owner. Remote native event receiver provenance is
 * a separate requirement: owner PIDs are never labelled exact input recipients. */
export function reportedFocusTargets(name: string, args: unknown, outcome: { dispatch: ToolExecutionOutcome["dispatch"]; details: unknown }): { scope: string; pids: number[] } {
	if (outcome.dispatch === "not-started") return { scope: "engine-did-not-execute", pids: [] };
	if (!["screen_read", "screen_act", "screen_look", "web_read", "web_act", "web_look"].includes(name)) return { scope: "non-ui-tool", pids: [] };
	const input = object(args), details = object(outcome.details);
	if (name === "screen_read" && (input.app === undefined || typeof input.app === "string" && !input.app.trim()) && Array.isArray(details.apps)) return { scope: "native-app-inventory", pids: [] };
	// Product dispatched=false does not exempt execute's preparation or launch work.
	const targets = new Set<number>([pid(details.pid)]);
	const addTargets=(record:Record<string,unknown>)=>{for (const field of ["targetPids", "inputTargetPids"]) if (record[field] !== undefined) {
		assert.ok(Array.isArray(record[field]) && record[field].length <= 4096, "invalid reported target list");
		for (const value of record[field]) targets.add(pid(value));
	}};
	addTargets(details);
	if (input.steps !== undefined) {
		assert.ok(Array.isArray(input.steps) && Array.isArray(details.steps) && details.steps.length > 0 && details.steps.length <= input.steps.length, "missing batch UI process evidence");
		for (const step of details.steps) {const record=object(step);targets.add(pid(record.pid));addTargets(record);}
	}
	return { scope: "reported-ui-owners-and-declared-receivers", pids: [...targets].sort((a, b) => a - b) };
}

/** Read-only bridge for the actual CLI observer. It neither launches an app nor
 * sends input. Formal acceptance also requires exact receiver routing, signed
 * monitor provenance, complete-run cleanup, and the final focus verifier. */
export class ModelFocusObserver {
	private readonly options: ModelFocusOptions;
	private readonly birth: WriterProcessIdentity;
	private readonly pending = new Map<string, Pending>();
	private failed = false;
	private closed = false;
	constructor(options: ModelFocusOptions) {
		this.options = Object.freeze({ ...options, processBinary: Object.freeze({ ...options.processBinary }),
			...(options.fixture ? { fixture: Object.freeze({ ...options.fixture }) } : {}) });
		this.birth = Object.freeze(writerProcessIdentity(options.monitorBirth));
		assert.equal(options.monitor.pid, this.birth.pid, "focus monitor belongs to a different process");
	}
	private live(): void {
		assert.ok(!this.failed && !this.closed, "model focus observation stopped");
		assert.ok(this.options.monitor.pid === this.birth.pid && this.options.monitor.exitCode === null && this.options.monitor.signalCode === null, "owned focus monitor has exited");
	}
	private async frame(signal: AbortSignal): Promise<Frame> {
		this.live(); signal.throwIfAborted();
		const now = this.options.fixture?.now ?? Date.now, at = now(), first = this.options.journal.snapshot();
		assert.deepEqual(first.monitorBirth, this.birth, "focus journal belongs to another monitor");
		const pids = [...new Set([this.birth.pid, ...first.subscriptions.map(s => s.pid)])];
		const observed = await (this.options.fixture?.read ?? readProcessBatch)(this.options.processBinary, pids, signal);
		signal.throwIfAborted(); this.live(); const last = this.options.journal.snapshot();
		assert.deepEqual(last.monitorBirth, this.birth, "focus journal monitor changed during OS query");
		assert.deepEqual(alive(observed.get(this.birth.pid), this.birth.pid), this.birth, "focus monitor OS birth changed");
		const stable = last.subscriptions.filter(subscription => {
			const prior = first.subscriptions.find(s => s.pid === subscription.pid);
			return prior && observerHash(prior) === observerHash(subscription);
		});
		for (const target of last.baselinePids) {
			const subscription = stable.find(s => s.pid === target); assert.ok(subscription, "baseline subscription changed during OS query");
			assert.deepEqual(alive(observed.get(target), target), subscription.birth, "baseline OS process changed");
		}
		const copy = observerJson({ monitor: this.birth, boundary: { at, end: now(), processes: pids.map(target => ({ pid: target,
			observation: observed.get(target) ?? { status: "unknown", reason: "process-query-failed" } })) }, subscriptions: { ...last, subscriptions: stable } });
		return copy as unknown as Frame;
	}
	before = async (identity: ToolExecutionIdentity, args: ToolObservationValue, signal: AbortSignal): Promise<ToolObservationValue> => {
		this.live(); assert.ok(!this.pending.has(identity.executionId), "duplicate focus observation");
		const entry: Pending = { identitySha256: observerHash(identity), args: observerJson(args), frame: null }; this.pending.set(identity.executionId, entry);
		try {
			entry.frame = await this.frame(signal);
			return observerJson({ componentOnly: !!this.options.fixture, kind: "independent-focus-before", monitor: this.birth, targetBefore: entry.frame.boundary, subscriptions: entry.frame.subscriptions });
		} catch (error) { this.pending.delete(identity.executionId); if (!signal.aborted) this.failed = true; throw error; }
	};
	after = async (identity: ToolExecutionIdentity, outcome: ToolExecutionOutcome, signal: AbortSignal): Promise<ToolObservationValue> => {
		this.live(); const entry = this.pending.get(identity.executionId);
		assert.ok(entry?.frame && entry.identitySha256 === observerHash(identity), "focus after has no matching private before");
		try {
			const targets = reportedFocusTargets(identity.name, entry.args, outcome), after = await this.frame(signal), before = entry.frame;
			for (const target of targets.pids) {
				const prior = before.subscriptions.subscriptions.find(s => s.pid === target), current = after.subscriptions.subscriptions.find(s => s.pid === target);
				assert.ok(prior && current, "reported UI process was not observed before and after execution");
				assert.equal(observerHash(prior), observerHash(current), "reported UI process subscription changed during execution");
				const firstBirth = alive(before.boundary.processes.find(p => p.pid === target)?.observation, target), lastBirth = alive(after.boundary.processes.find(p => p.pid === target)?.observation, target);
				assert.deepEqual(firstBirth, lastBirth, "reported UI process OS birth changed"); assert.deepEqual(lastBirth, current.birth, "focus subscription belongs to a different process");
			}
			this.pending.delete(identity.executionId);
			return observerJson({ componentOnly: !!this.options.fixture, kind: "independent-focus-after", monitor: this.birth, scope: targets.scope, reportedTargetPids: targets.pids,
				// Do not let an app owner stand in for an unrecorded remote native receiver.
				exactNativeReceiverProven: !identity.name.startsWith("screen_") || outcome.dispatch === "not-started" || targets.scope === "native-app-inventory",
				targetBefore: before.boundary, targetAfter: after.boundary, subscriptionsBefore: before.subscriptions, subscriptionsAfter: after.subscriptions });
		} catch (error) { if (!signal.aborted) this.failed = true; throw error; }
	};
	/** Called while the exact monitor is still alive, after CLI cleanup. Its final
 * EOF/fixture-cleanup tail remains the outer runner's separate responsibility. */
	finalize = async (signal: AbortSignal): Promise<ToolObservationValue> => {
		this.live(); assert.equal(this.pending.size, 0, "unfinished private focus observations");
		try {
			const cutoff = (this.options.fixture?.now ?? Date.now)(); let frame = await this.frame(signal);
			while (frame.subscriptions.sampleAt < cutoff) {
				await new Promise<void>(resolve => setTimeout(resolve, 10)); signal.throwIfAborted(); frame = await this.frame(signal);
			}
			const cursor = this.options.journal.verifyPrefix();
			return observerJson({ componentOnly: !!this.options.fixture, kind: "independent-focus-prefix", monitor: this.birth, cursor, sampleAt: frame.subscriptions.sampleAt, cleanupTailVerified: false });
		} catch (error) { this.failed = true; throw error; }
	};
	close(): void { this.closed = true; this.pending.clear(); this.options.journal.close(); }
}
