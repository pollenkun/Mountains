import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { Message } from "@mountains/protocol";
import { AnthropicMessagesAdapter, ChatCompletionsAdapter, openAiCompatibleRelay, PROVIDERS } from "../src/index.ts";

function sse(model: string): Response {
	const frames = [
		{ id: "fake", model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
		{ id: "fake", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		{ id: "fake", model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, prompt_tokens_details: { cached_tokens: 1 } } },
	];
	return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("xAI and a generic relay both use the OpenAI chat completions path on their own base URL", async () => {
	const seen: string[] = [];
	const fetchImpl: typeof fetch = async input => {
		seen.push(String(input));
		return sse("grok-4.7");
	};
	const xai = new ChatCompletionsAdapter({ baseUrl: PROVIDERS.xai.baseUrl, apiKey: "test-key", provider: "xai", fetch: fetchImpl });
	await xai.complete({ model: "grok-4.7", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], thinking: { enabled: false, effort: "default" }, maxTokens: 16 });
	const relay = openAiCompatibleRelay("http://127.0.0.1:9/relay/v1");
	const generic = new ChatCompletionsAdapter({ baseUrl: relay.baseUrl, apiKey: "test-key", provider: "openai-compatible", fetch: fetchImpl });
	await generic.complete({ model: "relay-model", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], thinking: { enabled: false, effort: "default" }, maxTokens: 16 });
	assert.match(seen[0] ?? "", /api\.x\.ai\/v1\/chat\/completions/);
	assert.match(seen[1] ?? "", /127\.0\.0\.1:9\/relay\/v1\/chat\/completions/);
	assert.throws(() => openAiCompatibleRelay("ftp://files.example/v1"), /https/);
});

test("Anthropic Messages streams text, thinking and a tool call against a local server", async () => {
	let body: Record<string, unknown> | undefined;
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", chunk => chunks.push(chunk as Buffer));
		req.on("end", () => {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			assert.equal(req.url, "/v1/messages");
			const frames = [
				`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } })}\n\n`,
				`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })}\n\n`,
				`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } })}\n\n`,
				`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "file_read" } })}\n\n`,
				`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.txt\"}" } })}\n\n`,
				`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } })}\n\n`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
			];
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(frames.join(""));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const adapter = new AnthropicMessagesAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key" });
	const messages: Message[] = [{ role: "user", content: "read a.txt" }];
	const result = await adapter.complete({
		model: "claude-sonnet-5-5", system: "sys", maxTokens: 100,
		tools: [{ name: "file_read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
		messages, thinking: { enabled: true, effort: "high" },
	});
	server.close();
	assert.equal(result.ok, true, result.error?.message);
	assert.equal(result.message.reasoning, "hmm");
	assert.equal(result.message.content, "ok");
	assert.equal(result.message.toolCalls[0]?.name, "file_read");
	assert.equal(result.message.toolCalls[0]?.argumentsJson, "{\"path\":\"a.txt\"}");
	assert.deepEqual([result.usage.input, result.usage.cacheRead, result.usage.cacheWrite, result.usage.output], [10, 4, 2, 6]);
	assert.equal(result.usage.partial, false);
	const system = body?.system as { cache_control?: { type: string } }[];
	const tools = body?.tools as { name: string; input_schema: { type: string }; cache_control?: { type: string } }[];
	const sent = body?.messages as { content: { cache_control?: { type: string } }[] }[];
	assert.equal(system?.[0]?.cache_control?.type, "ephemeral");
	assert.equal(tools?.[0]?.name, "file_read");
	assert.equal(tools?.[0]?.input_schema.type, "object");
	assert.equal(tools?.[0]?.cache_control?.type, "ephemeral");
	assert.equal(sent?.at(-1)?.content.at(-1)?.cache_control?.type, "ephemeral");
	assert.deepEqual(body?.thinking, { type: "enabled", budget_tokens: 8192 });
	const budgeted = new AnthropicMessagesAdapter({ baseUrl: "http://127.0.0.1:9", apiKey: "k", fetch: async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response("data: {\"type\":\"message_stop\"}\n\n", { status: 200 });
	} });
	await budgeted.complete({ model: "claude-sonnet-5-5", system: "s", tools: [], messages, thinking: { enabled: true, effort: "low", budgetTokens: 1234 }, maxTokens: 8 });
	assert.deepEqual(body?.thinking, { type: "enabled", budget_tokens: 1234 });
});

test("a relay base that already ends in /v1 is not posted to /v1/v1/messages", async () => {
	let url = "";
	const adapter = new AnthropicMessagesAdapter({
		baseUrl: "https://api.openlux.ai/v1/", apiKey: "k", fetch: async (input) => {
			url = String(input);
			return new Response("data: {\"type\":\"message_stop\"}\n\n", { status: 200 });
		},
	});
	await adapter.complete({ model: "claude-opus-5-5", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], thinking: { enabled: false, effort: "default" }, maxTokens: 8 });
	assert.equal(url, "https://api.openlux.ai/v1/messages");
});
