import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolExecutionIdentity, ToolExecutionOutcome, ToolObservationValue, ModelLedgerWitness } from "@mountains/engine";
import { redactValue } from "@mountains/telemetry";
import { observerHash, observerJson, observerPacket, TOOL_OBSERVER_PROTOCOL, type ObserverAgent, type ObserverRequest, type ObserverStart } from "../../../../apps/cli/src/tool-observer-protocol.ts";
import { ModelSourceProof } from "./model-source-proof.ts";
import { parseRunArgs } from "../../../../apps/cli/src/cli-args.ts";

const object = (value: unknown): Record<string, any> => { assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected controller object"); return value as Record<string, any>; };
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** How far two processes' Date.now() may disagree. V8 on Windows builds it from the coarse system time (one
 * 15.6 ms tick) plus high-resolution ticks, so a child can read an earlier time than its parent did before it. */
export const WALL_CLOCK_SKEW_MS = process.platform === "win32" ? 20 : 0;
// Windows cannot open a directory to fsync it (EPERM); NTFS journals the new entry itself.
function syncDirectory(path: string): void { if (process.platform === "win32") return; const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeAll(fd: number, bytes: Buffer): void { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); assert.ok(n > 0); offset += n; } }

/** Only parent-selected proof is persisted. Never log raw IPC args, result details, callback errors or final text. */
class ControllerJournal {
	private readonly fd: number;
	private bytes = 0;
	private seq = 0;
	private previous: string | null = null;
	private readonly digest = createHash("sha256");
	private closed = false;
	readonly path: string;
	constructor(path: string) { this.path = path; this.fd = openSync(path, "wx", 0o600); fsyncSync(this.fd); syncDirectory(path); }
	write(value: Record<string, unknown>): { seq: number; sha256: string } {
		assert.ok(!this.closed, "controller journal is closed");
		const file = fstatSync(this.fd), link = lstatSync(this.path);
		assert.ok(link.isFile() && file.dev === link.dev && file.ino === link.ino && file.size === this.bytes, "controller journal changed externally");
		const row = { ...redactValue(value) as Record<string, unknown>, seq: ++this.seq, at: Date.now(), monotonicMs: performance.now(), previous: this.previous };
		const text = JSON.stringify(row) + "\n"; assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024, "controller proof row is too large");
		const bytes = Buffer.from(text); writeAll(this.fd, bytes); fsyncSync(this.fd); this.digest.update(bytes); this.bytes += bytes.length; this.previous = sha(text);
		return { seq: this.seq, sha256: this.previous };
	}
	finish(): { path: string; sha256: string } {
		fsyncSync(this.fd);
		const file = fstatSync(this.fd), link = lstatSync(this.path), bytes = readFileSync(this.path);
		assert.ok(link.isFile() && file.dev === link.dev && file.ino === link.ino && bytes.length === this.bytes, "controller journal identity changed");
		const hash = sha(bytes); assert.equal(hash, this.digest.copy().digest("hex"), "controller journal history was rewritten");
		return { path: this.path, sha256: hash };
	}
	close(): void { if (!this.closed) { this.closed = true; closeSync(this.fd); } }
}

export interface ModelControllerOptions {
	expected: Omit<ObserverStart, "pid">;
	journalPath: string;
	sourcePath: string;
	/** Mandatory: the real runner checks all frozen code/dependencies here. Tests supply an explicit local stub. */
	assertVersion(): void | Promise<void>;
	/** Read-only independent observations. Honor signal; never dispatch a tool or detach work. */
	before(identity: ToolExecutionIdentity, args: ToolObservationValue, signal: AbortSignal): Promise<ToolObservationValue>;
	after(identity: ToolExecutionIdentity, outcome: ToolExecutionOutcome, signal: AbortSignal): Promise<ToolObservationValue>;
	/** Optional independent observation after exact CLI close, before sealing evidence.
	 * Does not stop the outer monitor or replace its fixture-cleanup tail. */
	finalizeObservations?(signal: AbortSignal): Promise<ToolObservationValue>;
}
export interface ModelControllerResult { accepted: boolean; childPid: number; exitCode: number | null; signal: NodeJS.Signals | null; sourcePath: string; failure: string | null }
interface ParentInstant { at: number; monotonicMs: number }
interface Execution { identity: ToolExecutionIdentity; agent: ObserverAgent; prepared: ToolObservationValue; requested: ParentInstant; permitted: ParentInstant | null; state: "preparing" | "prepared" | "completed" }

/** Attaches only to the actual parent-owned ChildProcess IPC. This does not launch any model/UI. */
export class RecordedModelController {
	readonly completion: Promise<ModelControllerResult>;
	private readonly child: ChildProcess;
	private readonly options: ModelControllerOptions;
	private readonly journal: ControllerJournal;
	private readonly sources: ModelSourceProof;
	private readonly seen = new Map<string, Pick<ObserverRequest, "phase" | "hash">>();
	private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
	private readonly executions = new Map<string, Execution>();
	private startAccepted = false;
	private startRequested = false;
	private finishRequested = false;
	private summary: Record<string, any> | null = null;
	private failure: string | null = null;
	private closed = false;
	private resolveCompletion!: (result: ModelControllerResult) => void;
	constructor(child: ChildProcess, options: ModelControllerOptions) {
		assert.ok(child.pid && child.connected && child.channel, "controller requires its live IPC child");
		const cliMain = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));
		assert.equal(realpathSync(child.spawnfile), realpathSync(process.execPath), "controller child is not this Node runtime");
		assert.equal(child.spawnargs[1], "--disable-sigusr1"); assert.equal(child.spawnargs[2], cliMain); assert.equal(child.spawnargs[3], "run");
		const { values } = parseRunArgs(child.spawnargs.slice(4));
		assert.equal(values["tool-observer-ipc"], true); assert.equal(values.workspace, options.expected.workspace); assert.equal(values.out, options.expected.outDir);
		assert.equal(values["run-id"], options.expected.runId); assert.equal(values["spend-ledger"], options.expected.spendLedger);
		if (values.task !== undefined) assert.equal(values.task, options.expected.task);
		this.child = child; this.options = options;
		this.journal = new ControllerJournal(options.journalPath);
		this.sources = new ModelSourceProof(options.expected.outDir, options.expected.spendLedger);
		this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
		this.journal.write({ kind: "controller-start", controllerPid: process.pid, childPid: child.pid, expectedSha256: observerHash(options.expected) });
		child.on("message", this.onMessage); child.on("disconnect", this.onDisconnect); child.on("error", this.onError);
		child.once("close", (code, signal) => { void this.onClose(code, signal); });
	}
	private fault(code: string): void {
		if (!this.failure) { this.failure = code; try { this.journal.write({ kind: "controller-failure", code }); } catch { /* no approval on failed storage */ } }
		for (const { controller } of this.active.values()) controller.abort();
	}
	private onError = (): void => { this.fault("child-error"); };
	private onDisconnect = (): void => { if (!this.summary) this.fault("early-disconnect"); };
	private reply(request: ObserverRequest, ok: boolean, receipt: ToolObservationValue): void {
		if (!this.child.connected || this.closed) { this.fault("reply-disconnected"); return; }
		try {
			if (ok && (this.failure || this.active.get(request.id)?.controller.signal.aborted)) { ok = false; receipt = null; }
			if (ok && request.phase === "before") {
				const identity = object(object(request.payload).identity), execution = this.executions.get(identity.executionId);
				assert.ok(execution && execution.state === "prepared" && !execution.permitted, "missing or repeated permission");
				// Independent parent time immediately before the send attempt, after all
				// pre-observation work. This is an outer bound, not the child's hrtime.
				const permitted = Object.freeze({ at: Date.now(), monotonicMs: performance.now() });
				this.journal.write({ kind: "permission", executionId: identity.executionId, permitted }); execution.permitted = permitted;
			}
			this.child.send({ protocol: TOOL_OBSERVER_PROTOCOL, kind: "reply", id: request.id, phase: request.phase, hash: request.hash, ok, receipt }, error => { if (error) this.fault("reply-send-failed"); });
		}
		catch { this.fault("reply-send-failed"); }
	}
	private onMessage = (message: unknown): void => {
		const received = Object.freeze({ at: Date.now(), monotonicMs: performance.now() });
		try {
			const packet = observerPacket(message);
			if (packet.kind === "reply") throw null;
			if (packet.kind === "cancel") {
				const prior = this.seen.get(packet.id);
				assert.ok(prior && prior.phase === packet.phase && prior.hash === packet.hash, "unknown cancellation");
				this.journal.write({ kind: "cancel", requestId: packet.id, phase: packet.phase });
				this.active.get(packet.id)?.controller.abort(); return;
			}
			assert.ok(!this.seen.has(packet.id) && this.seen.size < 8192 && this.active.size < 256, "duplicate or excessive controller request");
			this.seen.set(packet.id, { phase: packet.phase, hash: packet.hash });
			const controller = new AbortController();
			const done = this.handle(packet, controller.signal, received).then(receipt => this.reply(packet, true, receipt), () => {
				if (!controller.signal.aborted) this.fault("controller-request-failed");
				this.reply(packet, false, null);
			}).catch(() => { this.fault("controller-reply-failed"); }).finally(() => this.active.delete(packet.id));
			this.active.set(packet.id, { controller, done });
		} catch {
			this.fault("invalid-controller-packet");
			try { if (this.child.connected) this.child.disconnect(); } catch { /* child will detect closed channel */ }
		}
	};
	private async handle(request: ObserverRequest, signal: AbortSignal, received: ParentInstant): Promise<ToolObservationValue> {
		assert.ok(!this.failure && !this.closed, "controller stopped");
		await this.options.assertVersion(); signal.throwIfAborted();
		const value = object(request.payload);
		if (request.phase === "start") {
			assert.ok(!this.startRequested && !this.startAccepted, "duplicate startup"); this.startRequested = true;
			assert.equal(value.pid, this.child.pid); const { pid: _pid, ...actual } = value;
			assert.equal(observerHash(actual), observerHash(this.options.expected), "CLI startup differs from the frozen launch");
			const receipt = this.journal.write({ kind: "cli-start", childPid: this.child.pid, taskSha256: sha(this.options.expected.task), metadataSha256: observerHash(actual) });
			this.startAccepted = true; return receipt;
		}
		assert.ok(this.startAccepted, "CLI did not complete startup");
		if (request.phase === "finish") {
			assert.ok(!this.finishRequested, "duplicate CLI finish"); this.finishRequested = true;
			const others = [...this.active].filter(([id]) => id !== request.id).map(([, entry]) => entry.done);
			await Promise.all(others); signal.throwIfAborted();
			assert.ok(!this.failure, "controller failed during final drain");
			assert.equal(value.runId, this.options.expected.runId); assert.ok(["completed", "failed", "cancelled", "limit"].includes(value.status));
			assert.ok([...this.executions.values()].every(entry => entry.state === "completed") || value.status !== "completed", "successful summary omits unfinished observations");
			const receipt = this.journal.write({ kind: "cli-finish", summarySha256: observerHash(value), status: value.status, totals: value.totals });
			this.summary = value; return receipt;
		}
		assert.ok(!this.finishRequested, "tool arrived after CLI finish");
		if (request.phase === "model") {
			const agent = object(value.agent) as unknown as ObserverAgent, witness = object(value.witness) as unknown as ModelLedgerWitness;
			const source = this.sources.model(agent, witness);
			return this.journal.write({ kind: "model", agent, witness, source, requestHash: request.hash });
		}
		const identity = object(value.identity) as unknown as ToolExecutionIdentity, agent = object(value.agent) as unknown as ObserverAgent;
		assert.ok(/^[a-f0-9-]{36}$/.test(identity.executionId), "invalid execution ID");
		if (request.phase === "before") {
			assert.ok(!this.executions.has(identity.executionId), "execution was already observed");
			const entry: Execution = { identity, agent, prepared: null, requested: received, permitted: null, state: "preparing" }; this.executions.set(identity.executionId, entry);
			const source = this.sources.before(agent, identity);
			const proof = observerJson(await this.options.before(identity, value.args as ToolObservationValue, signal), 1024 * 1024);
			signal.throwIfAborted(); assert.ok(!this.failure && !this.closed, "controller stopped before permission");
			const receipt = this.journal.write({ kind: "before", executionId: identity.executionId, identity, agent, source, proof, requestHash: request.hash });
			entry.prepared = receipt; entry.state = "prepared"; return receipt;
		}
		const entry = this.executions.get(identity.executionId);
		assert.ok(entry && entry.state === "prepared" && entry.permitted, "after has no permitted execution");
		assert.ok(received.monotonicMs >= entry.permitted.monotonicMs && received.at >= entry.permitted.at, "parent execution clock reversed");
		assert.equal(observerHash(entry.identity), observerHash(identity)); assert.equal(observerHash(entry.agent), observerHash(agent)); assert.equal(observerHash(entry.prepared), observerHash(value.prepared));
		const outcome = object(value.outcome) as unknown as ToolExecutionOutcome;
		assert.ok(["not-started", "returned", "threw"].includes(outcome.dispatch) && typeof outcome.ok === "boolean");
		if (outcome.dispatch === "not-started") assert.ok(outcome.started === null && outcome.finished === null && !outcome.ok);
		else {
			assert.ok(outcome.started && outcome.finished && Number.isFinite(outcome.started.wallTimeMs) && outcome.finished.wallTimeMs >= outcome.started.wallTimeMs);
			assert.ok(BigInt(outcome.finished.monotonicNs) >= BigInt(outcome.started.monotonicNs));
			assert.ok(outcome.started.wallTimeMs + WALL_CLOCK_SKEW_MS >= entry.permitted.at && outcome.finished.wallTimeMs <= received.at + WALL_CLOCK_SKEW_MS, "child execution is outside the independent parent envelope");
		}
		const proof = observerJson(await this.options.after(identity, outcome, signal), 1024 * 1024);
		signal.throwIfAborted(); assert.ok(!this.failure && !this.closed, "controller stopped after execution");
		this.sources.after(agent, identity, outcome);
		const receipt = this.journal.write({ kind: "after", executionId: identity.executionId, dispatch: outcome.dispatch, started: outcome.started, finished: outcome.finished,
			ok: outcome.ok, modelContentSha256: outcome.modelContentSha256, recordedModelContentSha256: outcome.recordedModelContentSha256,
			envelope: { requested: entry.requested, permitted: entry.permitted, received }, proof, requestHash: request.hash });
		entry.state = "completed"; return receipt;
	}
	private async onClose(exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
		for (const { controller } of this.active.values()) controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([Promise.allSettled([...this.active.values()].map(entry => entry.done)), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(null), 2000); })]);
			assert.ok(this.summary && !this.failure && !this.active.size, "child closed without a verified final result");
			const expectedExit = { completed: 0, failed: 1, cancelled: 130, limit: 3 }[this.summary.status as "completed" | "failed" | "cancelled" | "limit"];
			assert.ok(!signal && exitCode === expectedExit, "child exit differs from its final result");
			const summaryPath = join(this.options.expected.outDir, "summary.json"), summaryBytes = readFileSync(summaryPath), actual = object(JSON.parse(summaryBytes.toString()));
			for (const [key, value] of Object.entries(this.summary)) assert.equal(observerHash(actual[key]), observerHash(value), "disk summary differs from the live CLI result");
			if (this.options.finalizeObservations) {
				const stop = new AbortController(), deadlineAt = performance.now() + 5000; let deadline: ReturnType<typeof setTimeout> | undefined;
				try {
					const proof = await Promise.race([this.options.finalizeObservations(stop.signal), new Promise<never>((_resolve, reject) => {
						deadline = setTimeout(() => { stop.abort(); reject(new Error("final observation deadline")); }, 5000);
					})]);
					const copy = observerJson(proof, 1024 * 1024);
					assert.ok(performance.now() < deadlineAt && !stop.signal.aborted, "final observation exceeded deadline");
					this.journal.write({ kind: "observations-finalized", proof: copy });
					assert.ok(performance.now() < deadlineAt, "final observation storage exceeded deadline");
				} finally { clearTimeout(deadline); stop.abort(); }
			}
			const files = this.sources.finalize(this.summary.totals);
			this.journal.write({ kind: "cli-closed", childPid: this.child.pid, exitCode, summarySha256: sha(summaryBytes), status: this.summary.status });
			const journal = this.journal.finish();
			const source = { version: 1, controllerPid: process.pid, childPid: this.child.pid, accepted: this.summary.status === "completed", expectedSha256: observerHash(this.options.expected),
				journal, files, summary: { path: summaryPath, sha256: sha(summaryBytes) }, outDir: this.options.expected.outDir, spendLedger: this.options.expected.spendLedger, spendBaseline: this.sources.spendBaseline };
			const fd = openSync(this.options.sourcePath, "wx", 0o600); try { writeAll(fd, Buffer.from(JSON.stringify(source) + "\n")); fsyncSync(fd); syncDirectory(this.options.sourcePath); } finally { closeSync(fd); }
		} catch { this.fault("controller-finalization-failed"); }
		finally {
			clearTimeout(timer); this.closed = true;
			this.child.off("message", this.onMessage); this.child.off("disconnect", this.onDisconnect); this.child.off("error", this.onError);
			try { this.sources.close(); } catch { this.fault("source-close-failed"); }
			try { this.journal.close(); } catch { this.fault("journal-close-failed"); }
			this.resolveCompletion({ accepted: !this.failure && this.summary?.status === "completed", childPid: this.child.pid!, exitCode, signal, sourcePath: this.options.sourcePath, failure: this.failure });
		}
	}
}
