import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, ModelBillingReceipt } from "@mountains/protocol";
import { ChatCompletionsAdapter, normalizeUsage, PROVIDERS, verifiedBillingReceipt, type ModelResponse, type RawUsage } from "../src/index.ts";

const router = "openai/gpt-4.1-mini";
const free = "Qwen/Qwen2.5-7B-Instruct";
const aggregate = { prompt_tokens: 64, completion_tokens: 4, total_tokens: 68 };

function response(model: string, raw: RawUsage, tool = false): Response {
	const content = tool ? { tool_calls: [{ index: 0, id: "read_1", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } }] } : { content: "done" };
	return new Response([
		{ id: "fake", model, choices: [{ index: 0, delta: { role: "assistant", ...content }, finish_reason: null }] },
		{ id: "fake", model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
		{ id: "fake", model, choices: [], usage: raw },
	].map(v => `data: ${JSON.stringify(v)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

function adapter(model: string, raw: RawUsage, endpoint?: string, returnedModel = model): ChatCompletionsAdapter {
	return new ChatCompletionsAdapter({ baseUrl: endpoint ?? (model === router ? PROVIDERS.openrouter.baseUrl : PROVIDERS.siliconflow.baseUrl), apiKey: "fake-key", fetch: async () => response(returnedModel, raw) });
}

function complete(a: ChatCompletionsAdapter, model: string): Promise<ModelResponse> {
	return a.complete({ model, system: "sys", tools: [], messages: [{ role: "user", content: "hi" }], thinking: { enabled: false, effort: "default" }, maxTokens: 64 });
}

for (const model of [router, free]) test(`${model}: two tool turns keep cache unknown but carry verified official fees`, async () => {
	let calls = 0;
	const endpoint = model === router ? PROVIDERS.openrouter.baseUrl : PROVIDERS.siliconflow.baseUrl;
	const currency = model === router ? "USD" : "CNY";
	const raw: RawUsage = { ...aggregate, ...(model === router ? { cost: 0.0123 } : {}) };
	const a = new ChatCompletionsAdapter({ baseUrl: endpoint, apiKey: "fake-key", fetch: async () => response(model, raw, ++calls === 1) });
	const history: Message[] = [{ role: "user", content: "read" }];
	const req = { model, system: "sys", tools: [{ name: "file_read", description: "read", parameters: { type: "object" } }], messages: history, thinking: { enabled: false, effort: "default" as const }, maxTokens: 64 };
	const first = await a.complete(req);
	const second = await a.complete({ ...req, messages: [...history, first.message, { role: "tool", toolCallId: "read_1", name: "file_read", content: "text" }] });
	assert.equal(calls, 2);
	assert.equal(first.message.toolCalls.length, 1);
	assert.equal(second.message.content, "done");
	for (const result of [first, second]) {
		assert.equal(result.ok, true, result.error?.message);
		assert.deepEqual([result.usage.input, result.usage.cacheRead, result.usage.cacheWrite, result.usage.partial], [null, null, null, true]);
		assert.equal(result.billingReceiptRejected, undefined);
		const receipt = verifiedBillingReceipt(model, result.rawUsage, result.usage, result.billingReceipt, currency);
		assert.equal(receipt?.amount, model === router ? raw.cost : 0);
		assert.equal(receipt?.inputTokens, 64);
		assert.equal(receipt?.outputTokens, 4);
		assert.equal(receipt?.totalTokens, 68);
		assert.equal(Object.isFrozen(receipt), true);
		assert.equal(result.usage.cacheRead, null, "verification must not manufacture cache statistics");
	}
});

test("OpenRouter complete cache statistics also use the response's actual USD cost", async () => {
	const raw = { ...aggregate, cost: 0.021, prompt_tokens_details: { cached_tokens: 32 } };
	const r = await complete(adapter(router, raw, undefined, "openai/gpt-4.1-mini-2025-04-14"), router);
	assert.equal(r.usage.partial, false);
	assert.equal(r.billingReceipt?.amount, 0.021);
	assert.equal(verifiedBillingReceipt(router, r.rawUsage, r.usage, r.billingReceipt, "USD")?.amount, 0.021);
	assert.equal(verifiedBillingReceipt(router, r.rawUsage, r.usage, r.billingReceipt, "CNY"), null);
});

test("official OpenRouter without cost cannot invent a receipt; complete standard usage remains available", async () => {
	const missing = await complete(adapter(router, aggregate), router);
	assert.equal(missing.billingReceipt, undefined);
	assert.equal(missing.billingReceiptRejected, undefined);
	assert.equal(missing.usage.partial, true);
	const completeUsage = await complete(adapter(router, { ...aggregate, prompt_tokens_details: { cached_tokens: 0 } }), router);
	assert.equal(completeUsage.billingReceipt, undefined);
	assert.equal(completeUsage.billingReceiptRejected, undefined);
	assert.equal(completeUsage.usage.partial, false);
});

for (const endpoint of ["https://proxy.example/v1", "https://api.siliconflow.com/v1", "https://openrouter.ai/api/v1?proxy=1", "https://openrouter.ai/api/v1/extra", "https://user:secret@openrouter.ai/api/v1"]) test(`custom or regional endpoint does not acquire an official fee receipt: ${endpoint}`, async () => {
	for (const model of [router, free]) {
		const r = await complete(adapter(model, { ...aggregate, cost: 0 }, endpoint), model);
		assert.equal(r.billingReceipt, undefined);
		assert.equal(r.billingReceiptRejected, undefined);
	}
});

for (const [name, raw] of [
	["missing aggregate", { prompt_tokens: 64, completion_tokens: 4 }],
	["wrong aggregate sum", { ...aggregate, total_tokens: 69 }],
	["negative cache", { ...aggregate, prompt_tokens_details: { cached_tokens: -1 } }],
	["cache exceeds input", { ...aggregate, prompt_tokens_details: { cached_tokens: 65 } }],
	["fractional cache", { ...aggregate, prompt_tokens_details: { cached_tokens: 0.5 } }],
	["conflicting hit and cache", { ...aggregate, prompt_cache_hit_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } }],
	["conflicting native hit and top-level cache", { ...aggregate, prompt_cache_hit_tokens: 1, cached_tokens: 2 }],
	["conflicting hit and miss", { ...aggregate, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 64 }],
	["conflicting standard cache and native miss", { ...aggregate, prompt_cache_miss_tokens: 60, prompt_tokens_details: { cached_tokens: 8 } }],
	["cache and write exceed input", { ...aggregate, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 } }],
	["negative reasoning", { ...aggregate, completion_tokens_details: { reasoning_tokens: -1 } }],
	["reasoning exceeds output", { ...aggregate, completion_tokens_details: { reasoning_tokens: 5 } }],
] as const) test(`${name}: even a finite cost cannot override a contradictory official usage record`, async () => {
	for (const model of [router, free]) {
		const r = await complete(adapter(model, { ...raw, cost: 0 }), model);
		assert.equal(r.billingReceipt, undefined);
		assert.equal(r.billingReceiptRejected, true);
	}
});

test("explicit invalid OR cost or nonzero SF cost rejects even a fully cached usage record", async () => {
	const withCache = { ...aggregate, prompt_tokens_details: { cached_tokens: 16 } };
	for (const badCost of [-1, Number.NaN, Number.POSITIVE_INFINITY, null, "0.001"]) {
		const r = await complete(adapter(router, { ...withCache, cost: badCost } as RawUsage), router);
		assert.equal(r.usage.partial, false);
		assert.equal(r.billingReceipt, undefined);
		assert.equal(r.billingReceiptRejected, true);
	}
	const chargedFree = await complete(adapter(free, { ...withCache, cost: 0.001 }), free);
	assert.equal(chargedFree.usage.partial, false);
	assert.equal(chargedFree.billingReceipt, undefined);
	assert.equal(chargedFree.billingReceiptRejected, true);
});

test("a wrong response model cannot get a receipt despite a valid official cost", async () => {
	for (const model of [router, free]) {
		const r = await complete(adapter(model, { ...aggregate, cost: 0 }, undefined, "gpt-4.1-mini-2025-04-14"), model);
		assert.equal(r.billingReceipt, undefined);
		assert.equal(r.billingReceiptRejected, true);
	}
});

test("a redirected transport cannot borrow the configured official endpoint identity", async () => {
	const a = new ChatCompletionsAdapter({ baseUrl: PROVIDERS.openrouter.baseUrl, apiKey: "fake-key", fetch: async () => {
		const r = response(router, { ...aggregate, cost: 0.003 });
		Object.defineProperty(r, "redirected", { value: true });
		Object.defineProperty(r, "url", { value: "https://other.example/chat/completions" });
		return r;
	} });
	const r = await complete(a, router);
	assert.equal(r.billingReceipt, undefined);
	assert.equal(r.billingReceiptRejected, true);
});

test("receipt consumer rechecks endpoint, currency, aggregate fields, cost, and normalized usage", () => {
	const raw: RawUsage = { ...aggregate, cost: 0.003 };
	const usage = normalizeUsage("openrouter", raw);
	const base: ModelBillingReceipt = { kind: "openrouter-usage-cost", endpoint: PROVIDERS.openrouter.baseUrl, model: router, currency: "USD", amount: 0.003, inputTokens: 64, outputTokens: 4, totalTokens: 68 };
	assert.ok(verifiedBillingReceipt(router, raw, usage, base, "USD"));
	for (const patch of [{ amount: 0 }, { amount: -1 }, { inputTokens: 63 }, { outputTokens: 5 }, { totalTokens: 67 }, { model: "gpt-4.1-mini" }, { endpoint: "https://proxy.example/v1" }, { currency: "CNY" as const }, { kind: "siliconflow-free" as const }]) {
		assert.equal(verifiedBillingReceipt(router, raw, usage, { ...base, ...patch }, "USD"), null);
	}
	assert.equal(verifiedBillingReceipt(router, raw, { ...usage, cacheRead: 0 }, base, "USD"), null);
	assert.equal(verifiedBillingReceipt(router, raw, { ...usage, partial: false }, base, "USD"), null);
	assert.equal(verifiedBillingReceipt(router, null, usage, base, "USD"), null);
	assert.equal(verifiedBillingReceipt(router, raw, usage, undefined, "USD"), null);
	assert.equal(verifiedBillingReceipt("gpt-4.1-mini", raw, usage, { ...base, model: "gpt-4.1-mini" }, "USD"), null);
});
