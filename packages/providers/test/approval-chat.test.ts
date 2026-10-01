import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { ApprovalChatAdapter, type ApprovalChatAdapterOptions } from "../src/approval-chat.ts";
import type { ModelRequest } from "../src/chat-completions.ts";

const KEY = "test-only-approval-key";
const request = (change: Partial<ModelRequest> = {}): ModelRequest => ({ model: "custom-reviewer", system: "Return one approval decision.",
	tools: [], messages: [{ role: "user", content: "Review a scoped file write." }], thinking: { enabled: true, effort: "default" }, maxTokens: 128, ...change });
function completion(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { id: "response-test", model: "custom-reviewer", choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"decision":"allow"}' } }],
		usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 4 } }, ...extra };
}
async function read(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString());
}
function json(res: ServerResponse, body: unknown, status = 200): void {
	res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
}
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (baseUrl: string) => Promise<void>): Promise<void> {
	const s = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.destroy(); }); });
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const address = s.address(); assert(address && typeof address !== "string");
	try { await run(`http://127.0.0.1:${address.port}/v1`); }
	finally { s.closeAllConnections(); await new Promise<void>((resolve, reject) => s.close((err) => err ? reject(err) : resolve())); }
}
function adapter(baseUrl: string, options: Partial<ApprovalChatAdapterOptions> = {}): ApprovalChatAdapter {
	return new ApprovalChatAdapter({ baseUrl, apiKey: KEY, profile: "openai", ...options });
}

test("approval transport sends one non-streaming, tool-free HTTP request and counts OpenAI usage", async () => {
	let calls = 0;
	await server(async (req, res) => {
		calls++; assert.equal(req.url, "/v1/chat/completions"); assert.equal(req.headers.authorization, `Bearer ${KEY}`);
		const body = await read(req); assert.equal(body.stream, false); assert.equal(body.max_tokens, 128);
		assert.equal(body.tools, undefined); assert.equal(body.reasoning_effort, undefined); assert.equal(body.thinking, undefined);
		json(res, completion());
	}, async (url) => {
		let text = ""; let first = 0;
		const r = await adapter(url).complete(request(), { onText: (t) => { text += t; }, onFirstByte: () => first++ });
		assert.equal(r.ok, true); assert.equal(text, '{"decision":"allow"}'); assert.equal(first, 1);
		assert.deepEqual(r.usage, { input: 80, cacheRead: 20, cacheWrite: null, output: 12, reasoning: 4, total: 112, partial: false });
		assert.equal(r.httpStatus, 200); assert.equal(r.error, null); assert(r.firstByteAt !== null); assert(r.finishedAt >= r.firstByteAt);
		assert(!JSON.stringify(r).includes(KEY)); assert.equal(calls, 1);
	});
});

test("registered providers send their actual thinking protocol", async () => {
	const bodies: Record<string, unknown>[] = [];
	await server(async (req, res) => { bodies.push(await read(req)); json(res, completion()); }, async (url) => {
		for (const [profile, model, enabled, effort] of [
			["deepseek", "deepseek-flash", true, "high"], ["deepseek", "deepseek-flash", false, "default"],
			["zhipu", "glm-5.3-flash", true, "default"], ["zhipu", "glm-5.3-flash", true, "max"],
			["moonshot", "kimi-k2.7-code", true, "default"],
		] as const) {
			assert.equal((await adapter(url, { profile }).complete(request({ model, thinking: { enabled, effort } }))).ok, true);
		}
	});
	assert.deepEqual(bodies[0]!.thinking, { type: "enabled" }); assert.equal(bodies[0]!.reasoning_effort, "high");
	assert.deepEqual(bodies[1]!.thinking, { type: "disabled" }); assert.equal(bodies[1]!.reasoning_effort, undefined);
	assert.deepEqual(bodies[2]!.thinking, { type: "enabled", clear_thinking: false }); assert.equal(bodies[2]!.reasoning_effort, undefined);
	assert.equal(bodies[3]!.reasoning_effort, "max");
	assert.equal(bodies[4]!.thinking, undefined); assert.equal(bodies[4]!.reasoning_effort, undefined); assert.equal(bodies[4]!.temperature, 1);
});

test("unsupported effort, profile mismatch and tool-bearing approval requests never reach HTTP", async () => {
	let calls = 0;
	await server((_req, res) => { calls++; json(res, completion()); }, async (url) => {
		const cases: [Partial<ApprovalChatAdapterOptions>, Partial<ModelRequest>][] = [
			[{}, { thinking: { enabled: true, effort: "high" } }],
			[{ supportedEfforts: ["max"] }, { thinking: { enabled: true, effort: "max" } }],
			[{ profile: "moonshot", supportedEfforts: ["high"] }, { thinking: { enabled: true, effort: "high" } }],
			[{ profile: "zhipu" }, { model: "glm-5.3-flash", thinking: { enabled: false, effort: "default" } }],
			[{}, { model: "deepseek-flash" }],
			[{}, { thinking: { enabled: false, effort: "default" } }],
			[{ profile: "deepseek" }, { model: "deepseek-flash", thinking: { enabled: false, effort: "high" } }],
			[{}, { tools: [{ name: "run", description: "run", parameters: {} }] }],
			[{}, { messages: [{ role: "tool", toolCallId: "t1", name: "run", content: "done" }] }],
		];
		for (const [options, req] of cases) {
			const result = await adapter(url, options).complete(request(req)); assert.equal(result.ok, false); assert.equal(result.httpStatus, null);
			assert.equal(result.usage.partial, true); assert.equal(result.usage.output, null);
		}
		assert.equal(calls, 0);
	});
});

test("custom OpenAI effort and output field require explicit declarations", async () => {
	const bodies: Record<string, unknown>[] = [];
	await server(async (req, res) => { bodies.push(await read(req)); json(res, completion()); }, async (url) => {
		const a = adapter(url, { supportedEfforts: ["low", "max"], effortMapping: { max: "xhigh" }, maxTokensField: "max_completion_tokens", disabledReasoningEffort: "none" });
		assert.equal((await a.complete(request({ thinking: { enabled: true, effort: "max" } }))).ok, true);
		assert.equal((await a.complete(request({ thinking: { enabled: false, effort: "default" } }))).ok, true);
	});
	assert.equal(bodies[0]!.reasoning_effort, "xhigh"); assert.equal(bodies[0]!.max_completion_tokens, 128); assert.equal(bodies[0]!.max_tokens, undefined);
	assert.equal(bodies[1]!.reasoning_effort, "none");
});

test("unsolicited tools remain visible with verbatim arguments and are never executed", async () => {
	const args = '{ "command" : "untrusted", "x": 1 }';
	await server((_req, res) => json(res, completion({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
		tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: args } }] } }] })), async (url) => {
		const r = await adapter(url).complete(request()); assert.equal(r.ok, true);
		assert.deepEqual(r.message.toolCalls, [{ id: "t1", name: "run", argumentsJson: args }]); assert.equal(r.finishReason, "tool_calls");
	});
});

test("missing or malformed usage stays unknown; contradictory usage is partial", async () => {
	const variants = [undefined, { prompt_tokens: -1, completion_tokens: 3 }, { prompt_tokens: 1.5, completion_tokens: 3 },
		{ prompt_tokens: 10, completion_tokens: 3, total_tokens: 999 }, { prompt_tokens: 10, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 9 } }];
	let next = 0;
	await server((_req, res) => json(res, completion({ usage: variants[next++] })), async (url) => {
		for (let i = 0; i < variants.length; i++) {
			const r = await adapter(url).complete(request()); assert.equal(r.ok, true); assert.equal(r.usage.partial, true);
			if (i < 3) { assert.equal(r.usage.input, null); assert.equal(r.usage.output, null); assert.equal(r.rawUsage, null); }
		}
	});
});

test("HTTP failure is sanitized and never retried", async () => {
	let count = 0;
	await server((_req, res) => { count++; json(res, { error: { message: `Bearer ${KEY} https://secret.invalid/path` } }, 429); }, async (url) => {
		const r = await adapter(url).complete(request()); assert.equal(r.ok, false); assert.equal(r.httpStatus, 429);
		assert.equal(r.error?.retryable, false); assert.equal(r.usage.total, null); assert.equal(count, 1);
		assert(!JSON.stringify(r).includes(KEY)); assert(!JSON.stringify(r).includes("secret.invalid"));
	});
});

test("malformed JSON and transport exceptions cannot leak raw endpoint errors", async () => {
	await server((_req, res) => { res.writeHead(200); res.end(`not-json ${KEY}`); }, async (url) => {
		const r = await adapter(url).complete(request()); assert.equal(r.ok, false); assert.equal(r.error?.message, "Invalid approval response"); assert(!JSON.stringify(r).includes(KEY));
	});
	const fakeFetch: typeof fetch = async () => { throw new Error(`Approval failed at https://${KEY}@private.invalid/token`); };
	const r = await adapter("http://127.0.0.1:1", { fetch: fakeFetch }).complete(request());
	assert.equal(r.error?.message, "Approval connection failed"); assert(!JSON.stringify(r).includes(KEY));
});

test("response size limits reject both advertised and chunked oversized bodies", async () => {
	for (const declared of [true, false]) {
		await server((_req, res) => {
			res.writeHead(200, declared ? { "Content-Length": "8192" } : {}); res.write("x".repeat(2048)); res.end();
		}, async (url) => {
			const r = await adapter(url, { maxResponseBytes: 1024 }).complete(request());
			assert.equal(r.ok, false); assert.match(r.error!.message, /size bound/); assert.equal(r.usage.partial, true);
		});
	}
});

test("real HTTP timeout aborts a stalled response", async () => {
	let count = 0;
	await server(async (req, _res) => { count++; await read(req); }, async (url) => {
		const before = Date.now(); const r = await adapter(url, { timeoutMs: 70 }).complete(request());
		assert.equal(r.ok, false); assert.equal(r.aborted, true); assert.equal(r.error?.message, "Approval request timed out");
		assert(Date.now() - before < 2000); assert.equal(count, 1);
	});
});

test("external cancellation during HTTP body read stops approval without a decision", async () => {
	const controller = new AbortController();
	await server((_req, res) => { res.writeHead(200); res.write('{"choices":'); }, async (url) => {
		const pending = adapter(url, { timeoutMs: 2000 }).complete(request({ signal: controller.signal }), { onFirstByte: () => controller.abort(new Error(KEY)) });
		const r = await pending; assert.equal(r.ok, false); assert.equal(r.aborted, true); assert.equal(r.message.content, "");
		assert.equal(r.error?.message, "Approval request cancelled"); assert(!JSON.stringify(r).includes(KEY));
	});
});

test("already cancelled request does not send HTTP and redirects never forward credentials", async () => {
	let requests = 0;
	await server((_req, res) => { requests++; res.writeHead(307, { Location: "/redirected" }); res.end(); }, async (url) => {
		const cancelled = AbortSignal.abort(new Error(KEY));
		const first = await adapter(url).complete(request({ signal: cancelled })); assert.equal(first.aborted, true); assert.equal(requests, 0);
		const next = await adapter(url).complete(request()); assert.equal(next.ok, false); assert.equal(requests, 1);
	});
});

test("configuration rejects implicit profiles and credential-bearing URLs", () => {
	assert.throws(() => adapter("https://user:password@example.invalid"), /base URL/);
	assert.throws(() => adapter("https://example.invalid?api_key=value"), /base URL/);
	assert.throws(() => adapter("https://example.invalid", { profile: "unknown" as "openai" }), /explicit/);
	assert.throws(() => adapter("https://example.invalid", { effortMapping: { max: "xhigh\nsecret" } }), /mapping/);
});
