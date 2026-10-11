import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent, ModelBillingReceipt, Usage } from "@mountains/protocol";
import { ChatCompletionsAdapter, type ModelAdapter, type ModelResponse, type RawUsage, pricingFor } from "@mountains/providers";
import { generalTools } from "@mountains/tools";
import { AgentSession, type RunLimits } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";

const router = "openai/gpt-4.1-mini";
const free = "Qwen/Qwen2.5-7B-Instruct";
const official = { [router]: "https://openrouter.ai/api/v1", [free]: "https://api.siliconflow.cn/v1" };
const aggregate: RawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
const cached: RawUsage = { ...aggregate, prompt_tokens_details: { cached_tokens: 20 } };
type Round = { responseModel: string | null; read?: boolean; rawUsage: RawUsage | null };
type FixtureOptions = { baseUrl?: string; limits?: Partial<RunLimits>; transform?: (response: ModelResponse) => ModelResponse };

// Only HTTP replies are faked. Official-URL validation, SSE parsing, accounting,
// file_read, disk journals and restoring the budget journal all execute normally.
function fixture(t: TestContext, model: typeof router | typeof free, rounds: Round[], options: FixtureOptions = {}) {
	const base = mkdtempSync(join(tmpdir(), "mountains-billing-receipt-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	writeFileSync(join(workspace, "a.txt"), "REAL_FILE_READ_WITH_KNOWN_FEE\n");
	const bodies: Record<string, unknown>[] = [];
	const responses: ModelResponse[] = [];
	let index = 0;
	const baseUrl = options.baseUrl ?? official[model];
	const fakeFetch: typeof globalThis.fetch = async (input, init) => {
		assert.equal(String(input), `${baseUrl.replace(/\/$/, "")}/chat/completions`);
		assert.equal(typeof init?.body, "string");
		bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
		const round = rounds[index++]; assert.ok(round, "offline HTTP response script exhausted");
		const delta = round.read ? { role: "assistant", tool_calls: [{ index: 0, id: "read-a", type: "function",
			function: { name: "file_read", arguments: JSON.stringify({ path: "a.txt" }) } }] }
			: { role: "assistant", content: "Read complete." };
		const frames = [{ choices: [{ index: 0, delta, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: round.read ? "tool_calls" : "stop" }],
				...(round.rawUsage === null ? {} : { usage: round.rawUsage }) }];
		const text = frames.map(frame => `data: ${JSON.stringify({ id: `offline-${index}`, object: "chat.completion.chunk",
			...(round.responseModel === null ? {} : { model: round.responseModel }), ...frame })}\n\n`).join("") + "data: [DONE]\n\n";
		return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const httpAdapter = new ChatCompletionsAdapter({ baseUrl, apiKey: "OFFLINE_FAKE_KEY", fetch: fakeFetch });
	const adapter: ModelAdapter = { id: "offline-official-receipt-test", complete: async (request, handlers) => {
		const response = await httpAdapter.complete(request, handlers);
		responses.push(response);
		return options.transform?.(response) ?? response;
	} };
	const currency = pricingFor(model)!.currency;
	const budget = new BudgetGuard({ globalLimit: 10, currency, ledgerPath: join(base, "spend.jsonl") });
	const dataDir = join(base, "data");
	const events: EngineEvent[] = [];
	const agent = new AgentSession({ workspace, dataDir, adapter, model, requestGuard: true, billingCurrency: currency,
		thinking: { enabled: false, effort: "default" },
		tools: generalTools().filter(tool => tool.name === "file_read" || tool.name === "context_expand"), maxTokens: 64, budget, checkpoints: false,
		retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 3, maxRequests: 3, maxCost: 10, ...options.limits },
		onEvent: event => events.push(event) });
	const ledger = () => readFileSync(join(dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {
		model: string | null; cost: number; costPartial: boolean; costEstimated: boolean; usage: Usage; rawUsage: RawUsage | null;
	});
	const usageEvents = () => events.filter(event => event.type === "usage");
	const restored = () => new BudgetGuard({ globalLimit: 10, currency, ledgerPath: budget.ledgerPath });
	return { agent, budget, bodies, responses, events, ledger, usageEvents, restored };
}

for (const [model, responseModel, amounts] of [
	[router, "openai/gpt-4.1-mini-2025-04-14", [0.000071, 0.000092]],
	[free, free, [0, 0]],
] as const) {
	test(`${model}: official aggregate usage completes two rounds without inventing cache details`, async t => {
		const f = fixture(t, model, amounts.map((amount, index) => ({ responseModel, read: index === 0,
			rawUsage: { ...aggregate, ...(model === router ? { cost: amount } : {}) } })));
		const result = await f.agent.run("Read a.txt and report its contents.");
		assert.equal(result.status, "completed", result.reason);
		assert.equal(f.bodies.length, 2);
		assert.ok(JSON.stringify(f.bodies[1]).includes("REAL_FILE_READ_WITH_KNOWN_FEE"));
		assert.ok(f.events.some(event => event.type === "tool.completed" && event.ok && event.tool === "file_read"));
		assert.equal(result.totals.input, 200);
		assert.equal(result.totals.cacheRead, 0);
		assert.equal(result.totals.output, 20);
		assert.equal(result.totals.usagePartialRequests, 2, "missing cache details remain partial usage, despite known fees");
		assert.ok(Math.abs(result.totals.cost - amounts.reduce<number>((sum, amount) => sum + amount, 0)) < 1e-12);
		const saved = f.budget.snapshot({ runId: result.runId });
		assert.equal(saved.unknownCost, 0); assert.equal(saved.spent, result.totals.cost); assert.equal(saved.reserved, 0);
		assert.deepEqual(f.restored().snapshot({ runId: result.runId }), saved);
		assert.equal(f.usageEvents().length, 2);
		for (const [index, event] of f.usageEvents().entries()) {
			assert.equal(event.cost, amounts[index]); assert.equal(event.costEstimated, false);
			assert.equal(event.model, responseModel); assert.equal(event.billingReceipt?.model, model);
			assert.equal(event.billingReceipt?.inputTokens, 100); assert.equal(event.billingReceipt?.outputTokens, 10);
			assert.equal(event.billingReceiptRejected, undefined);
			assert.equal(event.usage.input, null); assert.equal(event.usage.cacheRead, null); assert.equal(event.usage.partial, true);
		}
		for (const [index, row] of f.ledger().entries()) {
			assert.equal(row.cost, amounts[index]); assert.equal(row.costPartial, false);
			assert.equal(row.costEstimated, true, "the legacy ledger schema stays unchanged");
			assert.equal(row.usage.cacheRead, null); assert.equal(row.usage.partial, true);
		}
	});
}

test("OpenRouter actual invoice overrides catalog price even with complete cache statistics", async t => {
	const f = fixture(t, router, [{ responseModel: router, read: true, rawUsage: { ...cached, cost: 0.000071 } },
		{ responseModel: router, rawUsage: { ...cached, cost: 0.000092 } }]);
	const result = await f.agent.run("Read a.txt.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.input, 160); assert.equal(result.totals.cacheRead, 40);
	assert.equal(result.totals.output, 20); assert.equal(result.totals.usagePartialRequests, 0);
	assert.ok(Math.abs(result.totals.cost - 0.000163) < 1e-12);
	assert.ok(f.usageEvents().every(event => event.costEstimated === false && event.billingReceipt));
});

for (const [label, rawUsage, limits, expectedInput, expectedOutput] of [
	["input", { prompt_tokens: 200000, completion_tokens: 10, total_tokens: 200010 }, { maxInputTokens: 100000 }, 200000, 10],
	["output", { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 }, { maxOutputTokens: 100 }, 100, 500],
] as const) {
	test(`free official aggregate ${label} count still enforces token limits before tools`, async t => {
		const f = fixture(t, free, [{ responseModel: free, read: true, rawUsage }], { limits });
		const result = await f.agent.run("Read a.txt.");
		assert.equal(result.status, "limit"); assert.equal(f.bodies.length, 1);
		assert.equal(result.totals.input, expectedInput); assert.equal(result.totals.output, expectedOutput);
		assert.equal(result.totals.cost, 0); assert.equal(f.budget.snapshot({ runId: result.runId }).unknownCost, 0);
		assert.equal(f.events.some(event => event.type === "tool.completed"), false);
	});
}

for (const [model, label, responseModel, rawUsage] of [
	[router, "wrong upstream route", "gpt-4.1-mini-2025-04-14", { ...cached, cost: 0.000071 }],
	[router, "missing model", null, { ...cached, cost: 0.000071 }],
	[router, "wrong aggregate", router, { ...cached, total_tokens: 111, cost: 0.000071 }],
	[router, "negative cache", router, { ...aggregate, prompt_tokens_details: { cached_tokens: -1 }, cost: 0.000071 }],
	[router, "oversized cache", router, { ...aggregate, prompt_tokens_details: { cached_tokens: 101 }, cost: 0.000071 }],
	[router, "negative invoice", router, { ...cached, cost: -1 }],
	[router, "missing usage", router, null],
	[free, "wrong paid model", "Pro/Qwen/Qwen2.5-7B-Instruct", cached],
	[free, "contradictory mixed cache fields", free, { prompt_tokens: 64, completion_tokens: 4, total_tokens: 68, prompt_cache_miss_tokens: 64, prompt_tokens_details: { cached_tokens: 1 } }],
	[free, "nonzero invoice", free, { ...cached, cost: 0.5 }],
	[free, "missing usage", free, null],
] as const) {
	test(`${model}: ${label} keeps cost unknown and stops before the real file tool`, async t => {
		const f = fixture(t, model, [{ responseModel, read: true, rawUsage }]);
		const result = await f.agent.run("Read a.txt.");
		assert.equal(result.status, "limit"); assert.equal(f.bodies.length, 1);
		assert.equal(result.totals.usagePartialRequests, 1);
		assert.equal(f.events.some(event => event.type === "tool.completed"), false);
		assert.equal(f.responses[0]!.billingReceipt, undefined); assert.equal(f.responses[0]!.billingReceiptRejected, true);
		const event = f.usageEvents()[0]!;
		assert.equal(event.cost, null); assert.equal(event.billingReceiptRejected, true); assert.equal(event.billingReceipt, undefined);
		assert.equal(f.ledger()[0]!.costPartial, true);
		const saved = f.budget.snapshot({ runId: result.runId });
		assert.equal(saved.unknownCost, result.totals.cost); assert.equal(saved.spent, result.totals.cost);
		assert.deepEqual(f.restored().snapshot({ runId: result.runId }), saved);
	});
}

test("OpenRouter missing actual cost and missing cache details cannot obtain a receipt", async t => {
	const f = fixture(t, router, [{ responseModel: router, read: true, rawUsage: aggregate }]);
	const result = await f.agent.run("Read a.txt.");
	assert.equal(result.status, "limit"); assert.equal(f.bodies.length, 1);
	assert.equal(f.responses[0]!.billingReceipt, undefined); assert.equal(f.ledger()[0]!.costPartial, true);
	assert.equal(f.events.some(event => event.type === "tool.completed"), false);
});

test("OpenRouter missing actual cost keeps its prior conservative catalog estimate when cache usage is complete", async t => {
	const f = fixture(t, router, [{ responseModel: router, read: true, rawUsage: cached }, { responseModel: router, rawUsage: cached }]);
	const result = await f.agent.run("Read a.txt.");
	assert.equal(result.status, "completed", result.reason); assert.equal(result.totals.usagePartialRequests, 0);
	assert.ok(Math.abs(result.totals.cost - 0.00011) < 1e-12);
	assert.ok(f.usageEvents().every(event => !event.billingReceipt && event.costEstimated));
});

for (const model of [router, free] as const) {
	test(`${model}: custom endpoint cannot mint an official receipt`, async t => {
		const f = fixture(t, model, [{ responseModel: model, read: true, rawUsage: { ...aggregate, ...(model === router ? { cost: 0.000071 } : {}) } }],
			{ baseUrl: "https://example.invalid/v1" });
		const result = await f.agent.run("Read a.txt.");
		assert.equal(result.status, "limit"); assert.equal(f.responses[0]!.billingReceipt, undefined);
		assert.equal(f.usageEvents()[0]!.billingReceipt, undefined); assert.equal(f.ledger()[0]!.costPartial, true);
		assert.equal(f.events.some(event => event.type === "tool.completed"), false);
	});
}

for (const [label, patch] of [
	["wrong endpoint", { endpoint: "https://example.invalid/v1" }],
	["different amount", { amount: 0 }],
	["different currency", { currency: "CNY" }],
	["different input total", { inputTokens: 99 }],
] as const) {
	test(`OpenRouter: attached receipt with ${label} cannot fall back to a complete-cache estimate`, async t => {
		const f = fixture(t, router, [{ responseModel: router, read: true, rawUsage: { ...cached, cost: 0.000071 } }],
			{ transform: response => ({ ...response, billingReceipt: { ...response.billingReceipt!, ...patch } as ModelBillingReceipt }) });
		const result = await f.agent.run("Read a.txt.");
		assert.equal(result.status, "limit"); assert.equal(f.bodies.length, 1);
		assert.equal(f.usageEvents()[0]!.cost, null); assert.equal(f.usageEvents()[0]!.billingReceiptRejected, true);
		assert.equal(f.ledger()[0]!.costPartial, true); assert.ok(f.budget.snapshot({ runId: result.runId }).unknownCost > 0);
		assert.equal(f.events.some(event => event.type === "tool.completed"), false);
	});
}

test("OpenRouter actual cost above its reservation is retained and emitted before stopping", async t => {
	const f = fixture(t, router, [{ responseModel: router, read: true, rawUsage: { ...aggregate, cost: 2 } }]);
	const result = await f.agent.run("Read a.txt.");
	assert.equal(result.status, "limit"); assert.equal(f.bodies.length, 1);
	assert.equal(result.totals.cost, 2); assert.equal(f.ledger()[0]!.cost, 2); assert.equal(f.ledger()[0]!.costPartial, false);
	assert.equal(f.usageEvents()[0]!.cost, 2); assert.equal(f.usageEvents()[0]!.costEstimated, false);
	assert.equal(f.events.some(event => event.type === "tool.completed"), false);
	const saved = f.budget.snapshot({ runId: result.runId });
	assert.equal(saved.spent, 2); assert.equal(saved.unknownCost, 0);
	assert.deepEqual(f.restored().snapshot({ runId: result.runId }), saved);
});
