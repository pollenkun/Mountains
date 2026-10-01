import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import type { Message } from "@mountains/protocol";
import { ChatCompletionsAdapter, estimateCost, parseRetryAfter, isPeak, normalizeDeepSeekUsage, normalizeUsage, pricePeriod, thinkingSettingError, usageInconsistency, worstCaseCost } from "../src/index.ts";

const SSE = [
	{ choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning_content: "想" }, finish_reason: null }] },
	{ choices: [{ index: 0, delta: { reasoning_content: "一想" }, finish_reason: null }] },
	{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "file_read", arguments: "" } }] }, finish_reason: null }] },
	{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path": ' } }] }, finish_reason: null }] },
	{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.py"}' } }] }, finish_reason: null }] },
	{
		choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 2197, completion_tokens: 45, total_tokens: 2242, prompt_tokens_details: { cached_tokens: 2048 }, completion_tokens_details: { reasoning_tokens: 15 }, prompt_cache_hit_tokens: 2048, prompt_cache_miss_tokens: 149 },
	},
]
	.map((c) => `data: ${JSON.stringify({ id: "r1", object: "chat.completion.chunk", model: "deepseek-flash", ...c })}\n\n`)
	.join("") + "data: [DONE]\n\n";

describe("ChatCompletionsAdapter（本地假 SSE 服务，离线）", () => {
	let server: http.Server;
	let port = 0;
	const bodies: Record<string, unknown>[] = [];
	const auths: string[] = [];
	before(async () => {
		server = http.createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			auths.push(String(req.headers.authorization));
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(SSE);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		port = (server.address() as { port: number }).port;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	const history: Message[] = [
		{ role: "user", content: "修 bug" },
		{ role: "assistant", content: "", reasoning: "先读文件", toolCalls: [{ id: "call_0", name: "file_read", argumentsJson: '{"path": "x.py",  "startLine": 1}' }] },
		{ role: "tool", toolCallId: "call_0", name: "file_read", content: "x.py | lines 1-1 of 1\n1\tprint(1)" },
	];

	test("请求体：显式思考参数、工具名、max_tokens、回传 reasoning_content；解析原始 SSE", async () => {
		const a = new ChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-key" });
		const deltas: string[] = [];
		const r = await a.complete(
			{
				model: "deepseek-flash",
				system: "sys",
				tools: [{ name: "file_read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
				messages: history,
				thinking: { enabled: true, effort: "high" },
				maxTokens: 32000,
			},
			{ onThinking: (d: string) => deltas.push(d) },
		);
		assert.ok(r.ok, r.error?.message);
		const body = bodies.at(-1) as Record<string, unknown> & { messages: Record<string, unknown>[]; tools: { function: { name: string } }[] };
		assert.deepEqual(body.thinking, { type: "enabled" });
		assert.equal(body.reasoning_effort, "high");
		assert.equal(body.max_tokens, 32000);
		assert.equal(body.stream, true);
		assert.deepEqual(body.stream_options, { include_usage: true });
		assert.equal(body.tools[0]?.function.name, "file_read");
		const assistant = body.messages.find((m) => m.role === "assistant");
		assert.equal(assistant?.reasoning_content, "先读文件", "思考内容原样回传");
		assert.equal(auths.at(-1), "Bearer test-key");
		// 响应解析
		assert.equal(r.message.reasoning, "想一想");
		assert.deepEqual(deltas.join(""), "想一想");
		assert.equal(r.message.toolCalls[0]?.id, "call_A");
		assert.equal(r.message.toolCalls[0]?.argumentsJson, '{"path": "a.py"}', "保留模型生成的原始参数文本");
		assert.equal(r.usage.cacheRead, 2048);
		assert.equal(r.usage.input, 149);
		assert.equal(r.usage.cacheWrite, null);
		assert.equal(r.finishReason, "tool_calls");
		assert.equal(r.responseModel, "deepseek-flash");
		assert.ok(r.requestBody?.includes('"reasoning_effort":"high"'));
	});

	test("verbatimToolArguments：回放助手消息时使用原始参数文本（默认用 Pi 的重新序列化）", async () => {
		const a = new ChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" });
		const base = { model: "deepseek-flash", system: "s", tools: [], messages: history, thinking: { enabled: true, effort: "high" as const }, maxTokens: 100 };
		await a.complete(base);
		const pi = (bodies.at(-1) as { messages: { role: string; tool_calls?: { function: { arguments: string } }[] }[] }).messages.find((m) => m.role === "assistant");
		await a.complete({ ...base, verbatimToolArguments: true });
		const vb = (bodies.at(-1) as { messages: { role: string; tool_calls?: { function: { arguments: string } }[] }[] }).messages.find((m) => m.role === "assistant");
		assert.equal(pi?.tool_calls?.[0]?.function.arguments, '{"path":"x.py","startLine":1}');
		assert.equal(vb?.tool_calls?.[0]?.function.arguments, '{"path": "x.py",  "startLine": 1}');
	});

	test("关闭思考时发送 thinking: disabled", async () => {
		const a = new ChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" });
		await a.complete({ model: "deepseek-flash", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], thinking: { enabled: false, effort: "high" }, maxTokens: 10 });
		const body = bodies.at(-1) as Record<string, unknown>;
		assert.deepEqual(body.thinking, { type: "disabled" });
		assert.equal(body.reasoning_effort, undefined);
	});

	test("GLM：与 OpenCode 相同的 thinking {enabled, clear_thinking:false}；effort=default 不发 reasoning_effort；思考内容原样回传", async () => {
		const a = new ChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", provider: "zhipu" });
		const glmHistory: Message[] = history.map((m) => m);
		await a.complete({ model: "glm-5.3-flash", system: "s", tools: [{ name: "file_read", description: "read", parameters: { type: "object" } }], messages: glmHistory, thinking: { enabled: true, effort: "default" }, maxTokens: 32000 });
		const body = bodies.at(-1) as Record<string, unknown> & { messages: Record<string, unknown>[] };
		assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false });
		assert.equal(body.reasoning_effort, undefined);
		assert.equal(body.tool_stream, undefined, "与 OpenCode 一致：不开工具流式");
		assert.equal(body.temperature, undefined);
		assert.equal(body.max_tokens, 32000);
		const assistant = body.messages.find((m) => m.role === "assistant");
		assert.equal(assistant?.reasoning_content, "先读文件", "供应商名一致时 Pi 才会把思考作为 reasoning_content 回传");
		assert.equal(assistant?.content ?? null, null, "思考内容不能被降级成正文");
		await a.complete({ model: "glm-5.3-flash", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], thinking: { enabled: true, effort: "high" }, maxTokens: 10 });
		assert.equal((bodies.at(-1) as Record<string, unknown>).reasoning_effort, "high");
	});

	test("Kimi：不发任何思考参数与 reasoning_effort；temperature 固定 1；思考内容原样回传", async () => {
		const a = new ChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", provider: "moonshot" });
		await a.complete({ model: "kimi-k2.7-code", system: "s", tools: [{ name: "file_read", description: "read", parameters: { type: "object" } }], messages: history, thinking: { enabled: true, effort: "default" }, maxTokens: 32000 });
		const body = bodies.at(-1) as Record<string, unknown> & { messages: Record<string, unknown>[] };
		assert.equal(body.thinking, undefined);
		assert.equal(body.reasoning_effort, undefined);
		assert.equal(body.temperature, 1);
		assert.equal(body.max_tokens, 32000);
		const assistant = body.messages.find((m) => m.role === "assistant");
		assert.equal(assistant?.reasoning_content, "先读文件");
	});
});

describe("usage 与价格", () => {
	test("智谱：prompt_tokens 含命中；无 details 时按 0 命中", () => {
		const u = normalizeUsage("zhipu", { prompt_tokens: 3000, completion_tokens: 200, total_tokens: 3200, prompt_tokens_details: { cached_tokens: 2048 }, completion_tokens_details: { reasoning_tokens: 150 } });
		assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.output, u.reasoning], [952, 2048, null, 200, 150]);
		assert.equal(usageInconsistency(u), null);
		const z = normalizeUsage("zhipu", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
		assert.deepEqual([z.input, z.cacheRead, z.partial], [100, 0, false]);
		const c = estimateCost("glm-5.3-flash", { prompt_tokens: 2e6, completion_tokens: 1e6, prompt_tokens_details: { cached_tokens: 1e6 } }, new Date("2026-09-25T02:00:00Z"));
		assert.equal(c?.currency, "CNY");
		assert.equal(c?.period, "flat");
		assert.ok(c && Math.abs(c.amount - (0.8 + 0.23 + 2.8)) < 1e-9);
	});
	test("Moonshot：命中、写入、未缓存三者互斥；写入按未命中价", () => {
		const u = normalizeUsage("moonshot", { prompt_tokens: 5000, completion_tokens: 100, total_tokens: 5100, prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1500 } });
		assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.output], [500, 3000, 1500, 100]);
		assert.equal(usageInconsistency(u), null);
		const legacy = normalizeUsage("moonshot", { prompt_tokens: 5000, completion_tokens: 100, cached_tokens: 4096 });
		assert.deepEqual([legacy.input, legacy.cacheRead, legacy.cacheWrite], [904, 4096, 0]);
		const c = estimateCost("kimi-k2.7-code", { prompt_tokens: 3e6, completion_tokens: 1e6, prompt_tokens_details: { cached_tokens: 1e6, cache_write_tokens: 1e6 } }, new Date());
		assert.ok(c && Math.abs(c.amount - (6.5 + 1.3 + 6.5 + 27)) < 1e-9);
		assert.equal(c?.currency, "CNY");
		assert.ok(Math.abs(worstCaseCost("kimi-k2.7-code", 1e6, 1e6) - (6.5 + 27)) < 1e-9);
		assert.equal(worstCaseCost("unknown-model", 1, 1), Number.POSITIVE_INFINITY);
		assert.equal(pricePeriod(new Date("2026-09-25T02:00:00Z"), "kimi-k2.7-code"), "flat");
	});
	test("思考设置校验：Kimi 不能关闭思考、不支持 reasoning_effort；GLM 只能开启", () => {
		assert.match(String(thinkingSettingError("kimi-k2.7-code", { enabled: false, effort: "default" })), /不能关闭/);
		assert.match(String(thinkingSettingError("kimi-k2.7-code", { enabled: true, effort: "high" })), /不支持 reasoning_effort/);
		assert.equal(thinkingSettingError("kimi-k2.7-code", { enabled: true, effort: "default" }), null);
		assert.match(String(thinkingSettingError("glm-5.3-flash", { enabled: false, effort: "default" })), /enabled/);
		assert.equal(thinkingSettingError("glm-5.3-flash", { enabled: true, effort: "max" }), null);
		assert.equal(thinkingSettingError("deepseek-flash", { enabled: false, effort: "high" }), null);
	});
	test("四项互斥、缓存写入未提供、与 total 核对", () => {
		const u = normalizeDeepSeekUsage({ prompt_tokens: 2197, completion_tokens: 45, total_tokens: 2242, prompt_cache_hit_tokens: 2048, prompt_cache_miss_tokens: 149 });
		assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.output], [149, 2048, null, 45]);
		assert.equal(usageInconsistency(u), null);
		assert.equal(normalizeDeepSeekUsage(null).partial, true);
	});
	test("峰谷时段与费用", () => {
		assert.equal(isPeak(new Date("2026-09-25T02:00:00Z")), true);
		assert.equal(isPeak(new Date("2026-09-25T05:00:00Z")), false);
		assert.equal(isPeak(new Date("2026-09-25T09:59:00Z")), true);
		assert.equal(isPeak(new Date("2026-09-26T08:00:00Z")), false, "周六全天非峰时");
		const c = estimateCost("deepseek-flash", { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 }, new Date("2026-09-25T05:00:00Z"));
		assert.ok(c && Math.abs(c.amount - (0.003 + 0.15 + 0.6)) < 1e-12);
		assert.equal(c?.currency, "USD");
		assert.equal(estimateCost("deepseek-v4-flash", { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1e6, completion_tokens: 0 }, new Date("2026-09-25T02:00:00Z"))?.amount, 0.3, "旧名按 Flash 计费");
	});
});

describe("Retry-After", () => {
	test("retry-after-ms 优先；秒数；HTTP 日期；缺失为 null", () => {
		assert.equal(parseRetryAfter(new Headers({ "retry-after-ms": "1500", "retry-after": "9" })), 1500);
		assert.equal(parseRetryAfter(new Headers({ "retry-after": "20" })), 20000);
		assert.equal(parseRetryAfter(new Headers({ "retry-after": "Fri, 25 Sep 2026 10:00:30 GMT" }), Date.parse("2026-09-25T10:00:00Z")), 30000);
		assert.equal(parseRetryAfter(new Headers()), null);
	});
});
