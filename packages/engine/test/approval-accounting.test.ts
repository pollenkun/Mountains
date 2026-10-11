import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Usage } from "@mountains/protocol";
import type { ModelAdapter, ModelRequest, ModelResponse, RawUsage } from "@mountains/providers";
import { createExpandTool, type ToolDefinition } from "@mountains/tools";
import { AgentSession, type EngineOptions } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";
import { ScriptedModelAdapter, type RecordedResponse } from "../src/replay.ts";
import type { ApprovalEvidence } from "../src/model-approval.ts";
import { validateApprovalSettings } from "../src/approval-settings.ts";

const fullUsage: RawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function reply(rawUsage: RawUsage = fullUsage, tool?: string, model = "deepseek-flash"): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: tool ? "" : "done", reasoning: "", toolCalls: tool ? [{ id: "action", name: tool, argumentsJson: tool === "command_run" ? '{"argv":["echo","approved"]}' : "{}" }] : [] },
		finishReason: tool ? "tool_calls" : "stop", responseModel: model, rawUsage, httpStatus: 200, error: null, aborted: false };
}
function judgeResponse(request: ModelRequest, usage: Usage): ModelResponse {
	const evidence = JSON.parse(request.messages[0]!.content) as ApprovalEvidence;
	const authorization = evidence.userRequests.at(-1)!;
	return { ...reply(), responseModel: request.model, responseId: null, rawUsage: null, usage,
		message: { role: "assistant", content: JSON.stringify({ decision: "allow", authorization: [{ requestId: authorization.id, quote: authorization.text }] }), reasoning: "", toolCalls: [] },
		requestBody: null, startedAt: Date.now(), firstByteAt: null, finishedAt: Date.now(), retryAfterMs: null };
}

function fixture(t: TestContext, main: ModelAdapter, options: { model?: string; maxCost?: number; maxInputTokens?: number; judge?: ModelAdapter; runId?: string } = {}) {
	const base = mkdtempSync(join(tmpdir(), "mountains-approval-accounting-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	const dataDir = join(base, "run"); const model = options.model ?? "deepseek-flash";
	const currency = model === "kimi-k2.7-code" ? "CNY" : "USD";
	const maxCost = options.maxCost ?? 10;
	const budget = new BudgetGuard({ globalLimit: maxCost, currency, ledgerPath: join(base, "spend.jsonl") });
	const executed: string[] = [];
	const tools = ["test_read", "command_run"].map((name): ToolDefinition => ({
		name, logicalName: name, description: "Offline stub; performs no command or external action.", parameters: { type: "object" }, readOnly: name === "test_read",
		async execute() { executed.push(name); return { ok: true, modelContent: "stub", summary: "stub", details: {} }; },
	}));
	tools.push(createExpandTool());
	const settings = validateApprovalSettings({ model: "offline-judge", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED", profile: "moonshot",
		thinking: { enabled: true, effort: "default" }, maxTokens: 64, maxInputChars: 20_000, timeoutMs: 100, maxRequests: 8, maxDenials: 3, maxCost: maxCost / 2,
		pricing: { currency, inputPerMillion: 1, outputPerMillion: 1, version: "offline" },
	}, currency);
	const engineOptions: EngineOptions = { workspace, dataDir, tools, adapter: main, model, thinking: { enabled: true, effort: "default" }, maxTokens: 64,
		budget, checkpoints: false, retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 5, maxRequests: 5, maxCost, maxInputTokens: options.maxInputTokens ?? 100_000 },
		...(options.runId ? { runId: options.runId } : {}),
		modelApproval: { settings, adapter: options.judge ?? { id: "unused", async complete() { throw new Error("judge must not be called"); } } },
	};
	return { agent: new AgentSession(engineOptions), engineOptions, budget, executed, dataDir, base };
}

for (const [label, rawUsage] of [
	["inconsistent totals", { ...fullUsage, prompt_cache_miss_tokens: 0 }],
	["negative input", { ...fullUsage, prompt_cache_miss_tokens: -1, prompt_cache_hit_tokens: 101 }],
	["fractional input", { ...fullUsage, prompt_cache_miss_tokens: 99.5, prompt_cache_hit_tokens: 0.5 }],
	["reasoning exceeds output", { ...fullUsage, completion_tokens_details: { reasoning_tokens: 11 } }],
] as const) {
	test(`main ${label} cannot release the reservation or execute its proposed tool`, async (t) => {
		const main = new ScriptedModelAdapter([reply(rawUsage, "test_read"), reply()]);
		const f = fixture(t, main); const result = await f.agent.run("Read the local stub.");
		assert.equal(result.status, "limit"); assert.equal(main.requests.length, 1); assert.deepEqual(f.executed, []);
		assert.equal(result.totals.usagePartialRequests, 1);
		const saved = f.budget.snapshot({ runId: result.runId });
		assert.equal(saved.requests, 1); assert.equal(saved.reserved, 0); assert.ok(saved.unknownCost > 0);
		assert.equal(saved.spent, saved.unknownCost);
		assert.deepEqual(new BudgetGuard({ globalLimit: 10, ledgerPath: f.budget.ledgerPath }).snapshot({ runId: result.runId }), saved);
	});
}

test("Moonshot cache writes count toward main input limits before the next request", async (t) => {
	const usage = { prompt_tokens: 6000, completion_tokens: 10, total_tokens: 6010, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 6000 } };
	const main = new ScriptedModelAdapter([reply(usage, "test_read", "kimi-k2.7-code"), reply(usage, "test_read", "kimi-k2.7-code"), reply(usage, undefined, "kimi-k2.7-code")]);
	const f = fixture(t, main, { model: "kimi-k2.7-code", maxInputTokens: 14_000 });
	const result = await f.agent.run("Read the local stub.");
	assert.equal(result.status, "limit"); assert.match(result.reason, /token 上限/);
	assert.ok(main.requests.length > 0 && main.requests.length < 3);
	assert.equal(result.totals.input, main.requests.length * 6000);
	assert.ok(result.totals.input <= 14_000); assert.equal(result.totals.usagePartialRequests, 0);
});

test("approval cache writes join the same input total as main requests", async (t) => {
	const main = new ScriptedModelAdapter([reply(fullUsage, "command_run"), reply()]);
	let approvalRequests = 0;
	const judge: ModelAdapter = { id: "offline-cache-write", async complete(request) {
		approvalRequests++;
		return judgeResponse(request, { input: 0, cacheRead: 0, cacheWrite: 4000, output: 10, total: 4010, reasoning: null, partial: false });
	} };
	const f = fixture(t, main, { judge }); const result = await f.agent.run("Run echo approved in this workspace.");
	assert.equal(result.status, "completed", result.reason); assert.equal(approvalRequests, 1);
	assert.equal(result.totals.input, 4200); assert.equal(result.totals.requests, 3);
	assert.deepEqual(f.executed, ["command_run"]);
});

for (const purpose of ["main", "approval"] as const) {
	test(`${purpose} actual overrun remains charged after its request log fails, including after restart`, async (t) => {
		let dataDir = "";
		const breakRequestLog = () => {
			const path = join(dataDir, "ledger.jsonl");
			if (existsSync(path)) renameSync(path, `${path}.before-failure`);
			mkdirSync(path);
		};
		const huge = { ...fullUsage, completion_tokens: 1_000_000, total_tokens: 1_000_100 };
		const scripted = new ScriptedModelAdapter([reply(purpose === "main" ? huge : fullUsage, purpose === "main" ? undefined : "command_run")]);
		const main: ModelAdapter = { id: "offline-main", async complete(request, handlers) {
			const response = await scripted.complete(request, handlers);
			if (purpose === "main") breakRequestLog();
			return response;
		} };
		let approvalRequests = 0;
		const judge: ModelAdapter = { id: "offline-overrun", async complete(request) {
			approvalRequests++; breakRequestLog();
			return judgeResponse(request, { input: 100, cacheRead: 0, cacheWrite: 0, output: 1_000_000, total: 1_000_100, reasoning: null, partial: false });
		} };
		const f = fixture(t, main, { maxCost: 0.1, judge }); dataDir = f.dataDir;
		const result = await f.agent.run("Run echo approved in this workspace.");
		assert.equal(result.status, "limit"); assert.deepEqual(f.executed, []);
		assert.equal(scripted.requests.length, 1); assert.equal(approvalRequests, purpose === "approval" ? 1 : 0);
		const saved = f.budget.snapshot({ runId: result.runId });
		assert.ok(saved.spent > 0.1); assert.equal(saved.reserved, 0);
		const reloaded = new BudgetGuard({ globalLimit: 0.1, ledgerPath: f.budget.ledgerPath });
		assert.deepEqual(reloaded.snapshot({ runId: result.runId }), saved);
		assert.throws(() => reloaded.reserve({ runId: "next", requestId: "next", amount: 0 }, 0.1), /超过预留/);
		assert.ok(readFileSync(f.budget.ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((row) => row.kind === "budget.settle" && row.overrun === true));
	});
}

test("two sessions starting one run cannot each spend the same request allowance", async (t) => {
	const main = new ScriptedModelAdapter([reply()]); const f = fixture(t, main, { runId: "same-run" });
	const secondMain = new ScriptedModelAdapter([reply()]);
	const second = new AgentSession({ ...f.engineOptions, adapter: secondMain, dataDir: join(f.base, "second"), budget: new BudgetGuard({ globalLimit: 10, ledgerPath: f.budget.ledgerPath }), limits: { ...f.engineOptions.limits, maxRequests: 1 } });
	let secondRun: ReturnType<AgentSession["run"]> | undefined;
	const first = new AgentSession({ ...f.engineOptions, dataDir: join(f.base, "first"), limits: { ...f.engineOptions.limits, maxRequests: 1 }, onEvent(event) {
		if (event.type === "turn.started" && !secondRun) secondRun = second.run("Start the same run concurrently.");
	} });
	const firstResult = await first.run("Read the local stub."); const secondResult = await secondRun;
	assert.equal(firstResult.status, "completed"); assert.equal(secondResult?.status, "limit");
	assert.equal(main.requests.length, 1); assert.equal(secondMain.requests.length, 0);
	assert.equal(f.budget.snapshot({ runId: "same-run" }).requests, 1);
});
