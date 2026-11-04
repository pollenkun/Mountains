import assert from "node:assert/strict";
import http from "node:http";
import { test, type TestContext } from "node:test";
import { ChatCompletionsAdapter, normalizeUsage, type ModelRequest } from "../src/index.ts";

// Regression checks for the 2026-10-22 code review (B06–B09), against a local HTTP server.
const request: ModelRequest = { model: "deepseek-flash", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], thinking: { enabled: false, effort: "default" }, maxTokens: 64 };
const chunk = (text: string) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "deepseek-chat", choices: [{ index: 0, delta: { content: text } }] })}\n\n`;

async function serve(t: TestContext, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
	const closed: number[] = [];
	const server = http.createServer((req, res) => {
		req.on("close", () => closed.push(Date.now()));
		handler(req, res);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	t.after(() => { server.closeAllConnections(); server.close(); });
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, closed };
}

test("B06: token counts that are negative, fractional or larger than the prompt are unknown, not trusted", () => {
	const negative = normalizeUsage("deepseek", { prompt_tokens: 10, prompt_cache_hit_tokens: 11, prompt_cache_miss_tokens: -1, completion_tokens: 2, total_tokens: 12 });
	assert.equal(negative.input, null);
	assert.equal(negative.partial, true);
	const fractional = normalizeUsage("deepseek", { prompt_tokens: 10, prompt_cache_hit_tokens: 0.5, prompt_cache_miss_tokens: 9.5, completion_tokens: 2 });
	assert.equal(fractional.cacheRead, null);
	assert.equal(fractional.partial, true);
	const tooManyHits = normalizeUsage("zhipu", { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 }, completion_tokens: 2 });
	assert.equal(tooManyHits.input, null);
	assert.equal(tooManyHits.partial, true);
	const valid = normalizeUsage("deepseek", { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 2, total_tokens: 12 });
	assert.deepEqual([valid.input, valid.cacheRead, valid.output, valid.partial], [6, 4, 2, false]);
});

test("B07: an observer that throws also ends the HTTP request", async (t) => {
	const { url, closed } = await serve(t, (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		const timer = setInterval(() => res.write(chunk("a")), 20);
		res.on("close", () => clearInterval(timer));
	});
	const adapter = new ChatCompletionsAdapter({ baseUrl: url, apiKey: "test-key" });
	await assert.rejects(adapter.complete(request, { onText: () => { throw new Error("observer failed"); } }), /observer failed/);
	const deadline = Date.now() + 2000;
	while (!closed.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
	assert.equal(closed.length, 1, "the streaming request is closed once the observer fails");
});

test("B08: a stream that goes silent after the headers ends at timeoutMs as a retryable failure", { timeout: 10_000 }, async (t) => {
	await serve(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(chunk("partial")); }).then(async ({ url }) => {
		const adapter = new ChatCompletionsAdapter({ baseUrl: url, apiKey: "test-key", timeoutMs: 200 });
		const started = Date.now();
		const response = await adapter.complete(request);
		assert.ok(Date.now() - started < 3000, "the silent stream does not hold the request open");
		assert.equal(response.ok, false);
		assert.equal(response.aborted, false, "an idle timeout is not the user's cancellation");
		assert.equal(response.error?.retryable, true);
	});
});

test("B09: usage in a JSON 5xx error body is kept as evidence, separately from retryability", async (t) => {
	const usage = { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 };
	for (const status of [429, 500, 503]) {
		const { url } = await serve(t, (_req, res) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "busy" }, usage }));
		});
		const response = await new ChatCompletionsAdapter({ baseUrl: url, apiKey: "test-key" }).complete(request);
		assert.equal(response.ok, false, `status ${status}`);
		assert.deepEqual(response.rawUsage, usage, `status ${status} keeps its usage`);
		assert.equal(response.error?.retryable, true, `status ${status} stays retryable`);
	}
});
