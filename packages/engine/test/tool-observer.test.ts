import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assertToolPairing } from "@mountains/context";
import type { ModelAdapter } from "@mountains/providers";
import type { ToolCall } from "@mountains/protocol";
import { readRecording, type LedgerRecord } from "@mountains/telemetry";
import { generalTools, type ToolDefinition } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, validateApprovalSettings, type EngineOptions, type RecordedResponse,
	type ToolExecutionIdentity, type ToolExecutionObserver, type ToolExecutionOutcome, type ToolObservationValue } from "../src/index.ts";

// The model is entirely offline. File tools and the execution/recording boundaries are real.
const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function reply(calls: ToolCall[] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "", toolCalls: calls },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false };
}
const write = (id: string): ToolCall => ({ id, name: "file_write", argumentsJson: JSON.stringify({ path: `${id}.txt`, content: `${id} actual content\n` }) });
const read = (id: string): ToolCall => ({ id, name: "context_expand", argumentsJson: "{}" });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function gate<T = void>() {
	let release!: (value: T) => void;
	const promise = new Promise<T>(resolve => { release = resolve; });
	return { promise, release };
}
function observer(extra: Partial<ToolExecutionObserver> = {}): ToolExecutionObserver {
	return { before: async () => ({ prepared: true }), after: async () => ({ completed: true }), ...extra };
}
function fixture(t: TestContext, responses: RecordedResponse[], extra: Partial<EngineOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-tool-observer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"); mkdirSync(workspace);
	const scripted = new ScriptedModelAdapter(responses);
	const adapter: ModelAdapter = { id: "offline-observer-model", async complete(...args) {
		const result = await scripted.complete(...args);
		return { ...result, responseId: `offline-response-${scripted.requests.length}` };
	} };
	const dataDir = join(root, "data");
	const options: EngineOptions = { workspace, dataDir, archiveDir: join(root, "archive"), appDataDir: join(root, "appdata"),
		adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64,
		budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(root, "spend.jsonl") }), requestGuard: true, allowSessionSnapshots: true,
		limits: { maxCost: 2 }, checkpoints: true, retry: { maxAttempts: 2, baseDelayMs: 0 }, ...extra };
	const agent = new AgentSession(options);
	const recorded = (kind: "tool.input" | "tool.output" | "model.response") => readRecording(join(dataDir, "recording.jsonl")).filter(r => r.kind === kind).map(r => r.data as Record<string, any>);
	const ledger = () => readFileSync(join(dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row) as LedgerRecord);
	const results = () => {
		const messages = agent.builder.plan().messages; assertToolPairing(messages);
		return messages.filter(m => m.role === "tool");
	};
	return { agent, workspace, root, options, scripted, recorded, ledger, results };
}

test("actual execution is bracketed by frozen observations and bound to one settled response", async t => {
	const order: string[] = [], identities: ToolExecutionIdentity[] = [], outcomes: ToolExecutionOutcome[] = [];
	const receipt = { prepared: { token: "receipt" } };
	const writes = generalTools().map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
		order.push(`execute:${args[1].toolCallId}`); return tool.execute(...args);
	} }));
	const calls = [write("first"), write("second"), write("third")];
	const f = fixture(t, [reply(calls), reply()], { tools: writes, toolObserver: observer({
		async before(identity, args) {
			identities.push(identity); order.push(`before:${identity.toolCallId}`);
			assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.source) && Object.isFrozen(args));
			assert.throws(() => { (args as Record<string, unknown>).path = "wrong.txt"; }, TypeError);
			return receipt;
		},
		async after(identity, prepared, outcome, signal) {
			order.push(`after:${identity.toolCallId}`); outcomes.push(outcome); assert.equal(signal.aborted, false);
			assert.ok(Object.isFrozen(prepared) && Object.isFrozen(outcome) && Object.isFrozen(outcome.details));
			assert.throws(() => { (prepared as any).prepared.token = "mutated"; }, TypeError);
			assert.throws(() => { (outcome.details as Record<string, unknown>).path = "wrong.txt"; }, TypeError);
			assert.equal("modelContent" in outcome, false); assert.equal("images" in outcome, false);
			return { checked: true };
		},
	}) });
	const summary = await f.agent.run("Write these three files once.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(order, calls.flatMap(c => [`before:${c.id}`, `execute:${c.id}`, `after:${c.id}`]));
	assert.equal(new Set(identities.map(i => i.executionId)).size, 3);
	assert.equal(new Set(identities.map(i => i.source.requestId)).size, 1, "one model charge, not one charge per tool");
	for (let i = 0; i < 3; i++) {
		const input = f.recorded("tool.input")[i]!, output = f.recorded("tool.output")[i]!;
		assert.deepEqual(input.source, identities[i]!.source); assert.deepEqual(output.source, input.source);
		assert.equal(input.executionId, output.executionId); assert.equal(input.argumentsSha256, hash(calls[i]!.argumentsJson));
		assert.equal(input.source.responseId, "offline-response-1");
		assert.equal(f.ledger().find(l => l.requestId === input.source.requestId)?.responseId, input.source.responseId);
		assert.equal(f.recorded("model.response").find(r => r.requestId === input.source.requestId)?.responseId, input.source.responseId);
		const actual = readFileSync(join(f.workspace, `${calls[i]!.id}.txt`), "utf8");
		assert.equal(actual, `${calls[i]!.id} actual content\n`);
		assert.equal(outcomes[i]!.dispatch, "returned"); assert.ok(outcomes[i]!.started && outcomes[i]!.finished);
		assert.ok(BigInt(outcomes[i]!.finished!.monotonicNs) >= BigInt(outcomes[i]!.started!.monotonicNs));
		assert.equal(outcomes[i]!.modelContentSha256, hash(f.results()[i]!.content));
		assert.equal(output.observation.after.status, "completed");
	}
	assert.equal(f.ledger().length, 2); assert.deepEqual(receipt, { prepared: { token: "receipt" } });
	assert.equal(summary.totals.cost, f.ledger().reduce((sum, r) => sum + r.cost, 0));
});

test("retry binds tools to the successful response, preserving the failed request separately", async t => {
	const failure: RecordedResponse = { ...reply(), ok: false, rawUsage: null, httpStatus: 429, error: { message: "offline rate limit", retryable: true } };
	const sources: ToolExecutionIdentity[] = [];
	const f = fixture(t, [failure, reply([write("retry")]), reply()], { toolObserver: observer({ before: async i => { sources.push(i); return null; } }) });
	assert.equal((await f.agent.run("Create retry.txt.")).status, "completed");
	assert.equal(sources[0]!.source.attempt, 2); assert.equal(sources[0]!.source.responseId, "offline-response-2");
	assert.match(sources[0]!.source.requestId, /-a2-/); assert.equal(f.ledger().length, 3);
	assert.equal(f.ledger()[0]!.responseId, "offline-response-1"); assert.notEqual(f.ledger()[0]!.requestId, sources[0]!.source.requestId);
});

test("approval billing cannot overwrite the producing model response", async t => {
	const identities: ToolExecutionIdentity[] = [];
	const settings = validateApprovalSettings({ model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", profile: "deepseek", apiKeyEnv: "UNUSED_OFFLINE_KEY",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, timeoutMs: 100, maxRequests: 4, maxCost: 0.25,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline-test" } }, "USD");
	let approvals = 0;
	const judge: ModelAdapter = { id: "offline-observer-judge", async complete(request) {
		const evidence = JSON.parse(request.messages[0]!.content);
		const base = await new ScriptedModelAdapter([reply()]).complete(request);
		return { ...base, responseId: `offline-approval-${++approvals}`, message: { role: "assistant", content: JSON.stringify({ decision: "allow",
			authorization: [{ requestId: evidence.userRequests[0].id, quote: evidence.userRequests[0].text }] }), reasoning: "", toolCalls: [] } };
	} };
	const f = fixture(t, [reply([write("first"), write("second")]), reply()], { modelApproval: { settings, adapter: judge },
		toolObserver: observer({ before: async i => { identities.push(i); return null; } }) });
	const summary = await f.agent.run("Create first.txt and second.txt with their requested contents.");
	assert.equal(summary.status, "completed", summary.reason); assert.equal(approvals, 2); assert.equal(f.ledger().length, 4);
	assert.ok(identities.every(i => i.source.responseId === "offline-response-1"));
	assert.ok(identities.every(i => !i.source.requestId.includes("approval")));
	assert.deepEqual(f.ledger().filter(r => r.purpose === "approval").map(r => r.responseId), ["offline-approval-1", "offline-approval-2"]);
	assert.equal(summary.totals.cost, f.ledger().reduce((sum, row) => sum + row.cost, 0));
});

for (const mode of ["throw", "timeout", "synchronous-timeout", "invalid-receipt"] as const) test(`before ${mode} prevents both current and pending writes`, { timeout: 3000 }, async t => {
	let afters = 0, observedSignal: AbortSignal | undefined;
	const f = fixture(t, [reply([write("first"), write("second")])], { toolObserver: observer({ timeoutMs: 25,
		before: async (_i, _a, signal) => {
			observedSignal = signal;
			if (mode === "timeout") return new Promise(() => {});
			if (mode === "synchronous-timeout") { const until = performance.now() + 50; while (performance.now() < until) {} return null; }
			if (mode === "invalid-receipt") return undefined as unknown as ToolObservationValue;
			throw new Error("offline before observation failed");
		}, after: async () => { afters++; return null; },
	}) });
	const summary = await f.agent.run("Do not execute without evidence.");
	assert.equal(summary.status, "failed"); assert.match(summary.reason, /核对/); assert.equal(afters, 0);
	assert.equal(f.scripted.requests.length, 1); assert.equal(observedSignal?.aborted, true);
	for (const id of ["first", "second"]) assert.equal(existsSync(join(f.workspace, `${id}.txt`)), false);
	assert.ok(f.results().every(r => /未执行/.test(r.content))); assert.doesNotThrow(() => f.agent.exportSnapshot());
	assert.ok(f.recorded("tool.output").every(r => r.execution.dispatch === "not-started"));
});

test("cancelling an unfinished before stops dispatch without waiting for its uncooperative callback", { timeout: 3000 }, async t => {
	const controller = new AbortController(), entered = gate(); let afters = 0;
	const f = fixture(t, [reply([write("never")])], { toolObserver: observer({ before: async () => { entered.release(); return new Promise(() => {}); },
		after: async () => { afters++; return null; } }) });
	const running = f.agent.run("Cancel before dispatch.", controller.signal); await entered.promise; controller.abort();
	assert.equal((await running).status, "cancelled"); assert.equal(afters, 0);
	assert.equal(existsSync(join(f.workspace, "never.txt")), false); assert.equal(f.recorded("tool.output")[0]!.observation.before.status, "cancelled");
});

for (const mode of ["throw", "timeout", "synchronous-timeout", "oversized-receipt"] as const) test(`after ${mode} preserves the real write, stops the next one, and cannot cause replay`, { timeout: 3000 }, async t => {
	let fail = true;
	const f = fixture(t, [reply([write("first"), write("second")]), reply()], { toolObserver: observer({ timeoutMs: 25,
		after: async () => {
			if (!fail) return null;
			if (mode === "timeout") return new Promise(() => {});
			if (mode === "synchronous-timeout") { const until = performance.now() + 50; while (performance.now() < until) {} return null; }
			if (mode === "oversized-receipt") return "x".repeat(1_048_577);
			throw new Error("offline after observation failed");
		},
	}) });
	const summary = await f.agent.run("Write the first file only once.");
	assert.equal(summary.status, "failed"); assert.deepEqual(summary.filesChanged, ["first.txt"]);
	assert.equal(readFileSync(join(f.workspace, "first.txt"), "utf8"), "first actual content\n");
	assert.equal(existsSync(join(f.workspace, "second.txt")), false);
	assert.equal(f.recorded("tool.output")[0]!.ok, true); assert.equal(f.recorded("tool.output")[0]!.observation.after.status, "failed");
	assert.equal(f.results()[0]!.content, f.recorded("tool.output")[0]!.modelContent); assert.match(f.results()[1]!.content, /未执行/);
	assert.doesNotThrow(() => f.agent.exportSnapshot()); fail = false;
	assert.equal((await f.agent.run("Continue without repeating the completed write.")).status, "completed");
	assert.equal(f.recorded("tool.output").length, 2); assert.equal(f.scripted.requests.length, 2);
});

test("revocation during before closes its observation with not-started instead of executing the old write", async t => {
	const entered = gate(), release = gate(); const outcomes: ToolExecutionOutcome[] = [];
	const f = fixture(t, [reply([write("old")]), reply()], { allowInterjection: true, toolObserver: observer({ before: async () => { entered.release(); await release.promise; return null; },
		after: async (_i, _p, outcome) => { outcomes.push(outcome); return null; } }) });
	const running = f.agent.run("Create old.txt."); await entered.promise;
	try { assert.equal(f.agent.interject("Stop writing. Only report.").accepted, true); }
	finally { release.release(); await running; }
	assert.equal((await running).status, "completed"); assert.equal(existsSync(join(f.workspace, "old.txt")), false);
	assert.equal(outcomes[0]!.dispatch, "not-started"); assert.equal(outcomes[0]!.started, null); assert.match(f.results()[0]!.content, /授权.*撤销|授权失效/);
});

test("cancelling an executed write still runs after with an independent live signal", async t => {
	const controller = new AbortController(); const outcomes: ToolExecutionOutcome[] = [];
	const tools = generalTools().map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
		const result = await tool.execute(...args); controller.abort(); return result;
	} }));
	const f = fixture(t, [reply([write("written"), write("never")])], { tools, toolObserver: observer({ after: async (_i, _p, outcome, signal) => {
		assert.equal(controller.signal.aborted, true); assert.equal(signal.aborted, false); await new Promise<void>(resolve => setImmediate(resolve));
		outcomes.push(outcome); return null;
	} }) });
	const summary = await f.agent.run("Cancel after execution.", controller.signal);
	assert.equal(summary.status, "cancelled"); assert.deepEqual(summary.filesChanged, ["written.txt"]);
	assert.equal(outcomes[0]!.dispatch, "returned"); assert.equal(outcomes[0]!.ok, true); assert.equal(existsSync(join(f.workspace, "never.txt")), false);
});

test("parallel before failure prevents a slower prepared call from dispatching", async t => {
	const firstEntered = gate(), releaseFirst = gate(), failureEntered = gate(); const outcomes: ToolExecutionOutcome[] = []; let executions = 0;
	const tool: ToolDefinition = { name: "context_expand", logicalName: "fixture.read", description: "offline", parameters: {}, readOnly: true,
		async execute() { executions++; return { ok: true, modelContent: "actual", summary: "read", details: {} }; } };
	const f = fixture(t, [reply([read("slow"), read("failed")])], { tools: [tool], toolObserver: observer({
		before: async i => { if (i.toolCallId === "slow") { firstEntered.release(); await releaseFirst.promise; return null; }
			await firstEntered.promise; failureEntered.release(); throw new Error("offline failure"); },
		after: async (_i, _p, outcome) => { outcomes.push(outcome); return null; },
	}) });
	const running = f.agent.run("Read both."); await failureEntered.promise; await new Promise<void>(resolve => setImmediate(resolve)); releaseFirst.release();
	assert.equal((await running).status, "failed"); assert.equal(executions, 0); assert.equal(outcomes[0]!.dispatch, "not-started");
	assert.equal(f.results().length, 2);
});

test("parallel work already dispatched settles before observation failure ends the run", async t => {
	const executing = gate(), release = gate(), failed = gate(); let afters = 0;
	const tool: ToolDefinition = { name: "context_expand", logicalName: "fixture.read", description: "offline", parameters: {}, readOnly: true,
		async execute() { executing.release(); await release.promise; return { ok: true, modelContent: "real completed read", summary: "read", details: {} }; } };
	const f = fixture(t, [reply([read("started"), read("failed")])], { tools: [tool], toolObserver: observer({
		before: async i => { if (i.toolCallId === "started") return null; await executing.promise; failed.release(); throw new Error("offline failure"); },
		after: async () => { afters++; return null; },
	}) });
	let settled = false; const running = f.agent.run("Read both."); void running.finally(() => { settled = true; });
	try {
		await failed.promise; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
		assert.throws(() => f.agent.exportSnapshot(), /完整结束/); release.release();
		assert.equal((await running).status, "failed"); assert.equal(afters, 1); assert.equal(f.results()[0]!.content, "real completed read");
	} finally { release.release(); await running; }
});

test("tool throwing after a write is observed as started with unknown side effects, never not-started", async t => {
	const outcomes: ToolExecutionOutcome[] = [];
	const tools = generalTools().map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
		await tool.execute(...args); throw new Error("synthetic error after real write");
	} }));
	const f = fixture(t, [reply([write("written")]), reply()], { tools, toolObserver: observer({ after: async (_i, _p, outcome) => { outcomes.push(outcome); return null; } }) });
	assert.equal((await f.agent.run("Record a partial tool failure.")).status, "completed");
	assert.equal(readFileSync(join(f.workspace, "written.txt"), "utf8"), "written actual content\n");
	assert.equal(outcomes[0]!.dispatch, "threw"); assert.equal(outcomes[0]!.ok, false); assert.ok(outcomes[0]!.started && outcomes[0]!.finished);
	assert.match(f.results()[0]!.content, /synthetic error after real write/);
});

test("handoff survives failed after evidence and stops subsequent calls", async t => {
	let executions = 0;
	const tool: ToolDefinition = { name: "context_expand", logicalName: "fixture.handoff", description: "offline", parameters: {}, readOnly: false, canHandoff: true,
		async execute() { executions++; return { ok: true, modelContent: "Please log in to the test page.", summary: "handoff", details: {}, control: { kind: "handoff", message: "Please log in to the test page." } }; } };
	const f = fixture(t, [reply([read("handoff"), read("never")])], { tools: [tool], toolObserver: observer({ after: async () => { throw new Error("offline failure"); } }) });
	const summary = await f.agent.run("Hand the test page to me."); assert.equal(summary.status, "failed"); assert.equal(executions, 1);
	assert.equal(f.results()[0]!.content, "Please log in to the test page."); assert.match(f.results()[1]!.content, /交还用户/);
	assert.equal(summary.finalText, "Please log in to the test page.");
});

test("a strict host can reject a missing provider ID without inventing one", async t => {
	const adapter = new ScriptedModelAdapter([reply([write("never")])]);
	const f = fixture(t, [], { adapter, toolObserver: observer({ before: async identity => {
		assert.equal(identity.source.responseId, null); throw new Error("missing provider response ID");
	} }) });
	assert.equal((await f.agent.run("Do not accept unverifiable input.")).status, "failed");
	assert.equal(existsSync(join(f.workspace, "never.txt")), false); assert.equal(f.ledger()[0]!.responseId, null);
});

test("default callers retain ordinary execution and distinct IDs across separate sessions", async t => {
	const f = fixture(t, [reply([write("reused")]), reply()]);
	const other = fixture(t, [reply([write("reused")]), reply()]);
	for (const session of [f, other]) {
		assert.equal((await session.agent.run("Write the file once.")).status, "completed");
		assert.equal(session.scripted.requests.length, 2); assert.equal(session.recorded("tool.output").length, 1);
		assert.ok(session.recorded("tool.output").every(r => !("observation" in r)));
		assert.equal(session.results().length, 1);
	}
	assert.notEqual(f.recorded("tool.input")[0]!.executionId, other.recorded("tool.input")[0]!.executionId);
});

test("invalid observer deadlines are rejected before creating a session or calling a model", t => {
	for (const timeoutMs of [0, -1, NaN, Infinity, 30_001]) assert.throws(() => fixture(t, [], { toolObserver: observer({ timeoutMs }) }), /timeout/);
});

for (const phase of ["before", "after", "cancel"] as const) test(`synthetic secret in ${phase} failure cannot escape through observer error logging`, async t => {
	const synthetic = "synthetic-observer-password-for-local-test", entered = gate(), controller = new AbortController();
	const tool: ToolDefinition = { name: "context_expand", logicalName: "fixture.secret", description: "offline", parameters: {}, readOnly: true,
		async execute() { return { ok: true, modelContent: "Secret hidden", summary: "fixture", details: { password: synthetic } }; } };
	const f = fixture(t, [reply([read("secret")])], { tools: [tool], toolObserver: observer({
		before: async () => { if (phase === "before") throw new Error(synthetic); if (phase === "cancel") { entered.release(); return new Promise(() => {}); } return null; },
		after: async (_i, _p, result) => { assert.equal((result.details as any).password, synthetic); throw new Error(synthetic); },
	}) });
	const running = f.agent.run("Observe synthetic secret safely.", controller.signal);
	if (phase === "cancel") { await entered.promise; controller.abort(new Error(synthetic)); }
	const summary = await running;
	assert.equal(summary.status, phase === "cancel" ? "cancelled" : "failed");
	const recording = readFileSync(join(f.options.dataDir, "recording.jsonl"), "utf8");
	assert.equal(recording.includes(synthetic), false, "callback exception and abort text must not persist synthetic secret");
	assert.equal(JSON.stringify(summary).includes(synthetic), false);
	if (phase === "after") assert.equal(f.recorded("tool.output")[0]!.details.password, "[REDACTED]");
});

for (const phase of ["before", "after"] as const) for (const kind of ["null-prototype", "hostile-proxy"] as const) {
	test(`${phase} throwing ${kind} still finishes the run and preserves actual results`, async t => {
		const thrown = kind === "null-prototype" ? Object.create(null) : new Proxy({}, { getPrototypeOf() { throw new Error("must not inspect thrown prototype"); }, get() { throw new Error("must not inspect thrown properties"); } });
		const f = fixture(t, [reply([write("actual"), write("never")])], { toolObserver: observer({
			before: async () => { if (phase === "before") throw thrown; return null; },
			after: async () => { throw thrown; },
		}) });
		assert.equal((await f.agent.run("Observe a malformed callback failure.")).status, "failed");
		assert.equal(f.results().length, 2); assert.doesNotThrow(() => f.agent.exportSnapshot());
		assert.equal(existsSync(join(f.workspace, "actual.txt")), phase === "after");
		assert.equal(existsSync(join(f.workspace, "never.txt")), false);
		assert.equal(f.recorded("tool.output")[0]!.observation[phase].failure, "callback");
		if (phase === "after") assert.equal(f.results()[0]!.content, f.recorded("tool.output")[0]!.modelContent);
	});
}

for (const kind of ["null-prototype", "hostile-proxy"] as const) test(`tool throwing ${kind} after writing still runs after and publishes its real failure`, async t => {
	const thrown = kind === "null-prototype" ? Object.create(null) : new Proxy({}, { getPrototypeOf() { throw new Error("unreadable prototype"); }, get() { throw new Error("unreadable properties"); } });
	const outcomes: ToolExecutionOutcome[] = [];
	const tools = generalTools().map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) { await tool.execute(...args); throw thrown; } }));
	const f = fixture(t, [reply([write("written")]), reply()], { tools, toolObserver: observer({ after: async (_i, _p, outcome) => { outcomes.push(outcome); return null; } }) });
	const summary = await f.agent.run("Report the partial tool failure, without repeating the write.");
	assert.equal(summary.status, "completed"); assert.deepEqual(summary.filesChanged, ["written.txt"]);
	assert.equal(readFileSync(join(f.workspace, "written.txt"), "utf8"), "written actual content\n");
	assert.equal(outcomes.length, 1); assert.equal(outcomes[0]!.dispatch, "threw"); assert.equal(outcomes[0]!.ok, false);
	assert.match(f.results()[0]!.content, /unreadable error/); assert.doesNotThrow(() => f.agent.exportSnapshot());
	assert.equal(f.recorded("tool.output")[0]!.observation.after.status, "completed");
});
