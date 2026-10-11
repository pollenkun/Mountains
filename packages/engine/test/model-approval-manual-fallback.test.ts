import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import type { ModelAdapter, ModelRequest, ModelResponse } from "@mountains/providers";
import { generalTools, type ApprovalRequest } from "@mountains/tools";
import { AgentSession, type EngineOptions } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";
import { ScriptedModelAdapter, type RecordedResponse } from "../src/replay.ts";
import { validateApprovalSettings } from "../src/approval-settings.ts";

// Only model responses are fixtures. File writes, commands and both approval gates are real.
const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
const write = { id: "write", name: "file_write", argumentsJson: JSON.stringify({ path: "new.txt", content: "approved content\n" }) };
function reply(calls: RecordedResponse["message"]["toolCalls"] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "", toolCalls: calls },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false };
}
function judgeReply(value: unknown = { decision: "ask", reason: "需要用户决定这次写入。" }, extra: Partial<ModelResponse> = {}): ModelResponse {
	return { ...reply(), message: { role: "assistant", content: JSON.stringify(value), reasoning: "", toolCalls: [] },
		responseId: null, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 110, partial: false },
		requestBody: null, startedAt: Date.now(), firstByteAt: Date.now(), finishedAt: Date.now(), retryAfterMs: null, ...extra };
}
function fixture(t: TestContext, options: {
	decide?: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>;
	manualFallback?: boolean;
	omitManualFallback?: boolean;
	humanAvailable?: boolean;
	ask?: (request: ApprovalRequest, workspace: string) => Promise<"allow" | "deny">;
	calls?: RecordedResponse["message"]["toolCalls"];
	extra?: Partial<EngineOptions>;
} = {}) {
	const base = mkdtempSync(join(tmpdir(), "mountains-manual-fallback-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	const main = new ScriptedModelAdapter([reply(options.calls ?? [write]), reply()]);
	const events: EngineEvent[] = [];
	let judgeRequests = 0, humanRequests = 0;
	const humanErrors: unknown[] = [];
	t.after(() => { if (humanErrors.length) throw humanErrors[0]; });
	const judge: ModelAdapter = { id: "offline-fallback-judge", async complete(request) {
		judgeRequests++;
		return options.decide ? options.decide(request) : judgeReply();
	} };
	const settings = validateApprovalSettings({ model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", profile: "deepseek",
		apiKeyEnv: "UNUSED_OFFLINE_APPROVAL_KEY", thinking: { enabled: false, effort: "default" },
		maxTokens: 64, timeoutMs: 40, maxRequests: 8, maxCost: 0.25,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline-test" } }, "USD");
	const budget = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: join(base, "spend.jsonl") });
	const agent = new AgentSession({ workspace, dataDir: join(base, "data"), tools: generalTools({ approveFileWrites: true }),
		adapter: main, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64,
		budget, checkpoints: false, retry: { maxAttempts: 1, baseDelayMs: 0 },
		limits: { maxTurns: 4, maxRequests: 8, maxCost: 1 },
		modelApproval: { settings, adapter: judge, ...(options.omitManualFallback ? {} : { manualFallback: options.manualFallback ?? true }) },
		...(options.humanAvailable === false ? {} : { askApproval: async (request: ApprovalRequest) => {
			humanRequests++;
			try { return options.ask ? await options.ask(request, workspace) : "allow" as const; }
			catch (error) { humanErrors.push(error); throw error; }
		} }),
		onEvent: event => events.push(event), ...options.extra });
	return { agent, workspace, main, budget, events, counts: () => ({ judgeRequests, humanRequests }) };
}

test("known model uncertainty reaches the real file tool's human approval and preserves shared charges", async t => {
	const f = fixture(t);
	const result = await f.agent.run("Create new.txt with the approved contents.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(readFileSync(join(f.workspace, "new.txt"), "utf8"), "approved content\n");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 1 });
	assert.deepEqual(f.events.filter(event => event.type === "approval.requested").map(event => event.source), ["model", "human"]);
	assert.equal(result.totals.approvalRequests, 1);
	assert.ok(result.totals.approvalCost! > 0);
	assert.equal(result.totals.requests, 3);
	assert.equal(f.budget.snapshot({ runId: result.runId }).spent, result.totals.cost);
	assert.equal(f.budget.snapshot({ runId: result.runId }).unknownCost, 0);
});

for (const failure of ["invalid-json", "known-http-error"] as const) {
	test(`${failure} with trustworthy billed usage falls back to a human`, async t => {
		const f = fixture(t, { decide: () => failure === "invalid-json"
			? judgeReply(null, { message: { role: "assistant", content: "not JSON", reasoning: "", toolCalls: [] } })
			: judgeReply(null, { ok: false, httpStatus: 500, error: { message: "offline service error", retryable: false } }) });
		assert.equal((await f.agent.run("Create new.txt.")).status, "completed");
		assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 1 });
		assert.equal(existsSync(join(f.workspace, "new.txt")), true);
	});
}

test("the real command tool asks the human even if its static policy would allow it", async t => {
	const f = fixture(t, { calls: [{ id: "echo", name: "command_run", argumentsJson: JSON.stringify({ argv: ["echo", "offline approved"] }) }],
		extra: { approval: { rules: [{ id: "allow-all", decision: "allow" }], fallback: "deny" } } });
	const result = await f.agent.run("Run echo offline approved.");
	assert.equal(result.status, "completed", result.reason);
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 1 });
	assert.ok(f.events.some(event => event.type === "tool.completed" && event.tool === "command_run" && event.ok));
});

test("legacy callers still pause when model approval asks", async t => {
	const f = fixture(t, { manualFallback: false });
	const result = await f.agent.run("Create new.txt.");
	assert.equal(result.status, "limit");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 0 });
	assert.equal(f.main.requests.length, 1);
	assert.equal(existsSync(join(f.workspace, "new.txt")), false);
});

test("an explicit model denial never reaches human fallback", async t => {
	const f = fixture(t, { decide: () => judgeReply({ decision: "deny", reason: "当前要求禁止写文件。" }) });
	assert.equal((await f.agent.run("Inspect only.")).status, "completed");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 0 });
	assert.equal(existsSync(join(f.workspace, "new.txt")), false);
});

test("a human denial prevents the file write", async t => {
	const f = fixture(t, { ask: async () => "deny" });
	assert.equal((await f.agent.run("Create new.txt.")).status, "completed");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 1 });
	assert.equal(existsSync(join(f.workspace, "new.txt")), false);
});

for (const failure of ["missing-usage", "model-mismatch", "throws", "timeout", "aborted-known-usage"] as const) {
	test(`${failure} stops before human approval or real writes`, { timeout: 3000 }, async t => {
		const f = fixture(t, { decide: () => {
			if (failure === "throws") throw new Error("offline transport error");
			if (failure === "timeout") return new Promise<ModelResponse>(() => {});
			if (failure === "model-mismatch") return judgeReply(undefined, { responseModel: "unexpected-approval-model" });
			return failure === "aborted-known-usage" ? judgeReply(undefined, { aborted: true })
				: judgeReply(undefined, { rawUsage: null, usage: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null, partial: true } });
		} });
		const result = await f.agent.run("Create new.txt.");
		assert.equal(result.status, "limit");
		assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 0 });
		assert.equal(f.main.requests.length, 1);
		assert.equal(existsSync(join(f.workspace, "new.txt")), false);
		if (failure !== "aborted-known-usage") {
			const usageEvent = f.events.find(event => event.type === "usage" && event.requestId.includes("-approval-"));
			assert.ok(usageEvent?.type === "usage", "the approval charge must be visible to the caller's accounting");
			assert.equal(usageEvent.cost, null, "unknown approval cost must not look like a verified conservative reservation");
			assert.equal(usageEvent.model, failure === "model-mismatch" ? "unexpected-approval-model" : "deepseek-flash");
			assert.ok(f.budget.snapshot({ runId: result.runId }).unknownCost > 0);
			const restored = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: f.budget.ledgerPath });
			assert.deepEqual(restored.snapshot({ runId: result.runId }), f.budget.snapshot({ runId: result.runId }));
		}
	});
}

test("omitting manual fallback preserves legacy usage event fields even for a mismatched model", async t => {
	const f = fixture(t, { omitManualFallback: true, decide: () => judgeReply(undefined, { responseModel: "unexpected-approval-model" }) });
	const result = await f.agent.run("Create new.txt.");
	assert.equal(result.status, "limit");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 0 });
	assert.equal(existsSync(join(f.workspace, "new.txt")), false);
	const usageEvent = f.events.find(event => event.type === "usage" && event.requestId.includes("-approval-"));
	assert.ok(usageEvent?.type === "usage");
	assert.equal(usageEvent.model, "deepseek-flash");
	assert.ok(usageEvent.cost !== null && usageEvent.cost > 0);
	assert.equal(usageEvent.cost, f.budget.snapshot({ runId: result.runId }).unknownCost);
});

test("a target created while the human reads approval cannot be overwritten by a late allow", async t => {
	const f = fixture(t, { ask: async (_request, workspace) => {
		writeFileSync(join(workspace, "new.txt"), "external content\n");
		return "allow";
	} });
	assert.equal((await f.agent.run("Create new.txt.")).status, "completed");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 1 });
	assert.equal(readFileSync(join(f.workspace, "new.txt"), "utf8"), "external content\n");
	assert.ok(f.events.some(event => event.type === "approval.resolved" && event.decision === "deny"));
});

test("target changes on the human allow event are caught immediately before the write", async t => {
	let humanRequested = false;
	const f = fixture(t, { extra: { onEvent: event => {
		if (event.type === "approval.requested" && event.source === "human") humanRequested = true;
		if (event.type === "approval.resolved" && event.decision === "allow" && humanRequested) writeFileSync(join(f.workspace, "new.txt"), "late external content\n");
	} } });
	assert.equal((await f.agent.run("Create new.txt.")).status, "completed");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 1 });
	assert.equal(readFileSync(join(f.workspace, "new.txt"), "utf8"), "late external content\n");
});

for (const interruption of ["cancel", "interjection", "new-run"] as const) {
	test(`${interruption} while waiting for a human makes a late allow ineffective`, async t => {
		const controller = new AbortController();
		const f = fixture(t, { extra: { allowInterjection: true }, ask: async () => {
			if (interruption === "cancel") controller.abort();
			else if (interruption === "interjection") assert.equal(f.agent.interject("Stop writing files.").accepted, true);
			else await assert.rejects(f.agent.run("Stop writing files."), /正在运行/);
			return "allow";
		} });
		const result = await f.agent.run("Create new.txt.", controller.signal);
		assert.equal(existsSync(join(f.workspace, "new.txt")), false);
		assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 1 });
		if (interruption === "cancel") assert.equal(result.status, "cancelled");
	});
}

test("without a human callback, model uncertainty still pauses instead of executing", async t => {
	const f = fixture(t, { humanAvailable: false });
	assert.equal((await f.agent.run("Create new.txt.")).status, "limit");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 0 });
	assert.equal(existsSync(join(f.workspace, "new.txt")), false);
});

test("file tools that omit approval cannot use a human fallback as an implicit allow", async t => {
	const f = fixture(t, { extra: { tools: generalTools() } });
	assert.equal((await f.agent.run("Create new.txt.")).status, "completed");
	assert.deepEqual(f.counts(), { judgeRequests: 1, humanRequests: 0 });
	assert.equal(existsSync(join(f.workspace, "new.txt")), false);
});
