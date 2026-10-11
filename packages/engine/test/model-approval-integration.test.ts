import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import type { ModelAdapter, ModelRequest, ModelResponse } from "@mountains/providers";
import { generalTools, type ToolDefinition } from "@mountains/tools";
import { AgentSession, type EngineOptions } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";
import { ScriptedModelAdapter, type RecordedResponse } from "../src/replay.ts";
import { validateApprovalSettings, type ApprovalSettings } from "../src/approval-settings.ts";
import type { ApprovalEvidence } from "../src/model-approval.ts";

// Only model replies are fixtures. AgentSession, tools, approval dispatch and budgets are real.
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
type Call = { id: string; name: string; args: Record<string, unknown> };
function reply(calls: Call[] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Finished offline fixture.", reasoning: "MAIN_REASONING_STAYS_PRIVATE", toolCalls: calls.map(({ id, name, args }) => ({ id, name, argumentsJson: JSON.stringify(args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: usage, httpStatus: 200, error: null, aborted: false };
}
function judgeReply(value: unknown, extra: Partial<ModelResponse> = {}): ModelResponse {
	return { ...reply(), message: { role: "assistant", content: JSON.stringify(value), reasoning: "JUDGE_REASONING_MUST_NOT_REACH_MAIN", toolCalls: [] },
		responseId: null, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 110, partial: false },
		requestBody: null, startedAt: Date.now(), firstByteAt: Date.now(), finishedAt: Date.now(), retryAfterMs: null, ...extra };
}
class Judge implements ModelAdapter {
	readonly id = "offline-approval-judge";
	readonly requests: ModelRequest[] = [];
	readonly evidence: ApprovalEvidence[] = [];
	readonly decide: (evidence: ApprovalEvidence, request: ModelRequest) => ModelResponse | Promise<ModelResponse>;
	constructor(decide?: Judge["decide"]) {
		this.decide = decide ?? ((evidence) => judgeReply({ decision: "allow", authorization: [{ requestId: evidence.userRequests.at(-1)!.id, quote: evidence.userRequests.at(-1)!.text }] }));
	}
	async complete(request: ModelRequest): Promise<ModelResponse> {
		this.requests.push(request);
		assert.deepEqual(request.tools, []);
		assert.equal(request.messages.length, 1);
		const evidence = JSON.parse(request.messages[0]!.content) as ApprovalEvidence;
		this.evidence.push(evidence);
		assert.ok(evidence.userRequests.length > 0);
		assert.ok(!JSON.stringify(request).includes("MAIN_REASONING_STAYS_PRIVATE"));
		return this.decide(evidence, request);
	}
}
function fixture(t: TestContext, main: ModelAdapter, judge: Judge, settingsOverrides: Partial<ApprovalSettings> = {}, extra: Partial<EngineOptions> = {}) {
	const base = mkdtempSync(join(tmpdir(), "mountains-approval-integration-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "workspace"); const dataDir = join(base, "run"); mkdirSync(workspace);
	writeFileSync(join(workspace, "a.txt"), "hello\n");
	const executed: string[] = []; const events: EngineEvent[] = [];
	const command: ToolDefinition = {
		name: "command_run", logicalName: "command.run", description: "Never runs commands; records whether the real approval gate allowed execution.",
		parameters: { type: "object", additionalProperties: true }, readOnly: false,
		async execute(_args, ctx) {
			const allowed = await ctx.approve({ toolCallId: ctx.toolCallId, command: "sudo rm -rf cache", cwd: ctx.workspace.root, risk: "dangerous", explanation: "Offline stub only" });
			assert.equal(allowed, "allow", "approved dangerous action must not be vetoed again by the old static rule");
			executed.push("command_run");
			return { ok: true, modelContent: "STUB_EXECUTED_NO_COMMAND_WAS_RUN", summary: "stub completed", details: { stub: true } };
		},
	};
	const tools = generalTools().filter((tool) => tool.name !== "command_run").map((tool): ToolDefinition => ({
		...tool, async execute(args, ctx) { executed.push(tool.name); return tool.execute(args, ctx); },
	}));
	tools.push(command);
	const settings = validateApprovalSettings({
		model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_OFFLINE_APPROVAL_KEY", profile: "deepseek",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 20_000,
		timeoutMs: 200, maxRequests: 10, maxDenials: 3, maxCost: 0.25,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline-test" }, ...settingsOverrides,
	}, "USD");
	const budget = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: join(base, "spend.jsonl") });
	const agent = new AgentSession({
		workspace, dataDir, tools, adapter: main, model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 64,
		budget, checkpoints: false, retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 8, maxRequests: 8, maxCost: 1 },
		modelApproval: { settings, adapter: judge }, onEvent: (event) => events.push(event), ...extra,
	});
	return { agent, budget, dataDir, executed, events, workspace, settings };
}
const dangerous: Call = { id: "danger", name: "command_run", args: { argv: ["sudo", "rm", "-rf", "cache"] } };
function toolResult(request: ModelRequest, id: string): string {
	const message = request.messages.find((item) => item.role === "tool" && item.toolCallId === id);
	assert.ok(message?.role === "tool", `missing tool result ${id}`); return message.content;
}

test("authorized dangerous command reaches a harmless stub; approval reasoning and citation JSON stay out of the main conversation", async (t) => {
	const main = new ScriptedModelAdapter([reply([dangerous]), reply()]); const judge = new Judge(); const f = fixture(t, main, judge);
	const task = "请用 sudo 永久删除当前工作区的 cache 目录。";
	const result = await f.agent.run(task);
	assert.equal(result.status, "completed", result.reason); assert.deepEqual(f.executed, ["command_run"]);
	assert.equal(judge.requests.length, 1); assert.equal(main.requests.length, 2);
	assert.deepEqual(judge.evidence[0]!.userRequests.map((request) => request.text), [task]);
	assert.equal(judge.evidence[0]!.action.tool, "command_run"); assert.equal(judge.evidence[0]!.action.risk, "dangerous");
	assert.deepEqual(judge.evidence[0]!.action.arguments, dangerous.args);
	assert.match(toolResult(main.requests[1]!, "danger"), /STUB_EXECUTED/);
	const mainHistory = JSON.stringify(main.requests[1]!.messages);
	assert.doesNotMatch(mainHistory, /JUDGE_REASONING_MUST_NOT_REACH_MAIN|authorization|requestId/);
	assert.ok(mainHistory.includes("MAIN_REASONING_STAYS_PRIVATE"));
	assert.equal(result.totals.approvalRequests, 1); assert.ok(result.totals.approvalCost! > 0);
});

test("denied action never executes and only its short reason reaches the next main request", async (t) => {
	const reason = "用户只允许检查缓存，还没有允许删除。";
	const main = new ScriptedModelAdapter([reply([dangerous]), reply()]); const judge = new Judge(() => judgeReply({ decision: "deny", reason }));
	const f = fixture(t, main, judge); const result = await f.agent.run("检查 cache 目录，不要删除。");
	assert.equal(result.status, "completed", result.reason); assert.deepEqual(f.executed, []);
	assert.equal(main.requests.length, 2); assert.equal(judge.requests.length, 1);
	assert.equal(toolResult(main.requests[1]!, "danger"), `未执行：${reason}`);
	assert.doesNotMatch(JSON.stringify(main.requests[1]!.messages), /JUDGE_REASONING_MUST_NOT_REACH_MAIN|authorization/);
});

test("ordinary real file_read completes without calling the approval model", async (t) => {
	const main = new ScriptedModelAdapter([reply([{ id: "read", name: "file_read", args: { path: "a.txt" } }]), reply()]);
	const judge = new Judge(); const f = fixture(t, main, judge); const result = await f.agent.run("读取 a.txt。");
	assert.equal(result.status, "completed", result.reason); assert.deepEqual(f.executed, ["file_read"]);
	assert.equal(judge.requests.length, 0); assert.match(toolResult(main.requests[1]!, "read"), /hello/);
});

test("real file_edit and file_write each pass through the judge before committing their bytes", async (t) => {
	const main = new ScriptedModelAdapter([
		reply([{ id: "read", name: "file_read", args: { path: "a.txt" } }]),
		reply([{ id: "edit", name: "file_edit", args: { path: "a.txt", oldText: "hello", newText: "world" } }, { id: "write", name: "file_write", args: { path: "new.txt", content: "created\n" } }]), reply(),
	]);
	const judge = new Judge(); const f = fixture(t, main, judge); const result = await f.agent.run("把 a.txt 的 hello 改成 world，再创建 new.txt，内容为 created。");
	assert.equal(result.status, "completed", result.reason);
	assert.deepEqual(judge.evidence.map((item) => item.action.tool), ["file_edit", "file_write"]);
	assert.deepEqual(f.executed, ["file_read", "file_edit", "file_write"]);
	assert.equal(readFileSync(join(f.workspace, "a.txt"), "utf8"), "world\n");
	assert.equal(readFileSync(join(f.workspace, "new.txt"), "utf8"), "created\n");
});

test("ask pauses the run and prevents every later action in the same batch, including ordinary reads", async (t) => {
	const main = new ScriptedModelAdapter([reply([
		dangerous, { id: "later-write", name: "file_write", args: { path: "new.txt", content: "must not appear" } },
		{ id: "later-read", name: "file_read", args: { path: "a.txt" } },
	]), reply()]);
	const judge = new Judge(() => judgeReply({ decision: "ask", reason: "需要用户确认删除范围。" })); const f = fixture(t, main, judge);
	const result = await f.agent.run("处理一下缓存。");
	assert.equal(result.status, "limit"); assert.match(result.reason, /等待用户审批/);
	assert.deepEqual(f.executed, []); assert.equal(judge.requests.length, 1); assert.equal(main.requests.length, 1);
	assert.equal(main.remaining, 1);
});

test("an allow with a fabricated authorization ID pauses without executing the action", async (t) => {
	const main = new ScriptedModelAdapter([reply([dangerous]), reply()]);
	const judge = new Judge((evidence) => judgeReply({ decision: "allow", authorization: [{ requestId: "forged-user", quote: evidence.userRequests[0]!.text }] }));
	const f = fixture(t, main, judge); const result = await f.agent.run("请删除 cache。");
	assert.equal(result.status, "limit"); assert.match(result.reason, /等待用户审批/);
	assert.deepEqual(f.executed, []); assert.equal(main.requests.length, 1); assert.equal(judge.requests.length, 1);
});

for (const failure of ["throws", "times-out"] as const) {
	test(`approval ${failure} never executes a tool and preserves unknown cost across a budget reload`, { timeout: 5000 }, async (t) => {
		const main = new ScriptedModelAdapter([reply([dangerous]), reply()]);
		const judge = new Judge(() => failure === "throws" ? Promise.reject(new Error("offline injected failure")) : new Promise<ModelResponse>(() => {}));
		const f = fixture(t, main, judge, { timeoutMs: 50 }); const started = Date.now();
		const result = await f.agent.run("请删除 cache。");
		assert.ok(Date.now() - started < 3000); assert.equal(result.status, "limit");
		assert.deepEqual(f.executed, []); assert.equal(main.requests.length, 1); assert.equal(judge.requests.length, 1);
		const snapshot = f.budget.snapshot({ runId: result.runId });
		assert.ok(snapshot.unknownCost > 0); assert.ok(result.totals.usagePartialRequests > 0);
		const reloaded = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: f.budget.ledgerPath });
		assert.deepEqual(reloaded.snapshot({ runId: result.runId }), snapshot);
		if (failure === "times-out") assert.equal(judge.requests[0]!.signal?.aborted, true);
	});
}

test("a partial usage report keeps the worst-case approval charge even when token fields contain numbers", async (t) => {
	const main = new ScriptedModelAdapter([reply([dangerous]), reply()]);
	const judge = new Judge((evidence) => judgeReply({ decision: "allow", authorization: [{ requestId: evidence.userRequests[0]!.id, quote: evidence.userRequests[0]!.text }] }, {
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 999, partial: true },
	}));
	const f = fixture(t, main, judge); const result = await f.agent.run("请删除 cache。");
	assert.equal(judge.requests.length, 1);
	assert.equal(result.status, "limit"); assert.equal(main.requests.length, 1); assert.deepEqual(f.executed, []);
	assert.ok(f.budget.snapshot({ runId: result.runId }).unknownCost > 0);
	assert.ok(result.totals.usagePartialRequests > 0);
});

test("approval budget exhaustion pauses before contacting the judge or executing a tool", async (t) => {
	const main = new ScriptedModelAdapter([reply([dangerous]), reply()]); const judge = new Judge();
	const f = fixture(t, main, judge, { maxCost: 0.000000001 }); const result = await f.agent.run("请删除 cache。");
	assert.equal(result.status, "limit"); assert.equal(judge.requests.length, 0); assert.deepEqual(f.executed, []);
});

for (const failure of ["throws", "missing-usage"] as const) {
	test(`main model ${failure} retains unknown cost and stops before approval or tool execution`, async (t) => {
		const requests: ModelRequest[] = [];
		const script = new ScriptedModelAdapter([{ ...reply([dangerous]), rawUsage: null }, reply()]);
		const main: ModelAdapter = {
			id: `main-${failure}`,
			async complete(request) {
				requests.push(request);
				if (failure === "throws") throw new Error("offline main transport failure");
				return script.complete(request);
			},
		};
		const judge = new Judge(); const f = fixture(t, main, judge);
		const result = await f.agent.run("请删除 cache。");
		assert.equal(result.status, "limit"); assert.match(result.reason, /用量不完整/);
		assert.equal(requests.length, 1); assert.equal(result.totals.requests, 1); assert.equal(result.totals.usagePartialRequests, 1);
		assert.equal(judge.requests.length, 0); assert.deepEqual(f.executed, []);
		assert.ok(result.totals.input > 0); assert.equal(result.totals.output, 64); assert.ok(result.totals.cost > 0);
		const snapshot = f.budget.snapshot({ runId: result.runId });
		assert.equal(snapshot.unknownCost, result.totals.cost); assert.equal(snapshot.spent, snapshot.unknownCost); assert.equal(snapshot.reserved, 0);
		const reloaded = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: f.budget.ledgerPath });
		assert.deepEqual(reloaded.snapshot({ runId: result.runId }), snapshot);
		const ledger = readFileSync(join(f.dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(ledger.length, 1); assert.equal(ledger[0].purpose, "agent-turn"); assert.equal(ledger[0].costPartial, true);
	});
}

test("a main-model bill above its reservation is retained and blocks every requested action", async (t) => {
	const excessive = { prompt_tokens: 1_000_000, completion_tokens: 10, total_tokens: 1_000_010, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1_000_000 };
	const main = new ScriptedModelAdapter([{ ...reply([dangerous]), rawUsage: excessive }, reply()]);
	const judge = new Judge(); const f = fixture(t, main, judge); const result = await f.agent.run("请删除 cache。");
	assert.equal(result.status, "limit"); assert.match(result.reason, /费用超出预留/);
	assert.equal(main.requests.length, 1); assert.equal(judge.requests.length, 0); assert.deepEqual(f.executed, []);
	const budgetRows = readFileSync(f.budget.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const reserve = budgetRows.find((row) => row.kind === "budget.reserve");
	const settle = budgetRows.find((row) => row.kind === "budget.settle");
	assert.ok(reserve && settle); assert.equal(settle.overrun, true); assert.equal(settle.partial, false);
	assert.ok(settle.amount > reserve.worstCost); assert.equal(settle.amount, result.totals.cost);
	const snapshot = f.budget.snapshot({ runId: result.runId }); assert.equal(snapshot.spent, settle.amount);
	const reloaded = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: f.budget.ledgerPath });
	assert.deepEqual(reloaded.snapshot({ runId: result.runId }), snapshot);
	assert.throws(() => reloaded.check(0, 1), /超过预留上界/);
	const ledger = readFileSync(join(f.dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(ledger.length, 1); assert.equal(ledger[0].cost, settle.amount);
});

test("restarting a recorded run ID cannot reset its request count or spend", async (t) => {
	const firstMain = new ScriptedModelAdapter([reply()]); const judge = new Judge();
	const f = fixture(t, firstMain, judge, {}, { runId: "same-funded-run" });
	const first = await f.agent.run("只回答本地测试完成。");
	assert.equal(first.status, "completed");
	const before = f.budget.snapshot({ runId: first.runId }); assert.equal(before.requests, 1);
	const budgetBytes = readFileSync(f.budget.ledgerPath, "utf8");
	const restartedMain = new ScriptedModelAdapter([reply([dangerous]), reply()]);
	const restartedBudget = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: f.budget.ledgerPath });
	const restarted = new AgentSession({ ...f.agent.options, adapter: restartedMain, budget: restartedBudget, dataDir: join(f.dataDir, "restart"), runId: first.runId });
	const result = await restarted.run("请删除 cache。");
	assert.equal(result.status, "limit"); assert.match(result.reason, /已有记录/);
	assert.equal(result.turns, 0); assert.equal(result.totals.requests, 0);
	assert.equal(restartedMain.requests.length, 0); assert.equal(judge.requests.length, 0); assert.deepEqual(f.executed, []);
	assert.deepEqual(restartedBudget.snapshot({ runId: first.runId }), before);
	assert.equal(readFileSync(f.budget.ledgerPath, "utf8"), budgetBytes);
});

for (const bound of ["input", "output"] as const) {
	test(`an insufficient initial ${bound} limit stops before any main or approval request`, async (t) => {
		const main = new ScriptedModelAdapter([reply([dangerous])]); const judge = new Judge();
		const limits = { maxTurns: 8, maxRequests: 8, maxCost: 1, ...(bound === "input" ? { maxInputTokens: 1 } : { maxOutputTokens: 63 }) };
		const f = fixture(t, main, judge, {}, { limits }); const result = await f.agent.run("请删除 cache。");
		assert.equal(result.status, "limit"); assert.match(result.reason, /下一次模型请求会超过任务 token 上限/);
		assert.equal(main.requests.length, 0); assert.equal(judge.requests.length, 0); assert.deepEqual(f.executed, []);
		assert.equal(f.budget.snapshot({ runId: result.runId }).requests, 0);
	});
}

test("approval output tokens count before the next main request is allowed", async (t) => {
	const main = new ScriptedModelAdapter([reply([dangerous]), reply()]); const judge = new Judge();
	const f = fixture(t, main, judge, {}, { limits: { maxTurns: 8, maxRequests: 8, maxCost: 1, maxOutputTokens: 83 } });
	const result = await f.agent.run("请删除 cache。");
	// Main output 10 + approval output 10 + next output reservation 64 exceeds 83.
	assert.equal(result.status, "limit"); assert.match(result.reason, /下一次模型请求会超过任务 token 上限/);
	assert.equal(main.requests.length, 1); assert.equal(judge.requests.length, 1); assert.equal(result.totals.output, 20);
	assert.equal(result.totals.requests, 2); assert.deepEqual(f.executed, ["command_run"]);
	assert.equal(f.budget.snapshot({ runId: result.runId }).requests, 2);
});

test("approval input tokens count before the next main request, even when main-only consumption would fit", async (t) => {
	const task = "请删除 cache。";
	const controlMain = new ScriptedModelAdapter([reply([dangerous]), reply()]); const controlJudge = new Judge();
	const control = fixture(t, controlMain, controlJudge); assert.equal((await control.agent.run(task)).status, "completed");
	const mainBound = (request: ModelRequest) => Buffer.byteLength(JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages }), "utf8") + 4096;
	const firstBound = mainBound(controlMain.requests[0]!); const secondBound = mainBound(controlMain.requests[1]!);
	const approvalRequest = controlJudge.requests[0]!;
	const approvalBound = Buffer.byteLength(approvalRequest.system + JSON.stringify(approvalRequest.messages), "utf8") + 4096;
	const limit = Math.max(firstBound, 100 + approvalBound, 100 + secondBound);
	assert.ok(limit < 200 + secondBound, "fixture must allow initial main and approval preflight, but not both consumed inputs plus the next main request");
	const main = new ScriptedModelAdapter([reply([dangerous]), reply()]); const judge = new Judge();
	const f = fixture(t, main, judge, {}, { limits: { maxTurns: 8, maxRequests: 8, maxCost: 1, maxInputTokens: limit } });
	const result = await f.agent.run(task);
	assert.equal(result.status, "limit"); assert.match(result.reason, /下一次模型请求会超过任务 token 上限/);
	assert.equal(main.requests.length, 1); assert.equal(judge.requests.length, 1); assert.equal(result.totals.input, 200);
	assert.equal(result.totals.requests, 2); assert.deepEqual(f.executed, ["command_run"]);
	assert.equal(f.budget.snapshot({ runId: result.runId }).requests, 2);
});

test("a manually approved read pauses an all-read-only batch before a later ordinary read can run", async (t) => {
	const main = new ScriptedModelAdapter([reply([
		{ id: "manual-read", name: "file_read", args: { path: "a.txt" } },
		{ id: "ordinary-glob", name: "query_plan", args: { steps: [{ id: "files", op: "glob", patterns: ["*.txt"] }] } },
	]), reply()]);
	const judge = new Judge(); const f = fixture(t, main, judge, { manualTools: ["file_read"] });
	const result = await f.agent.run("查看文件内容并列出文本文件。");
	assert.equal(result.status, "limit"); assert.match(result.reason, /等待用户审批.*用户亲自审批/);
	assert.equal(main.requests.length, 1); assert.equal(judge.requests.length, 0); assert.deepEqual(f.executed, []);
	const completed = f.events.filter((event) => event.type === "tool.completed");
	assert.deepEqual(completed.map((event) => event.toolCallId), ["manual-read", "ordinary-glob"]);
	assert.ok(completed.every((event) => !event.ok));
	for (const event of completed) assert.equal((event.details as { decision?: unknown }).decision, "ask");
});
