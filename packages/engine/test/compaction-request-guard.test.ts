import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import type { ModelRequest, ModelResponse, ModelStreamHandlers } from "@mountains/providers";
import { AgentSession, BudgetGuard, COMPACTION_REQUEST, ScriptedModelAdapter, type RecordedResponse, type RunLimits } from "../src/index.ts";

const big = (tag: string, count: number) => Array.from({ length: count }, (_, i) =>
	`${tag} line ${i}: inventory record ${i * 7919 % 1000003} checked, no action needed`).join("\n") + "\n";
function reply(path?: string): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: path ? "" : "Read complete.", reasoning: "",
		toolCalls: path ? [{ id: `read-${path}`, name: "file_read", argumentsJson: JSON.stringify({ path }) }] : [] },
		finishReason: path ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens: 12, total_tokens: 132 },
		httpStatus: 200, error: null, aborted: false };
}
class CompactionScript extends ScriptedModelAdapter {
	private readonly queue: RecordedResponse[];
	readonly summary: RecordedResponse;
	constructor(summary: RecordedResponse) {
		const queue: RecordedResponse[] = [];
		super(queue); this.queue = queue; this.summary = summary;
	}
	override async complete(request: ModelRequest, handlers?: ModelStreamHandlers): Promise<ModelResponse> {
		assert.ok(this.requests.length < 4, "unexpected extra paid request");
		this.queue.push(request.messages.at(-1)?.content === COMPACTION_REQUEST ? this.summary
			: this.requests.length === 0 ? reply("a.txt") : this.requests.length === 1 ? reply("b.txt") : reply());
		return super.complete(request, handlers);
	}
}
function fixture(t: TestContext, limits: Partial<RunLimits> = {}, summary = reply()) {
	const root = mkdtempSync(join(tmpdir(), "compaction-request-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	writeFileSync(join(workspace, "a.txt"), big("alpha", 1200));
	writeFileSync(join(workspace, "b.txt"), big("bravo", 300));
	const adapter = new CompactionScript(summary);
	const budget = new BudgetGuard({ globalLimit: 100, ledgerPath: join(root, "spend.jsonl") });
	const dataDir = join(root, "data"); const events: EngineEvent[] = [];
	const agent = new AgentSession({ workspace, dataDir, adapter, model: "deepseek-flash",
		thinking: { enabled: false, effort: "default" }, maxTokens: 32_000, checkpoints: false, requestGuard: true, budget,
		retry: { maxAttempts: 1, baseDelayMs: 0 },
		limits: { maxTurns: 20, maxRequests: 20, maxCost: 10, maxInputTokens: 20_000_000, maxOutputTokens: 1_000_000, ...limits },
		contextPolicy: { triggerTokens: 6_000, hardLimitTokens: 400_000, compactTokens: 52_000,
			compactTailTokens: 3_000, minBatchTokens: 1_000, settledUserTurns: 2 }, onEvent: event => events.push(event) });
	const records = () => readFileSync(join(dataDir, "recording.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const ledger = () => readFileSync(join(dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const summaries = () => adapter.requests.filter(request => request.messages.at(-1)?.content === COMPACTION_REQUEST);
	return { agent, adapter, budget, records, ledger, summaries, events };
}

test("automatic compaction cannot send a request after the run request allowance is exhausted", async t => {
	const f = fixture(t, { maxRequests: 2 });
	const result = await f.agent.run("Read both files.");
	assert.equal(result.status, "limit"); assert.equal(result.totals.requests, 2);
	assert.equal(f.adapter.requests.length, 2); assert.equal(f.summaries().length, 0);
	assert.ok(f.records().some(row => row.kind === "context.compaction-request" && row.data.sent === false && row.data.reason === "request-limit"));
	assert.equal(f.budget.snapshot({ runId: result.runId }).requests, 2);
});

test("automatic compaction preflights its own input bound and can fall back to the program record", async t => {
	const f = fixture(t, { maxInputTokens: 110_000 });
	const result = await f.agent.run("Read both files.");
	assert.equal(result.status, "completed", result.reason); assert.equal(f.adapter.requests.length, 3);
	assert.equal(f.summaries().length, 0);
	assert.ok(f.records().some(row => row.kind === "context.compaction-request" && row.data.sent === false && row.data.reason === "token-limit"));
	assert.ok(f.adapter.requests.at(-1)!.messages.some(message => message.content.includes("program record")));
});

test("automatic compaction cannot reserve another output allowance beyond the run token limit", async t => {
	const f = fixture(t, { maxOutputTokens: 32_012 });
	const result = await f.agent.run("Read both files.");
	assert.equal(result.status, "limit"); assert.equal(f.adapter.requests.length, 2);
	assert.equal(f.summaries().length, 0);
	assert.ok(f.records().some(row => row.kind === "context.compaction-request" && row.data.sent === false && row.data.reason === "token-limit"));
});

test("unknown guarded compaction usage is charged and stops the run before another paid request", async t => {
	const f = fixture(t, {}, { ...reply(), rawUsage: null });
	const result = await f.agent.run("Read both files.");
	assert.equal(result.status, "limit"); assert.match(result.reason, /压缩请求用量不完整/);
	assert.equal(f.adapter.requests.length, 3); assert.equal(f.summaries().length, 1);
	assert.equal(result.totals.usagePartialRequests, 1);
	const snapshot = f.budget.snapshot({ runId: result.runId });
	assert.ok(snapshot.unknownCost > 0); assert.equal(snapshot.reserved, 0); assert.equal(snapshot.spent, result.totals.cost);
	assert.equal(f.ledger().at(-1).purpose, "compaction"); assert.equal(f.ledger().at(-1).costPartial, true);
});

test("guarded compaction overrun is retained and ends with a limit summary", async t => {
	const f = fixture(t, {}, { ...reply(), rawUsage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100,
		prompt_cache_miss_tokens: 20, completion_tokens: 1_000_000, total_tokens: 1_000_120 } });
	const result = await f.agent.run("Read both files.");
	assert.equal(result.status, "limit"); assert.match(result.reason, /费用超出预留/);
	assert.equal(f.adapter.requests.length, 3); assert.equal(f.summaries().length, 1);
	assert.equal(f.budget.snapshot({ runId: result.runId }).spent, result.totals.cost);
	assert.throws(() => f.budget.reserve({ runId: "later", requestId: "later", amount: 0 }, 10), /超过预留/);
});

test("successful compaction has the same purpose in request events and the persisted usage ledger", async t => {
	const f = fixture(t);
	const result = await f.agent.run("Read both files.");
	assert.equal(result.status, "completed", result.reason); assert.equal(f.adapter.requests.length, 4);
	assert.equal(f.summaries().length, 1);
	const purposes = ["agent-turn", "agent-turn", "compaction", "agent-turn"];
	assert.deepEqual(f.events.filter(event => event.type === "model.request").map(event => event.purpose), purposes);
	assert.deepEqual(f.ledger().map(row => row.purpose), purposes);
	assert.equal(f.budget.snapshot({ runId: result.runId }).spent, result.totals.cost);
});
