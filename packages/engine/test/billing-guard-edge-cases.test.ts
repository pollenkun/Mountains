import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import { ChatCompletionsAdapter, currencyOf, normalizeUsage, PROVIDERS, type ModelAdapter, type ModelResponse, type RawUsage } from "@mountains/providers";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

const router = "openai/gpt-4.1-mini";
const free = "Qwen/Qwen2.5-7B-Instruct";
const raw: RawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
	prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } };
function sse(model: string, usage: RawUsage, status = 200): Response {
	return new Response(`data: ${JSON.stringify({ id: "offline", model,
		choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
		{ status, headers: { "content-type": "text/event-stream", "retry-after": "0" } });
}
function fixture(t: TestContext, adapter: ModelAdapter, model: string, currency = currencyOf(model)!) {
	const root = mkdtempSync(join(tmpdir(), "billing-guard-edge-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace); writeFileSync(join(workspace, "a.txt"), "local evidence\n");
	const budget = new BudgetGuard({ globalLimit: 10, currency, ledgerPath: join(root, "spend.jsonl") });
	const events: EngineEvent[] = [];
	const options: EngineOptions = { workspace, dataDir: join(root, "data"), adapter, model,
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, requestGuard: true, checkpoints: false, budget,
		limits: { maxCost: 5, maxInputTokens: 50_000 }, retry: { maxAttempts: 2, baseDelayMs: 0 }, onEvent: event => events.push(event) };
	const ledger = () => readFileSync(join(root, "data", "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	return { options, budget, events, ledger };
}

for (const model of [router, free]) {
	for (const status of [400, 401, 403, 429]) {
		test(`${model}: explicit HTTP ${status} without usage has no rejected invoice or conservative fee`, async t => {
			let calls = 0; const responses: ModelResponse[] = [];
			const http = new ChatCompletionsAdapter({ baseUrl: model === router ? PROVIDERS.openrouter.baseUrl : PROVIDERS.siliconflow.baseUrl,
				apiKey: "OFFLINE_FAKE_KEY", fetch: async () => ++calls === 1
					? Response.json({ error: { message: "Rejected request" } }, { status, headers: { "retry-after": "0" } })
					: sse(model, { ...raw, ...(model === router ? { cost: 0.00006 } : {}) }) });
			const adapter: ModelAdapter = { id: "offline-http", async complete(request, handlers) {
				const response = await http.complete(request, handlers); responses.push(response); return response;
			} };
			const f = fixture(t, adapter, model); const result = await new AgentSession(f.options).run("Say done.");
			assert.equal(responses[0]!.httpStatus, status); assert.equal(responses[0]!.rawUsage, null);
			assert.equal(responses[0]!.billingReceiptRejected, undefined); assert.equal(responses[0]!.billingReceipt, undefined);
			assert.equal(calls, status === 429 ? 2 : 1); assert.equal(result.status, status === 429 ? "completed" : "failed");
			assert.equal(result.totals.usagePartialRequests, 0);
			assert.equal(f.ledger()[0].cost, 0); assert.equal(f.ledger()[0].costPartial, false);
			const snapshot = f.budget.snapshot({ runId: result.runId });
			assert.equal(snapshot.unknownCost, 0); assert.equal(snapshot.reserved, 0); assert.equal(snapshot.spent, result.totals.cost);
		});
	}

	test(`${model}: HTTP 429 with contradictory nonempty usage still fails closed`, async t => {
		let calls = 0; let response: ModelResponse | undefined;
		const http = new ChatCompletionsAdapter({ baseUrl: model === router ? PROVIDERS.openrouter.baseUrl : PROVIDERS.siliconflow.baseUrl,
			apiKey: "OFFLINE_FAKE_KEY", fetch: async () => { calls++; return sse(model, { ...raw, total_tokens: 111, cost: 0 }, 429); } });
		const adapter: ModelAdapter = { id: "offline-http", async complete(request, handlers) {
			response = await http.complete(request, handlers); return response;
		} };
		const f = fixture(t, adapter, model); const result = await new AgentSession(f.options).run("Say done.");
		assert.equal(result.status, "limit"); assert.equal(calls, 1); assert.equal(response!.billingReceiptRejected, true);
		assert.equal(result.totals.usagePartialRequests, 1); assert.equal(f.ledger()[0].costPartial, true);
	});

	test(`${model}: JSON HTTP 429 retains contradictory invoice evidence`, async t => {
		let calls = 0; let response: ModelResponse | undefined;
		const http = new ChatCompletionsAdapter({ baseUrl: model === router ? PROVIDERS.openrouter.baseUrl : PROVIDERS.siliconflow.baseUrl,
			apiKey: "OFFLINE_FAKE_KEY", fetch: async () => {
				calls++; return new Response(JSON.stringify({ model, error: { message: "Rejected" }, usage: { ...raw, total_tokens: 111, cost: 0 } }, null, 2),
					{ status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
			} });
		const adapter: ModelAdapter = { id: "offline-json-http", async complete(request, handlers) {
			response = await http.complete(request, handlers); return response;
		} };
		const f = fixture(t, adapter, model); const result = await new AgentSession(f.options).run("Say done.");
		assert.equal(result.status, "limit"); assert.equal(calls, 1); assert.equal(response!.billingReceiptRejected, true);
		assert.equal(response!.rawUsage?.total_tokens, 111); assert.equal(f.ledger()[0].costPartial, true);
	});
}

test("an HTTP rejection with redirected transport remains a rejected billing identity", async t => {
	const http = new ChatCompletionsAdapter({ baseUrl: PROVIDERS.openrouter.baseUrl, apiKey: "OFFLINE_FAKE_KEY", fetch: async () => {
		const response = Response.json({ error: { message: "Rejected" } }, { status: 429 });
		Object.defineProperty(response, "redirected", { value: true }); return response;
	} });
	const f = fixture(t, http, router); const result = await new AgentSession(f.options).run("Say done.");
	assert.equal(result.status, "limit"); assert.equal(result.totals.requests, 1); assert.equal(f.ledger()[0].costPartial, true);
});

test("contradictory DeepSeek prompt aggregates cannot release a reservation or execute tools", async t => {
	const usage = { ...raw, prompt_tokens: 1_000_000 };
	const response: RecordedResponse = { ok: true, message: { role: "assistant", content: "", reasoning: "",
		toolCalls: [{ id: "read", name: "file_read", argumentsJson: '{"path":"a.txt"}' }] }, finishReason: "tool_calls",
		responseModel: "deepseek-flash", rawUsage: usage, httpStatus: 200, error: null, aborted: false };
	const adapter = new ScriptedModelAdapter([response]);
	const f = fixture(t, adapter, "deepseek-flash"); const result = await new AgentSession(f.options).run("Read a.txt.");
	assert.equal(normalizeUsage("deepseek", usage).partial, true);
	assert.equal(normalizeUsage("siliconflow", usage).partial, true);
	assert.equal(result.status, "limit"); assert.equal(adapter.requests.length, 1); assert.equal(result.totals.usagePartialRequests, 1);
	assert.equal(f.events.some(event => event.type === "tool.completed"), false);
	const snapshot = f.budget.snapshot({ runId: result.runId });
	assert.ok(snapshot.unknownCost > 0); assert.equal(snapshot.spent, snapshot.unknownCost); assert.equal(snapshot.spent, result.totals.cost);
	assert.equal(f.ledger()[0].costPartial, true);
});

for (const [model, currency] of [["kimi-k2.7-code", "USD"], ["glm-5.3-flash", "USD"], ["qwen-plus", "USD"], [free, "USD"], ["deepseek-flash", "CNY"]] as const) {
	test(`${model}: omitted billingCurrency still rejects a ${currency} budget before dispatch`, t => {
		const adapter = new ScriptedModelAdapter([]); const f = fixture(t, adapter, model, currency);
		assert.throws(() => new AgentSession(f.options), /币种一致/);
		assert.equal(adapter.requests.length, 0); assert.equal(f.budget.globalSpent, 0);
	});
}
