import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { ChatCompletionsAdapter, type ModelRequest } from "../src/index.ts";

const usage = { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 2, total_tokens: 12 };
const request: ModelRequest = { model: "deepseek-flash", system: "Offline fixture", tools: [], messages: [{ role: "user", content: "fixture" }], thinking: { enabled: false, effort: "default" }, maxTokens: 64 };
const chunk = (delta: object, finish: string | null = null, withUsage = false) => ({ id: "offline", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }], ...(withUsage ? { usage } : {}) });
const event = (value: object, multiline = false) => JSON.stringify(value, null, multiline ? 2 : undefined).split("\n").map(line => `data: ${line}\n`).join("") + "\n";
const response = (body: string | ReadableStream<Uint8Array>) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const adapter = (fetch: typeof globalThis.fetch) => new ChatCompletionsAdapter({ baseUrl: "https://offline.invalid/v1", apiKey: "fixture-only", fetch });
function fragmented(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text); let index = 0;
	return new ReadableStream({ pull(controller) { if (index === bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index)); } });
}
function brokenStream(prefix: string, error: Error, abort?: () => void): Response {
	let sent = false;
	return response(new ReadableStream({ async pull(controller) {
		if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prefix)); }
		else { await setImmediate(); abort?.(); controller.error(error); }
	} }));
}

for (const withUsage of [false, true]) test(`HTTP 200 body transport failure is retryable (usage=${withUsage})`, async () => {
	const result = await adapter(async () => brokenStream(event(chunk({ content: "partial" }, null, withUsage)), new TypeError("offline connection reset"))).complete(request);
	assert.equal(result.ok, false); assert.equal(result.httpStatus, 200); assert.equal(result.error?.retryable, true);
	assert.equal(result.aborted, false); assert.deepEqual(result.rawUsage, withUsage ? usage : null);
});

test("provider network_error is retryable independently of HTTP 200", async () => {
	const result = await adapter(async () => response(event(chunk({}, "network_error", true)) + "data: [DONE]\n\n")).complete(request);
	assert.equal(result.ok, false); assert.equal(result.httpStatus, 200); assert.equal(result.finishReason, "network_error");
	assert.equal(result.error?.retryable, true); assert.deepEqual(result.rawUsage, usage);
});

for (const finish of ["content_filter", "unsupported_finish"]) test(`${finish} remains permanent even if the body later resets`, async () => {
	for (const reset of [false, true]) {
		const prefix = event(chunk({}, finish, true));
		const result = await adapter(async () => reset ? brokenStream(prefix, new TypeError("offline reset")) : response(prefix + "data: [DONE]\n\n")).complete(request);
		assert.equal(result.ok, false); assert.equal(result.error?.retryable, false);
	}
});

test("cancellation remains permanent even after a network_error event", async () => {
	const controller = new AbortController();
	const result = await adapter(async () => brokenStream(event(chunk({}, "network_error", true)), new DOMException("cancelled", "AbortError"), () => controller.abort())).complete({ ...request, signal: controller.signal });
	assert.equal(result.ok, false); assert.equal(result.aborted, true); assert.equal(result.error?.retryable, false);
});

test("a clean stream without finish_reason is a permanent protocol error", async () => {
	const result = await adapter(async () => response(event(chunk({ content: "unfinished" })) + "data: [DONE]\n\n")).complete(request);
	assert.equal(result.ok, false); assert.equal(result.error?.retryable, false);
});

test("local request errors without HTTP status do not become transport retries", async () => {
	let fetches = 0;
	const result = await new ChatCompletionsAdapter({ baseUrl: "https://offline.invalid/v1", apiKey: "", fetch: async () => { fetches++; throw new Error("must not dispatch"); } }).complete(request);
	assert.equal(fetches, 0); assert.equal(result.ok, false); assert.equal(result.error?.retryable, false);
});

for (const status of [429, 503]) test(`HTTP ${status} retains retry and Retry-After behavior`, async () => {
	const result = await adapter(async () => Response.json({ error: { message: "offline unavailable" } }, { status, headers: { "retry-after-ms": "17" } })).complete(request);
	assert.equal(result.ok, false); assert.equal(result.error?.retryable, true); assert.equal(result.retryAfterMs, 17);
});

test("a fetch rejection before headers remains retryable", async () => {
	const result = await adapter(async () => { throw new TypeError("offline transport unavailable"); }).complete(request);
	assert.equal(result.ok, false); assert.equal(result.httpStatus, null); assert.equal(result.error?.retryable, true);
});

const first = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-a", type: "function", function: { name: "file_read", arguments: '{"path": ' } }] });
const last = chunk({ tool_calls: [{ index: 0, function: { arguments: '"雪\\\\a.txt",  "startLine": 1}' } }] }, "tool_calls", true);
const rawArguments = '{"path": "雪\\\\a.txt",  "startLine": 1}';
for (const [name, newline, multiline, bytes] of [
	["LF single-line control", "\n", false, false],
	["LF multiline", "\n", true, false],
	["CRLF multiline byte fragments", "\r\n", true, true],
	["CR multiline byte fragments", "\r", true, true],
	["LF multiline byte fragments", "\n", true, true],
] as const) test(`${name} preserves event metadata, usage and verbatim tool arguments`, async () => {
	const body = (": keepalive\nid: transport-id\nevent: message\n" + event(first, multiline) + event(last, multiline) + "data: [DONE]\n\n").replaceAll("\n", newline);
	const result = await adapter(async () => response(bytes ? fragmented(body) : body)).complete(request);
	assert.equal(result.ok, true, result.error?.message); assert.equal(result.finishReason, "tool_calls");
	assert.equal(result.responseModel, "deepseek-flash"); assert.equal(result.responseId, "offline"); assert.deepEqual(result.rawUsage, usage);
	assert.equal(result.message.toolCalls[0]?.argumentsJson, rawArguments);
});

test("a multiline first event followed by single-line fragments retains the complete arguments", async () => {
	const result = await adapter(async () => response(event(first, true) + event(last) + "data: [DONE]\n\n")).complete(request);
	assert.equal(result.ok, true); assert.equal(result.message.toolCalls[0]?.argumentsJson, rawArguments);
});

test("mixed CR, LF and CRLF events keep interleaved tool indexes distinct", async () => {
	const a = chunk({ tool_calls: [
		{ index: 1, id: "b", type: "function", function: { name: "file_read", arguments: '{"path": "b' } },
		{ index: 0, id: "a", type: "function", function: { name: "file_read", arguments: '{"path": "a' } },
	] });
	const b = chunk({ tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }, { index: 1, function: { arguments: '.txt"}' } }] }, "tool_calls", true);
	const body = event(a, true).replaceAll("\n", "\r") + event(b).replaceAll("\n", "\r\n") + "data: [DONE]\n\n";
	const result = await adapter(async () => response(fragmented(body))).complete(request);
	assert.equal(result.ok, true); assert.deepEqual(result.message.toolCalls.map(call => [call.id, call.argumentsJson]), [["b", '{"path": "b.txt"}'], ["a", '{"path": "a.txt"}']]);
});

test("an unsupported raw capture shape cannot override the SDK's complete arguments", async () => {
	// Pi can merge this ID-only fragment; the tap must either do so too or fall back as a whole.
	const idOnly = chunk({ tool_calls: [{ id: "call-a", function: { arguments: '"a.txt"}' } }] }, "tool_calls", true);
	const result = await adapter(async () => response(event(first) + event(idOnly) + "data: [DONE]\n\n")).complete(request);
	assert.equal(result.ok, true); assert.deepEqual(JSON.parse(result.message.toolCalls[0]!.argumentsJson), { path: "a.txt" });
});

for (const raw of ['{"path":"unfinished', "null", "[]"]) test(`complete capture preserves invalid tool arguments ${JSON.stringify(raw)} for dispatcher rejection`, async () => {
	const value = chunk({ tool_calls: [{ index: 0, id: "bad", type: "function", function: { name: "file_read", arguments: raw } }] }, "tool_calls", true);
	const result = await adapter(async () => response(event(value, true) + "data: [DONE]\n\n")).complete(request);
	assert.equal(result.ok, true); assert.equal(result.message.toolCalls[0]?.argumentsJson, raw);
});

test("events after DONE cannot contaminate captured metadata or tool arguments", async () => {
	const extra = chunk({ tool_calls: [{ index: 0, function: { arguments: "corruption" } }] }, "network_error", true);
	const result = await adapter(async () => response(event(first) + event(last) + "data: [DONE]\n\n" + event(extra))).complete(request);
	assert.equal(result.ok, true); assert.equal(result.finishReason, "tool_calls"); assert.equal(result.message.toolCalls[0]?.argumentsJson, rawArguments);
});

for (const reset of [false, true]) test(`malformed SSE after network_error stays permanent (later reset=${reset})`, async t => {
	t.mock.method(console, "error", () => {});
	const body = event(chunk({}, "network_error", true)) + 'data: {not JSON}\n\n';
	const result = await adapter(async () => reset ? brokenStream(body, new TypeError("offline reset")) : response(body)).complete(request);
	assert.equal(result.ok, false); assert.equal(result.error?.retryable, false);
});

for (const status of [400, 401, 403]) test(`HTTP ${status} remains permanent`, async () => {
	const result = await adapter(async () => Response.json({ error: { message: "offline rejection" } }, { status })).complete(request);
	assert.equal(result.ok, false); assert.equal(result.error?.retryable, false);
});

test("an EOF without an event boundary cannot manufacture usage evidence", async () => {
	const result = await adapter(async () => response(event(chunk({ content: "done" }, "stop")) + `data: ${JSON.stringify({ usage })}\n`)).complete(request);
	assert.equal(result.ok, true); assert.equal(result.rawUsage, null); assert.equal(result.usage.partial, true);
});

test("empty data fields, comments and data without a space follow event-level framing", async () => {
	const body = event(first, true).replace('data: {\n', 'data:{\n: inside event\ndata\n') + event(last, true) + "data: [DONE]\n\n";
	const result = await adapter(async () => response(fragmented(body))).complete(request);
	assert.equal(result.ok, true); assert.equal(result.message.toolCalls[0]?.argumentsJson, rawArguments); assert.deepEqual(result.rawUsage, usage);
});

for (const status of [400, 401, 403, 404, 429, 503]) test(`a reset while reading HTTP ${status}'s error body preserves status retry policy`, async () => {
	const result = await adapter(async () => {
		const broken = brokenStream('{"error":', new TypeError("offline error-body reset"));
		return new Response(broken.body, { status, headers: { "content-type": "application/json" } });
	}).complete(request);
	assert.equal(result.ok, false); assert.equal(result.httpStatus, status);
	assert.equal(result.error?.retryable, status === 429 || status >= 500);
});
