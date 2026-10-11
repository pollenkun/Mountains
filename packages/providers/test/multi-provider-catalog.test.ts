import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@mountains/protocol";
import { capabilitiesFor, ChatCompletionsAdapter, estimateCost, normalizeUsage, pricingFor, PROVIDERS, responseModelMatches, thinkingSettingError, usageInconsistency, worstCaseCost } from "../src/index.ts";

const newModels = ["gpt-4.1-mini", "qwen-plus", "Qwen/Qwen2.5-7B-Instruct", "openai/gpt-4.1-mini"];
type Body = Record<string, unknown> & { messages: Record<string, unknown>[]; tools?: { function: { name: string } }[] };

function sse(model: string, tool: boolean): Response {
	const delta = tool ? { tool_calls: [{ index: 0, id: "tool_1", type: "function", function: { name: "file_read", arguments: '{"path": "a.txt"}' } }] } : { content: "done" };
	const frames = [
		{ id: "fake-completion", model, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
		{ id: "fake-completion", model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
		{ id: "fake-completion", model, choices: [], usage: { prompt_tokens: 64, completion_tokens: 3, total_tokens: 67, prompt_tokens_details: { cached_tokens: 8 } } },
	];
	return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

for (const model of newModels) test(`${model}: two tool turns use generic fields and explicit provider identity`, async () => {
	const cap = capabilitiesFor(model)!;
	const bodies: Body[] = [];
	const a = new ChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:9999/v1", apiKey: "fake-key", provider: cap.provider, fetch: async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as Body;
		bodies.push(body);
		return sse(model, bodies.length === 1);
	} });
	const initial: Message[] = [{ role: "user", content: "read a.txt" }];
	const req = { model, system: "sys", tools: [{ name: "file_read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }], messages: initial, thinking: { enabled: false, effort: "default" as const }, maxTokens: 4096, verbatimToolArguments: true, userId: "generic-user" };
	const first = await a.complete(req);
	assert.equal(first.ok, true, first.error?.message);
	assert.equal(first.message.toolCalls[0]?.name, "file_read");
	assert.equal(first.message.toolCalls[0]?.argumentsJson, '{"path": "a.txt"}');
	const second = await a.complete({ ...req, messages: [...initial, { ...first.message, reasoning: "prior-provider-private-reasoning" }, { role: "tool", toolCallId: "tool_1", name: "file_read", content: "hello" }] });
	assert.equal(second.ok, true, second.error?.message);
	assert.equal(second.message.content, "done");
	assert.equal(second.usage.cacheRead, 8);
	assert.equal(second.usage.input, 56);
	assert.equal(usageInconsistency(second.usage), null);
	assert.equal(a.id, cap.provider);
	for (const body of bodies) {
		assert.equal(body.model, model);
		assert.equal(body.thinking, undefined);
		assert.equal(body.reasoning_effort, undefined);
		assert.equal(body.reasoning, undefined);
		assert.equal(body.user_id, undefined, "DeepSeek cache identity is not a standard OpenAI parameter");
		assert.equal(body.enable_thinking, model === "qwen-plus" ? false : undefined);
		assert.equal(body[cap.maxTokensField ?? "max_tokens"], 4096);
		assert.equal(body.tools?.[0]?.function.name, "file_read");
		assert.ok(!JSON.stringify(body).includes("prior-provider-private-reasoning"));
		for (const msg of body.messages) {
			assert.equal(msg.reasoning_content, undefined);
			assert.equal(msg.reasoning_details, undefined);
		}
	}
	assert.equal(thinkingSettingError(model, req.thinking), null);
	assert.match(String(thinkingSettingError(model, { enabled: true, effort: "default" })), /非思考/);
});

test("unknown compatible model does not inherit DeepSeek fields or reasoning replay", async () => {
	let body: Body | undefined;
	const a = new ChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:9999/v1", apiKey: "fake", fetch: async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Body;
		return sse("private-generic-model", false);
	} });
	await a.complete({ model: "private-generic-model", system: "s", tools: [], maxTokens: 10, thinking: { enabled: true, effort: "high" }, messages: [{ role: "assistant", content: "hello", reasoning: "hidden", toolCalls: [] }, { role: "user", content: "next" }] });
	assert.equal(body?.thinking, undefined);
	assert.equal(body?.reasoning_effort, undefined);
	assert.equal(body?.messages[1]?.reasoning_content, undefined);
	assert.ok(!JSON.stringify(body).includes("hidden"));
});

test("generic usage subtracts only documented cached input and preserves unknown cache", () => {
	for (const provider of ["openai", "qwen", "openrouter", "gemini"] as const) {
		const complete = normalizeUsage(provider, { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34, prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 7 } });
		assert.deepEqual([complete.input, complete.cacheRead, complete.cacheWrite, complete.output, complete.partial], [18, 12, null, 4, false]);
		assert.equal(usageInconsistency(complete), null);
		const missing = normalizeUsage(provider, { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34, cached_tokens: 10 });
		assert.deepEqual([missing.input, missing.cacheRead, missing.cacheWrite, missing.partial], [null, null, null, true]);
		assert.equal(normalizeUsage(provider, null).partial, true);
	}
});

test("SiliconFlow alone uses its official hit/miss fields and does not invent cache when absent", () => {
	const u = normalizeUsage("siliconflow", { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34, prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 18 });
	assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.output, u.partial], [18, 12, null, 4, false]);
	assert.equal(usageInconsistency(u), null);
	const missing = normalizeUsage("siliconflow", { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 });
	assert.equal(missing.cacheRead, null);
	assert.equal(missing.partial, true);
});

test("response aliases are exact and scoped to the requested route", () => {
	assert.equal(responseModelMatches("gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"), true);
	assert.equal(responseModelMatches("gpt-4.1-mini", "gpt-4.1-mini-2026-01-01"), false);
	assert.equal(responseModelMatches("gpt-4.1-mini", "gpt-4.1"), false);
	assert.equal(responseModelMatches("qwen-plus", "qwen-plus-2025-12-01"), true);
	assert.equal(responseModelMatches("qwen-plus", "qwen-plus-2025-01-25"), false);
	assert.equal(responseModelMatches("openai/gpt-4.1-mini", "openai/gpt-4.1-mini-2025-04-14"), true);
	assert.equal(responseModelMatches("openai/gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"), false);
	assert.equal(responseModelMatches("gpt-4.1-mini", "openai/gpt-4.1-mini-2025-04-14"), false);
	assert.equal(responseModelMatches("Qwen/Qwen2.5-7B-Instruct", "Pro/Qwen/Qwen2.5-7B-Instruct"), false);
	assert.equal(responseModelMatches("deepseek-v4-flash", "deepseek-flash"), true);
});

test("new provider budgets use original currency and conservative route/tier prices", () => {
	const raw = { prompt_tokens: 2e6, completion_tokens: 1e6, total_tokens: 3e6, prompt_tokens_details: { cached_tokens: 1e6 } };
	const now = new Date("2026-10-03T05:00:00Z");
	assert.equal(estimateCost("gpt-4.1-mini", raw, now)?.amount, 2.1);
	assert.ok(Math.abs(estimateCost("openai/gpt-4.1-mini", raw, now)!.amount - 2.31) < 1e-12);
	assert.equal(estimateCost("qwen-plus", raw, now, "CNY")?.amount, 53.76);
	assert.equal(estimateCost("Qwen/Qwen2.5-7B-Instruct", raw, now, "CNY")?.amount, 0);
	assert.equal(pricingFor("gpt-4.1-mini", "CNY"), undefined);
	assert.equal(pricingFor("qwen-plus", "USD"), undefined);
	assert.equal(pricingFor("qwen-plus")?.currency, "CNY");
	assert.equal(worstCaseCost("qwen-plus", 1e6, 1e6, "CNY"), 52.8);
	assert.equal(worstCaseCost("Qwen/Qwen2.5-7B-Instruct", 1e6, 1e6, "CNY"), 0);
	assert.equal(estimateCost("gpt-4.1-mini", { prompt_tokens: 1e6, completion_tokens: 1e6 }, now)?.partial, true);
	assert.equal(PROVIDERS.qwen.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
	assert.equal(capabilitiesFor("gemini-3.5-flash-lite"), undefined, "signature-dependent models are not falsely registered");
});

test("existing DeepSeek Pro prices have a real selectable capability without claiming vision", () => {
	const cap = capabilitiesFor("deepseek-v4-pro")!;
	assert.equal(cap.provider, "deepseek");
	assert.equal(cap.contextWindow, 1_048_576);
	assert.equal(cap.maxOutputTokens, 393_216);
	assert.deepEqual(cap.inputModalities, ["text"]);
	assert.deepEqual(cap.effortLevels, ["low", "high", "max"]);
	assert.equal(thinkingSettingError(cap.id, { enabled: true, effort: "max" }), null);
	assert.equal(pricingFor(cap.id, "CNY")?.peak.output, 27);
	assert.equal(pricingFor(cap.id, "USD")?.peak.output, 3.96);
});
